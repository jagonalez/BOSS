import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectCheckout, ProjectScope } from './project-identity'
import type { ProductGraph } from '../shared/product-graph'
// @ts-expect-error Application code uses bundler resolution.
import { legacyProjectGraph } from './product-graph-legacy.ts'
// @ts-expect-error Application code uses bundler resolution.
import { ProductGraphStore } from './product-graph-store.ts'

interface Fixture {
  dir: string
  file: string
}

async function open(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'boss-product-graph-'))
  return { dir, file: join(dir, 'product-graph.json') }
}

async function close(fixture: Fixture): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true })
}

function orbitGraph(): ProductGraph {
  return {
    version: 1,
    nodes: [
      { id: 'product_orbit', kind: 'product', name: 'Orbit', purpose: 'Fictional example product', createdAt: 100, updatedAt: 100 },
      { id: 'codebase_orbit_app', kind: 'codebase', name: 'orbit-app', sourceKind: 'git', createdAt: 100, updatedAt: 100 },
      { id: 'checkout_orbit_main', kind: 'checkout', name: 'orbit-app · main checkout', path: '/Users/dev/orbit', branch: 'main', main: true, createdAt: 100, updatedAt: 100 }
    ],
    relations: [
      { id: 'relation_checkout_of', kind: 'checkout-of', sourceId: 'checkout_orbit_main', targetId: 'codebase_orbit_app', createdAt: 100 }
    ]
  }
}

function legacySeed(scope: ProjectScope, checkouts: ProjectCheckout[]): () => ProductGraph | null {
  return () => legacyProjectGraph({ scope, checkouts, sourceKind: 'git', now: 100 })
}

test('a replaced graph is validated, persisted, and read back by a fresh store', async () => {
  const fixture = await open()
  try {
    const store = new ProductGraphStore(fixture.file)
    const replaced = await store.replace(orbitGraph())
    assert.deepEqual(replaced, { ok: true, issues: [] })
    const afterReplace = await store.current()
    assert.equal(afterReplace.source, 'persisted')
    assert.equal(existsSync(fixture.file), true)
    assert.deepEqual(await readdir(fixture.dir), ['product-graph.json'])

    // A new instance stands in for the next app launch reading the same file.
    const reloaded = new ProductGraphStore(fixture.file)
    const snapshot = await reloaded.current()
    assert.equal(snapshot.source, 'persisted')
    assert.deepEqual(snapshot.issues, [])
    assert.deepEqual(snapshot.graph, orbitGraph())
  } finally {
    await close(fixture)
  }
})

test('a missing file adopts the folder-project projection without writing it', async () => {
  const fixture = await open()
  try {
    const scope: ProjectScope = {
      projectId: 'project_abc123',
      projectPath: '/Users/dev/orbit',
      executionPath: '/Users/dev/orbit'
    }
    const checkouts: ProjectCheckout[] = [{ path: '/Users/dev/orbit', branch: 'main', main: true }]
    const store = new ProductGraphStore(fixture.file, legacySeed(scope, checkouts))
    const snapshot = await store.current()

    assert.equal(snapshot.source, 'seeded-legacy-project')
    assert.deepEqual(snapshot.issues, [])
    assert.equal(snapshot.graph.nodes[0].id, 'codebase_abc123')
    assert.equal(snapshot.graph.nodes[0].kind, 'codebase')
    assert.ok(snapshot.graph.nodes.slice(1).every((node) => node.kind === 'checkout'))
    assert.ok(snapshot.graph.relations.every((relation) => relation.kind === 'checkout-of'))
    // The seed is derived, not durable: nothing is written until a replace.
    assert.equal(existsSync(fixture.file), false)
  } finally {
    await close(fixture)
  }
})

