/* eslint-disable camelcase */
const NopCommand = require('../nopcommand')
const AppOctokitClient = require('../appOctokitClient')

/**
 * AppInstallations plugin manages which repositories are accessible to
 * GitHub App installations in the organization.
 *
 * Unlike repo-targeting plugins (which extend Diffable), this plugin
 * operates at the org level — the "target" is an app installation,
 * not a repository.
 *
 * Supports:
 *   - Delta-based sync (incremental changes from config file diffs)
 *   - Full sync (compare desired state against live API state)
 *   - disable_plugins (skipped when disabled)
 *   - additive_plugins (only adds repos, never removes)
 */
class AppInstallations {
  /**
   * @param {boolean} nop - Dry-run mode
   * @param {object} github - Octokit client (installation-authenticated)
   * @param {object} appGithub - Octokit client (app-authenticated, for enterprise API)
   * @param {object} repo - { owner, repo } context
   * @param {string} enterpriseSlug - Enterprise slug from webhook payload
   * @param {object} log - Logger
   * @param {Array} errors - Shared errors array
   */
  constructor (nop, github, appGithub, repo, enterpriseSlug, log, errors) {
    this.nop = nop
    this.github = github
    this.repo = repo
    this.log = log
    this.errors = errors || []
    this.additive = false

    if (appGithub && enterpriseSlug) {
      this.enterpriseClient = new AppOctokitClient({
        github: appGithub,
        enterpriseSlug,
        log
      })
    }
  }

  /**
   * Delta-based sync: process pre-computed per-app changes.
   *
   * @param {Array} appChanges - Array of per-app change objects:
   *   {
   *     app_slug: string,
   *     installation_id: number,
   *     repository_selection: Set<string> | 'all',  // repos to add
   *     repository_unselection: Set<string>,         // repos to remove
   *   }
   * @returns {Promise<Array>} NopCommand results (in nop mode) or empty
   */
  async syncDelta (appChanges) {
    const results = []

    if (!appChanges || appChanges.length === 0) return results

    for (const change of appChanges) {
      try {
        const appResults = await this._processAppChange(change)
        results.push(...appResults)
      } catch (e) {
        this.log.error(`Error processing app installation '${change.app_slug}': ${e.message}`)
        this.errors.push({
          owner: this.repo.owner,
          repo: this.repo.repo,
          msg: e.message,
          plugin: 'app_installations'
        })
        if (this.nop) {
          results.push(new NopCommand(
            'app_installations',
            this.repo,
            null,
            `Error: ${e.message}`,
            'ERROR'
          ))
        }
      }
    }

    return results
  }

