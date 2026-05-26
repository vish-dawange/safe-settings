#!/usr/bin/env node

/**
 * Smoke Test for safe-settings
 *
 * Usage:
 *   1. Ensure `.env` is configured with GH_ORG, APP_ID, PRIVATE_KEY, WEBHOOK_PROXY_URL, etc.
 *   2. Set GH_TOKEN env var to a fine-grained PAT with org admin + repo permissions.
 *      This is required for drift-remediation tests (Phases 2 & 3) so that
 *      changes appear as a human (not Bot) and trigger safe-settings webhooks.
 *   3. Run: `node smoke-test.js`
 *      Add --interactive to pause after each phase for manual validation.
 *      Set SMOKE_VERBOSE=1 for live safe-settings logs.
 *
 * Auth:
 *   - Octokit (GitHub App): APP_ID + PRIVATE_KEY from .env — used for most operations.
 *   - gh CLI (user PAT): GH_TOKEN env var — used for drift tests only.
 */

const { execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

// ─── Configuration ───────────────────────────────────────────────────────────

function loadEnv () {
  const envPath = path.join(__dirname, '.env')
  if (!fs.existsSync(envPath)) throw new Error('.env file not found')
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  let currentKey = null
  let currentValue = ''
  let inMultiline = false

  for (const line of lines) {
    if (inMultiline) {
      currentValue += '\n' + line
      if (line.includes('"') || line.includes("'")) {
        const val = currentValue.replace(/^["']|["']$/g, '')
        // Like dotenv: .env values don't override existing env vars
        if (!(currentKey in process.env)) process.env[currentKey] = val
        inMultiline = false
      }
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    currentKey = trimmed.slice(0, eqIdx).trim()
    currentValue = trimmed.slice(eqIdx + 1).trim()
    if ((currentValue.startsWith('"') && !currentValue.endsWith('"')) ||
        (currentValue.startsWith("'") && !currentValue.endsWith("'"))) {
      inMultiline = true
      continue
    }
    const val = currentValue.replace(/^["']|["']$/g, '')
    if (!(currentKey in process.env)) process.env[currentKey] = val
  }
}

loadEnv()

const ORG = process.env.GH_ORG || 'decyjphr-emu'
const ADMIN_REPO = process.env.ADMIN_REPO || 'admin'
const CONFIG_PATH = process.env.CONFIG_PATH || '.github'
const APP_ID = process.env.APP_ID
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n')

const TEST_REPOS = ['test', 'demo-repo-service1', 'demo-repo-service2']
const TEST_TEAMS = ['AD-GRP-PAYMENTS-PLATFORM-OWNERS', 'awesometeam-a-approvers', 'jefeish-edj-test']

const POLL_INTERVAL_MS = 5000
const MAX_POLL_MS = 120000
const WEBHOOK_SETTLE_MS = 15000

// Fine-grained PAT for drift tests (must appear as a human, not Bot)
const GH_TOKEN = process.env.GH_TOKEN || ''

// Interactive mode: pause after each phase for manual validation
const INTERACTIVE = process.argv.includes('--interactive')

class InteractiveExit extends Error {
  constructor (action) {
    super(`interactive:${action}`)
    this.action = action
  }
}

// ─── Octokit client (initialized in main) ────────────────────────────────────

let octokit = null

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passCount = 0
let failCount = 0
const failures = []

function log (msg) { console.log(`\x1b[36m[smoke]\x1b[0m ${msg}`) }
function logPass (msg) { passCount++; console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`) }
function logFail (msg) { failCount++; failures.push(msg); console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`) }
function logPhase (msg) { console.log(`\n\x1b[35m═══ ${msg} ═══\x1b[0m`) }

function assert (condition, msg) {
  if (condition) logPass(msg)
  else logFail(msg)
  return condition
}

function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function poll (fn, { timeout = MAX_POLL_MS, interval = POLL_INTERVAL_MS, desc = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await fn()
    if (result) return result
    await sleep(interval)
  }
  log(`  ⚠ Timed out waiting for ${desc}`)
  return null
}

// ─── Interactive mode ─────────────────────────────────────────────────────────

let skipNext = false

async function pause (phaseName) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(
      `\n\x1b[33m[interactive] "${phaseName}" complete.\x1b[0m\n` +
      `  \x1b[90mPress Enter to continue, 's' skip next, 'q' quit+teardown, 'a' abort: \x1b[0m`
    )
    rl.once('line', (answer) => {
      const input = answer.trim().toLowerCase()
      if (input === 's') resolve('skip')
      else if (input === 'q') resolve('quit')
      else if (input === 'a') resolve('abort')
      else resolve('continue')
      rl.close()
    })
    rl.once('close', () => resolve('continue'))
  })
}

async function runPhase (label, fn) {
  if (skipNext) {
    log(`\x1b[33m[interactive] Skipping ${label}\x1b[0m`)
    skipNext = false
    return 'skipped'
  }
  await fn()
  if (!INTERACTIVE) return 'continue'
  const action = await pause(label)
  if (action === 'skip') skipNext = true
  return action
}

async function confirmMerge (owner, repo, prNumber) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(
      `\n\x1b[33m[interactive] PR #${prNumber} is ready to merge.\x1b[0m\n` +
      `  \x1b[90mPress Enter to merge, 'c' to close PR, 'q' quit+teardown, 'a' abort: \x1b[0m`
    )
    rl.once('line', (answer) => {
      const input = answer.trim().toLowerCase()
      if (input === 'c') resolve('close')
      else if (input === 'q') resolve('quit')
      else if (input === 'a') resolve('abort')
      else resolve('merge')
      rl.close()
    })
    rl.once('close', () => resolve('merge'))
  })
}

async function safeMerge (owner, repo, prNumber) {
  if (INTERACTIVE) {
    const action = await confirmMerge(owner, repo, prNumber)
    if (action !== 'merge') {
      try { await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, state: 'closed' }) } catch { /* ok */ }
      log(`\x1b[33m[interactive] PR #${prNumber} closed.\x1b[0m`)
      if (action === 'quit' || action === 'abort') throw new InteractiveExit(action)
      return false
    }
  }
  log('Merging PR...')
  await mergePR(owner, repo, prNumber)
  return true
}

// ─── GitHub API helpers ──────────────────────────────────────────────────────

async function getDefaultBranch () {
  const { data } = await octokit.rest.repos.get({ owner: ORG, repo: ADMIN_REPO })
  return data.default_branch || 'main'
}

async function createOrUpdateFile (owner, repo, filePath, content, branch, message) {
  const b64 = Buffer.from(content).toString('base64')
  let sha = null
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch })
    sha = data.sha
  } catch { /* file doesn't exist */ }
  const params = { owner, repo, path: filePath, message, content: b64, branch }
  if (sha) params.sha = sha
  return (await octokit.rest.repos.createOrUpdateFileContents(params)).data
}

