const AppInstallations = require('../../../../lib/plugins/appInstallations')

describe('AppInstallations', () => {
  let github
  let appGithub
  let log
  let errors

  beforeEach(() => {
    log = {
      debug: jest.fn(),
      error: jest.fn()
    }
    errors = []

    github = {
      paginate: jest.fn(),
      repos: {
        get: jest.fn()
      },
      request: jest.fn().mockResolvedValue({ data: {} })
    }
    github.request.endpoint = {
      merge: jest.fn().mockReturnValue({})
    }

    appGithub = {
      paginate: jest.fn(),
      request: jest.fn().mockResolvedValue({ data: {} })
    }
    appGithub.request.endpoint = {
      merge: jest.fn().mockReturnValue({})
    }
  })

  describe('syncDelta', () => {
    it('returns empty array for no changes', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([])
      expect(result).toEqual([])
    })

    it('returns empty array for null changes', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta(null)
      expect(result).toEqual([])
    })

    it('reports error when enterprise client is not configured', async () => {
      const plugin = new AppInstallations(true, github, null, { owner: 'org', repo: 'admin' }, null, log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'test-app',
        installation_id: 1,
        repository_selection: new Set(['repo-a']),
        repository_unselection: new Set()
      }])

      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('ERROR')
    })

    it('generates NopCommand in nop mode for specific repos', async () => {
      // Mock enterprise client listing repos
      appGithub.paginate.mockResolvedValue([])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(['repo-a', 'repo-b']),
        repository_unselection: new Set(['repo-c'])
      }])

      expect(result).toHaveLength(1)
      expect(result[0].plugin).toBe('app_installations')
      expect(result[0].action.additions).toEqual(['repo-a', 'repo-b'])
      expect(result[0].action.deletions).toEqual(['repo-c'])
    })

    it('generates NopCommand in nop mode for "all" selection', async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: 'all',
        repository_unselection: new Set()
      }])

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['(all repositories)'])
    })

    it('suppresses unselections in additive mode', async () => {
      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true

      const result = await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(['repo-a']),
        repository_unselection: new Set(['repo-b'])
      }])

      expect(result).toHaveLength(1)
      // Should only have additions, no deletions
      expect(result[0].action.additions).toEqual(['repo-a'])
      expect(result[0].action.deletions).toBeNull()
    })

    it('processes unselections before selections in non-nop mode', async () => {
      const callOrder = []
      appGithub.request.mockImplementation((route) => {
        if (route.includes('/repositories/remove')) callOrder.push('remove')
        if (route.includes('/repositories/add')) callOrder.push('add')
        return Promise.resolve({ data: {} })
      })

      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncDelta([{
        app_slug: 'copilot',
        installation_id: 1,
        repository_selection: new Set(['repo-a']),
        repository_unselection: new Set(['repo-b'])
      }])

      // Removal must be applied before addition so a repo removed by one
      // config and added by another ends up present.
      expect(callOrder).toEqual(['remove', 'add'])
    })
  })

  describe('syncFull', () => {
    it('returns empty array for no desired state', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({})
      expect(result).toEqual([])
    })

    it('reports error when enterprise client is missing', async () => {
      const plugin = new AppInstallations(true, github, null, { owner: 'org', repo: 'admin' }, null, log, errors)
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']) }
      })
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('ERROR')
    })

    it('generates NopCommand with additions and deletions in nop mode', async () => {
      // Mock listInstallationRepos (live state)
      appGithub.paginate.mockResolvedValue([
        { name: 'existing-repo', id: 10 },
        { name: 'stale-repo', id: 20 }
      ])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: {
          installation_id: 1,
          repos: new Set(['existing-repo', 'new-repo'])
        }
      })

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['new-repo'])
      expect(result[0].action.deletions).toEqual(['stale-repo'])
    })

    it('suppresses deletions in additive mode during full sync', async () => {
      appGithub.paginate.mockResolvedValue([
        { name: 'existing-repo', id: 10 },
        { name: 'stale-repo', id: 20 }
      ])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true

      const result = await plugin.syncFull({
        copilot: {
          installation_id: 1,
          repos: new Set(['existing-repo', 'new-repo'])
        }
      })

      expect(result).toHaveLength(1)
      expect(result[0].action.additions).toEqual(['new-repo'])
      expect(result[0].action.deletions).toBeNull()
    })

    it('skips app when no changes needed', async () => {
      appGithub.paginate.mockResolvedValue([
        { name: 'repo-a', id: 10 }
      ])

      const plugin = new AppInstallations(true, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: {
          installation_id: 1,
          repos: new Set(['repo-a'])
        }
      })

      expect(result).toEqual([])
    })

    it("toggles to 'all' when desired is all and current is selected", async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncFull({
        copilot: { installation_id: 1, repos: 'all', current_selection: 'selected' }
      })

      expect(appGithub.request).toHaveBeenCalledWith(
        expect.stringContaining('/repositories'),
        expect.objectContaining({ repository_selection: 'all', installation_id: 1 })
      )
    })

    it('skips when desired is all and current is already all', async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: 'all', current_selection: 'all' }
      })

      expect(result).toEqual([])
      expect(appGithub.request).not.toHaveBeenCalled()
    })

    it("narrows from 'all' to 'selected' when desired is a set", async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']), current_selection: 'all' }
      })

      expect(appGithub.request).toHaveBeenCalledWith(
        expect.stringContaining('/repositories'),
        expect.objectContaining({ repository_selection: 'selected', repositories: ['repo-a'] })
      )
    })

    it("leaves 'all' untouched in additive mode", async () => {
      const plugin = new AppInstallations(false, github, appGithub, { owner: 'org', repo: 'admin' }, 'ent', log, errors)
      plugin.additive = true
      const result = await plugin.syncFull({
        copilot: { installation_id: 1, repos: new Set(['repo-a']), current_selection: 'all' }
      })

      expect(result).toEqual([])
      expect(appGithub.request).not.toHaveBeenCalled()
    })
  })
})
