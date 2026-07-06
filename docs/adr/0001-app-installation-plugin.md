# 1. App installation management plugin

- Status: Accepted
- Date: 2026-07-06
- Deciders: safe-settings maintainers
- Related PR: `decyjphr-app-installation-plugin`

## Context

Safe-settings manages configuration whose **target is a repository** (branch
protection, labels, collaborators, …), with a couple of exceptions
(`rulesets`, `custom_repository_roles`) that target the organization. All of
these are driven through the org → suborg → repo configuration hierarchy and
applied by `syncAll` / `syncSelectedRepos` / `sync`.

We need a new capability where the **target of the operation is a GitHub App
installation** rather than a repository. Concretely, safe-settings should
declaratively control **which repositories each installed GitHub App can
access** (`repository_selection`), driven by the same config hierarchy:

- **Org-level `settings.yml`** → the app should have access to **all** repos in
  the org.
- **Suborg-level `suborgs/*.yml`** → repos selected by the suborg's targeting
  criteria (custom properties, teams, names).
- **Repo-level `repos/*.yml`** → the specific repo, by name.

Two hard constraints shaped the design:

1. **A different credential is required.** Reading org/suborg/repo config and
   resolving repos can use the normal per-installation Octokit client. But
   **mutating an app's installation repository access** requires an Octokit
   client authenticated as the App at the **enterprise** level, using the
   [Enterprise Organization Installations API][ent-api] (permission:
   *Enterprise organization installations*).
2. **Drift.** Humans can change an app's repo access outside safe-settings, so
   we want to detect and revert that drift.

We also want the design to accommodate **future non-repo targets** (e.g.,
Copilot policies) without another ground-up rewrite.

## Decision

Add an `app_installations` plugin plus supporting infrastructure, wired into
the existing sync pipeline as a **separate phase**.

### Configuration shape

```yaml
# settings.yml (org level) — implies "all repos"
app_installations:
  - app_slug: copilot
  - app_slug: dependabot

# suborgs/team-a.yml — repos selected by this suborg's criteria
app_installations:
  - app_slug: copilot

# repos/my-repo.yml — this specific repo
app_installations:
  - app_slug: copilot
```

### Components

| Component | Responsibility |
| --- | --- |
| `lib/plugins/appInstallations.js` | Reconcile desired vs. live repo access per app (`syncDelta` / `syncFull`). Not `Diffable` — app installations are an org-scoped target, not a per-repo list. |
| `lib/appOctokitClient.js` | Enterprise-level App client for the Enterprise Organization Installations API. |
| `lib/repoSelector.js` | Resolve a repo set from **fixed** criteria: name, team, custom properties, or "all". |
| `lib/settings.js` | `syncAppInstallations` phase; delta computation from changed configs; full desired-state computation. |
| `index.js` | Enterprise-client enrichment on the context; `installation_target` webhook handler. |

### Sync model: delta vs. full

- **Delta (`syncSelectedRepos`, push events)**: only apps that appear in
  **changed** config files are "marked for change". For each changed
  suborg/repo file we compute, per app:
  - `repository_selection` — repos to **add**,
  - `repository_unselection` — repos to **remove** (by diffing the previous
    `baseRef` version of *that one file* — one extra fetch, reusing the existing
    "removed from suborg targeting" pattern).

  Apps configured with org-level "all" are **not** handled in delta mode; they
  are managed only by full sync.

- **Full (`syncAll`, cron/manual)**: recompute the complete desired state for
  every managed app across all config layers and reconcile against live API
  state. This is the only place the expensive full computation runs, and the
  only path that reconciles drift.

### Enterprise API usage

All mutations go through the org-scoped Enterprise Organization Installations
API (version `2026-03-10`) and operate on repository **names**:

- List installations: `GET /enterprises/{ent}/apps/organizations/{org}/installations`
- List repos: `GET …/installations/{id}/repositories`
- Toggle all/selected: `PATCH …/installations/{id}/repositories`
- Add: `PATCH …/installations/{id}/repositories/add`
- Remove: `PATCH …/installations/{id}/repositories/remove`

