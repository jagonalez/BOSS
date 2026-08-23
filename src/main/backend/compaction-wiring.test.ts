import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function source(name: string): string {
  return readFileSync(join(import.meta.dirname, name), 'utf8')
}

test('Claude turns SDK status and compact boundaries into the shared lifecycle', () => {
  const claude = source('claude-backend.ts')
  assert.ok(claude.includes("value.subtype === 'status'"), 'Claude compaction progress must not be ignored')
  assert.ok(claude.includes("value.subtype === 'compact_boundary'"), 'Claude completion metadata must not be ignored')
  assert.ok(claude.includes('compactionStartedEvent(sessionId)'), 'Claude should publish a distinct progress state')
  assert.ok(claude.includes('compactionCompletedEvents(sessionId'), 'Claude should write a persistent completion marker')
  assert.ok(claude.includes('metadata.pre_tokens') && claude.includes('metadata.post_tokens'), 'Claude token reduction should reach the notice')
})

test('Codex and Pi distinguish manual from automatic compaction', () => {
  const codex = source('codex-backend.ts')
  assert.ok(codex.includes("case 'thread/compacted':"))
  assert.ok(codex.includes("this.manualCompactions.delete(sessionId) ? 'manual' : 'auto'"))
  assert.ok(codex.includes('compactionCompletedEvents(sessionId'))

  const pi = source('pi-backend.ts')
  assert.ok(pi.includes("case 'compaction_start':"))
  assert.ok(pi.includes('compactionStartedEvent('))
  assert.ok(pi.includes("case 'compaction_end':"))
  assert.ok(pi.includes("this.manualCompactions.delete(sessionId) ? 'manual' : 'auto'"))
  assert.ok(pi.includes('compactionCompletedEvents(sessionId'))
})