test('a missing file with no known project seeds an empty graph', async () => {
  const fixture = await open()
  try {
    const store = new ProductGraphStore(fixture.file)
    const snapshot = await store.current()
    assert.equal(snapshot.source, 'seeded-empty')
    assert.deepEqual(snapshot.graph, { version: 1, nodes: [], relations: [] })
  } finally {
    await close(fixture)
  }
})

test('a malformed file falls back to the seed and is flagged', async () => {
  const fixture = await open()
  try {
    await writeFile(fixture.file, '{ not json', 'utf8')
    const store = new ProductGraphStore(fixture.file)
    const snapshot = await store.current()
    assert.equal(snapshot.source, 'malformed-file')
    assert.deepEqual(snapshot.graph, { version: 1, nodes: [], relations: [] })

    const shapedWrong = JSON.stringify({ version: 1, nodes: 'many', relations: [] })
    await writeFile(fixture.file, shapedWrong, 'utf8')
    const second = new ProductGraphStore(fixture.file)
    const again = await second.current()
    assert.equal(again.source, 'malformed-file')
    assert.deepEqual(again.graph, { version: 1, nodes: [], relations: [] })
  } finally {
    await close(fixture)
  }
})

test('an unknown schema version is served empty and left untouched on disk', async () => {
  const fixture = await open()
  try {
    const future = { version: 2, nodes: [{ id: 'kept', kind: 'product', name: 'Kept' }], relations: [] }
    await writeFile(fixture.file, JSON.stringify(future), 'utf8')
    const store = new ProductGraphStore(fixture.file)
    const snapshot = await store.current()
    assert.equal(snapshot.source, 'unsupported-version')
    assert.deepEqual(snapshot.graph, { version: 1, nodes: [], relations: [] })

    // This build must not overwrite a document it cannot read.
    const onDisk = JSON.parse(await readFile(fixture.file, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.equal(onDisk.nodes[0].id, 'kept')

    // The next explicit replace takes ownership of the file.
    const replaced = await store.replace(orbitGraph())
    assert.equal(replaced.ok, true)
    assert.equal(JSON.parse(await readFile(fixture.file, 'utf8')).version, 1)
  } finally {
    await close(fixture)
  }
})

test('a persisted but semantically invalid graph loads with advisories instead of bricking', async () => {
  const fixture = await open()
  try {
    const dangling = orbitGraph()
    dangling.relations.push({ id: 'relation_dangling', kind: 'built-from', sourceId: 'product_orbit', targetId: 'nowhere', createdAt: 100 })
    await writeFile(fixture.file, JSON.stringify(dangling), 'utf8')
    const store = new ProductGraphStore(fixture.file)
    const snapshot = await store.current()
    assert.equal(snapshot.source, 'persisted')
    assert.deepEqual(snapshot.graph, dangling)
    assert.ok(snapshot.issues.some((issue) => issue.code === 'dangling-relation'))
  } finally {
    await close(fixture)
  }
})

test('replace refuses an invalid graph and leaves memory and disk unchanged', async () => {
  const fixture = await open()
  try {
    const store = new ProductGraphStore(fixture.file)
    assert.equal((await store.replace(orbitGraph())).ok, true)
    const before = await readFile(fixture.file, 'utf8')

    const duplicated = orbitGraph()
    duplicated.nodes.push({ ...duplicated.nodes[0] })
    const refused = await store.replace(duplicated)
    assert.equal(refused.ok, false)
    assert.ok(refused.issues.some((issue) => issue.code === 'duplicate-node'))
    assert.equal(await readFile(fixture.file, 'utf8'), before)

    const dangling = orbitGraph()
    dangling.relations.push({ id: 'relation_dangling', kind: 'built-from', sourceId: 'product_orbit', targetId: 'nowhere', createdAt: 100 })
    const refusedDangling = await store.replace(dangling)
    assert.equal(refusedDangling.ok, false)
    assert.ok(refusedDangling.issues.some((issue) => issue.code === 'dangling-relation'))

    const after = await store.current()
    assert.deepEqual(after.graph, orbitGraph())
  } finally {
    await close(fixture)
  }
})

test('replace rejects payloads that are not version 1 documents', async () => {
  const fixture = await open()
  try {
    const store = new ProductGraphStore(fixture.file)
    for (const bad of [
      null,
      'orbit',
      7,
      { version: 1 },
      { version: 2, nodes: [], relations: [] },
      { version: 1, nodes: [], relations: 'none' },
      { version: 1, nodes: [{ id: 'bad', kind: 'imaginary', name: 'Bad', createdAt: 100, updatedAt: 100 }], relations: [] },
      { version: 1, nodes: [{ id: 'codebase', kind: 'codebase', name: 'Incomplete', createdAt: 100, updatedAt: 100 }], relations: [] }
    ]) {
      const result = await store.replace(bad)
      assert.equal(result.ok, false)
      assert.deepEqual(result.issues, [])
      assert.ok(result.error)
    }
    assert.equal(existsSync(fixture.file), false)
  } finally {
    await close(fixture)
  }
})

test('a persisted document with an invalid runtime shape falls back without being overwritten', async () => {
  const fixture = await open()
  try {
    const malformed = {
      version: 1,
      nodes: [{ id: 'bad', kind: 'imaginary', name: 'Bad', createdAt: 100, updatedAt: 100 }],
      relations: []
    }
    const text = JSON.stringify(malformed)
    await writeFile(fixture.file, text, 'utf8')

    const snapshot = await new ProductGraphStore(fixture.file).current()
    assert.equal(snapshot.source, 'malformed-file')
    assert.deepEqual(snapshot.graph, { version: 1, nodes: [], relations: [] })
    assert.equal(await readFile(fixture.file, 'utf8'), text)
  } finally {
    await close(fixture)
  }
})

test('concurrent replacements are serialized and the final snapshot matches the last write', async () => {
  const fixture = await open()
  try {
    const starts: Array<Promise<void>> = []
    const release: Array<() => void> = []
    const started: Array<() => void> = []
    for (let index = 0; index < 2; index += 1) {
      starts.push(new Promise((resolve) => started.push(resolve)))
    }
    const gates = [
      new Promise<void>((resolve) => release.push(resolve)),
      new Promise<void>((resolve) => release.push(resolve))
    ]
    const writes: ProductGraph[] = []
    const store = new ProductGraphStore(fixture.file, undefined, async (_file, document) => {
      const index = writes.length
      writes.push(structuredClone(document))
      started[index]()
      await gates[index]
    })
    const firstGraph = orbitGraph()
    firstGraph.nodes[0].name = 'First'
    const secondGraph = orbitGraph()
    secondGraph.nodes[0].name = 'Second'

    const first = store.replace(firstGraph)
    const second = store.replace(secondGraph)
    await starts[0]
    assert.deepEqual(writes.map((graph) => graph.nodes[0].name), ['First'])
    release[0]()
    assert.equal((await first).ok, true)
    await starts[1]
    assert.deepEqual(writes.map((graph) => graph.nodes[0].name), ['First', 'Second'])
    release[1]()
    assert.equal((await second).ok, true)
    assert.equal((await store.current()).graph.nodes[0].name, 'Second')
  } finally {
    await close(fixture)
  }
})

test('a failed replacement does not poison later writes', async () => {
  const fixture = await open()
  try {
    let attempt = 0
    const store = new ProductGraphStore(fixture.file, undefined, async () => {
      attempt += 1
      if (attempt === 1) throw new Error('simulated write failure')
    })
    const failed = await store.replace(orbitGraph())
    assert.equal(failed.ok, false)
    assert.equal(failed.error, 'simulated write failure')

    const recovered = orbitGraph()
    recovered.nodes[0].name = 'Recovered'
    assert.equal((await store.replace(recovered)).ok, true)
    assert.equal((await store.current()).graph.nodes[0].name, 'Recovered')
  } finally {
    await close(fixture)
  }
})
