import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { ReportManager } from './report-manager.ts'

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

test('deleting a report persists the removal and emits the new snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-reports-'))
  const file = join(dir, 'reports.json')
  const snapshots: number[] = []
  try {
    const manager = new ReportManager(file, (snapshot) => snapshots.push(snapshot.reports.length))
    const report = await manager.createFromAgent({
      threadId: 'thread-1',
      projectPath: '/repo',
      backendId: 'codex',
      title: 'Disposable report',
      body: 'Temporary findings.'
    })

    await manager.handle({ type: 'report.delete', reportId: report.id })

    assert.deepEqual(snapshots, [1, 0])
    assert.deepEqual((await new ReportManager(file).snapshot()).reports, [])
    await assert.rejects(manager.handle({ type: 'report.get', reportId: report.id }), /Report not found/)
    await assert.rejects(manager.handle({ type: 'report.delete', reportId: report.id }), /Report not found/)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2)
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
