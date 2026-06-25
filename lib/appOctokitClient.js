const BATCH_SIZE = 50

/**
 * AppOctokitClient wraps an Octokit client authenticated as the GitHub App
 * (JWT) and provides methods for managing app installation repository access
 * via the Enterprise Organization Installations API.
 *
 * Prerequisites:
 *   - safe-settings must be installed on the enterprise with
 *     "Enterprise organization installations" permission.
 *   - The enterprise slug is obtained from the webhook event payload
 *     (payload.enterprise.slug).
 *
 * @param {object} options
 * @param {object} options.github - Octokit client authenticated as the app (via robot.auth())
 * @param {string} options.enterpriseSlug - Enterprise slug from webhook payload
 * @param {object} options.log - Logger instance
 */
class AppOctokitClient {
  constructor ({ github, enterpriseSlug, log }) {
    this.github = github
    this.enterpriseSlug = enterpriseSlug
    this.log = log
  }

  /**
   * List all app installations in the enterprise for a given org.
   * Returns array of installation objects with { id, app_slug, app_id, ... }
   *
   * @param {string} org - Organization login name
   * @returns {Promise<Array>} List of installations
   */
  async listOrgInstallations (org) {
    try {
      const options = this.github.request.endpoint.merge(
        'GET /enterprises/{enterprise}/apps/installations',
        {
          enterprise: this.enterpriseSlug,
          headers: { 'X-GitHub-Api-Version': '2026-03-10' }
        }
      )
      const installations = await this.github.paginate(options)
      // Filter to installations for the specified org
      return installations.filter(i =>
        i.account && i.account.login === org
      )
    } catch (e) {
      if (e.status === 403 || e.status === 404) {
        throw new Error(
          `Cannot access enterprise installations API. Ensure safe-settings is installed on the enterprise '${this.enterpriseSlug}' with 'Enterprise organization installations' permission. Error: ${e.message}`
        )
      }
      throw e
    }
  }

  /**
   * List repositories accessible to an app installation.
   *
   * @param {number} installationId - The installation ID
   * @returns {Promise<Array>} List of repository objects
   */
  async listInstallationRepos (installationId) {
    try {
      const options = this.github.request.endpoint.merge(
        'GET /enterprises/{enterprise}/apps/installations/{installation_id}/repositories',
        {
          enterprise: this.enterpriseSlug,
          installation_id: installationId,
          headers: { 'X-GitHub-Api-Version': '2026-03-10' }
        }
      )
      return this.github.paginate(options)
    } catch (e) {
      this.log.error(`Error listing repos for installation ${installationId}: ${e.message}`)
      throw e
    }
  }

  /**
   * Grant repository access to an app installation.
   * Automatically batches into chunks of 50 (API limit).
   *
   * @param {number} installationId - The installation ID
   * @param {number[]} repositoryIds - Array of repository IDs to add
   * @returns {Promise<void>}
   */
  async addReposToInstallation (installationId, repositoryIds) {
    if (!repositoryIds || repositoryIds.length === 0) return

    const batches = this._chunk(repositoryIds, BATCH_SIZE)
    for (const batch of batches) {
      this.log.debug(`Adding ${batch.length} repos to installation ${installationId}`)
      await this.github.request(
        'POST /enterprises/{enterprise}/apps/installations/{installation_id}/repositories',
        {
          enterprise: this.enterpriseSlug,
          installation_id: installationId,
          repository_ids: batch,
          headers: { 'X-GitHub-Api-Version': '2026-03-10' }
        }
      )
    }
  }

  /**
   * Remove repository access from an app installation.
   * Automatically batches into chunks of 50 (API limit).
   *
   * @param {number} installationId - The installation ID
   * @param {number[]} repositoryIds - Array of repository IDs to remove
   * @returns {Promise<void>}
   */
  async removeReposFromInstallation (installationId, repositoryIds) {
    if (!repositoryIds || repositoryIds.length === 0) return

    const batches = this._chunk(repositoryIds, BATCH_SIZE)
    for (const batch of batches) {
      this.log.debug(`Removing ${batch.length} repos from installation ${installationId}`)
      await this.github.request(
        'DELETE /enterprises/{enterprise}/apps/installations/{installation_id}/repositories',
        {
          enterprise: this.enterpriseSlug,
          installation_id: installationId,
          repository_ids: batch,
          headers: { 'X-GitHub-Api-Version': '2026-03-10' }
        }
      )
    }
  }

  /**
   * Split an array into chunks of the given size.
   * @private
   */
  _chunk (array, size) {
    const chunks = []
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size))
    }
    return chunks
  }
}

module.exports = AppOctokitClient