  /**
   * Full sync: compute full desired state for all managed apps,
   * compare against live API state, and reconcile.
   *
   * @param {object} desiredState - Map of app_slug → { installation_id, repos: Set<string> | 'all' }
   * @returns {Promise<Array>} NopCommand results (in nop mode) or empty
   */
  async syncFull (desiredState) {
    const results = []

    if (!desiredState || Object.keys(desiredState).length === 0) return results

    if (!this.enterpriseClient) {
      const msg = 'Cannot sync app installations: enterprise client not configured. Ensure safe-settings is installed on the enterprise.'
      this.log.error(msg)
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, msg, 'ERROR'))
      }
      return results
    }

    for (const [appSlug, desired] of Object.entries(desiredState)) {
      try {
        // Get live state
        const liveRepos = await this.enterpriseClient.listInstallationRepos(desired.installation_id)
        const liveRepoNames = new Set(liveRepos.map(r => r.name))
        const liveRepoMap = new Map(liveRepos.map(r => [r.name, r.id]))

        let desiredRepoNames
        if (desired.repos === 'all') {
          // Desired = all repos in org
          desiredRepoNames = await this._getAllRepoNames()
        } else {
          desiredRepoNames = desired.repos
        }

        // Compute diff
        const toAdd = new Set([...desiredRepoNames].filter(r => !liveRepoNames.has(r)))
        const toRemove = this.additive
          ? new Set() // Additive mode: never remove
          : new Set([...liveRepoNames].filter(r => !desiredRepoNames.has(r)))

        if (toAdd.size === 0 && toRemove.size === 0) {
          this.log.debug(`App '${appSlug}': no changes needed`)
          continue
        }

        if (this.nop) {
          results.push(new NopCommand(
            'app_installations',
            this.repo,
            null,
            {
              msg: `App '${appSlug}' installation repos`,
              additions: toAdd.size > 0 ? [...toAdd] : null,
              modifications: null,
              deletions: toRemove.size > 0 ? [...toRemove] : null
            }
          ))
          continue
        }

        // Resolve names to IDs. Process removals first, then additions, so a
        // repo that should be both removed (by one config) and added (by
        // another) ends up present.
        if (toRemove.size > 0) {
          const removeIds = [...toRemove].map(name => liveRepoMap.get(name)).filter(Boolean)
          await this.enterpriseClient.removeReposFromInstallation(desired.installation_id, removeIds)
          this.log.debug(`App '${appSlug}': removed ${removeIds.length} repos`)
        }

        if (toAdd.size > 0) {
          const addIds = await this._resolveRepoIds([...toAdd])
          await this.enterpriseClient.addReposToInstallation(desired.installation_id, addIds)
          this.log.debug(`App '${appSlug}': added ${addIds.length} repos`)
        }
      } catch (e) {
        this.log.error(`Error in full sync for app '${appSlug}': ${e.message}`)
        this.errors.push({
          owner: this.repo.owner,
          repo: this.repo.repo,
          msg: e.message,
          plugin: 'app_installations'
        })
        if (this.nop) {
          results.push(new NopCommand('app_installations', this.repo, null, `Error: ${e.message}`, 'ERROR'))
        }
      }
    }

    return results
  }

  /**
   * Process a single app's delta change.
   * @private
   */
  async _processAppChange (change) {
    const results = []
    const { app_slug, installation_id, repository_selection, repository_unselection } = change

    if (!this.enterpriseClient) {
      const msg = 'Cannot sync app installations: enterprise client not configured. Ensure safe-settings is installed on the enterprise.'
      this.log.error(msg)
      if (this.nop) {
        results.push(new NopCommand('app_installations', this.repo, null, msg, 'ERROR'))
      }
      return results
    }

    const hasSelections = repository_selection === 'all' ||
      (repository_selection instanceof Set && repository_selection.size > 0)
    const hasUnselections = !this.additive &&
      (repository_unselection instanceof Set && repository_unselection.size > 0)

    if (!hasSelections && !hasUnselections) {
      return results
    }

    // Handle "all" selection — set repository_selection to all via the API
    if (repository_selection === 'all') {
      if (this.nop) {
        results.push(new NopCommand(
          'app_installations',
          this.repo,
          null,
          {
            msg: `App '${app_slug}': set repository_selection to 'all'`,
            additions: ['(all repositories)'],
            modifications: null,
            deletions: null
          }
        ))
        return results
      }

      // For "all" repos, get the full list and add all
      const allRepoNames = await this._getAllRepoNames()
      const liveRepos = await this.enterpriseClient.listInstallationRepos(installation_id)
      const liveRepoNames = new Set(liveRepos.map(r => r.name))
      const toAdd = [...allRepoNames].filter(r => !liveRepoNames.has(r))

      if (toAdd.length > 0) {
        const addIds = await this._resolveRepoIds(toAdd)
        await this.enterpriseClient.addReposToInstallation(installation_id, addIds)
        this.log.debug(`App '${app_slug}': added all repos (${addIds.length} new)`)
      }

      return results
    }

    // Handle specific repos
    if (this.nop) {
      const additions = hasSelections ? [...repository_selection] : null
      const deletions = hasUnselections ? [...repository_unselection] : null
      results.push(new NopCommand(
        'app_installations',
        this.repo,
        null,
        {
          msg: `App '${app_slug}' installation repos`,
          additions,
          modifications: null,
          deletions
        }
      ))
      return results
    }

    if (hasUnselections) {
      const removeIds = await this._resolveRepoIds([...repository_unselection])
      await this.enterpriseClient.removeReposFromInstallation(installation_id, removeIds)
      this.log.debug(`App '${app_slug}': removed ${removeIds.length} repos`)
    }

    if (hasSelections) {
      const addIds = await this._resolveRepoIds([...repository_selection])
      await this.enterpriseClient.addReposToInstallation(installation_id, addIds)
      this.log.debug(`App '${app_slug}': added ${addIds.length} repos`)
    }

    return results
  }

  /**
   * Get all repo names visible to the installation.
   * @private
   */
  async _getAllRepoNames () {
    const repos = await this.github.paginate('GET /installation/repositories')
    return new Set(repos.map(r => r.name))
  }

  /**
   * Resolve repo names to IDs.
   * @private
   */
  async _resolveRepoIds (repoNames) {
    const ids = []
    for (const name of repoNames) {
      try {
        const { data } = await this.github.repos.get({
          owner: this.repo.owner,
          repo: name
        })
        ids.push(data.id)
      } catch (e) {
        this.log.debug(`Could not resolve repo ID for '${name}': ${e.message}`)
      }
    }
    return ids
  }
}

module.exports = AppInstallations
