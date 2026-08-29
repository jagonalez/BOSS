import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { knowledgeFreshness, validateProductGraph, type ProductGraph, type ProductGraphNode } from './product-graph.ts'

const now = 1_788_000_000_000

type UntimedNode<Node extends ProductGraphNode = ProductGraphNode> =
  Node extends ProductGraphNode ? Omit<Node, 'createdAt' | 'updatedAt'> : never

function node(value: UntimedNode): ProductGraphNode {
  return { ...value, createdAt: now, updatedAt: now } as ProductGraphNode
}

test('a product can connect several codebases, deployments, and observability signals', () => {
  const graph: ProductGraph = {
    version: 1,
    nodes: [
      node({ id: 'product-orbit', kind: 'product', name: 'Orbit', purpose: 'A fictional multi-service product.' }),
      node({ id: 'component-gateway', kind: 'component', name: 'Gateway', componentType: 'service' }),
      node({ id: 'codebase-app', kind: 'codebase', name: 'orbit-app', sourceKind: 'git' }),
      node({ id: 'codebase-chart', kind: 'codebase', name: 'orbit-chart', sourceKind: 'git' }),
      node({ id: 'environment-production', kind: 'environment', name: 'Production', environmentType: 'production' }),
      node({ id: 'deployment-gateway-production', kind: 'deployment', name: 'Gateway production', health: 'healthy' }),
      node({ id: 'signal-beacon', kind: 'signal', name: 'Beacon', signalType: 'monitor' })
    ],
    relations: [
      { id: 'r1', kind: 'part-of', sourceId: 'component-gateway', targetId: 'product-orbit', createdAt: now },
      { id: 'r2', kind: 'built-from', sourceId: 'component-gateway', targetId: 'codebase-app', createdAt: now },
      { id: 'r3', kind: 'packaged-by', sourceId: 'component-gateway', targetId: 'codebase-chart', createdAt: now },
      { id: 'r4', kind: 'runs-in', sourceId: 'deployment-gateway-production', targetId: 'environment-production', createdAt: now },
      { id: 'r5', kind: 'observed-by', sourceId: 'deployment-gateway-production', targetId: 'signal-beacon', createdAt: now }
    ]
  }

  assert.deepEqual(validateProductGraph(graph), [])
})

test('graph validation catches duplicate, dangling, and semantically invalid relations', () => {
  const graph: ProductGraph = {
    version: 1,
    nodes: [
      node({ id: 'product-orbit', kind: 'product', name: 'Orbit' }),
      node({ id: 'product-orbit', kind: 'product', name: 'Duplicate Orbit' }),
      node({ id: 'environment-production', kind: 'environment', name: 'Production', environmentType: 'production' })
    ],
    relations: [
      { id: 'r1', kind: 'runs-in', sourceId: 'product-orbit', targetId: 'environment-production', createdAt: now },
      { id: 'r1', kind: 'depends-on', sourceId: 'product-orbit', targetId: 'missing', createdAt: now }
    ]
  }

  assert.deepEqual(validateProductGraph(graph).map((issue) => issue.code), [
    'duplicate-node',
    'invalid-relation',
    'duplicate-relation',
    'dangling-relation'
  ])
})

test('knowledge remains fresh across unrelated commits when its discovery scope is unchanged', () => {
  const artifact = {
    sources: [{
      resourceId: 'codebase-helm',
      revision: 'commit-a',
      scopeHash: 'helm-scope-a',
      paths: [{ path: 'values.yaml', contentHash: 'blob-values-a' }]
    }]
  }

  assert.equal(knowledgeFreshness(artifact, [{
    resourceId: 'codebase-helm',
    reachable: true,
    revision: 'commit-b',
    scopeHash: 'helm-scope-a',
    paths: { 'values.yaml': 'blob-values-a' }
  }]), 'fresh')
})

test('knowledge becomes stale when a scanned input or discovery scope changes', () => {
  const artifact = {
    sources: [{
      resourceId: 'codebase-helm',
      revision: 'commit-a',
      scopeHash: 'helm-scope-a',
      paths: [{ path: 'values.yaml', contentHash: 'blob-values-a' }]
    }]
  }

  assert.equal(knowledgeFreshness(artifact, [{
    resourceId: 'codebase-helm',
    reachable: true,
    revision: 'commit-b',
    scopeHash: 'helm-scope-b',
    paths: { 'values.yaml': 'blob-values-a' }
  }]), 'stale')

  assert.equal(knowledgeFreshness(artifact, [{
    resourceId: 'codebase-helm',
    reachable: true,
    revision: 'commit-b',
    scopeHash: 'helm-scope-a',
    paths: { 'values.yaml': 'blob-values-b' }
  }]), 'stale')
})

test('scanned files without a discovery receipt cannot prove a changed repository is fresh', () => {
  const artifact = {
    sources: [{
      resourceId: 'codebase-helm',
      revision: 'commit-a',
      paths: [{ path: 'values.yaml', contentHash: 'blob-values-a' }]
    }]
  }

  assert.equal(knowledgeFreshness(artifact, [{
    resourceId: 'codebase-helm',
    reachable: true,
    revision: 'commit-b',
    paths: { 'values.yaml': 'blob-values-a' }
  }]), 'unknown')
  assert.equal(knowledgeFreshness(artifact, []), 'unknown')
})
