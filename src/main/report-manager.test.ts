import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('automation reports persist independently and a run creates at most one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-reports-'))
  const file = join(dir, 'reports.json')
  try {
    const manager = new ReportManager(file)
    const first = await manager.createForAutomation(automation, run, '# Codex\n\nReport history shipped.')
    const duplicate = await manager.createForAutomation(automation, run, 'replacement')
    assert.equal(duplicate?.id, first?.id)
    assert.equal((await manager.snapshot()).reports.length, 1)

    const restored = new ReportManager(file)
    assert.equal('body' in (await restored.snapshot()).reports[0], false)
    assert.equal((await restored.handle({ type: 'report.get', reportId: first!.id }) as { body: string }).body, '# Codex\n\nReport history shipped.')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent reports can be created and refined only by their source thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-reports-'))
  const file = join(dir, 'reports.json')
  try {
    const manager = new ReportManager(file)
    const report = await manager.createFromAgent({
      threadId: 'thread-1',
      projectPath: '/repo',
      backendId: 'claude',
      title: 'Architecture notes',
      summary: 'Initial design',
      body: '# Design\n\nFirst draft.'
    })
    assert.deepEqual(report.source, { kind: 'agent', backendId: 'claude' })
    assert.ok((await manager.markRead(report.id)).readAt)

    const updated = await manager.updateFromAgent('thread-1', report.id, {
      summary: '',
      body: '# Design\n\nRevised draft.'
    })
    assert.equal(updated.summary, undefined)
    assert.equal(updated.readAt, undefined)
    assert.match(updated.body, /Revised draft/)
    await assert.rejects(
      manager.updateFromAgent('thread-other', report.id, { title: 'Hijacked' }),
      /Only the thread that created/
    )

    const restored = new ReportManager(file)
    assert.match((await restored.handle({ type: 'report.get', reportId: report.id }) as { body: string }).body, /Revised draft/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the automation-only report format migrates into first-class artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-reports-'))
  const file = join(dir, 'reports.json')
  try {
    await writeFile(file, JSON.stringify({
      version: 1,
      reports: [{
        id: 'legacy-report',
        automationId: 'automation-1',
        automationName: 'Codex changelog',
        runId: 'run-1',
        threadId: 'thread-1',
        projectPath: '/repo',
        title: 'Codex changelog',
        body: 'Legacy body',
        status: 'success',
        createdAt: 20
      }]
    }))

    const [summary] = (await new ReportManager(file).snapshot()).reports
    assert.deepEqual(summary.source, {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Codex changelog',
      runId: 'run-1',
      status: 'success'
    })
    assert.equal(summary.updatedAt, 20)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
