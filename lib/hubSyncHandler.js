const { minimatch } = require('minimatch')
const env = require('./env')
const { getInstallations } = require('./installationCache')
const yaml = require('js-yaml')
const path = require('path')
const fs = require('fs')
const os = require('os')
const util = require('util')
const mergeBy = require('./mergeArrayBy')

/**
 * Attach a file-backed logger to robot.log that mirrors all log calls to a file.
 * It preserves the original behavior and appends each log line to a file, trimming
 * the file to the last `maxLines` entries (default 1000).
 *
 * Usage: call attachFileLogger(robot, { filePath: '/tmp/safe-settings.log', maxLines: 1000 })
 */
function attachFileLogger (robot, options = {}) {
  if (!robot || !robot.log) return
  if (robot.log.__fileLoggerAttached) return
  const filePath = options.filePath || process.env.SAFE_SETTINGS_LOG_FILE || path.join(process.cwd(), 'hubSyncHandler.log')
  const maxLines = Number(options.maxLines || process.env.SAFE_SETTINGS_LOG_FILE_MAX_LINES || 1000)
  const methods = ['info', 'warn', 'debug', 'error', 'fatal', 'trace', 'notice']

  methods.forEach(method => {
    const orig = (robot.log && robot.log[method]) ? robot.log[method].bind(robot.log) : (...args) => { /* no-op */ }
    robot.log[method] = (...args) => {
      // call original logger so console output still occurs
      try { orig(...args) } catch (e) { /* swallow */ }

      // Build a single-line message representation
      try {
        const msg = args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 2 }))).join(' ')
        const line = `${new Date().toISOString()} [${method.toUpperCase()}] ${msg}`
        // append and then trim to last `maxLines`
        fs.appendFile(filePath, line + os.EOL, err => {
          if (err) {
            try { orig(`Failed to append log to ${filePath}: ${err.message}`) } catch (e) { /* swallow */ }
            return
          }
          // trim asynchronously
          fs.promises.readFile(filePath, 'utf8').then(data => {
            const lines = data.split(/\r?\n/)
            // Remove a possible trailing empty line created by join
            if (lines.length && lines[lines.length - 1] === '') lines.pop()
            if (lines.length > maxLines) {
              const tail = lines.slice(-maxLines)
              return fs.promises.writeFile(filePath, tail.join(os.EOL) + os.EOL, 'utf8')
            }
            return Promise.resolve()
          }).catch(() => { /* don't break logging on trim failures */ })
        })
      } catch (e) {
        try { orig(`Failed to write log to ${filePath}: ${e && e.message ? e.message : e}`) } catch (e) { /* swallow */ }
      }
    }
  })

  robot.log.__fileLoggerAttached = true
}

/**
 * Get authenticated octokit client for an org installation
 * @param {import('probot').Probot} robot
 * @param {string} orgName
 * @returns {Promise<import('@octokit/rest').Octokit|null>} Authenticated client or null
 */
async function getOrgInstallation (robot, orgName) {
  const installs = await getInstallations(robot)
  const install = installs.find(i => i.account && i.account.type === 'Organization' && i.account.login.toLowerCase() === orgName.toLowerCase())
  if (!install) {
    return null
  }
  return await robot.auth(install.id)
}


