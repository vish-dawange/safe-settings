const mergeConfigs = require('../../../lib/mergeConfigs')

describe('mergeConfigs', () => {
  describe('Array handling', () => {
    const json1 = `
teams:
  - team-a
  - team-b
`

    const json2 = `
teams:
  - team-c
`

    it('should replace arrays when replaceArrays=true', () => {
      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        teams: ['team-c']
      })
    })

    it('should smart merge arrays when replaceArrays=false (deduplicate)', () => {
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        teams: ['team-a', 'team-b', 'team-c']
      })
    })

    it('should not create duplicates in smart merge mode', () => {
      const json1 = `
teams:
  - team-a
  - team-b
`
      const json2 = `
teams:
  - team-b
  - team-c
`
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        teams: ['team-a', 'team-b', 'team-c']
      })
    })

    it('should default to replace mode when replaceArrays not specified', () => {
      const result = mergeConfigs(json1, json2)
      expect(result).toEqual({
        teams: ['team-c']
      })
    })
  })

  describe('Object merging', () => {
    const json1 = `
repository:
  private: true
  has_issues: true
`

    const json2 = `
repository:
  visibility: internal
  has_issues: false
`

    it('should merge objects recursively', () => {
      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        repository: {
          private: true,
          visibility: 'internal',
          has_issues: false
        }
      })
    })
  })

  describe('Complex nested structures', () => {
    const json1 = `
repository:
  settings:
    security:
      scanning: true
  teams:
    - team-a
    - team-b
labels:
  - name: bug
    color: red
`

    const json2 = `
repository:
  settings:
    security:
      alerts: true
  teams:
    - team-c
labels:
  - name: feature
    color: blue
`

    it('should handle complex nesting with array replace', () => {
      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({
        repository: {
          settings: {
            security: {
              scanning: true,
              alerts: true
            }
          },
          teams: ['team-c']
        },
        labels: [
          { name: 'feature', color: 'blue' }
        ]
      })
    })

    it('should handle complex nesting with smart array merge', () => {
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        repository: {
          settings: {
            security: {
              scanning: true,
              alerts: true
            }
          },
          teams: ['team-a', 'team-b', 'team-c']
        },
        labels: [
          { name: 'bug', color: 'red' },
          { name: 'feature', color: 'blue' }
        ]
      })
    })

    it('should merge matching objects in arrays by name property', () => {
      const json1 = `
collaborators:
  - username: alice
    permission: push
  - username: bob
    permission: pull
`
      const json2 = `
collaborators:
  - username: alice
    permission: admin
  - username: charlie
    permission: push
`
      const result = mergeConfigs(json1, json2, false)
      expect(result).toEqual({
        collaborators: [
          { username: 'alice', permission: 'admin' },
          { username: 'bob', permission: 'pull' },
          { username: 'charlie', permission: 'push' }
        ]
      })
    })
  })

  describe('JSON input', () => {
    it('should handle JSON strings', () => {
      const json1 = JSON.stringify({ teams: ['team-a', 'team-b'] })
      const json2 = JSON.stringify({ teams: ['team-c'] })

      const replaced = mergeConfigs(json1, json2, true)
      expect(replaced).toEqual({ teams: ['team-c'] })

      const appended = mergeConfigs(json1, json2, false)
      expect(appended).toEqual({ teams: ['team-a', 'team-b', 'team-c'] })
    })
  })

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      const result = mergeConfigs('', 'teams: [team-a]', true)
      expect(result).toEqual({ teams: ['team-a'] })
    })

    it('should handle null/undefined values', () => {
      const json1 = 'a: 1\nb: 2'
      const json2 = 'b: null'

      const result = mergeConfigs(json1, json2, true)
      expect(result).toEqual({ a: 1, b: null })
    })

    it('should skip prototype pollution', () => {
      const json1 = 'a: 1'
      const json2 = '__proto__: {polluted: true}'

      const result = mergeConfigs(json1, json2, true)
      expect(result.polluted).toBeUndefined()
    })
  })

  describe('Real-world example from documentation', () => {
    it('should merge global and org settings with replace', () => {
      const globalSettings = `
repository:
  private: true
`

      const orgSettings = `
repository:
  visibility: internal
`

      const result = mergeConfigs(globalSettings, orgSettings, true)
      expect(result).toEqual({
        repository: {
          private: true,
          visibility: 'internal'
        }
      })
    })
  })
})
