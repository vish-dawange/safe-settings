#!/usr/bin/env node

/**
 * Simple example demonstrating the mergeConfigs function
 */

const mergeConfigs = require('../lib/mergeConfigs')

console.log('═══════════════════════════════════════════════════')
console.log('  mergeConfigs() Function Examples')
console.log('═══════════════════════════════════════════════════\n')

// Example 1: Array Replace Mode
console.log('Example 1: Array Replace Mode (replaceArrays = true)')
console.log('─────────────────────────────────────────────────\n')

const json1 = `
teams:
  - team-a
  - team-b
`

const json2 = `
teams:
  - team-c
`

console.log('JSON-1:')
console.log(json1)
console.log('JSON-2:')
console.log(json2)

const replaced = mergeConfigs(json1, json2, true)
console.log('Result (replace=true):')
console.log(JSON.stringify(replaced, null, 2))
console.log('✓ Second array REPLACES first array\n')

// Example 2: Array Append Mode
console.log('Example 2: Array Append Mode (replaceArrays = false)')
console.log('─────────────────────────────────────────────────\n')

const appended = mergeConfigs(json1, json2, false)
console.log('Result (replace=false):')
console.log(JSON.stringify(appended, null, 2))
console.log('✓ Second array is APPENDED to first array\n')

// Example 3: Object Merging
console.log('Example 3: Object Merging')
console.log('─────────────────────────────────────────────────\n')

const global = `
repository:
  private: true
  has_issues: true
`

const org = `
repository:
  visibility: internal
  has_issues: false
`

console.log('Global Settings:')
console.log(global)
console.log('Organization Settings:')
console.log(org)

const merged = mergeConfigs(global, org, true)
console.log('Merged Result:')
console.log(JSON.stringify(merged, null, 2))
console.log('✓ Objects are merged, second takes precedence\n')

// Example 4: Complex Case with Both Arrays and Objects
console.log('Example 4: Complex Nested Structure')
console.log('─────────────────────────────────────────────────\n')

const complex1 = `
repository:
  settings:
    security:
      scanning: true
  teams:
    - admin-team
    - dev-team
labels:
  - bug
  - feature
`

const complex2 = `
repository:
  settings:
    security:
      alerts: true
  teams:
    - qa-team
labels:
  - enhancement
`

console.log('Config 1:')
console.log(complex1)
console.log('Config 2:')
console.log(complex2)

console.log('Result with REPLACE mode:')
const complexReplaced = mergeConfigs(complex1, complex2, true)
console.log(JSON.stringify(complexReplaced, null, 2))

console.log('\nResult with APPEND mode:')
const complexAppended = mergeConfigs(complex1, complex2, false)
console.log(JSON.stringify(complexAppended, null, 2))

console.log('\n═══════════════════════════════════════════════════')
console.log('  Usage Summary')
console.log('═══════════════════════════════════════════════════\n')
console.log('const mergeConfigs = require("./lib/mergeConfigs")\n')
console.log('// Replace arrays (default)')
console.log('mergeConfigs(json1, json2, true)\n')
console.log('// Append arrays')
console.log('mergeConfigs(json1, json2, false)\n')
