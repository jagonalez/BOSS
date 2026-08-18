import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { policyOverrides, policySource, resolvePolicy } from './collaboration-policy.ts'

test('a project without its own setting follows the default', () => {
  // The bug this replaces: the fallback was a hardcoded 'off', so every
  // project had to be enabled by hand and a user with many projects could
  // never turn collaboration on once.
  assert.equal(resolvePolicy({}, 'collaborate', 'project_a'), 'collaborate')
  assert.equal(resolvePolicy({}, 'read', 'project_a'), 'read')
  assert.equal(resolvePolicy({}, 'off', 'project_a'), 'off')
})

test('a project setting overrides the default in both directions', () => {
  const policies = { project_quiet: 'off' as const, project_loud: 'collaborate' as const }
  assert.equal(resolvePolicy(policies, 'collaborate', 'project_quiet'), 'off')
  assert.equal(resolvePolicy(policies, 'off', 'project_loud'), 'collaborate')
})

test('one project’s setting never reaches another project', () => {
  // The reported bug: enabling collaboration wrote the policy onto whichever
  // project was opened last, so the project the agent actually ran in kept
  // reading 'off' and every backend was denied.
  const policies = { project_boss: 'collaborate' as const }
  assert.equal(resolvePolicy(policies, 'off', 'project_boss'), 'collaborate')
  assert.equal(resolvePolicy(policies, 'off', 'project_new_horizons'), 'off')
})

test('the source of a policy says whether it was inherited', () => {
  const policies = { project_a: 'read' as const }
  assert.equal(policySource(policies, 'project_a'), 'project')
  assert.equal(policySource(policies, 'project_b'), 'default')
})

test('a project explicitly set to the same value as the default still counts as its own', () => {
  // Otherwise the row would flip back to "Use default" and the setting would
  // silently follow a later change to the default.
  assert.equal(policySource({ project_a: 'off' }, 'project_a'), 'project')
})

test('only projects with their own setting are listed, named by path', () => {
  const overrides = policyOverrides(
    { project_b: 'read', project_a: 'collaborate' },
    { project_a: '/Users/dev/alpha', project_b: '/Users/dev/beta' }
  )
  assert.deepEqual(overrides, [
    { projectId: 'project_a', projectPath: '/Users/dev/alpha', policy: 'collaborate' },
    { projectId: 'project_b', projectPath: '/Users/dev/beta', policy: 'read' }
  ])
})

test('an overridden project with no known path still appears', () => {
  // Upgrades from version 2 kept no paths, so a project keeps its policy and
  // the settings row explains the missing name rather than dropping the row.
  assert.deepEqual(policyOverrides({ project_a: 'read' }, {}), [
    { projectId: 'project_a', projectPath: '', policy: 'read' }
  ])
})

test('a default with no overrides lists nothing to manage', () => {
  assert.deepEqual(policyOverrides({}, {}), [])
})