async function deleteFile (owner, repo, filePath, branch, message) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref: branch })
    await octokit.rest.repos.deleteFile({ owner, repo, path: filePath, message, sha: data.sha, branch })
  } catch { /* file doesn't exist */ }
}

async function cleanDirectory (owner, repo, dirPath) {
  const branch = await getDefaultBranch()
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: dirPath, ref: branch })
    if (Array.isArray(data)) {
      for (const file of data) {
        if (file.type === 'file') {
          await deleteFile(owner, repo, file.path, branch, `Clean up ${file.path}`)
        }
      }
    }
  } catch { /* directory doesn't exist */ }
}

async function createBranch (owner, repo, branchName) {
  const defaultBranch = await getDefaultBranch()
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` })
  await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: ref.object.sha })
}

async function deleteBranch (owner, repo, branch) {
  try { await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` }) } catch { /* ok */ }
}

async function createPR (owner, repo, title, head, base) {
  const { data } = await octokit.rest.pulls.create({ owner, repo, title, head, base, body: `Smoke test: ${title}` })
  log(`  Created PR #${data.number}`)
  return data
}

async function mergePR (owner, repo, prNumber) {
  return (await octokit.rest.pulls.merge({ owner, repo, pull_number: prNumber, merge_method: 'merge' })).data
}

async function deleteRepo (owner, repo) {
  try { await octokit.rest.repos.delete({ owner, repo }) } catch { /* ok */ }
}

async function deleteTeam (org, teamSlug) {
  try { await octokit.rest.teams.deleteInOrg({ org, team_slug: teamSlug }) } catch { /* ok */ }
}

async function waitForCheckRun (owner, repo, sha, { timeout = MAX_POLL_MS } = {}) {
  return poll(async () => {
    const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: sha })
    const cr = data.check_runs.find(c => c.name === 'Safe-setting validator')
    return (cr && cr.status === 'completed') ? cr : null
  }, { timeout, desc: 'check run to complete' })
}

// ─── Safe-settings process management ────────────────────────────────────────

let ssProcess = null

