import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { legacyProjectGraph } from './product-graph-legacy.ts'
// @ts-expect-error Application code uses bundler resolution.
import { validateProductGraph } from '../shared/product-graph.ts'

test('a legacy repository becomes one codebase with stable checkout identities', () => {
  const first = legacyProjectGraph({
    scope: {
      projectId: 'project_abc123',
      projectPath: '/Users/dev/orbit',
      executionPath: '/Users/dev/orbit-worktrees/feature'
    },
    checkouts: [
      { path: '/Users/dev/orbit', branch: 'main', main: true },
      { path: '/Users/dev/orbit-worktrees/feature', branch: 'feature', main: false }
    ],
    sourceKind: 'git',
    now: 100
  })
  const second = legacyProjectGraph({
    scope: {
      projectId: 'project_abc123',
      projectPath: '/Users/dev/orbit',
      executionPath: '/Users/dev/orbit-worktrees/feature'
    },
    checkouts: [
      { path: '/Users/dev/orbit', branch: 'main', main: true },
      { path: '/Users/dev/orbit-worktrees/feature', branch: 'feature', main: false }
    ],
    sourceKind: 'git',
    now: 200
  })

  assert.equal(first.nodes[0].id, 'codebase_abc123')
  assert.deepEqual(first.nodes.map((node) => node.id), second.nodes.map((node) => node.id))
  assert.equal(first.nodes.filter((node) => node.kind === 'checkout').length, 2)
  assert.deepEqual(validateProductGraph(first), [])
})

test('the active checkout is included even before the legacy checkout list discovers it', () => {
  const graph = legacyProjectGraph({
    scope: {
      projectId: 'project_abc123',
      projectPath: '/repo',
      executionPath: '/repo-linked'
    },
    checkouts: [{ path: '/repo', branch: 'main', main: true }],
    now: 100
  })

  assert.deepEqual(
    graph.nodes.filter((node) => node.kind === 'checkout').map((checkout) => checkout.path),
    ['/repo', '/repo-linked']
  )
})

test('global threads do not manufacture a codebase', () => {
  assert.deepEqual(legacyProjectGraph({
    scope: { projectId: 'global', projectPath: '', executionPath: '' },
    checkouts: [],
    now: 100
  }), { version: 1, nodes: [], relations: [] })
})
