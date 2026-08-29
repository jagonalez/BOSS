import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { knowledgeFreshness, productGraphShapeError, validateProductGraph, type ProductGraph, type ProductGraphNode } from './product-graph.ts'

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

test('runtime shape validation accepts every Product Graph node variant', () => {
  const graph: ProductGraph = {
    version: 1,
    nodes: [
      node({ id: 'product', kind: 'product', name: 'Product', purpose: 'Purpose' }),
      node({ id: 'component', kind: 'component', name: 'Component', componentType: 'service' }),
      node({ id: 'codebase', kind: 'codebase', name: 'Codebase', sourceKind: 'git', remote: 'https://example.test/repo.git' }),
      node({ id: 'checkout', kind: 'checkout', name: 'Checkout', path: '/tmp/orbit', branch: 'main', main: true }),
      node({ id: 'environment', kind: 'environment', name: 'Environment', environmentType: 'production' }),
      node({ id: 'platform', kind: 'platform', name: 'Platform', platformType: 'cloud', externalRef: 'platform-1' }),
      node({ id: 'deployment', kind: 'deployment', name: 'Deployment', health: 'healthy', observedAt: now }),
      node({ id: 'project', kind: 'project', name: 'Project', outcome: 'Ship', successCriteria: ['Green'], status: 'active', health: 'on-track', startedAt: now }),
      node({ id: 'work-item', kind: 'work-item', name: 'Work item', workType: 'code', acceptanceCriteria: ['Done'], status: 'running' }),
      node({ id: 'run', kind: 'run', name: 'Run', threadIds: ['thread-1'], status: 'running', startedAt: now }),
      node({ id: 'rollout', kind: 'rollout', name: 'Rollout', status: 'running', stages: [{ id: 'stage-1', name: 'Production', status: 'running', environmentId: 'environment' }] }),
      node({ id: 'signal', kind: 'signal', name: 'Signal', signalType: 'monitor' }),
      node({ id: 'observation', kind: 'observation', name: 'Observation', observedAt: now, status: 'healthy', value: { latency: 10 } }),
      node({ id: 'artifact', kind: 'artifact', name: 'Artifact', artifactType: 'test-result' }),
      node({ id: 'decision', kind: 'decision', name: 'Decision', status: 'accepted', decidedAt: now }),
      node({
        id: 'knowledge', kind: 'knowledge', name: 'Knowledge', knowledgeType: 'architecture', content: 'Fictional context',
        sources: [{ resourceId: 'codebase', revision: 'abc', paths: [{ path: 'README.md', contentHash: 'hash' }], scopeHash: 'scope' }],
        generatedAt: now, generator: { model: 'test-model', promptVersion: '1' }, freshness: 'fresh'
      })
    ],
    relations: [{ id: 'relation', kind: 'contains', sourceId: 'product', targetId: 'component', createdAt: now, metadata: { source: 'test' } }]
  }

  assert.equal(productGraphShapeError(graph), null)
})

test('runtime shape validation rejects unknown, incomplete, and nested malformed values', () => {
  const base = { version: 1, nodes: [], relations: [] }
  const invalid = [
    { ...base, nodes: [{ id: 'bad', kind: 'imaginary', name: 'Bad', createdAt: now, updatedAt: now }] },
    { ...base, nodes: [{ id: 'codebase', kind: 'codebase', name: 'Missing source kind', createdAt: now, updatedAt: now }] },
    { ...base, nodes: [{ id: 'product', kind: 'product', name: 'Bad time', createdAt: Number.POSITIVE_INFINITY, updatedAt: now }] },
    { ...base, relations: [{ id: 'relation', kind: 'imaginary', sourceId: 'a', targetId: 'b', createdAt: now }] },
    {
      ...base,
      nodes: [{
        id: 'knowledge', kind: 'knowledge', name: 'Bad receipt', createdAt: now, updatedAt: now,
        knowledgeType: 'architecture', content: 'Context', sources: [{ resourceId: 'codebase' }],
        generatedAt: now, generator: { model: 'test-model', promptVersion: '1' }, freshness: 'fresh'
      }]
    }
  ]

  for (const value of invalid) assert.ok(productGraphShapeError(value), JSON.stringify(value))
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