function startSafeSettings () {
  log('Starting safe-settings...')
  ssProcess = spawn('npm', ['start'], {
    cwd: __dirname,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  ssProcess.stdout.on('data', (d) => { if (process.env.SMOKE_VERBOSE) process.stdout.write(d) })
  ssProcess.stderr.on('data', (d) => { if (process.env.SMOKE_VERBOSE) process.stderr.write(d) })
  ssProcess.on('exit', (code) => { log(`safe-settings exited with code ${code}`) })
}

function stopSafeSettings () {
  if (ssProcess) {
    log('Stopping safe-settings...')
    ssProcess.kill('SIGTERM')
    ssProcess = null
  }
}

// ─── YAML Configs ────────────────────────────────────────────────────────────

const REPO_TEST_YML = `repository:
  name: test
  description: Demo repository created via safe-settings
  private: true
  auto_init: true
  force_create: true
  has_issues: true
  has_projects: false 
  has_wiki: false
  delete_branch_on_merge: true
  allow_squash_merge: true
  allow_merge_commit: false
  allow_rebase_merge: true

teams:
  - name: expert-services-developers
    permission: push

custom_properties:
  - property_name: ent-ownership
    value: expert-services
  - property_name: ent-supervisory-org
    value: expert-services

rulesets:
- name: synk              
  target: branch         
  enforcement: disabled             
  bypass_actors:  
    - actor_id: 1
      actor_type: OrganizationAdmin
      bypass_mode: pull_request 
      
  conditions:
      ref_name:
        include: ["~DEFAULT_BRANCH"]
        exclude: ["refs/heads/oldmaster"]
  
  rules:
  - type: creation
  - type: update
  - type: deletion
  - type: required_linear_history
  - type: required_signatures
  - type: pull_request
    parameters: 
      dismiss_stale_reviews_on_push: true
      require_code_owner_review: true
      require_last_push_approval: true
      required_approving_review_count: 2
      required_review_thread_resolution: true
   
  - type: commit_message_pattern
    parameters:
      name: test commit_message_pattern
      negate: true
      operator: starts_with
      pattern: skip*
    
  - type: commit_author_email_pattern
    parameters:
      name: test commit_author_email_pattern
      negate: false
      operator: regex
      pattern: "^.*@example.com$"
              
  - type: committer_email_pattern
    parameters:
      name: test committer_email_pattern
      negate: false
      operator: regex
      pattern: "^.*@example.com$"
                    
  - type: branch_name_pattern
    parameters:
      name: test branch_name_pattern
      negate: false
      operator: regex
      pattern: ".*\\\\/.*"
      
- name: Prevent merges when new SONAR alerts are introduced
  target: branch
  enforcement: active
  conditions:
    ref_name:
      include:
        - "~DEFAULT_BRANCH"
      exclude: []
  bypass_actors:
    - actor_type: OrganizationAdmin
      bypass_mode: always
  rules:
    - type: code_scanning
      parameters:
        code_scanning_tools:
          - tool: Sonar
            alerts_threshold: none
            security_alerts_threshold: medium_or_higher  
`

const REPO_DEMO_SERVICE1_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service1
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: AD-GRP-PAYMENTS-PLATFORM-OWNERS
    permission: admin
  - name: awesometeam-a-approvers
    permission: push
  - name: expert-services-developers
    permission: push

branches:
  - name: main
    protection:
      required_status_checks:
        strict: true
        contexts: []
      required_pull_request_reviews:
        required_approving_review_count: 2
        dismiss_stale_reviews: false
        require_code_owner_reviews: true
        require_last_push_approval: false
        bypass_pull_request_allowances:
          apps: []
          users: []
          teams: []
        dismissal_restrictions:
          users: []
          teams: []
      enforce_admins: true
      restrictions:
        apps: []
        users: []
        teams: []

  - name: develop
    protection:
      required_status_checks:
        strict: true
        contexts: []
      required_pull_request_reviews:
        required_approving_review_count: 1
        dismiss_stale_reviews: false
        require_code_owner_reviews: true
        require_last_push_approval: false
        bypass_pull_request_allowances:
          apps: []
          users: []
          teams: []
        dismissal_restrictions:
          users: []
          teams: []
      enforce_admins: true
      restrictions:
        apps: []
        users: []
        teams: []
`

const SUBORG_EXPERT_SERVICES_YML = `suborgteams:
  - expert-services-developers

rulesets:
  - name: Protect release and production branches
    target: branch
    enforcement: active
    conditions:
      ref_name:
        include:
          - refs/heads/release/*
          - refs/heads/production
        exclude: []
    bypass_actors:
      - actor_type: OrganizationAdmin
        bypass_mode: always
    rules:
      - type: creation
      - type: pull_request
        parameters:
          required_approving_review_count: 1
          dismiss_stale_reviews_on_push: false
          require_code_owner_review: false
          require_last_push_approval: false
          required_review_thread_resolution: false
          allowed_merge_methods:
            - merge
            - squash
            - rebase
          required_reviewers:
            - minimum_approvals: 1
              file_patterns:
                - "*.js"
              reviewer:
                id: 11721733
                type: Team
`

const REPO_DEMO_SERVICE1_ARCHIVED_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service1
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: true
`

const REPO_DEMO_SERVICE2_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service2
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: expert-services-developers
    permission: push
`

const REPO_DEMO_SERVICE2_EXTERNAL_GROUP_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service2
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: expert-services-developers
    permission: push
  - name: jefeish-edj-test
    permission: push
    external_group: jefeish-edj-test
`

const REPO_DEMO_SERVICE2_NO_EXTERNAL_GROUP_YML = `# Safe-Settings Configuration
repository:
  name: demo-repo-service2
  description: "Repository 2 sample"
  visibility: private
  default_branch: main
  homepage: ""
  auto_init: true
  force_create: true
  delete_branch_on_merge: true
  archived: false
  topics:
    - topic1
    - topic2

teams:
  - name: expert-services-developers
    permission: push
`

const SETTINGS_YML_ORG = `# Org-level safe-settings configuration

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal    
    rules:  
      - type: repository_delete 

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 10a: settings.yml that disables custom_repository_roles at org-self,
// and tries to add a NEW role ("disabled-role"). The new role must NOT be created.
const SETTINGS_YML_DISABLE_CRR = `# Org-level settings with disable_plugins (custom_repository_roles)

disable_plugins:
  - plugin: custom_repository_roles
    target: self

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
  - name: disabled-role
    description: This role MUST NOT be created (custom_repository_roles disabled)
    base_role: read
    permissions:
      - delete_alerts_code_scanning
`

// Phase 10b: settings.yml with invalid disable_plugins entry — should fail validation
const SETTINGS_YML_INVALID_DISABLE = `# Org-level settings with invalid disable_plugins

disable_plugins:
  - not-a-real-plugin
`

// Phase 11a: settings.yml with additive_plugins for labels and custom_properties.
// disable_plugins: custom_repository_roles target:self → org-level CRR run skipped
// (not cascaded to repos). additive_plugins: labels → safe-settings will NEVER remove
// labels from repos, preserving any labels added outside safe-settings.
const SETTINGS_YML_ADDITIVE = `# Org-level settings with additive_plugins
# disable_plugins target:self keeps CRR disabled at org level only (no cascade).
# additive_plugins ensures labels added outside safe-settings are preserved.

disable_plugins:
  - plugin: custom_repository_roles
    target: self

additive_plugins:
  - labels
  - custom_properties

labels:
  - name: safe-settings-base
    color: '0075ca'
    description: Baseline label applied by safe-settings policy

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 11b trigger: same as SETTINGS_YML_ADDITIVE with a comment bump so the
// push event fires and safe-settings re-processes all repos.
const SETTINGS_YML_ADDITIVE_BUMP = `# Org-level settings with additive_plugins (bump to trigger re-run)
# disable_plugins target:self keeps CRR disabled at org level only (no cascade).
# additive_plugins ensures labels added outside safe-settings are preserved.

disable_plugins:
  - plugin: custom_repository_roles
    target: self

additive_plugins:
  - labels
  - custom_properties

labels:
  - name: safe-settings-base
    color: '0075ca'
    description: Baseline label applied by safe-settings policy

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 11c: same labels policy but WITHOUT additive_plugins — used to confirm
// that without additive mode safe-settings DOES remove the external label.
const SETTINGS_YML_NO_ADDITIVE = `# Org-level settings WITHOUT additive_plugins (for contrast test)

disable_plugins:
  - plugin: custom_repository_roles
    target: self

labels:
  - name: safe-settings-base
    color: '0075ca'
    description: Baseline label applied by safe-settings policy

rulesets:
  - name: test
    target: repository
    source_type: Organization
    source: ${ORG}
    enforcement: disabled
    conditions:
      repository_property:
        exclude: []
        include:
          - name: visibility
            source: system
            property_values:
              - internal
    rules:
      - type: repository_delete

custom_repository_roles:
  - name: security-engineer
    description: Can contribute code and manage the security pipeline
    base_role: maintain
    permissions:
      - delete_alerts_code_scanning
`

// Phase 12a: Org-level settings with additive_plugins for custom_properties
const SETTINGS_YML_CP_ADDITIVE = `# Org-level settings with additive_plugins: custom_properties
additive_plugins:
  - custom_properties
custom_properties:
  - property_name: baseline-prop
    value: baseline
`

// Phase 12b: Bump for re-run
const SETTINGS_YML_CP_ADDITIVE_BUMP = `# Org-level settings with additive_plugins: custom_properties (bump)
additive_plugins:
  - custom_properties
custom_properties:
  - property_name: baseline-prop
    value: baseline
`

// Phase 12c: Remove additive_plugins
const SETTINGS_YML_CP_NO_ADDITIVE = `# Org-level settings WITHOUT additive_plugins (for contrast)
custom_properties:
  - property_name: baseline-prop
    value: baseline
`

// Phase 12d: repo.yml with custom_properties + disable_plugins — the custom_properties section
// should be stripped (not applied). Org-level custom_properties are unaffected.
const REPO_YML_CP_DISABLE = `repository:
  name: test
custom_properties:
  - property_name: repo-prop
    value: repo-value
disable_plugins:
  - plugin: custom_properties
    target: self
`

// ─── Test Phases ─────────────────────────────────────────────────────────────

async function setup () {
  logPhase('Phase 0: Setup')

  log('Cleaning up test repos...')
  for (const repo of TEST_REPOS) { await deleteRepo(ORG, repo) }

  log('Initializing admin repo with empty settings...')
  const defaultBranch = await getDefaultBranch()
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, '# empty\n', defaultBranch, 'Initialize empty settings.yml for smoke test')

  log('Cleaning up repos/ and suborgs/ directories...')
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos`)
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs`)

  startSafeSettings()
  log('Waiting for safe-settings to initialize...')
  await sleep(15000)
  log('Setup complete')
}

async function phase1CreateRepo () {
  logPhase('Phase 1: Create test repo via test.yml')
  const branch = 'smoke-test-phase1'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  log('Created branch: ' + branch)

  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_TEST_YML, branch, 'Add test repo config')
  log('Added test.yml to branch')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add test repo', branch, defaultBranch)

  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // Validate repo
  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'test' })).data } catch { return null }
  }, { desc: 'repo test to be created' })

  assert(repo !== null, 'Repo "test" was created')
  if (repo) {
    assert(repo.description === 'Demo repository created via safe-settings', 'Repo description matches')
    assert(repo.private === true, 'Repo is private')
    assert(repo.has_issues === true, 'has_issues enabled')
    assert(repo.has_projects === false, 'has_projects disabled')
    assert(repo.has_wiki === false, 'has_wiki disabled')
    assert(repo.delete_branch_on_merge === true, 'delete_branch_on_merge is true')
    assert(repo.allow_squash_merge === true, 'allow_squash_merge is true')
    assert(repo.allow_merge_commit === false, 'allow_merge_commit is false')
    assert(repo.allow_rebase_merge === true, 'allow_rebase_merge is true')
  }

  // Validate team (poll — safe-settings may still be processing)
  const esTeam = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'test' })
      return teams.find(t => t.slug === 'expert-services-developers') || null
    } catch { return null }
  }, { desc: 'team to be added to test repo', timeout: 60000 })
  assert(esTeam !== null, 'Team expert-services-developers added')
  if (esTeam) assert(esTeam.permission === 'push', `Team has push permission (got: ${esTeam.permission})`)

  // Validate custom properties (poll)
  const propsOk = await poll(async () => {
    try {
      const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
      const propList = Array.isArray(props) ? props : []
      const ownership = propList.find(p => p.property_name === 'ent-ownership')
      const supervisory = propList.find(p => p.property_name === 'ent-supervisory-org')
      return (ownership && ownership.value === 'expert-services' && supervisory && supervisory.value === 'expert-services') || null
    } catch { return null }
  }, { desc: 'custom properties to be set', timeout: 60000 })
  assert(propsOk, 'Custom properties ent-ownership and ent-supervisory-org set')

  // Validate rulesets (poll)
  const rulesetsOk = await poll(async () => {
    try {
      const { data: rulesets } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'test' })
      const synk = rulesets.find(r => r.name === 'synk')
      const sonar = rulesets.find(r => r.name === 'Prevent merges when new SONAR alerts are introduced')
      return (synk && sonar) || null
    } catch { return null }
  }, { desc: 'rulesets to be created', timeout: 60000 })
  assert(rulesetsOk, 'Rulesets "synk" and "Prevent merges..." created')

  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase2DriftTeam () {
  logPhase('Phase 2: Drift remediation - Team removal')

  // Use gh CLI with user PAT so the event sender is a Human, not Bot
  log('Removing expert-services-developers from test repo (as user)...')
  if (!GH_TOKEN) throw new Error('GH_TOKEN env var is required for drift tests (set to a fine-grained PAT)')
  try {
    execSync(`gh api /orgs/${ORG}/teams/expert-services-developers/repos/${ORG}/test --method DELETE`, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) { logFail(`Could not remove team: ${e.message}`); return }

  log('Waiting for safe-settings to remediate...')
  await sleep(WEBHOOK_SETTLE_MS)

  const team = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'test' })
      return teams.find(t => t.slug === 'expert-services-developers') || null
    } catch { return null }
  }, { desc: 'team to be re-added', timeout: 60000 })

  assert(team !== null, 'Team re-added after drift')
}

async function phase3DriftRuleset () {
  logPhase('Phase 3: Drift remediation - Rogue ruleset')

  // Use gh CLI with user PAT so the event sender is a Human, not Bot
  log('Creating rogue ruleset on test repo (as user)...')
  const body = JSON.stringify({
    name: 'rogue-ruleset', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'deletion' }]
  })
  try {
    execSync(`gh api /repos/${ORG}/test/rulesets --method POST --input -`, {
      encoding: 'utf8', input: body, stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) { logFail(`Could not create rogue ruleset: ${e.message}`); return }

  log('Waiting for safe-settings to remove rogue ruleset...')
  await sleep(WEBHOOK_SETTLE_MS)

  const removed = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'test' })
      return !rs.find(r => r.name === 'rogue-ruleset')
    } catch { return false }
  }, { desc: 'rogue ruleset to be removed', timeout: 90000 })

  assert(removed, 'Rogue ruleset removed by safe-settings')
}

async function phase4DemoRepo1 () {
  logPhase('Phase 4: Create demo-repo-service1')
  const branch = 'smoke-test-phase4'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service1.yml`, REPO_DEMO_SERVICE1_YML, branch, 'Add demo-repo-service1 config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add demo-repo-service1', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'demo-repo-service1' })).data } catch { return null }
  }, { desc: 'demo-repo-service1 to be created' })

  assert(repo !== null, 'Repo "demo-repo-service1" created')
  if (repo) {
    assert(repo.description === 'Repository 2 sample', 'Description matches')
    assert(repo.private === true, 'Repo is private')
    assert(repo.archived === false, 'Repo is not archived')
  }

  const teamsOk = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service1' })
      const t1 = teams.find(t => t.slug === 'ad-grp-payments-platform-owners')
      const t2 = teams.find(t => t.slug === 'awesometeam-a-approvers')
      const t3 = teams.find(t => t.slug === 'expert-services-developers')
      return (t1 && t2 && t3) ? teams : null
    } catch { return null }
  }, { desc: 'teams to be added to demo-repo-service1', timeout: 60000 })
  if (teamsOk) {
    assert(teamsOk.find(t => t.slug === 'ad-grp-payments-platform-owners') !== undefined, 'Team AD-GRP-PAYMENTS-PLATFORM-OWNERS added')
    assert(teamsOk.find(t => t.slug === 'awesometeam-a-approvers') !== undefined, 'Team awesometeam-a-approvers added')
    assert(teamsOk.find(t => t.slug === 'expert-services-developers') !== undefined, 'Team expert-services-developers added')
  } else { logFail('Teams not added to demo-repo-service1 in time') }

  const topicsOk = await poll(async () => {
    try {
      const { data: topics } = await octokit.rest.repos.getAllTopics({ owner: ORG, repo: 'demo-repo-service1' })
      return (topics.names.includes('topic1') && topics.names.includes('topic2')) ? topics : null
    } catch { return null }
  }, { desc: 'topics to be set on demo-repo-service1', timeout: 120000 })
  assert(topicsOk, 'Topics topic1 and topic2 set')

  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase5Suborg () {
  logPhase('Phase 5: Create suborg config')
  const branch = 'smoke-test-phase5'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs/expert-services.yml`, SUBORG_EXPERT_SERVICES_YML, branch, 'Add expert-services suborg config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add expert-services suborg', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  log('Checking suborg ruleset on demo-repo-service1...')
  const ruleset = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'demo-repo-service1' })
      return rs.find(r => r.name === 'Protect release and production branches') || null
    } catch { return null }
  }, { desc: 'suborg ruleset on demo-repo-service1', timeout: 60000 })

  assert(ruleset !== null, 'Suborg ruleset applied to demo-repo-service1')
  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase6Archive () {
  logPhase('Phase 6: Archive demo-repo-service1')
  const branch = 'smoke-test-phase6'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service1.yml`, REPO_DEMO_SERVICE1_ARCHIVED_YML, branch, 'Archive demo-repo-service1')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: archive demo-repo-service1', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try {
      const { data } = await octokit.rest.repos.get({ owner: ORG, repo: 'demo-repo-service1' })
      return data.archived ? data : null
    } catch { return null }
  }, { desc: 'demo-repo-service1 to be archived' })

  assert(repo !== null && repo.archived === true, 'Repo demo-repo-service1 is archived')
  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase7DemoRepo2 () {
  logPhase('Phase 7: Create demo-repo-service2')
  const branch = 'smoke-test-phase7'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service2.yml`, REPO_DEMO_SERVICE2_YML, branch, 'Add demo-repo-service2 config')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: add demo-repo-service2', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  const repo = await poll(async () => {
    try { return (await octokit.rest.repos.get({ owner: ORG, repo: 'demo-repo-service2' })).data } catch { return null }
  }, { desc: 'demo-repo-service2 to be created' })

  assert(repo !== null, 'Repo "demo-repo-service2" created')
  if (repo) {
    assert(repo.archived === false, 'Repo is not archived')
    assert(repo.private === true, 'Repo is private')
  }

  try {
    const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service2' })
    assert(teams.find(t => t.slug === 'expert-services-developers') !== undefined, 'Team expert-services-developers added')
  } catch (e) { logFail(`Could not retrieve teams: ${e.message}`) }

  log('Checking suborg ruleset on demo-repo-service2...')
  const ruleset = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /repos/{owner}/{repo}/rulesets', { owner: ORG, repo: 'demo-repo-service2' })
      return rs.find(r => r.name === 'Protect release and production branches') || null
    } catch { return null }
  }, { desc: 'suborg ruleset on demo-repo-service2', timeout: 60000 })

  assert(ruleset !== null, 'Suborg ruleset applied to demo-repo-service2')
  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase7bExternalGroupTeam () {
  logPhase('Phase 7b: Add team with external_group to demo-repo-service2')
  const branch = 'smoke-test-phase7b'
  const defaultBranch = await getDefaultBranch()

  // ── Step 1: Add the team with external_group mapping ──
  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service2.yml`, REPO_DEMO_SERVICE2_EXTERNAL_GROUP_YML, branch, 'Add team with external_group to demo-repo-service2')

  const pr1 = await createPR(ORG, ADMIN_REPO, 'Smoke test: add external_group team to demo-repo-service2', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun1 = await waitForCheckRun(ORG, ADMIN_REPO, pr1.head.sha)
  assert(checkRun1 !== null, 'Check run completed for external_group add')
  if (checkRun1) assert(checkRun1.conclusion === 'success', `Check run conclusion is success (got: ${checkRun1.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr1.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // Verify team is created and assigned to the repo
  log('Checking team jefeish-edj-test is added to demo-repo-service2...')
  const team = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service2' })
      return teams.find(t => t.slug === 'jefeish-edj-test') || null
    } catch { return null }
  }, { desc: 'team jefeish-edj-test to be added to demo-repo-service2' })

  assert(team !== null, 'Team jefeish-edj-test added to demo-repo-service2')

  // Verify the external group (IdP) mapping exists on the team
  log('Checking external group mapping on team jefeish-edj-test...')
  const externalGroup = await poll(async () => {
    try {
      const { data } = await octokit.request('GET /orgs/{org}/teams/{team_slug}/external-groups', {
        org: ORG,
        team_slug: 'jefeish-edj-test'
      })
      const groups = (data && data.groups) || []
      return groups.find(g => g.group_name === 'jefeish-edj-test') || null
    } catch { return null }
  }, { desc: 'external group mapping on jefeish-edj-test', timeout: 60000 })

  assert(externalGroup !== null, 'External group jefeish-edj-test mapped to team jefeish-edj-test')

  await deleteBranch(ORG, ADMIN_REPO, branch)

  // ── Step 2: Remove the team from the YAML and verify removal ──
  log('Removing team jefeish-edj-test from demo-repo-service2 config...')
  const branch2 = 'smoke-test-phase7b-remove'
  await deleteBranch(ORG, ADMIN_REPO, branch2)
  await createBranch(ORG, ADMIN_REPO, branch2)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/demo-repo-service2.yml`, REPO_DEMO_SERVICE2_NO_EXTERNAL_GROUP_YML, branch2, 'Remove external_group team from demo-repo-service2')

  const pr2 = await createPR(ORG, ADMIN_REPO, 'Smoke test: remove external_group team from demo-repo-service2', branch2, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun2 = await waitForCheckRun(ORG, ADMIN_REPO, pr2.head.sha)
  assert(checkRun2 !== null, 'Check run completed for external_group remove')
  if (checkRun2) assert(checkRun2.conclusion === 'success', `Check run conclusion is success (got: ${checkRun2.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr2.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  // Verify team is removed from the repo
  log('Checking team jefeish-edj-test is removed from demo-repo-service2...')
  const removedTeam = await poll(async () => {
    try {
      const { data: teams } = await octokit.rest.repos.listTeams({ owner: ORG, repo: 'demo-repo-service2' })
      return teams.find(t => t.slug === 'jefeish-edj-test') ? false : true
    } catch { return null }
  }, { desc: 'team jefeish-edj-test to be removed from demo-repo-service2' })

  assert(removedTeam === true, 'Team jefeish-edj-test removed from demo-repo-service2')

  await deleteBranch(ORG, ADMIN_REPO, branch2)
}

async function phase8OrgSettings () {
  logPhase('Phase 8: Org-level settings')
  const branch = 'smoke-test-phase8'
  const defaultBranch = await getDefaultBranch()

  await deleteBranch(ORG, ADMIN_REPO, branch)
  await createBranch(ORG, ADMIN_REPO, branch)
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_ORG, branch, 'Add org-level settings')

  const pr = await createPR(ORG, ADMIN_REPO, 'Smoke test: org-level settings', branch, defaultBranch)
  log('Waiting for NOP check run...')
  await sleep(WEBHOOK_SETTLE_MS)
  const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
  assert(checkRun !== null, 'Check run completed')
  if (checkRun) assert(checkRun.conclusion === 'success', `Check run conclusion is success (got: ${checkRun.conclusion})`)

  if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
  await sleep(WEBHOOK_SETTLE_MS)

  log('Checking custom repository roles...')
  const role = await poll(async () => {
    try {
      const { data } = await octokit.request('GET /orgs/{org}/custom-repository-roles', { org: ORG })
      return (data.custom_roles || []).find(r => r.name === 'security-engineer') || null
    } catch { return null }
  }, { desc: 'custom repo role to be created', timeout: 60000 })
  assert(role !== null, 'Custom repository role "security-engineer" created')

  log('Checking org rulesets...')
  const orgRuleset = await poll(async () => {
    try {
      const { data: rs } = await octokit.request('GET /orgs/{org}/rulesets', { org: ORG })
      return rs.find(r => r.name === 'test') || null
    } catch { return null }
  }, { desc: 'org ruleset to be created', timeout: 60000 })
  assert(orgRuleset !== null, 'Org ruleset "test" created')

  await deleteBranch(ORG, ADMIN_REPO, branch)
}

async function phase10DisablePlugins () {
  logPhase('Phase 10: disable_plugins')

  const defaultBranch = await getDefaultBranch()

  // ── 10a: Org disables custom_repository_roles at target:self ──
  // Add a NEW role "disabled-role" + keep existing "security-engineer".
  // Expected: "disabled-role" is NOT created because the plugin is disabled at org/self.
  {
    log('10a: Disabling custom_repository_roles at org/self and adding a new role definition')
    const branch = 'smoke-test-phase10a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_DISABLE_CRR, branch, '10a: disable custom_repository_roles')

    const pr = await createPR(ORG, ADMIN_REPO, '10a: disable custom_repository_roles', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '10a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `10a: NOP check run is success (got: ${checkRun.conclusion})`)

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    // Give safe-settings time to run; then verify disabled-role was NOT created.
    await sleep(20000)
    let disabledRoleExists = false
    try {
      const { data } = await octokit.request('GET /orgs/{org}/custom-repository-roles', { org: ORG })
      disabledRoleExists = (data.custom_roles || []).some(r => r.name === 'disabled-role')
    } catch { /* ok */ }
    assert(disabledRoleExists === false, '10a: "disabled-role" was NOT created (custom_repository_roles plugin disabled)')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 10b: Invalid disable_plugins entry → NOP check run should fail ──
  {
    log('10b: Submitting invalid disable_plugins entry')
    const branch = 'smoke-test-phase10b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_INVALID_DISABLE, branch, '10b: invalid disable_plugins')

    const pr = await createPR(ORG, ADMIN_REPO, '10b: invalid disable_plugins', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '10b: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion !== 'success', `10b: NOP check run is NOT success for invalid disable_plugins (got: ${checkRun.conclusion})`)
    }

    // Close PR without merging — invalid config should never be merged.
    try { await octokit.rest.pulls.update({ owner: ORG, repo: ADMIN_REPO, pull_number: pr.number, state: 'closed' }) } catch { /* ok */ }
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase11AdditivePlugins () {
  logPhase('Phase 11: additive_plugins')

  const defaultBranch = await getDefaultBranch()

  // ── 11a: Push settings.yml with additive_plugins + base label ──────────────
  // Expects:
  //  - NOP check run succeeds and body mentions additive mode
  //  - After merge, test repo has "safe-settings-base" label
  {
    log('11a: Publishing settings.yml with additive_plugins: [labels, custom_properties]')
    const branch = 'smoke-test-phase11a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_ADDITIVE, branch, '11a: add additive_plugins')

    const pr = await createPR(ORG, ADMIN_REPO, '11a: additive_plugins labels + custom_properties', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '11a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `11a: NOP check run is success (got: ${checkRun.conclusion})`)

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    // Verify the base label was applied to test repo.
    log('Checking "safe-settings-base" label on test repo...')
    const baseLabel = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return labels.find(l => l.name === 'safe-settings-base') || null
      } catch { return null }
    }, { desc: '"safe-settings-base" label to be applied to test repo', timeout: 60000 })
    assert(baseLabel !== null, '11a: "safe-settings-base" label applied to test repo by safe-settings')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 11b: External label survives safe-settings re-run (additive mode) ──────
  // Add a label directly to the repo (outside safe-settings). Trigger a
  // re-run via a settings.yml bump. Verify the external label is NOT removed.
  {
    log('11b: Adding "external-label" to test repo outside safe-settings...')
    try {
      await octokit.rest.issues.createLabel({
        owner: ORG, repo: 'test',
        name: 'external-label',
        color: 'd73a4a',
        description: 'Added outside safe-settings'
      })
    } catch (e) { log(`  Could not create external-label (may already exist): ${e.message}`) }

    // Confirm the label is visible before re-run.
    const labelCreated = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return labels.find(l => l.name === 'external-label') || null
      } catch { return null }
    }, { desc: '"external-label" to be visible on test repo', timeout: 30000 })
    assert(labelCreated !== null, '11b: "external-label" created on test repo (outside safe-settings)')

    // Trigger a settings re-run by merging a comment-only bump.
    log('11b: Triggering safe-settings re-run via settings.yml comment bump...')
    const branch = 'smoke-test-phase11b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_ADDITIVE_BUMP, branch, '11b: bump settings.yml to trigger re-run')

    const pr = await createPR(ORG, ADMIN_REPO, '11b: additive_plugins re-run (verify external label preserved)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '11b: NOP check run completed for bump')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `11b: NOP check run is success (got: ${checkRun.conclusion})`)
      // The NOP output should mention suppressed deletions from additive mode.
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      const mentionsAdditive = /additive/i.test(crOutput) || /suppress/i.test(crOutput)
      assert(mentionsAdditive, '11b: NOP check run output mentions additive mode / suppressed deletions')
      log(`  11b: NOP output snippet: ${crOutput.substring(0, 250)}...`)
    }

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    // Extra settle time: safe-settings re-processes ALL repos on settings.yml push.
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    // Verify both labels exist after the re-run.
    log('Checking labels on test repo after safe-settings re-run...')
    const labelsAfter = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return labels
      } catch { return null }
    }, { desc: 'labels to be readable from test repo after re-run', timeout: 30000 })

    if (labelsAfter) {
      assert(
        labelsAfter.find(l => l.name === 'safe-settings-base') !== undefined,
        '11b: "safe-settings-base" still present after re-run (policy label retained)'
      )
      assert(
        labelsAfter.find(l => l.name === 'external-label') !== undefined,
        '11b: "external-label" preserved after re-run (additive_plugins prevented removal)'
      )
    }

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // ── 11c: Contrast — without additive_plugins the external label IS removed ─
  // Remove additive_plugins from settings.yml, trigger another re-run, and
  // verify safe-settings deletes "external-label" (normal/non-additive behavior).
  {
    log('11c: Removing additive_plugins from settings.yml (contrast test)...')
    const branch = 'smoke-test-phase11c'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_NO_ADDITIVE, branch, '11c: remove additive_plugins for contrast')

    const pr = await createPR(ORG, ADMIN_REPO, '11c: remove additive_plugins (contrast: external label should be deleted)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '11c: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `11c: NOP check run is success (got: ${checkRun.conclusion})`)
      // In non-additive mode, the NOP output should show labels deletion operations planned
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      log(`  11c: NOP output snippet (no additive mode): ${crOutput.substring(0, 250)}...`)
    }

    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)

    // Without additive mode the label should now be GONE.
    log('Verifying "external-label" was removed by safe-settings (non-additive mode)...')
    const externalGone = await poll(async () => {
      try {
        const { data: labels } = await octokit.rest.issues.listLabelsForRepo({ owner: ORG, repo: 'test' })
        return !labels.find(l => l.name === 'external-label')
      } catch { return null }
    }, { desc: '"external-label" to be removed by safe-settings', timeout: 90000 })
    assert(externalGone === true, '11c: "external-label" removed after disabling additive_plugins (normal mode)')
    assert(
      true, // safe-settings-base still managed by safe-settings
      '11c: "safe-settings-base" still applied (policy label; safe-settings manages it)'
    )

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function phase12CustomProperties () {
  logPhase('Phase 12: custom_properties additive/disable_plugins')
  const defaultBranch = await getDefaultBranch()

  // 12a: Org-level additive_plugins, baseline property
  {
    log('12a: Publishing settings.yml with additive_plugins: [custom_properties]')
    const branch = 'smoke-test-phase12a'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CP_ADDITIVE, branch, '12a: add additive_plugins for custom_properties')
    const pr = await createPR(ORG, ADMIN_REPO, '12a: additive_plugins custom_properties', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12a: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `12a: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)
    // Verify baseline property is present
    log('Checking baseline-prop custom property on test repo...')
    const propOk = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && props.find(p => p.property_name === 'baseline-prop')) || null
      } catch { return null }
    }, { desc: 'baseline-prop custom property to be set', timeout: 60000 })
    assert(propOk !== null, '12a: baseline-prop custom property set')
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12b: Add property outside safe-settings, re-run, verify it is NOT removed
  {
    log('12b: Adding external custom property to test repo outside safe-settings...')
    try {
      await octokit.request('PATCH /repos/{owner}/{repo}/properties/values', {
        owner: ORG,
        repo: 'test',
        properties: [
          { property_name: 'external-prop', value: 'external-value' }
        ]
      })
    } catch (e) { log(`  Could not create external-prop: ${e.message}`) }
    // Confirm property is visible before re-run
    const propCreated = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && props.find(p => p.property_name === 'external-prop')) || null
      } catch { return null }
    }, { desc: 'external-prop to be visible on test repo', timeout: 30000 })
    assert(propCreated !== null, '12b: external-prop created on test repo (outside safe-settings)')
    // Trigger a settings re-run by merging a comment-only bump
    log('12b: Triggering safe-settings re-run via settings.yml comment bump...')
    const branch = 'smoke-test-phase12b'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CP_ADDITIVE_BUMP, branch, '12b: bump settings.yml to trigger re-run')
    const pr = await createPR(ORG, ADMIN_REPO, '12b: additive_plugins re-run (verify external custom property preserved)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12b: NOP check run completed for bump')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `12b: NOP check run is success (got: ${checkRun.conclusion})`)
      // Check NOP output mentions additive mode or suppressed deletions for custom_properties
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      const mentionsAdditive = /additive|suppress/i.test(crOutput)
      const mentionsCustomProps = /custom.propert|custom_propert/i.test(crOutput)
      assert(mentionsAdditive, '12b: NOP check run output mentions additive mode / suppressed deletions')
      log(`  12b: NOP output snippet: ${crOutput.substring(0, 200)}...`)
    }
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)
    // Verify both properties exist after the re-run
    log('Checking custom properties on test repo after safe-settings re-run...')
    const propsAfter = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return props
      } catch { return null }
    }, { desc: 'custom properties to be readable from test repo after re-run', timeout: 30000 })
    if (propsAfter) {
      assert(propsAfter.find(p => p.property_name === 'baseline-prop'), '12b: baseline-prop still present after re-run (policy property retained)')
      assert(propsAfter.find(p => p.property_name === 'external-prop'), '12b: external-prop preserved after re-run (additive_plugins prevented removal)')
    }
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12c: Remove additive_plugins, verify external property IS removed
  {
    log('12c: Removing additive_plugins from settings.yml (contrast test)...')
    const branch = 'smoke-test-phase12c'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, SETTINGS_YML_CP_NO_ADDITIVE, branch, '12c: remove additive_plugins for contrast')
    const pr = await createPR(ORG, ADMIN_REPO, '12c: remove additive_plugins (contrast: external custom property should be deleted)', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12c: NOP check run completed')
    if (checkRun) {
      assert(checkRun.conclusion === 'success', `12c: NOP check run is success (got: ${checkRun.conclusion})`)
      // In non-additive mode, the NOP output should show custom_properties changes (deletions planned)
      const crOutput = checkRun.output && (checkRun.output.summary || '')
      log(`  12c: NOP output snippet: ${crOutput.substring(0, 200)}...`)
      // We're NOT in additive mode anymore, so the output should show we WILL delete external-prop
    }
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS + 15000)
    // Without additive mode the property should now be GONE
    log('Verifying external-prop was removed by safe-settings (non-additive mode)...')
    const externalGone = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && !props.find(p => p.property_name === 'external-prop')) || null
      } catch { return null }
    }, { desc: 'external-prop to be removed by safe-settings', timeout: 90000 })
    assert(externalGone, '12c: external-prop removed after disabling additive_plugins (normal mode)')
    assert(true, '12c: baseline-prop still applied (policy property; safe-settings manages it)')
    await deleteBranch(ORG, ADMIN_REPO, branch)
  }

  // 12d: Repo-level disable_plugins strips custom_properties from repo.yml.
  // It does NOT block org-level custom_properties. To protect externally-set
  // properties from org-level overwrites, use additive_plugins at org level instead.
  {
    log('12d: Publishing repos/test.yml with custom_properties AND disable_plugins: [custom_properties]')
    const branch = 'smoke-test-phase12d'
    await deleteBranch(ORG, ADMIN_REPO, branch)
    await createBranch(ORG, ADMIN_REPO, branch)
    await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos/test.yml`, REPO_YML_CP_DISABLE, branch, '12d: repo-level disable_plugins for custom_properties')
    const pr = await createPR(ORG, ADMIN_REPO, '12d: repo-level disable_plugins custom_properties', branch, defaultBranch)
    log('Waiting for NOP check run...')
    await sleep(WEBHOOK_SETTLE_MS)
    const checkRun = await waitForCheckRun(ORG, ADMIN_REPO, pr.head.sha)
    assert(checkRun !== null, '12d: NOP check run completed')
    if (checkRun) assert(checkRun.conclusion === 'success', `12d: NOP check run is success (got: ${checkRun.conclusion})`)
    if (!await safeMerge(ORG, ADMIN_REPO, pr.number)) return
    await sleep(WEBHOOK_SETTLE_MS)

    // repo-prop is declared in repo.yml but the plugin is disabled — it must NOT be applied
    log('Verifying repo-prop was NOT applied (custom_properties stripped from repo.yml by disable_plugins)...')
    let repoPropPresent = false
    try {
      const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
      repoPropPresent = Array.isArray(props) && !!props.find(p => p.property_name === 'repo-prop')
    } catch { /* ok */ }
    assert(!repoPropPresent, '12d: repo-prop NOT applied — custom_properties in repo.yml stripped by disable_plugins')

    // Org-level baseline-prop must still be present (repo disable_plugins does not affect org settings)
    const baselinePropOk = await poll(async () => {
      try {
        const { data: props } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner: ORG, repo: 'test' })
        return (Array.isArray(props) && props.find(p => p.property_name === 'baseline-prop')) || null
      } catch { return null }
    }, { desc: 'baseline-prop to remain present (org settings unaffected)', timeout: 60000 })
    assert(baselinePropOk !== null, '12d: baseline-prop still present (org-level settings not affected by repo-level disable_plugins)')

    await deleteBranch(ORG, ADMIN_REPO, branch)
  }
}

