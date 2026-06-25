const AppOctokitClient = require('../../../lib/appOctokitClient')

describe('AppOctokitClient', () => {
  let github
  let log
  let client

  beforeEach(() => {
    log = {
      debug: jest.fn(),
      error: jest.fn()
    }

    github = {
      paginate: jest.fn(),
      request: jest.fn().mockResolvedValue({ data: {} })
    }
    github.request.endpoint = {
      merge: jest.fn().mockReturnValue({})
    }

    client = new AppOctokitClient({
      github,
      enterpriseSlug: 'my-enterprise',
      log
    })
  })

  describe('listOrgInstallations', () => {
    it('returns installations filtered by org', async () => {
      github.paginate.mockResolvedValue([
        { id: 1, app_slug: 'app-a', account: { login: 'my-org' } },
        { id: 2, app_slug: 'app-b', account: { login: 'other-org' } },
        { id: 3, app_slug: 'app-c', account: { login: 'my-org' } }
      ])

      const result = await client.listOrgInstallations('my-org')
      expect(result).toHaveLength(2)
      expect(result[0].app_slug).toBe('app-a')
      expect(result[1].app_slug).toBe('app-c')
    })

    it('throws descriptive error on 403', async () => {
      github.paginate.mockRejectedValue({ status: 403, message: 'Forbidden' })

      await expect(client.listOrgInstallations('my-org'))
        .rejects.toThrow(/enterprise/)
    })

    it('throws descriptive error on 404', async () => {
      github.paginate.mockRejectedValue({ status: 404, message: 'Not Found' })

      await expect(client.listOrgInstallations('my-org'))
        .rejects.toThrow(/enterprise/)
    })
  })

  describe('addReposToInstallation', () => {
    it('does nothing for empty array', async () => {
      await client.addReposToInstallation(123, [])
      expect(github.request).not.toHaveBeenCalled()
    })

    it('sends single batch for <= 50 repos', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => i + 1)
      await client.addReposToInstallation(123, ids)
      expect(github.request).toHaveBeenCalledTimes(1)
      expect(github.request).toHaveBeenCalledWith(
        expect.stringContaining('POST'),
        expect.objectContaining({
          repository_ids: ids,
          installation_id: 123
        })
      )
    })

    it('batches into chunks of 50', async () => {
      const ids = Array.from({ length: 120 }, (_, i) => i + 1)
      await client.addReposToInstallation(123, ids)
      expect(github.request).toHaveBeenCalledTimes(3) // 50 + 50 + 20
    })
  })

  describe('removeReposFromInstallation', () => {
    it('does nothing for empty array', async () => {
      await client.removeReposFromInstallation(123, [])
      expect(github.request).not.toHaveBeenCalled()
    })

    it('batches into chunks of 50', async () => {
      const ids = Array.from({ length: 75 }, (_, i) => i + 1)
      await client.removeReposFromInstallation(123, ids)
      expect(github.request).toHaveBeenCalledTimes(2) // 50 + 25
    })
  })

  describe('_chunk', () => {
    it('splits array into correct chunks', () => {
      expect(client._chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    })

    it('returns single chunk for small array', () => {
      expect(client._chunk([1, 2], 50)).toEqual([[1, 2]])
    })

    it('returns empty array for empty input', () => {
      expect(client._chunk([], 50)).toEqual([])
    })
  })
})