// Helper to create a branch if not direct push
async function createBranchIfNeeded(githubClient, owner, repo, baseBranch, branchName, directPush, logger) {
  if (!directPush) {
    try {
      const baseRef = await githubClient.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` })
      const baseSha = baseRef.data.object.sha
      await githubClient.rest.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha })
      logger.info(`Created branch ${branchName} in ${owner}/${repo}`)
    } catch (err) {
      if (err.status === 422) {
        logger.warn(`Branch ${branchName} already exists, continuing`)
      } else {
        throw err
      }
    }
  }
}

// Helper to create or update a file in a repo
async function createOrUpdateFile(githubClient, params, logger) {
  try {
    await githubClient.rest.repos.createOrUpdateFileContents(params)
    logger.info(`Committed ${params.path} to ${params.owner}/${params.repo}@${params.branch}`)
  } catch (err) {
    logger.error(`Failed to sync file ${params.path}: ${err.message}`)
    throw err
  }
}

/**
 * Sync changed safe-settings organization files from the master admin PR
 * into the target organization's admin repository.
 * @param {import('probot').Probot} robot
 * @param {import('probot').Context} context
 * @param {string} orgName Destination organization login (also folder name under organizations/)
 * @param {string} destRepo Destination repo name inside orgName (e.g. admin repo)
 * @param {string} destinationFolder Base folder in destination repo where content lives (e.g. .github or .github/safe-settings)
 */
async function syncHubOrgUpdate (robot, context, orgName, destRepo, destinationFolder) {
  attachFileLogger(robot)
  try {
    robot.log.info(`Syncing safe settings for organization: ${orgName}`)
    robot.log.info(`Organization: ${orgName}, Destination Repo: ${destRepo}, Destination Folder: ${destinationFolder}`)
    const pr = context.payload.pull_request
    if (!pr) {
      robot.log.warn('No pull_request payload found; aborting sync')
      return
    }
    const { owner: srcOwner, repo: srcRepo } = context.repo()
    const pull_number = pr.number
    const configRoot = env.CONFIG_PATH || '.github/'
    const sourceBase = (`${configRoot}/${env.SAFE_SETTINGS_HUB_PATH}/organizations`).replace(/\/$/, '')
    robot.log.debug(`sourceBase='${sourceBase}'`)
    robot.log.debug(`env.CONFIG_PATH='${env.CONFIG_PATH}', env.SAFE_SETTINGS_HUB_PATH='${env.SAFE_SETTINGS_HUB_PATH}'`)
    const files = await context.octokit.paginate(
      context.octokit.rest.pulls.listFiles,
      { owner: srcOwner, repo: srcRepo, pull_number, per_page: 100 }
    )
    robot.log.debug(`PR #${pull_number} contains ${files.length} changed file(s)`)
    if (files.length) robot.log.debug(`files=${files.map(f => f.filename).join(', ')}`)
    if (files.length) {
      try {
        robot.log.debug(`first file object = ${JSON.stringify(files[0], null, 2)}`)
        robot.log.debug(`file[0] keys = ${Object.keys(files[0] || {}).join(', ')}`)
      } catch (e) {
        robot.log.debug(`failed to stringify first file: ${e.message}`)
      }
      files.forEach((f, i) => {
        try {
          robot.log.debug(`FILE[${i}] raw=${JSON.stringify(f)}`)
          robot.log.debug(`FILE[${i}] filename=${JSON.stringify(f.filename)} length=${(f.filename || '').length}`)
        } catch (e) {
          robot.log.debug(`FILE[${i}] stringify error: ${e.message}`)
        }
      })
    }
    const orgPrefix = `${sourceBase}/${orgName}/`
    robot.log.debug(`files=${files.map(f => f.filename).join(', ')}`)
    robot.log.debug(`Path ${sourceBase}/${orgName}`)
    const relevant = files.filter(f => f.filename === `${sourceBase}/${orgName}` || f.filename.startsWith(orgPrefix))
    robot.log.debug(`Found ${relevant.length} changed file(s) relevant to org ${orgName}`)
    if (!relevant.length) {
      robot.log.info(`No files for org ${orgName} in PR #${pull_number}`)
      files.forEach(f => {
        const exact = f.filename === `${sourceBase}/${orgName}`
        const pref = f.filename.startsWith(orgPrefix)
        robot.log.info(`MATCH CHECK: file='${f.filename}' exact=${exact} prefix=${pref}`)
      })
      const altBase = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/organizations`
      const altPrefix = `${altBase}/${orgName}/`
      files.forEach(f => {
        const exactAlt = f.filename === `${altBase}/${orgName}`
        const prefAlt = f.filename.startsWith(altPrefix)
        robot.log.info(`ALT CHECK: file='${f.filename}' exactAlt=${exactAlt} prefAlt=${prefAlt}`)
      })
      return
    }
    const destOwner = orgName
    const destBase = (destinationFolder || env.CONFIG_PATH || '.github').replace(/\/$/, '')
    const destBaseBranch = 'main'
    const directPush = (env.SAFE_SETTINGS_HUB_DIRECT_PUSH === 'true' || env.SAFE_SETTINGS_HUB_DIRECT_PUSH === '1')
    const githubDest = await getOrgInstallation(robot, destOwner)
    if (!githubDest) {
      robot.log.warn(`Installation for destination org ${destOwner} not found; cannot sync`)
      return
    }
    robot.log.info(`Syncing from ${srcOwner}/${srcRepo} PR #${pull_number} to ${destOwner}/${destRepo}@${destBaseBranch} under ${destBase} (directPush=${directPush})`)
    const timestamp = Date.now()
    const branchName = directPush ? destBaseBranch : `safe-settings-sync/pr-${pull_number}-${orgName}-${timestamp}`
    await createBranchIfNeeded(githubDest, destOwner, destRepo, destBaseBranch, branchName, directPush, robot.log)
    for (const f of relevant) {
      let relative
      if (f.filename === `${sourceBase}/${orgName}`) {
        continue
      } else {
        relative = f.filename.slice(orgPrefix.length)
      }
      const destPath = `${destBase}/${relative}`.replace(/\/+/g, '/')
      const srcContentResp = await context.octokit.rest.repos.getContent({ owner: srcOwner, repo: srcRepo, path: f.filename, ref: pr.head.sha })
      const data = srcContentResp.data
      if (Array.isArray(data)) {
        continue
      }
      const fileContent = Buffer.from(data.content, data.encoding).toString('utf8')
      const encoded = Buffer.from(fileContent, 'utf8').toString('base64')
      let existingSha
      try {
        const destGet = await githubDest.rest.repos.getContent({ owner: destOwner, repo: destRepo, path: destPath, ref: destBaseBranch })
        if (!Array.isArray(destGet.data)) existingSha = destGet.data.sha
      } catch (getErr) {
        if (getErr.status !== 404) throw getErr
      }
      await createOrUpdateFile(githubDest, {
        owner: destOwner,
        repo: destRepo,
        path: destPath,
        message: directPush ? `Direct sync safe-settings from ${srcOwner}/${srcRepo} PR #${pull_number}` : `Sync safe-settings from ${srcOwner}/${srcRepo} PR #${pull_number}`,
        content: encoded,
        branch: branchName,
        sha: existingSha,
        committer: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' },
        author: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' }
      }, robot.log)
    }
    if (!directPush) {
      try {
        const prTitle = `Sync safe-settings from ${srcOwner}/${srcRepo} PR #${pull_number}`
        const prBody = `Automated sync of safe-settings for ${orgName} from ${srcOwner}/${srcRepo} PR #${pull_number}.`
        const created = await githubDest.rest.pulls.create({ owner: destOwner, repo: destRepo, title: prTitle, head: branchName, base: destBaseBranch, body: prBody })
        robot.log.info(`Created PR ${created.data.html_url} in ${destOwner}/${destRepo}`)
      } catch (prErr) {
        robot.log.error(`Failed to create PR in ${destOwner}/${destRepo}: ${prErr.message}`)
        throw prErr
      }
    } else {
      robot.log.info(`Changes pushed directly to ${destOwner}/${destRepo}@${destBaseBranch}`)
    }
  } catch (err) {
    robot.log.error(`syncSafeSettingConfig error for org ${orgName}: ${err.message}`)
  }
}

/**
 * Handle closed pull requests to sync safe-settings changes to target organizations.
 * Focus on the organization and repository specified in the pull request and if they belong to the Safe-Settings Hub.
 * @param {import('probot').Probot} robot
 * @param {import('probot').Context} context
 */
async function hubSyncHandler (robot, context) {
  attachFileLogger(robot)
  const { payload } = context
  const { repository, pull_request } = payload || {}
  robot.log.info(`Received 'pull_request.closed' event: ${pull_request && pull_request.number}`)
  try {
    // Ensure the event is from the configured Safe-Settings Hub repo/org
    const isMasterRepo = repository && repository.name === env.SAFE_SETTINGS_HUB_REPO
    const isMasterOrg = repository && repository.owner && repository.owner.login === env.SAFE_SETTINGS_HUB_ORG

    if (!(isMasterRepo && isMasterOrg)) {
      robot.log.info(`Pull request.closed is not from master admin repo/org (${env.SAFE_SETTINGS_HUB_ORG}/${env.SAFE_SETTINGS_HUB_REPO}), ignoring`)
      return
    }

    robot.log.info(`Pull request closed on Safe-Settings Hub: (${repository.full_name})`)

    // Get the PR details
    const pr = pull_request
    const { owner, repo } = context.repo()
    const pull_number = pr.number

    // Paginate through all files changed in the PR
    const files = await context.octokit.paginate(
      context.octokit.rest.pulls.listFiles,
      { owner, repo, pull_number, per_page: 100 }
    )

    robot.log.info(`Files changed in PR #${pull_number}: ${files.map(f => f.filename).join(', ')}`)

    // Routing logic: check for 'globals' or 'organizations' folder changes
    const globalsChanged = files.some(f => /\/globals\//.test(f.filename))
    const orgsChanged = files.some(f => /\/organizations\//.test(f.filename))

    if (globalsChanged) {
      robot.log.debug('Detected changes in the globals folder. Routing to syncHubGlobalsUpdate(...).')
      await module.exports.syncHubGlobalsUpdate(robot, context, files)
    }

    if (orgsChanged) {
      robot.log.debug('Detected changes in the organizations folder. Routing to syncHubOrgUpdate(...).')
      // Only sync updates in organization subfolders, not files directly in organizations folder
      const baseSettingsPath = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}/organizations`
      const normalizedBase = baseSettingsPath.replace(/\/$/, '')
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Only match files in org subfolders: .../organizations/<org>/...
      const orgSubfolderPattern = new RegExp(`^${escapeRegex(normalizedBase)}/([^/]+)/.+`)
      const orgNamesSet = new Set()
      files.forEach(f => {
        const m = f.filename.match(orgSubfolderPattern)
        if (m && m[1]) {
          orgNamesSet.add(m[1])
        }
      })
      const orgNames = Array.from(orgNamesSet)
      robot.log.info(`Orgs updated in PR #${pull_number}: ${orgNames.join(', ')}`)
      for (const orgName of orgNames) {
        const destRepo = env.ADMIN_REPO
        const destinationFolder = env.CONFIG_PATH || '.github'
        await module.exports.syncHubOrgUpdate(robot, context, orgName, destRepo, destinationFolder)
      }
    }
  } catch (err) {
    robot.log.error(`Failed to sync safe settings: ${err && err.message ? err.message : err}`)
  }
}

/**
 * Handle updates in the globals folder and sync to destinations defined in manifest.yml rules
 * @param {import('probot').Probot} robot
 * @param {import('probot').Context} context
 * @param {Array<Object>} files - Array of changed file objects from PR
 */
async function syncHubGlobalsUpdate (robot, context, files) {
  attachFileLogger(robot)
  robot.log.info(`Syncing safe settings for 'globals/'.`)
  const manifestPath = `${env.CONFIG_PATH}/${env.SAFE_SETTINGS_HUB_PATH}/globals/manifest.yml`
  let manifest
  try {
    const resp = await context.octokit.repos.getContent({
      owner: env.SAFE_SETTINGS_HUB_ORG,
      repo: env.SAFE_SETTINGS_HUB_REPO,
      path: manifestPath,
      ref: 'main'
    })
    const manifestContent = Buffer.from(resp.data.content, resp.data.encoding).toString('utf8')
    manifest = yaml.load(manifestContent)
    robot.log.debug('Loaded manifest.yml rules from hub repo:' + JSON.stringify(manifest, null, 2))
  } catch (err) {
    robot.log.error('Failed to load manifest.yml from hub repo:' + err.message)
    return
  }
  const changedGlobals = files.filter(f => /\/globals\//.test(f.filename))
  if (!changedGlobals.length) {
    robot.log.info('No changed files in globals folder.')
    return
  }
  // Pre-filter rules for each file, and precompute orgs for each rule
  const installs = await getInstallations(robot)
  const orgLogins = installs.filter(i => i.account && i.account.type === 'Organization').map(i => i.account.login)
  // Precompute matching rules for each fileName in changedGlobals
  const fileNameToMatchingRules = {};
  for (const fileObj of changedGlobals) {
    const fileName = fileObj.filename.split('/').pop();
    fileNameToMatchingRules[fileName] = (manifest.rules || []).filter(rule =>
      (rule.files || []).some(pattern => minimatch(fileName, pattern))
    );
  }
  for (const fileObj of changedGlobals) {
    const fileName = fileObj.filename.split('/').pop();
    if (fileName === 'manifest.yml') {
      robot.log.debug(`Skipping sync for manifest.yml (should only exist in hub)`);
      continue;
    }
    robot.log.debug(`Evaluating globals file: ${fileObj.filename}`);
    // Use precomputed matching rules
    const matchingRules = fileNameToMatchingRules[fileName];
    for (const rule of matchingRules) {
      const mergeStrategy = rule.mergeStrategy || 'merge';
      // Precompute orgs to sync for each target pattern
      let orgsToSync = [];
      for (const orgPattern of rule.targets || []) {
        if (orgPattern === '*') {
          orgsToSync.push(...orgLogins);
        } else if (orgPattern.endsWith('*')) {
          const prefix = orgPattern.slice(0, -1);
          orgsToSync.push(...orgLogins.filter(login => login.startsWith(prefix)));
        } else {
          orgsToSync.push(orgPattern);
        }
      }
      // Remove duplicates
      orgsToSync = Array.from(new Set(orgsToSync));
      robot.log.debug(`Rule '${rule.name}' matches file '${fileName}'. Targets: ${orgsToSync.join(', ')}`);
      for (const orgName of orgsToSync) {
        robot.log.debug(`Preparing to sync file '${fileName}' to org '${orgName}' with mergeStrategy='${mergeStrategy}'`);
        const destRepo = env.ADMIN_REPO;
        const githubDest = await getOrgInstallation(robot, orgName);
        if (!githubDest) {
          robot.log.info(`Skipping org ${orgName}: no installation found.`);
          continue;
        }
        let repoExists = false;
        try {
          await githubDest.repos.get({ owner: orgName, repo: destRepo });
          repoExists = true;
        } catch (err) {
          if (err.status === 404) {
            robot.log.info(`Skipping org ${orgName}: config repo '${destRepo}' does not exist.`);
            continue;
          } else {
            throw err;
          }
        }
        if (!repoExists) continue;
        const destPath = `${env.CONFIG_PATH}/${fileName}`;
        let exists = false;
        let existingSha = undefined;
        try {
          robot.log.debug(`Checking existence of ${destPath} in ${orgName}/${destRepo}`);
          const resp = await githubDest.repos.getContent({
            owner: orgName,
            repo: destRepo,
            path: destPath,
            ref: 'main'
          });
          if (!Array.isArray(resp.data)) {
            robot.log.debug(`Found ${destPath} in ${orgName}/${destRepo}`);
            exists = true;
            existingSha = resp.data.sha;
          }
        } catch (err) {
          if (err.status === 404) {
            robot.log.info(`File ${destPath} not found in ${orgName}/${destRepo} (this is fine for both merge strategies)`);
            exists = false;
            existingSha = undefined;
          } else {
            robot.log.error(`Error checking ${destPath} in ${orgName}/${destRepo}: ${err.message}`);
            throw err;
          }
        }
        if (mergeStrategy === 'merge' && exists) {
          robot.log.info(`Skipping sync of ${fileName} to ${orgName} (already exists & mergeStrategy=${mergeStrategy})`);
          continue;
        }
        robot.log.info(`Syncing ${fileName} to ${orgName} (mergeStrategy=${mergeStrategy})`);
        try {
          let srcContentResp;
          const pr = context.payload && context.payload.pull_request;
          const srcRef = pr && pr.head && pr.head.sha ? pr.head.sha : 'main';
          srcContentResp = await context.octokit.repos.getContent({
            owner: env.SAFE_SETTINGS_HUB_ORG,
            repo: env.SAFE_SETTINGS_HUB_REPO,
            path: fileObj.filename,
            ref: srcRef
          });
          const data = srcContentResp.data;
          if (Array.isArray(data)) {
            robot.log.debug(`Skipping directory ${fileObj.filename}`);
            continue;
          }
          const fileContent = Buffer.from(data.content, data.encoding).toString('utf8');
          const encoded = Buffer.from(fileContent, 'utf8').toString('base64');
          const destBaseBranch = 'main';
          const directPush = (env.SAFE_SETTINGS_HUB_DIRECT_PUSH === 'true' || env.SAFE_SETTINGS_HUB_DIRECT_PUSH === '1');
          const timestamp = Date.now();
          const branchName = directPush ? destBaseBranch : `safe-settings-globals-sync/${orgName}-${fileName}-${timestamp}`;
          await createBranchIfNeeded(githubDest, orgName, destRepo, destBaseBranch, branchName, directPush, robot.log);
          await createOrUpdateFile(githubDest, {
            owner: orgName,
            repo: destRepo,
            path: destPath,
            message: directPush ? `Direct sync globals file '${fileName}' from hub` : `Sync globals file '${fileName}' from hub`,
            content: encoded,
            branch: branchName,
            sha: exists ? existingSha : undefined,
            committer: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' },
            author: { name: 'Safe Settings Bot', email: 'safe-settings-bot@example.com' }
          }, robot.log);
          if (!directPush) {
            try {
              const prTitle = `Sync globals file '${fileName}' from hub`;
              const prBody = `Automated sync of globals file '${fileName}' from hub to ${orgName}.`;
              const created = await githubDest.rest.pulls.create({ owner: orgName, repo: destRepo, title: prTitle, head: branchName, base: destBaseBranch, body: prBody });
              robot.log.info(`Created PR ${created.data.html_url} in ${orgName}/${destRepo}`)
            } catch (prErr) {
              robot.log.error(`Failed to create PR in ${orgName}/${destRepo}: ${prErr.message}`)
              throw prErr
            }
          } else {
            robot.log.info(`Changes pushed directly to ${orgName}/${destRepo}@${destBaseBranch}`)
          }
        } catch (syncErr) {
          robot.log.error(`Failed to sync globals file ${fileName} to ${orgName}: ${syncErr.message}`)
        }
      }
    }
  }
}

/**
 * Retrieve settings files from remote organization admin repositories,
 * commit them into a branch in the hub repository, and open a pull request.
 * @param {import('probot').Probot} robot
 * @param {Array<string>} orgNames Array of organization names to retrieve settings from
 * @param {Object} options Options for the operation
 * @param {string} options.baseBranch Base branch to create new branches from (default: 'main')
 * @returns {Promise<Array<Object>>} Results of the operation for each organization
 */
async function retrieveSettingsFromOrgs (robot, orgNames = [], options = {}) {
  attachFileLogger(robot)
  const results = []
  try {
    if (!Array.isArray(orgNames) || orgNames.length === 0) return results

    const installs = await getInstallations(robot)

    const hubOwnerLogin = (env.SAFE_SETTINGS_HUB_ORG || '').toLowerCase()
    const hubRepoName = env.SAFE_SETTINGS_HUB_REPO
    if (!hubOwnerLogin || !hubRepoName) {
      throw new Error('SAFE_SETTINGS_HUB_ORG and SAFE_SETTINGS_HUB_REPO must be configured')
    }

    const hubInstall = installs.find(i => i.account && i.account.login && i.account.login.toLowerCase() === hubOwnerLogin)
    if (!hubInstall) throw new Error(`Installation for hub org ${env.SAFE_SETTINGS_HUB_ORG} not found`)

    const githubHub = await robot.auth(hubInstall.id)
    const baseBranch = options.baseBranch || 'main'

    // Resolve the base sha for creating branches
    let baseRef, baseSha
    try {
      baseRef = await githubHub.rest.git.getRef({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, ref: `heads/${baseBranch}` })
      baseSha = baseRef.data && baseRef.data.object && baseRef.data.object.sha
    } catch (refErr) {
      if (refErr && refErr.status === 404) {
        // Hub repo doesn't exist - return N/A for all requested orgs
        robot.log.warn(`Hub repository ${env.SAFE_SETTINGS_HUB_ORG}/${hubRepoName} or branch '${baseBranch}' not found`)
        return orgNames.map(org => ({ org, status: 'N/A', reason: `hub_repo_not_found: ${env.SAFE_SETTINGS_HUB_ORG}/${hubRepoName}` }))
      }
      throw refErr
    }

    // Helper: collect all files under a path in a repo (recursively)
    async function collectFilesFromRepo (githubClient, owner, repo, dirPath, ref = 'main') {
      const out = []
      
      // First verify the repo exists by checking for the ref
      try {
        await githubClient.rest.git.getRef({ owner, repo, ref: `heads/${ref}` })
      } catch (repoCheckErr) {
        if (repoCheckErr && repoCheckErr.status === 404) {
          const err404 = new Error(`Repository ${owner}/${repo} or branch '${ref}' not found`)
          err404.status = 404
          throw err404
        }
        throw repoCheckErr
      }
      
      async function walk (p) {
        try {
          const resp = await githubClient.repos.getContent({ owner, repo, path: p, ref })
          const data = resp.data
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.type === 'file') {
                try {
                  const fileResp = await githubClient.repos.getContent({ owner, repo, path: item.path, ref })
                  if (!Array.isArray(fileResp.data) && typeof fileResp.data.content === 'string') {
                    const decoded = Buffer.from(fileResp.data.content, fileResp.data.encoding || 'base64').toString('utf8')
                    out.push({ path: fileResp.data.path, content: decoded })
                  }
                } catch (fe) {
                  // skip unreadable files, but log
                  robot.log && robot.log.warn && robot.log.warn(`collectFilesFromRepo: failed to fetch ${item.path} from ${owner}/${repo}: ${fe.message}`)
                }
              } else if (item.type === 'dir') {
                await walk(item.path)
              } else {
                // skip other types (submodules, symlinks)
                robot.log && robot.log.debug && robot.log.debug(`Skipping unsupported item type ${item.type} at ${item.path}`)
              }
            }
          } else if (typeof data.content === 'string') {
            const decoded = Buffer.from(data.content, data.encoding || 'base64').toString('utf8')
            out.push({ path: data.path, content: decoded })
          }
        } catch (e) {
          if (e && e.status === 404) {
            // path does not exist on repo -> no files
            return
          }
          throw e
        }
      }
      await walk(dirPath)
      return out
    }

    // Iterate requested orgs and import their CONFIG_PATH into the hub repo under the organizations/<org> tree
    for (const orgName of orgNames) {
      try {
        if (!orgName) { results.push({ org: orgName, error: 'invalid org name' }); continue }
        robot.log.info(`Retrieving settings from org: ${orgName}`)

        // fast existence check on the hub repo: skip if org folder already exists under CONFIG_PATH/SAFE_SETTINGS_HUB_PATH/organizations
        try {
          const destOrgPath = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}/organizations/${orgName}`
          try {
            const destCheck = await githubHub.rest.repos.getContent({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, path: destOrgPath, ref: baseBranch })
            if (Array.isArray(destCheck.data) && destCheck.data.length > 0) {
              robot.log.info(`Skipping ${orgName}: already present in hub`)
              results.push({ org: orgName, status: 'imported', reason: 'already_imported' })
              continue
            }
          } catch (probeErr) {
            if (!(probeErr && probeErr.status === 404)) {
              robot.log && robot.log.warn && robot.log.warn(`Failed to probe hub destination for ${orgName}: ${probeErr.message}`)
              results.push({ org: orgName, error: `failed to check destination: ${probeErr.message}` })
              continue
            }

            // 404 -> not present, proceed
          }
        } catch (e) {
          robot.log && robot.log.warn && robot.log.warn(`Unexpected error while probing destination for ${orgName}: ${e.message}`)
          results.push({ org: orgName, error: `probe error: ${e.message}` })
          continue
        }

        const srcInstall = installs.find(i => i.account && i.account.login && i.account.login.toLowerCase() === orgName.toLowerCase())
        if (!srcInstall) {
          results.push({ org: orgName, error: 'installation not found for org' })
          continue
        }

        const githubSrc = await robot.auth(srcInstall.id)
        const adminRepo = env.ADMIN_REPO
        if (!adminRepo) {
          results.push({ org: orgName, error: 'ADMIN_REPO is not configured' })
          continue
        }

        const sourceBase = (env.CONFIG_PATH || '.github').replace(/\/$/, '')
        // collect files from the source admin repo under CONFIG_PATH
        let files
        try {
          files = await collectFilesFromRepo(githubSrc, orgName, adminRepo, sourceBase, 'main')
        } catch (collectErr) {
          if (collectErr && collectErr.status === 404) {
            robot.log.info(`Skipping ${orgName}: admin repo '${adminRepo}' not found`)
            results.push({ org: orgName, status: 'N/A', reason: `admin_repo_not_found: ${adminRepo}` })
            continue
          }
          throw collectErr
        }

        if (!files || files.length === 0) {
          results.push({ org: orgName, status: 'N/A', reason: 'no_files_at_config_path' })
          continue
        }

        const timestamp = Date.now()
        const branchName = `safe-settings-import/${orgName}/${timestamp}`.replace(/[^a-zA-Z0-9_\-./]/g, '-')

        // create branch in hub repo
        try {
          await githubHub.rest.git.createRef({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, ref: `refs/heads/${branchName}`, sha: baseSha })
        } catch (createErr) {
          if (createErr && createErr.status === 422) {
            robot.log.info(`Branch ${branchName} already exists, continuing`) // continue
          } else {
            throw createErr
          }
        }

        // Instead of creating/updating files one-by-one, build a single tree and commit so the PR contains all files atomically
        try {
          const treeEntries = []
          for (const f of files) {
            // relative path under the sourceBase
            const rel = path.posix.relative(sourceBase, f.path)
            // Destination should be: CONFIG_PATH/SAFE_SETTINGS_HUB_PATH/organizations/<orgName>/<relative>
            const destBase = `${(env.CONFIG_PATH || '.github').replace(/\/$/, '')}/${env.SAFE_SETTINGS_HUB_PATH}`
            const destPath = path.posix.join(destBase, 'organizations', orgName, rel).replace(/\/+/g, '/')
            treeEntries.push({ path: destPath, mode: '100644', type: 'blob', content: f.content })
          }

          // Get base commit and tree
          const baseCommitResp = await githubHub.rest.git.getCommit({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, commit_sha: baseSha })
          const baseTreeSha = baseCommitResp.data && baseCommitResp.data.tree && baseCommitResp.data.tree.sha

          // Create a new tree rooted at the base tree
          const createdTree = await githubHub.rest.git.createTree({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, tree: treeEntries, base_tree: baseTreeSha })

          // Create a commit that points to the new tree
          const commitMessage = `Import safe-settings from ${orgName}`
          const newCommit = await githubHub.rest.git.createCommit({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, message: commitMessage, tree: createdTree.data.sha, parents: [baseSha] })

          // Update the branch ref to point to the new commit
          await githubHub.rest.git.updateRef({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, ref: `heads/${branchName}`, sha: newCommit.data.sha })

          robot.log.info(`Created commit ${newCommit.data.sha} on ${env.SAFE_SETTINGS_HUB_ORG}/${hubRepoName}@${branchName} with ${treeEntries.length} files`)
        } catch (commitErr) {
          robot.log.error(`Failed to create commit tree for ${orgName}: ${commitErr && commitErr.message ? commitErr.message : commitErr}`)
          results.push({ org: orgName, error: `failed to commit files: ${commitErr && commitErr.message ? commitErr.message : String(commitErr)}` })
          continue
        }

        // Create a PR in the hub repo for this branch
        try {
          const prTitle = `Import safe-settings from ${orgName}`
          const prBody = `Automated import of settings from ${orgName} admin repo (${adminRepo}) into the hub.`
          const created = await githubHub.rest.pulls.create({ owner: env.SAFE_SETTINGS_HUB_ORG, repo: hubRepoName, title: prTitle, head: branchName, base: baseBranch, body: prBody })
          results.push({ org: orgName, pr: created.data && created.data.html_url })
          robot.log.info(`Created PR ${created.data && created.data.html_url} for ${orgName}`)
        } catch (prErr) {
          robot.log.error(`Failed to create PR for ${orgName}: ${prErr && prErr.message ? prErr.message : prErr}`)
          results.push({ org: orgName, error: `failed to create PR: ${prErr && prErr.message ? prErr.message : String(prErr)}` })
        }
      } catch (errInner) {
        robot.log.error(`Error importing settings for org ${orgName}: ${errInner && errInner.message ? errInner.message : errInner}`)
        results.push({ org: orgName, error: errInner && errInner.message ? errInner.message : String(errInner) })
      }
    }

    return results
  } catch (err) {
    robot.log.error(`retrieveSettingsFromOrgs error: ${err && err.message ? err.message : err}`)
    throw err
  }
}

// Properties used to identify matching items in arrays
const NAME_FIELDS = ['name', 'username', 'actor_id', 'login', 'type', 'key_prefix', 'context']

/**
 * Merge two JSON/YAML configuration strings at the object level.
 * 
 * @param {string} json1 - First JSON/YAML content string (base)
 * @param {string} json2 - Second JSON/YAML content string (overlay - takes precedence)
 * @param {boolean} replaceArrays - If true (default), arrays in json2 replace arrays in json1.
 *                                   If false, arrays are merged intelligently:
 *                                   - Simple arrays: deduplicated (no duplicates added)
 *                                   - Object arrays: matched by name/username/etc and merged
 * @returns {Object} Merged configuration object
 * 
 * @example
 * const json1 = `
 * teams:
 *   - team-a
 *   - team-b
 * `
 * const json2 = `
 * teams:
 *   - team-b
 *   - team-c
 * `
 * 
 * // Replace mode (default): result = { teams: ['team-b', 'team-c'] }
 * const replaced = mergeConfigs(json1, json2)
 * // or explicitly: mergeConfigs(json1, json2, true)
 * 
 * // Smart merge mode: result = { teams: ['team-a', 'team-b', 'team-c'] }
 * const smartMerge = mergeConfigs(json1, json2, false)
 * mergeConfigs
 * @example
 * // Smart merge with objects
 * const json1 = `
 * collaborators:
 *   - username: alice
 *     permission: push
 * `
 * const json2 = `
 * collaborators:
 *   - username: alice
 *     permission: admin
 *   - username: bob
 *     permission: pull
 * `
 * // Result: alice updated to admin, bob added
 */
function mergeConfigs (json1, json2, replaceArrays = true) {
  // Parse input strings as YAML (which also handles JSON)
  const obj1 = yaml.load(json1) || {}
  const obj2 = yaml.load(json2) || {}

  // Perform the merge
  return deepMerge(obj1, obj2, replaceArrays)
}

/**
 * Deep merge two objects with configurable array handling
 * 
 * @param {*} target - Base object
 * @param {*} source - Overlay object (takes precedence)
 * @param {boolean} replaceArrays - Array merge strategy
 * @returns {*} Merged result
 */
function deepMerge (target, source, replaceArrays) {
  // Handle null/undefined
  if (source === null || source === undefined) {
    return target
  }
  if (target === null || target === undefined) {
    return source
  }

  // If source is not an object, it replaces target
  if (typeof source !== 'object' || source === null) {
    return source
  }

  // Handle arrays
  if (Array.isArray(source)) {
    if (Array.isArray(target)) {
      if (replaceArrays) {
        // Replace: return only source array
        return [...source]
      } else {
        // Smart merge: deduplicate primitives or merge objects by matching properties
        return smartMergeArrays(target, source)
      }
    }
    // Target is not an array, replace with source array
    return [...source]
  }

  // Handle objects (not arrays)
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    // Target is not a plain object, replace with source
    target = {}
  }

  const result = { ...target }

  // Merge source properties into result
  for (const key in source) {
    // Skip prototype pollution
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }

    const sourceValue = source[key]
    const targetValue = result[key]

    // Recursively merge if both are objects or arrays
    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      targetValue !== null &&
      typeof targetValue === 'object'
    ) {
      result[key] = deepMerge(targetValue, sourceValue, replaceArrays)
    } else {
      // For primitives, source overwrites target
      result[key] = sourceValue
    }
  }

  return result
}

/**
 * Smart merge two arrays: deduplicates primitives, or matches objects by name/username/etc and deep-merges them.
 * 
 * **Primitive arrays**: ['a', 'b'] + ['b', 'c'] → ['a', 'b', 'c']
 * 
 * **Object arrays** (via mergeBy):
 * - Matches by NAME_FIELDS (name, username, actor_id, login, type, key_prefix, context)
 * - Deep-merges matching objects (source properties override target, nested props preserved)
 * - Appends non-matching source objects
 * - Preserves target-only objects
 * 
 * Example (labels):
 * ```
 * target: [{ name: 'bug', color: 'red' }, { name: 'feature', color: 'blue' }]
 * source: [{ name: 'bug', color: 'green' }, { name: 'docs', color: 'yellow' }]
 * result: [{ name: 'bug', color: 'green' },    // updated
 *          { name: 'feature', color: 'blue' }, // preserved
 *          { name: 'docs', color: 'yellow' }]  // added
 * ```
 * 
 * @param {Array} target - Base array (primitives or objects)
 * @param {Array} source - Overlay array (primitives or objects)
 * @returns {Array} Merged array
 */
function smartMergeArrays (target, source) {
  // Check if arrays contain objects or primitives
  const hasObjects = source.some(item => item && typeof item === 'object' && !Array.isArray(item))
  
  if (!hasObjects) {
    // Primitives: deduplicate
    const result = [...target]
    source.forEach(item => {
      if (!result.includes(item)) {
        result.push(item)
      }
    })
    return result
  }
  
  // Objects: match by NAME_FIELDS and deep-merge
  // mergeBy(key, configvalidator, overridevalidator, properties, target, source, options, githubContext)
  return mergeBy(null, null, null, NAME_FIELDS, target, source, undefined, undefined)
}

// Export all internal functions for testability
module.exports = {
  hubSyncHandler,
  retrieveSettingsFromOrgs,
  syncHubOrgUpdate,
  syncHubGlobalsUpdate,
  getOrgInstallation,
  mergeConfigs
}