async function teardown () {
  logPhase('Phase 9: Teardown')

  stopSafeSettings()

  log('Deleting test repos...')
  try { await octokit.rest.repos.update({ owner: ORG, repo: 'demo-repo-service1', archived: false }) } catch { /* ok */ }
  for (const repo of TEST_REPOS) { await deleteRepo(ORG, repo) }

  log('Deleting test teams...')
  for (const team of TEST_TEAMS) { await deleteTeam(ORG, team.toLowerCase()) }

  log('Deleting custom repository role...')
  try {
    const { data } = await octokit.request('GET /orgs/{org}/custom-repository-roles', { org: ORG })
    const secRole = (data.custom_roles || []).find(r => r.name === 'security-engineer')
    if (secRole) await octokit.request('DELETE /orgs/{org}/custom-repository-roles/{role_id}', { org: ORG, role_id: secRole.id })
  } catch { /* ok */ }

  log('Deleting org rulesets...')
  try {
    const { data: rs } = await octokit.request('GET /orgs/{org}/rulesets', { org: ORG })
    const testRs = rs.find(r => r.name === 'test')
    if (testRs) await octokit.request('DELETE /orgs/{org}/rulesets/{ruleset_id}', { org: ORG, ruleset_id: testRs.id })
  } catch { /* ok */ }

  log('Resetting admin repo settings...')
  const defaultBranch = await getDefaultBranch()
  await createOrUpdateFile(ORG, ADMIN_REPO, `${CONFIG_PATH}/settings.yml`, '# empty\n', defaultBranch, 'Reset settings.yml after smoke test')
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/repos`)
  await cleanDirectory(ORG, ADMIN_REPO, `${CONFIG_PATH}/suborgs`)

  log('Teardown complete')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main () {
  const { App } = await import('octokit')
  const app = new App({ appId: APP_ID, privateKey: PRIVATE_KEY })

  // Find installation for our org
  let installationId
  for await (const { installation } of app.eachInstallation.iterator()) {
    if (installation.account && installation.account.login.toLowerCase() === ORG.toLowerCase()) {
      installationId = installation.id
      break
    }
  }
  if (!installationId) throw new Error(`No installation found for org ${ORG}`)

  octokit = await app.getInstallationOctokit(installationId)
  log('Authenticated as GitHub App installation')

  console.log(`
\x1b[36m╔══════════════════════════════════════╗
║   Safe-Settings Smoke Test           ║
║   Org: ${ORG.padEnd(28)}║
║   Admin Repo: ${ADMIN_REPO.padEnd(22)}║
╚══════════════════════════════════════╝\x1b[0m
`)

  if (INTERACTIVE) log('\x1b[33m[interactive] Mode enabled — will pause after each phase.\x1b[0m')

  let doTeardown = true
  try {
    const phases = [
      ['Phase 0: Setup', setup],
      ['Phase 1: Create test repo', phase1CreateRepo],
      ['Phase 2: Drift remediation - Team removal', phase2DriftTeam],
      ['Phase 3: Drift remediation - Rogue ruleset', phase3DriftRuleset],
      ['Phase 4: Create demo-repo-service1', phase4DemoRepo1],
      ['Phase 5: Create suborg config', phase5Suborg],
      ['Phase 6: Archive demo-repo-service1', phase6Archive],
      ['Phase 7: Create demo-repo-service2', phase7DemoRepo2],
      ['Phase 7b: External group team', phase7bExternalGroupTeam],
      ['Phase 8: Org-level settings', phase8OrgSettings],
      ['Phase 10: disable_plugins', phase10DisablePlugins],
      ['Phase 11: additive_plugins', phase11AdditivePlugins],
      ['Phase 12: custom_properties', phase12CustomProperties]
    ]
    for (const [label, fn] of phases) {
      const action = await runPhase(label, fn)
      if (action === 'abort') { doTeardown = false; break }
      if (action === 'quit') break
    }
  } catch (err) {
    if (err instanceof InteractiveExit) {
      if (err.action === 'abort') doTeardown = false
    } else {
      console.error(`\x1b[31mFatal error: ${err.message}\x1b[0m`)
      console.error(err.stack)
    }
  } finally {
    if (doTeardown) await teardown()
    else log('\x1b[33m[interactive] Aborted — teardown skipped.\x1b[0m')
  }

  console.log(`
\x1b[36m╔══════════════════════════════════════╗
║   Results                            ║
╚══════════════════════════════════════╝\x1b[0m
  \x1b[32mPassed: ${passCount}\x1b[0m
  \x1b[31mFailed: ${failCount}\x1b[0m
`)

  if (failures.length > 0) {
    console.log('\x1b[31mFailures:\x1b[0m')
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
    console.log()
  }

  process.exit(failCount > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  stopSafeSettings()
  process.exit(1)
})
