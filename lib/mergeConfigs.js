const yaml = require('js-yaml')
const merge = require('deepmerge')
const mergeBy = require('./mergeArrayBy')

// Properties used to identify matching items in arrays
const NAME_FIELDS = ['name', 'username', 'actor_id', 'login', 'type', 'key_prefix', 'context']

/**
 * Merge two JSON/YAML configuration strings at the object level.
 * 
 * @param {string} json1 - First JSON/YAML content string (base)
 * @param {string} json2 - Second JSON/YAML content string (overlay - takes precedence)
 * @param {boolean} replaceArrays - If true, arrays in json2 replace arrays in json1.
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
 * // Replace mode: result = { teams: ['team-b', 'team-c'] }
 * const replaced = mergeConfigs(json1, json2, true)
 * 
 * // Smart merge mode: result = { teams: ['team-a', 'team-b', 'team-c'] }
 * const smartMerge = mergeConfigs(json1, json2, false)
 * 
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
function mergeConfigs (json1, json2, replaceArrays = false) {
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
 * Smart merge two arrays:
 * - For primitives: deduplicate (don't add items that already exist)
 * - For objects: match by name/username/etc properties and merge, or append if no match
 * 
 * @param {Array} target - Base array
 * @param {Array} source - Overlay array
 * @returns {Array} Merged array
 */
function smartMergeArrays (target, source) {
  // Check if arrays contain objects or primitives
  const hasObjects = source.some(item => item && typeof item === 'object' && !Array.isArray(item))
  
  if (!hasObjects) {
    // Simple array of primitives - deduplicate
    const result = [...target]
    source.forEach(item => {
      if (!result.includes(item)) {
        result.push(item)
      }
    })
    return result
  }
  
  // Array of objects - use existing mergeBy utility
  // mergeBy params: (key, configvalidator, overridevalidator, properties, target, source, options, githubContext)
  return mergeBy(null, null, null, NAME_FIELDS, target, source, undefined, undefined)
}

module.exports = mergeConfigs
