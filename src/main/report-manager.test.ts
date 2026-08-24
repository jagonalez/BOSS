import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation, AutomationRun } from '../shared/automation.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { ReportManager } from './report-manager.ts'

const automation: Automation = {
  id: 'automation-1',
  name: 'Codex changelog',
  prompt: 'Summarize the changelog.',
  projectPath: '',
  backendId: 'codex',
  mode: 'auto',
  schedule: { kind: 'manual' },
  workspace: 'none',
  overlapPolicy: 'skip',
  catchUp: true,
  notify: 'events',
  maxRunMinutes: 30,
  keepRuns: 50,
  enabled: true,
  missedRuns: 0,
  createdAt: 1,
  updatedAt: 1
}

const run: AutomationRun = {
  id: 'run-1',
  automationId: automation.id,
  threadId: 'thread-1',
  trigger: 'schedule',
  status: 'success',
  summary: 'Codex shipped report history.',
  changedFiles: 0,
  startedAt: 10,
  finishedAt: 20
}

test('reports persist independently and a run creates at most one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-reports-'))
  const file = join(dir, 'reports.json')
  try {
    const manager = new ReportManager(file)
    const first = await manager.create(automation, run, '# Codex\n\nReport history shipped.')
    const duplicate = await manager.create(automation, run, 'replacement')
    assert.equal(duplicate?.id, first?.id)
    assert.equal((await manager.snapshot()).reports.length, 1)

    const restored = new ReportManager(file)
    assert.equal('body' in (await restored.snapshot()).reports[0], false)
    assert.equal((await restored.handle({ type: 'report.get', reportId: first!.id }) as { body: string }).body, '# Codex\n\nReport history shipped.')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('marking read and retention mutations are durable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-reports-'))
  const file = join(dir, 'reports.json')
  try {
    const manager = new ReportManager(file)
    const report = await manager.create(automation, run, 'Result')
    assert.ok(report)
    assert.ok((await manager.markRead(report.id)).readAt)
    await manager.removeForRuns([run.id])
    assert.deepEqual((await new ReportManager(file).snapshot()).reports, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
