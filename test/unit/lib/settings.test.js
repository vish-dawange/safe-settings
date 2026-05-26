/* eslint-disable no-undef */
const { Octokit } = require('@octokit/core')
const Settings = require('../../../lib/settings')
const yaml = require('js-yaml')
// jest.mock('../../../lib/settings', () => {
//   const OriginalSettings = jest.requireActual('../../../lib/settings')
//   //const orginalSettingsInstance = new OriginalSettings(false, stubContext, mockRepo, config, mockRef, mockSubOrg)
//   return OriginalSettings
// })

describe('Settings Tests', () => {
  let stubContext
  let mockRepo
  let stubConfig
  let mockRef
  let mockSubOrg
  let subOrgConfig

  function createSettings (config) {
    const settings = new Settings(false, stubContext, mockRepo, config, mockRef, mockSubOrg)
    return settings
  }

  beforeEach(() => {
    const mockOctokit = jest.mocked(Octokit)
    const content = Buffer.from(`
suborgrepos:
- new-repo
#- test*
#- secret*

suborgteams:
- core

suborgproperties:
- EDP: true
- do_no_delete: true

teams:
  - name: core
    permission: bypass
  - name: docss
    permission: pull
  - name: docs
    permission: pull

validator:
  pattern: '[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+.*'

repository:
  # A comma-separated list of topics to set on the repository
  topics:
  - frontend
     `).toString('base64')
    mockOctokit.repos = {
      getContent: jest.fn().mockResolvedValue({ data: { content } })
    }

    mockOctokit.request = {
      endpoint: jest.fn().mockReturnValue({})
    }

    mockOctokit.paginate = jest.fn().mockResolvedValue([])

    stubContext = {
      payload: {
        installation: {
          id: 123
        }
      },
      octokit: mockOctokit,
      log: {
        debug: jest.fn((msg) => {
          console.log(msg)
        }),
        info: jest.fn((msg) => {
          console.log(msg)
        }),
        error: jest.fn((msg) => {
          console.log(msg)
        })
      }
    }

    mockRepo = { owner: 'test', repo: 'test-repo' }
    mockRef = 'main'
    mockSubOrg = 'frontend'
  })

  describe('restrictedRepos', () => {
    describe('restrictedRepos not defined', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
          }
        }
      })

      it('Allow repositories being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo')).toEqual(false)
        expect(settings.isRestricted('another-repo')).toEqual(false)
      })

      it('Do not allow default excluded repositories being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('.github')).toEqual(false)
        expect(settings.isRestricted('safe-settings')).toEqual(false)
        expect(settings.isRestricted('admin')).toEqual(false)
      })
    })

    describe('restrictedRepos.exclude defined', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
            exclude: ['foo', '*-test', 'personal-*']
          }
        }
      })

      it('Skipping excluded repository from being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('foo')).toEqual(true)
      })

      it('Skipping excluded repositories matching regex in restrictedRepos.exclude', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test')).toEqual(true)
        expect(settings.isRestricted('personal-repo')).toEqual(true)
      })

      it('Allowing repositories not matching regex in restrictedRepos.exclude', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test-data')).toEqual(false)
        expect(settings.isRestricted('personalization-repo')).toEqual(false)
      })
    })

    describe('restrictedRepos.include defined', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
            include: ['foo', '*-test', 'personal-*']
          }
        }
      })

      it('Allowing repository from being configured', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('foo')).toEqual(false)
      })

      it('Allowing repositories matching regex in restrictedRepos.include', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test')).toEqual(false)
        expect(settings.isRestricted('personal-repo')).toEqual(false)
      })

      it('Skipping repositories not matching regex in restrictedRepos.include', () => {
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo-test-data')).toEqual(true)
        expect(settings.isRestricted('personalization-repo')).toEqual(true)
      })
    })

    describe('restrictedRepos not defined', () => {
      it('Throws TypeError if restrictedRepos not defined', () => {
        stubConfig = {}
        settings = createSettings(stubConfig)
        expect(() => settings.isRestricted('my-repo')).toThrow('Cannot read properties of undefined (reading \'include\')')
      })

      it('Throws TypeError if restrictedRepos is null', () => {
        stubConfig = {
          restrictedRepos: null
        }
        settings = createSettings(stubConfig)
        expect(() => settings.isRestricted('my-repo')).toThrow('Cannot read properties of null (reading \'include\')')
      })

      it('Allowing all repositories if restrictedRepos is empty', () => {
        stubConfig = {
          restrictedRepos: []
        }
        settings = createSettings(stubConfig)
        expect(settings.isRestricted('my-repo')).toEqual(false)
      })
    })
  }) // restrictedRepos

  describe('getRepoOverrideConfig', () => {
    describe('repository defined in a file using the .yaml extension', () => {
      beforeEach(() => {
        stubConfig = {
          repoConfigs: {
            'repository.yaml': { repository: { name: 'repository', config: 'config1' } }
          }
        }
      })

      it('Picks up a repository defined in file using the .yaml extension', () => {
        settings = createSettings(stubConfig)
        settings.repoConfigs = stubConfig.repoConfigs
        const repoConfig = settings.getRepoOverrideConfig('repository')

        expect(typeof repoConfig).toBe('object')
        expect(repoConfig).not.toBeNull()
        expect(Object.keys(repoConfig).length).toBeGreaterThan(0)
      })
    })

    describe('repository defined in a file using the .yml extension', () => {
      beforeEach(() => {
        stubConfig = {
          repoConfigs: {
            'repository.yml': { repository: { name: 'repository', config: 'config1' } }
          }
        }
      })

      it('Picks up a repository defined in file using the .yml extension', () => {
        settings = createSettings(stubConfig)
        settings.repoConfigs = stubConfig.repoConfigs
        const repoConfig = settings.getRepoOverrideConfig('repository')

        expect(typeof repoConfig).toBe('object')
        expect(repoConfig).not.toBeNull()
        expect(Object.keys(repoConfig).length).toBeGreaterThan(0)
      })
    })
  }) // repoOverrideConfig
  describe('loadConfigs', () => {
    describe('load suborg configs', () => {
      beforeEach(() => {
        stubConfig = {
          restrictedRepos: {
          }
        }
        subOrgConfig = yaml.load(`
          suborgrepos:
          - new-repo

          suborgproperties:
          - EDP: true
          - do_no_delete: true

          teams:
            - name: core
              permission: bypass
            - name: docss
              permission: pull
            - name: docs
              permission: pull

          validator:
            pattern: '[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+.*'

          repository:
            # A comma-separated list of topics to set on the repository
            topics:
            - frontend

          `)
      })

      it("Should load configMap for suborgs'", async () => {
        // mockSubOrg = jest.fn().mockReturnValue(['suborg1', 'suborg2'])
        mockSubOrg = undefined
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: 'frontend', path: '.github/suborgs/frontend.yml' }])
        jest.spyOn(settings, 'loadYaml').mockImplementation(() => subOrgConfig)
        jest.spyOn(settings, 'getReposForTeam').mockImplementation(() => [{ name: 'repo-test' }])
        jest.spyOn(settings, 'getSubOrgRepositories').mockImplementation(() => [{ repository_name: 'repo-for-property' }])

        const subOrgConfigs = await settings.getSubOrgConfigs()
        expect(settings.loadConfigMap).toHaveBeenCalledTimes(1)

        // Get own properties of subOrgConfigs
        const ownProperties = Object.getOwnPropertyNames(subOrgConfigs)
        expect(ownProperties.length).toEqual(3)
      })

      it("Should throw an error when a repo is found in multiple suborgs configs'", async () => {
        // mockSubOrg = jest.fn().mockReturnValue(['suborg1', 'suborg2'])
        mockSubOrg = undefined
        settings = createSettings(stubConfig)
        jest.spyOn(settings, 'loadConfigMap').mockImplementation(() => [{ name: 'frontend', path: '.github/suborgs/frontend.yml' }, { name: 'backend', path: '.github/suborgs/backend.yml' }])
        jest.spyOn(settings, 'loadYaml').mockImplementation(() => subOrgConfig)
        jest.spyOn(settings, 'getReposForTeam').mockImplementation(() => [{ name: 'repo-test' }])
        jest.spyOn(settings, 'getSubOrgRepositories').mockImplementation(() => [{ repository_name: 'repo-for-property' }])

        expect(async () => await settings.getSubOrgConfigs()).rejects.toThrow('Multiple suborg configs for new-repo in .github/suborgs/backend.yml and .github/suborgs/frontend.yml')
        // try {
        //   await settings.getSubOrgConfigs()
        // } catch (e) {
        //   console.log(e)
        // }
      })
    })
  }) // loadConfigs

  describe('loadYaml', () => {
    let settings

    beforeEach(() => {
      Settings.fileCache = {}
      stubContext = {
        octokit: {
          repos: {
            getContent: jest.fn()
          },
          request: jest.fn(),
          paginate: jest.fn()
        },
        log: {
          debug: jest.fn(),
          info: jest.fn(),
          error: jest.fn()
        },
        payload: {
          installation: {
            id: 123
          }
        }
      }
      settings = createSettings({})
    })

    it('should return parsed YAML content when file is fetched successfully', async () => {
      // Given
      const filePath = 'path/to/file.yml'
      const content = Buffer.from('key: value').toString('base64')
      jest.spyOn(settings.github.repos, 'getContent').mockResolvedValue({
        data: { content },
        headers: { etag: 'etag123' }
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toEqual({ key: 'value' })
      expect(Settings.fileCache[`${mockRepo.owner}/${filePath}`]).toEqual({
        etag: 'etag123',
        data: { content }
      })
    })

    it('should return cached content when file has not changed (304 response)', async () => {
      // Given
      const filePath = 'path/to/file.yml'
      const content = Buffer.from('key: value').toString('base64')
      Settings.fileCache[`${mockRepo.owner}/${filePath}`] = { etag: 'etag123', data: { content } }
      jest.spyOn(settings.github.repos, 'getContent').mockRejectedValue({ status: 304 })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toEqual({ key: 'value' })
      expect(settings.github.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'If-None-Match': 'etag123' } })
      )
    })

    it('should not return cached content when the cache is for another org', async () => {
      // Given
      const filePath = 'path/to/file.yml'
      const content = Buffer.from('key: value').toString('base64')
      const wrongContent = Buffer.from('wrong: content').toString('base64')
      Settings.fileCache['another-org/path/to/file.yml'] = { etag: 'etag123', data: { wrongContent } }
      jest.spyOn(settings.github.repos, 'getContent').mockResolvedValue({
        data: { content },
        headers: { etag: 'etag123' }
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toEqual({ key: 'value' })
    })

    it('should return null when the file path is a folder', async () => {
      // Given
      const filePath = 'path/to/folder'
      jest.spyOn(settings.github.repos, 'getContent').mockResolvedValue({
        data: []
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeNull()
    })

    it('should return null when the file is a symlink or submodule', async () => {
      // Given
      const filePath = 'path/to/symlink'
      jest.spyOn(settings.github.repos, 'getContent').mockResolvedValue({
        data: { content: null }
      })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeUndefined()
    })

    it('should handle 404 errors gracefully and return null', async () => {
      // Given
      const filePath = 'path/to/nonexistent.yml'
      jest.spyOn(settings.github.repos, 'getContent').mockRejectedValue({ status: 404 })

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeNull()
    })

    it('should throw an error for non-404 exceptions when not in nop mode', async () => {
      // Given
      const filePath = 'path/to/error.yml'
      jest.spyOn(settings.github.repos, 'getContent').mockRejectedValue(new Error('Unexpected error'))

      // When / Then
      await expect(settings.loadYaml(filePath)).rejects.toThrow('Unexpected error')
    })

    it('should log and append NopCommand for non-404 exceptions in nop mode', async () => {
      // Given
      const filePath = 'path/to/error.yml'
      settings.nop = true
      jest.spyOn(settings.github.repos, 'getContent').mockRejectedValue(new Error('Unexpected error'))
      jest.spyOn(settings, 'appendToResults')

      // When
      const result = await settings.loadYaml(filePath)

      // Then
      expect(result).toBeUndefined()
      expect(settings.appendToResults).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'ERROR',
            action: expect.objectContaining({
              msg: expect.stringContaining('Unexpected error')
            })
          })
        ])
      );
    });
  });

  describe('getAllMatchingSubOrgSources', () => {
    it('returns an empty set when subOrgConfigs is undefined', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = undefined
      const result = settings.getAllMatchingSubOrgSources('any-repo')
      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(0)
    })

    it('returns an empty set when no suborg matches', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = {
        'frontend-*': { source: '.github/suborgs/frontend.yml' }
      }
      const result = settings.getAllMatchingSubOrgSources('backend-repo')
      expect(result.size).toBe(0)
    })

    it('returns a single-entry set when one suborg glob matches', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = {
        'frontend-*': { source: '.github/suborgs/frontend.yml' },
        'backend-*': { source: '.github/suborgs/backend.yml' }
      }
      const result = settings.getAllMatchingSubOrgSources('frontend-app')
      expect(result.size).toBe(1)
      expect(result.has('.github/suborgs/frontend.yml')).toBe(true)
    })

    it('does not alter getSubOrgConfig single-match behavior', () => {
      const settings = createSettings({})
      settings.subOrgConfigs = {
        'frontend-*': { source: '.github/suborgs/frontend.yml', tag: 'A' }
      }
      const before = settings.getSubOrgConfig('frontend-app')
      settings.getAllMatchingSubOrgSources('frontend-app')
      const after = settings.getSubOrgConfig('frontend-app')
      expect(after).toBe(before)
      expect(after.tag).toBe('A')
    })
  })

  describe('shouldConsiderReevaluation', () => {
    let settings
    const repo = { owner: 'o', repo: 'foo' }
    beforeEach(() => {
      settings = createSettings({})
      settings.repoConfigs = {}
    })

    describe('with changeSignals (preferred path)', () => {
      it('returns true when teams plugin reported changes', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { teamsChanged: true })).toBe(true)
      })

      it('returns true when custom_properties plugin reported changes', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { propertiesChanged: true })).toBe(true)
      })

      it('returns true on repository rename', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { renamed: true })).toBe(true)
      })

      it('returns true on repository create', () => {
        expect(settings.shouldConsiderReevaluation(repo, null, { created: true })).toBe(true)
      })

      it('returns false when all change signals are false (steady state)', () => {
        // Pre-existing team that is already on the repo -> diffable reports no
        // changes -> we must NOT trigger a re-eval reload.
        settings.repoConfigs = { 'foo.yml': { teams: [{ name: 'core' }] } }
        const signals = { teamsChanged: false, propertiesChanged: false, renamed: false, created: false }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' }, signals)).toBe(false)
      })
    })

    describe('without changeSignals (fallback)', () => {
      it('returns false when there is no repo-yml entry', () => {
        expect(settings.shouldConsiderReevaluation(repo, null)).toBe(false)
        expect(settings.shouldConsiderReevaluation(repo, undefined)).toBe(false)
      })

      it('returns false when repo-yml has no teams/properties and no rename', () => {
        settings.repoConfigs = { 'foo.yml': { repository: { name: 'foo' } } }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' })).toBe(false)
      })

      it('returns true when repo-yml has teams', () => {
        settings.repoConfigs = { 'foo.yml': { teams: [{ name: 'core' }] } }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' })).toBe(true)
      })

      it('returns true when repo-yml has custom_properties', () => {
        settings.repoConfigs = { 'foo.yaml': { custom_properties: [{ name: 'EDP', value: 'true' }] } }
        expect(settings.shouldConsiderReevaluation(repo, { name: 'foo' })).toBe(true)
      })

      it('returns true on rename via repo.oldname', () => {
        expect(settings.shouldConsiderReevaluation({ owner: 'o', repo: 'new', oldname: 'old' }, null)).toBe(true)
      })

      it('returns true on rename via repoConfig.oldname', () => {
        expect(settings.shouldConsiderReevaluation(repo, { name: 'new', oldname: 'old' })).toBe(true)
      })
    })
  })

  describe('maybeReevaluateSuborg', () => {
    it('is a no-op when reevaluateOnChange is false', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = false
      settings.repoConfigs = { 'r.yml': { teams: [{ name: 'core' }] } }
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r' }, { name: 'r' }, new Set())
      expect(reloadSpy).not.toHaveBeenCalled()
    })

    it('is a no-op when repo-yml has no triggers (teams/properties/rename)', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.repoConfigs = { 'r.yml': { repository: { name: 'r' } } }
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r' }, { name: 'r' }, new Set())
      expect(reloadSpy).not.toHaveBeenCalled()
    })

    it('is a no-op when changeSignals report no plugin changes (preexisting team)', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      // repo-yml has teams, but plugin reported no change (team already on repo)
      settings.repoConfigs = { 'r.yml': { teams: [{ name: 'core' }] } }
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      const signals = { teamsChanged: false, propertiesChanged: false, renamed: false, created: false }
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r' }, { name: 'r' }, new Set(), signals)
      expect(reloadSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('stops when the matched suborg source set is stable (no new sources)', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.subOrgConfigs = { 'r*': { source: '.github/suborgs/x.yml' } }
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      // pre = post = {x.yml} -> stable, no recursion
      const pre = new Set(['.github/suborgs/x.yml'])
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, pre, { teamsChanged: true })
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('recurses once when a new suborg source appears, then stops at depth cap', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      // After reload, a new suborg matches r1
      settings.subOrgConfigs = { 'r*': { source: '.github/suborgs/new.yml' } }
      settings.repoConfigs = { 'r1.yml': { teams: [{ name: 't' }] } }
      jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      jest.spyOn(settings, 'getRepoConfigs').mockResolvedValue({ 'r1.yml': { teams: [{ name: 't' }] } })
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      const pre = new Set() // pre-apply: nothing matched
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, pre, { teamsChanged: true })
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(settings.reevaluationDepth.get('r1')).toBe(1)
    })

    it('respects MAX_REEVALUATION_DEPTH and logs a warning', async () => {
      const settings = createSettings({})
      settings.reevaluateOnChange = true
      settings.reevaluationDepth.set('r1', 1) // already at cap
      settings.repoConfigs = { 'r1.yml': { teams: [{ name: 't' }] } }
      stubContext.log.warn = jest.fn()
      const reloadSpy = jest.spyOn(settings, 'reloadSubOrgConfigs').mockResolvedValue()
      const updateSpy = jest.spyOn(settings, 'updateRepos').mockResolvedValue()
      await settings.maybeReevaluateSuborg({ owner: 'o', repo: 'r1' }, { name: 'r1' }, new Set(), { teamsChanged: true })
      expect(reloadSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
      expect(stubContext.log.warn).toHaveBeenCalledWith(expect.stringContaining('max depth'))
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // disable_plugins
  // ────────────────────────────────────────────────────────────────────────
  describe('disable_plugins', () => {
    const DeploymentConfig = require('../../../lib/deploymentConfig')
    let savedDeploymentDisable
    let savedPlugins

    beforeEach(() => {
      savedDeploymentDisable = DeploymentConfig.config && DeploymentConfig.config.disable_plugins
      if (DeploymentConfig.config) delete DeploymentConfig.config.disable_plugins
      savedPlugins = { ...Settings.PLUGINS }
    })

    afterEach(() => {
      if (DeploymentConfig.config) {
        if (savedDeploymentDisable !== undefined) {
          DeploymentConfig.config.disable_plugins = savedDeploymentDisable
        } else {
          delete DeploymentConfig.config.disable_plugins
        }
      }
      Object.keys(Settings.PLUGINS).forEach(k => { Settings.PLUGINS[k] = savedPlugins[k] })
    })

    // ── normalizeDisableEntries ──────────────────────────────────────────
    describe('normalizeDisableEntries', () => {
      it('1. string shorthand defaults target=all and sets declaredAt', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries(['labels'], 'org')
        expect(out).toEqual([{ plugin: 'labels', target: 'all', declaredAt: 'org' }])
      })

      it('2. object form preserves each of self|children|all', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries([
          { plugin: 'rulesets', target: 'self' },
          { plugin: 'branches', target: 'children' },
          { plugin: 'labels', target: 'all' }
        ], 'org')
        expect(out).toEqual([
          { plugin: 'rulesets', target: 'self', declaredAt: 'org' },
          { plugin: 'branches', target: 'children', declaredAt: 'org' },
          { plugin: 'labels', target: 'all', declaredAt: 'org' }
        ])
      })

      it('3. unknown plugin name throws descriptive error', () => {
        const settings = createSettings({})
        expect(() => settings.normalizeDisableEntries(['nope'], 'org'))
          .toThrow(/unknown plugin 'nope'/)
      })

      it('4. invalid target throws', () => {
        const settings = createSettings({})
        expect(() => settings.normalizeDisableEntries([{ plugin: 'labels', target: 'bogus' }], 'org'))
          .toThrow(/invalid target 'bogus'/)
      })

      it('5. repository and archive are accepted as plugin names', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries(['repository', 'archive'], 'org')
        expect(out.map(e => e.plugin).sort()).toEqual(['archive', 'repository'])
      })

      it('6. at declaredAt=repo, target=children normalizes to all', () => {
        const settings = createSettings({})
        const out = settings.normalizeDisableEntries([{ plugin: 'labels', target: 'children' }], 'repo')
        expect(out).toEqual([{ plugin: 'labels', target: 'all', declaredAt: 'repo' }])
      })
    })

    // ── computeStripMap ──────────────────────────────────────────────────
    describe('computeStripMap', () => {
      const repoName = 'my-repo'

      it('7. empty configs produce empty map (all four levels are empty sets)', () => {
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        for (const level of ['deployment', 'org', 'suborg', 'repo']) {
          expect(sm.get(level).size).toBe(0)
        }
      })

      it('8. org target:self for rulesets strips only the org layer', () => {
        const settings = createSettings({ disable_plugins: [{ plugin: 'rulesets', target: 'self' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('org')]).toEqual(['rulesets'])
        expect(sm.get('suborg').size).toBe(0)
        expect(sm.get('repo').size).toBe(0)
        expect(sm.get('deployment').size).toBe(0)
      })

      it('9. org target:children for branches strips suborg+repo', () => {
        const settings = createSettings({ disable_plugins: [{ plugin: 'branches', target: 'children' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect(sm.get('org').size).toBe(0)
        expect([...sm.get('suborg')]).toEqual(['branches'])
        expect([...sm.get('repo')]).toEqual(['branches'])
      })

      it('10. org target:all for labels strips org+suborg+repo', () => {
        const settings = createSettings({ disable_plugins: ['labels'] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('org')]).toEqual(['labels'])
        expect([...sm.get('suborg')]).toEqual(['labels'])
        expect([...sm.get('repo')]).toEqual(['labels'])
      })

      it('11. suborg target:all contributes only when a suborg matches the repo', () => {
        const settings = createSettings({})
        settings.subOrgConfigs = {
          [repoName]: { disable_plugins: ['teams'], source: '.github/suborgs/x.yml' }
        }
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('suborg')]).toEqual(['teams'])
        expect([...sm.get('repo')]).toEqual(['teams'])

        const sm2 = settings.computeStripMap('other-repo')
        expect(sm2.get('suborg').size).toBe(0)
        expect(sm2.get('repo').size).toBe(0)
      })

      it('12. repo-declared target:all only strips repo layer', () => {
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = { [`${repoName}.yml`]: { disable_plugins: ['labels'] } }
        const sm = settings.computeStripMap(repoName)
        expect(sm.get('org').size).toBe(0)
        expect(sm.get('suborg').size).toBe(0)
        expect([...sm.get('repo')]).toEqual(['labels'])
      })

      it('13. deployment target:children strips org+suborg+repo', () => {
        DeploymentConfig.config.disable_plugins = [{ plugin: 'milestones', target: 'children' }]
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const sm = settings.computeStripMap(repoName)
        expect(sm.get('deployment').size).toBe(0)
        expect([...sm.get('org')]).toEqual(['milestones'])
        expect([...sm.get('suborg')]).toEqual(['milestones'])
        expect([...sm.get('repo')]).toEqual(['milestones'])
      })

      it('14. union across layers: org self + repo all → org and repo both contain plugin', () => {
        const settings = createSettings({ disable_plugins: [{ plugin: 'labels', target: 'self' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = { [`${repoName}.yml`]: { disable_plugins: ['labels'] } }
        const sm = settings.computeStripMap(repoName)
        expect([...sm.get('org')]).toEqual(['labels'])
        expect(sm.get('suborg').size).toBe(0)
        expect([...sm.get('repo')]).toEqual(['labels'])
      })
    })

    // ── childPluginsList integration ─────────────────────────────────────
    describe('childPluginsList integration', () => {
      it('15. org disables custom_properties (target:all) → not in plugin list even with repo override', () => {
        const settings = createSettings({
          disable_plugins: ['custom_properties'],
          custom_properties: [{ property_name: 'a', value: '1' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = { 'foo.yml': { custom_properties: [{ property_name: 'b', value: '2' }] } }
        const list = settings.childPluginsList({ repo: 'foo' })
        const pluginNames = list.map(([P]) => Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(pluginNames).not.toContain('custom_properties')
      })

      it('16. suborg-declared branches + suborg disable_plugins:branches → stripped for matched repo only', () => {
        // Per the matrix, suborg target:all strips suborg+repo (NOT org).
        // So we put branches only at suborg level for a meaningful test.
        const settings = createSettings({})
        settings.subOrgConfigs = {
          'matched-repo': {
            disable_plugins: ['branches'],
            branches: [{ name: 'main', protection: {} }],
            source: '.github/suborgs/x.yml'
          },
          'other-repo': {
            // different suborg without disable; still declares branches
            branches: [{ name: 'main', protection: {} }],
            source: '.github/suborgs/y.yml'
          }
        }
        settings.repoConfigs = {}
        const matched = settings.childPluginsList({ repo: 'matched-repo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        const other = settings.childPluginsList({ repo: 'other-repo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(matched).not.toContain('branches')
        expect(other).toContain('branches')
      })

      it('17. repo-level labels + repo disable_plugins:labels → stripped for that repo only', () => {
        // Repo target:all strips only the repo layer (matrix). To demonstrate
        // scoping we put labels in each repo's own yml so the strip is effective.
        const settings = createSettings({})
        settings.subOrgConfigs = {}
        settings.repoConfigs = {
          'foo.yml': { disable_plugins: ['labels'], labels: { include: [{ name: 'bug' }] } },
          'bar.yml': { labels: { include: [{ name: 'bug' }] } }
        }
        const foo = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        const bar = settings.childPluginsList({ repo: 'bar' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(foo).not.toContain('labels')
        expect(bar).toContain('labels')
      })

      it('18. org target:children for variables: org-level variables still run per-repo (documented nuance)', () => {
        // target:children strips from suborg+repo only; merged repo plugin
        // config still inherits the org-level variables → plugin DOES run.
        const settings = createSettings({
          disable_plugins: [{ plugin: 'variables', target: 'children' }],
          variables: [{ name: 'FOO', value: 'bar' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const names = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(names).toContain('variables')
      })

      it('19. org target:all for variables: variables plugin is fully suppressed', () => {
        const settings = createSettings({
          disable_plugins: [{ plugin: 'variables', target: 'all' }],
          variables: [{ name: 'FOO', value: 'bar' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        const names = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(names).not.toContain('variables')
      })
    })

    // ── updateOrg integration ────────────────────────────────────────────
    describe('updateOrg integration', () => {
      function stubPlugin () {
        const sync = jest.fn().mockResolvedValue([])
        const ctor = jest.fn().mockImplementation(() => ({ sync }))
        return { ctor, sync }
      }

      it('20. org disable rulesets (target:self) → rulesets plugin NOT invoked', async () => {
        const { ctor } = stubPlugin()
        Settings.PLUGINS.rulesets = ctor
        const settings = createSettings({
          disable_plugins: [{ plugin: 'rulesets', target: 'self' }],
          rulesets: [{ name: 'foo' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()
        expect(ctor).not.toHaveBeenCalled()
      })

      it('21. org disable custom_repository_roles (shorthand) → plugin NOT invoked', async () => {
        const { ctor } = stubPlugin()
        Settings.PLUGINS.custom_repository_roles = ctor
        const settings = createSettings({
          disable_plugins: ['custom_repository_roles'],
          custom_repository_roles: [{ name: 'sec' }]
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()
        expect(ctor).not.toHaveBeenCalled()
      })

      it('22. deployment disable rulesets overrides org config that wants rulesets', async () => {
        DeploymentConfig.config.disable_plugins = ['rulesets']
        const { ctor } = stubPlugin()
        Settings.PLUGINS.rulesets = ctor
        const settings = createSettings({ rulesets: [{ name: 'foo' }] })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        await settings.updateOrg()
        expect(ctor).not.toHaveBeenCalled()
      })
    })

    // ── updateRepos integration ──────────────────────────────────────────
    describe('updateRepos integration', () => {
      it('23. org disable repository → RepoPlugin not instantiated', async () => {
        const repoSync = jest.fn().mockResolvedValue([])
        const repoCtor = jest.fn().mockImplementation(() => ({ sync: repoSync, renamed: false, created: false }))
        Settings.PLUGINS.repository = repoCtor
        const settings = createSettings({
          disable_plugins: ['repository'],
          repository: { name: 'will-not-be-used' }
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        // Avoid running child plugins (their internal logic isn't under test).
        jest.spyOn(settings, 'childPluginsList').mockReturnValue([])
        await settings.updateRepos({ owner: 'o', repo: 'r' })
        expect(repoCtor).not.toHaveBeenCalled()
      })

      it('24. org disable archive → archive plugin getState NOT invoked', async () => {
        const Archive = require('../../../lib/plugins/archive')
        const getStateSpy = jest.spyOn(Archive.prototype, 'getState').mockResolvedValue({ shouldArchive: false, shouldUnarchive: false })
        // RepoPlugin still runs; stub it to a no-op constructor.
        const repoSync = jest.fn().mockResolvedValue([])
        Settings.PLUGINS.repository = jest.fn().mockImplementation(() => ({ sync: repoSync, renamed: false, created: false }))
        const settings = createSettings({
          disable_plugins: ['archive'],
          repository: { name: 'r' }
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        jest.spyOn(settings, 'childPluginsList').mockReturnValue([])
        await settings.updateRepos({ owner: 'o', repo: 'r' })
        expect(getStateSpy).not.toHaveBeenCalled()
        getStateSpy.mockRestore()
      })
    })

    // ── cascade enforcement ──────────────────────────────────────────────
    describe('cascade enforcement', () => {
      it('25. org target:all labels; repo declares empty disable_plugins → labels still disabled', () => {
        const settings = createSettings({
          disable_plugins: ['labels'],
          labels: { include: [{ name: 'bug' }] }
        })
        settings.subOrgConfigs = {}
        settings.repoConfigs = { 'foo.yml': { disable_plugins: [] } }
        const names = settings.childPluginsList({ repo: 'foo' }).map(([P]) =>
          Object.keys(Settings.PLUGINS).find(k => Settings.PLUGINS[k] === P))
        expect(names).not.toContain('labels')
      })
    })

    // ── NOP mode ─────────────────────────────────────────────────────────
    describe('NOP mode', () => {
      it('26. each strip produces a NopCommand with type=INFO and plugin/level info', () => {
        const settings = new Settings(true, stubContext, mockRepo, {
          disable_plugins: ['labels'],
          labels: { include: [{ name: 'bug' }] }
        }, mockRef)
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        settings.childPluginsList({ repo: 'foo' })
        const nopEntries = settings.results.filter(r => r && r.plugin === 'disable_plugins')
        expect(nopEntries.length).toBeGreaterThan(0)
        expect(nopEntries[0].type).toBe('INFO')
        expect(nopEntries[0].action.msg).toMatch(/labels/)
        expect(nopEntries[0].action.msg).toMatch(/declared by/)
      })

      it('27. dedup retains all disable_plugins NopCommands when multiple plugins are disabled for the same repo', () => {
        // Disable both labels and teams at org level for all layers.
        const settings = new Settings(true, stubContext, mockRepo, {
          disable_plugins: ['labels', 'teams'],
          labels: [{ name: 'bug', color: 'red' }],
          teams: [{ name: 'core', permission: 'push' }]
        }, mockRef)
        settings.subOrgConfigs = {}
        settings.repoConfigs = {}
        settings.childPluginsList({ repo: 'foo' })
        const nopEntries = settings.results.filter(r => r && r.plugin === 'disable_plugins')
        // Both 'labels' and 'teams' disable messages must survive; the old
        // dedup (key = type+repo+plugin+endpoint) would drop one of them
        // because they share the same empty endpoint. The new key adds
        // action.msg, so each unique message is kept.
        const msgs = nopEntries.map(r => r.action.msg)
        expect(msgs.some(m => /labels/.test(m))).toBe(true)
        expect(msgs.some(m => /teams/.test(m))).toBe(true)
      })
    })
  })
}) // Settings Tests