Add/remove are capped at **50 repos per call** and are auto-batched.

## Decisions and rationale

1. **Enterprise auth is a prerequisite, not a config knob.**
   safe-settings must already be installed on the enterprise with the
   *Enterprise organization installations* permission. If it is not, the plugin
   surfaces a clear error rather than accepting a separate private-key env var.
   The enterprise slug is read from the webhook payload
   (`payload.enterprise.slug`); the enterprise installation id is discovered via
   `apps.listInstallations` (matching `target_type === 'Enterprise'` &&
   `account.slug === enterprise.slug`) and cached for reuse.

2. **App installation sync is a separate phase**, not folded into `updateOrg()`.
   This keeps repo iteration and app reconciliation independent and easier to
   reason about and disable.

3. **Fixed repo-selection criteria only** (name, team, custom properties, plus
   "all"). No arbitrary Search API queries, to keep behavior predictable and
   reuse existing `getReposForTeam` / `getRepositoriesByProperty` patterns.

4. **Org-level "all" takes precedence** over any suborg/repo-level selection or
   exclusion. If an app is "all" at org level, the installation is toggled to
   `all` and deltas for that app are skipped.

5. **Repository NAMES, not IDs.** The Enterprise Org Installations API accepts
   names, so the plugin no longer resolves names → IDs or enumerates all repos
   for the "all" case (it uses the native toggle instead).

6. **Unselection before selection.** In both delta and full sync, removals are
   applied before additions, so a repo removed by one config layer and added by
   another ends up **present** (net-correct even with transient churn).

7. **Churn skip.** In delta mode, if an app's targeting is unchanged between the
   previous and current versions of a file, it is skipped entirely to avoid
   redundant add/remove writes.

8. **Full-sync `current_selection` awareness.** Full sync reads each
   installation's live `repository_selection` and chooses the minimal action:
   skip when already correct; toggle `all` ↔ `selected`; or diff names and
   remove-then-add when already `selected`. In `additive` mode it never narrows
   an `all` installation.

9. **`disable_plugins` / `additive_plugins` support.** `app_installations`
   participates in the same gating: it can be disabled at any layer, and in
   additive mode it only adds, never removes.

10. **Future target abstraction.** The plugin is structured around a target that
    is *not* a repository, paving the way for future targets (e.g., Copilot
    policies) to reuse the same phase/plumbing without being repo-bound.

## Consequences

### Positive

- App access is now declarative and flows through the existing config hierarchy.
- Delta processing keeps incremental (push-triggered) runs cheap.
- Names-based API + native "all" toggle removes an entire class of ID-resolution
  and enumeration work.
- Batching respects the 50-repo API limit transparently.

### Negative / limitations

- **Managed-app drift relies on the scheduled full sync.** An app only receives
  `installation` repository events for its *own* installation, so there is no
  webhook that reports drift on *other* managed apps. The
  `installation.repositories_added/removed` handler was intentionally **removed**
  because it could not detect managed-app drift; only `installation_target` is
  retained. Drift on managed apps is reconciled on the next cron full sync.
- **Multi-suborg overlap can briefly churn** in delta mode (a repo may be
  removed then re-added within a run). The unselection-before-selection ordering
  guarantees the net end state is correct.
- Requires an enterprise-level installation with the specific permission; orgs
  not on enterprise cannot use the plugin.

## Alternatives considered

- **Enumerate all repos and add them individually for the "all" case** —
  rejected in favor of the API's native `repository_selection: all` toggle
  (fewer calls, no drift from newly created repos).
- **Arbitrary Search API queries for repo selection** — rejected for now in
  favor of a fixed, predictable criteria set.
- **Suborg exclusions overriding org "all"** — rejected; org "all" takes
  precedence to keep the mental model simple.
- **A dedicated private-key env var for enterprise auth** — rejected in favor of
  reusing the existing app credentials and treating enterprise installation as a
  prerequisite.

[ent-api]: https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/organization-installations?apiVersion=2026-03-10
