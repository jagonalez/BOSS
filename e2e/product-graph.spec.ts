import { control, expect, test, type E2EProductGraphSnapshot } from './fixtures'

/** Fictional product data only — the same stand-in product the RFC uses.
 *  Timestamps are fixed so the replaced document round-trips exactly. */
const ORBIT_GRAPH = {
  version: 1,
  nodes: [
    { id: 'product_orbit', kind: 'product', name: 'Orbit', purpose: 'Fictional example product', createdAt: 100, updatedAt: 100 },
    { id: 'codebase_orbit_app', kind: 'codebase', name: 'orbit-app', sourceKind: 'git', createdAt: 100, updatedAt: 100 },
    { id: 'checkout_orbit_main', kind: 'checkout', name: 'orbit-app · main checkout', path: '/tmp/boss-e2e/orbit-app', branch: 'main', main: true, createdAt: 100, updatedAt: 100 }
  ],
  relations: [
    { id: 'relation_orbit_checkout', kind: 'checkout-of', sourceId: 'checkout_orbit_main', targetId: 'codebase_orbit_app', createdAt: 100 }
  ]
}

test('a replaced Product Graph is validated, served, and survives an app restart', async ({ restartableApp }) => {
  let page = restartableApp.page()
  let fixture = await control(page)

  // The E2E main records no folder project, so the first read seeds empty.
  const seeded = await fixture.productGraphGet()
  expect(seeded.source).toBe('seeded-empty')
  expect(seeded.graph).toEqual({ version: 1, nodes: [], relations: [] })
  expect(seeded.issues).toEqual([])

  const replaced = await fixture.productGraphReplace(ORBIT_GRAPH)
  expect(replaced).toEqual({ ok: true, issues: [] })
  const afterReplace = await fixture.productGraphGet()
  expect(afterReplace.source).toBe('persisted')
  expect(afterReplace.graph).toEqual(ORBIT_GRAPH)

  page = await restartableApp.restart()
  fixture = await control(page)
  const reloaded = await fixture.productGraphGet()
  expect(reloaded.source).toBe('persisted')
  expect(reloaded.issues).toEqual([])
  expect(reloaded.graph).toEqual(ORBIT_GRAPH)
  expect(reloaded.graph.nodes.map((node) => node.id)).toEqual(['product_orbit', 'codebase_orbit_app', 'checkout_orbit_main'])
})

test('an invalid replace is refused with typed issues and keeps the stored graph', async ({ appPage }) => {
  const fixture = await control(appPage)
  expect((await fixture.productGraphReplace(ORBIT_GRAPH)).ok).toBe(true)

  const dangling = {
    ...ORBIT_GRAPH,
    relations: [
      ...ORBIT_GRAPH.relations,
      { id: 'relation_dangling', kind: 'built-from', sourceId: 'product_orbit', targetId: 'codebase_missing', createdAt: 100 }
    ]
  }
  const refused = await fixture.productGraphReplace(dangling)
  expect(refused.ok).toBe(false)
  expect(refused.issues.map((issue) => issue.code)).toContain('dangling-relation')

  // The refusal changed nothing: the last valid document keeps serving.
  const after = await fixture.productGraphGet()
  expect(after.source).toBe('persisted')
  expect(after.issues).toEqual([])
  expect(after.graph).toEqual(ORBIT_GRAPH)

  // Not even a version 1 shape passes: the envelope is checked in main.
  const unshaped = await fixture.productGraphReplace({ version: 1, nodes: 'many' })
  expect(unshaped.ok).toBe(false)
  expect(unshaped.error).toBeTruthy()

  // IPC values are untrusted at runtime even though the renderer API is typed.
  // Unknown discriminants and missing variant fields must never reach disk.
  const structurallyInvalid = await fixture.productGraphReplace({
    version: 1,
    nodes: [{ id: 'node_bad', kind: 'imaginary', name: 'Bad', createdAt: 100, updatedAt: 100 }],
    relations: []
  })
  expect(structurallyInvalid.ok).toBe(false)
  expect(structurallyInvalid.error).toContain('nodes[0].kind')
  expect((await fixture.productGraphGet() as E2EProductGraphSnapshot).graph).toEqual(ORBIT_GRAPH)
})
