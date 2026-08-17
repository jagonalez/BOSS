import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { LabSessionStore } from './lab-session-store.ts'
// @ts-expect-error Application code uses bundler resolution.
import { LabOrchestrator } from './lab-orchestrator.ts'

interface Fixture {
  store: LabSessionStore
  orchestrator: LabOrchestrator
  parentId: string
  cleanup: () => void
}

/** A fake child runner: writes an assistant reply into the child's session and
 *  resolves after `delay` ms. */
function makeFixture(delayMs = 5): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-orch-'))
  const store = new LabSessionStore(join(dir, 'threads.json'))
  const parent = store.create('parent')
  const orchestrator = new LabOrchestrator(store, (request) =>
    new Promise((resolve) => {
      setTimeout(() => {
        store.upsertMessage(request.sessionId, {
          info: { id: `a-${request.sessionId}`, sessionID: request.sessionId, role: 'assistant' as const, time: { created: Date.now() } },
          parts: [{ id: 'a-p', type: 'text' as const, sessionID: request.sessionId, messageID: `a-${request.sessionId}`, text: request.instruction.toUpperCase() }]
        })
        resolve({ status: 'completed' })
      }, delayMs)
    })
  )
  return {
    store,
    orchestrator,
    parentId: parent.id,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

test('wait_subagents gathers a fanned-out batch', async () => {
  const fx = makeFixture()
  try {
    const first = await fx.orchestrator.spawnSubagent(fx.parentId, { instruction: 'write the parser', title: 'a', wait: false }, { model: 'm', cwd: '/tmp', parentSignal: new AbortController().signal })
    const second = await fx.orchestrator.spawnSubagent(fx.parentId, { instruction: 'write the tests', title: 'b', wait: false }, { model: 'm', cwd: '/tmp', parentSignal: new AbortController().signal })
    assert.match(first, /background/)
    assert.match(second, /background/)

    const result = await fx.orchestrator.waitSubagents(fx.parentId)
    const parsed = JSON.parse(result) as Array<{ id: string; title: string; status: string; summary?: string }>
    assert.equal(parsed.length, 2)
    assert.ok(parsed.every((item) => item.status === 'completed'))
    assert.ok(parsed.some((item) => item.title === 'a' && item.summary === 'WRITE THE PARSER'))
    assert.ok(parsed.some((item) => item.title === 'b' && item.summary === 'WRITE THE TESTS'))
  } finally {
    fx.cleanup()
  }
})

test('wait_subagents honors an explicit id list', async () => {
  const fx = makeFixture()
  try {
    const a = await fx.orchestrator.spawnSubagent(fx.parentId, { instruction: 'one', wait: false }, { model: 'm', cwd: '/tmp', parentSignal: new AbortController().signal })
    const b = await fx.orchestrator.spawnSubagent(fx.parentId, { instruction: 'two', wait: false }, { model: 'm', cwd: '/tmp', parentSignal: new AbortController().signal })
    const idA = a.match(/\(([0-9a-f-]+)\)/)?.[1] ?? ''
    const idB = b.match(/\(([0-9a-f-]+)\)/)?.[1] ?? ''
    assert.ok(idA && idB)

    const result = await fx.orchestrator.waitSubagents(fx.parentId, [idA])
    const parsed = JSON.parse(result) as Array<{ id: string }>
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].id, idA)
  } finally {
    fx.cleanup()
  }
})

test('wait_subagents with no children returns an empty batch', async () => {
  const fx = makeFixture()
  try {
    assert.equal(await fx.orchestrator.waitSubagents(fx.parentId), '[]')
  } finally {
    fx.cleanup()
  }
})