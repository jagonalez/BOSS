import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationInput } from '../shared/automation.ts'
import type { BackendManager } from './backend/manager.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { AutomationManager } from './automation-manager.ts'

test('completed automations keep run history without implicitly creating reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boss-automations-'))
  const stateFile = join(dir, 'automations.json')
  const runsFile = join(dir, 'automation-runs.json')
  const reportsFile = join(dir, 'reports.json')
  let listener: ((event: Record<string, unknown>) => void) | undefined
  const backends = {
    emit: () => {},
    onEvent: (callback: (event: Record<string, unknown>) => void) => {
      listener = callback
      return () => { listener = undefined }
    },
    scopeFor: () => ({ projectId: 'project-1', projectPath: '', executionPath: '' }),
    createScopedThread: async () => ({ id: 'thread-1' }),
    defaultModel: () => undefined,
    isThreadBusy: () => false,
    handle: async (request: { type: string }) => {
      if (request.type === 'thread.send') {
        listener?.({ type: 'session.idle', properties: { sessionID: 'thread-1' } })
        return undefined
      }
      if (request.type === 'thread.messages') {
        return [{ info: { id: 'message-1', role: 'assistant' }, parts: [{ type: 'text', text: 'Done.\n\nSUMMARY: Checked the repository.' }] }]
      }
      if (request.type === 'thread.diff') return []
      return undefined
    }
  } as unknown as BackendManager
  const manager = new AutomationManager({ stateFile, runsFile }, backends)

  try {
    await manager.start()
    const input: AutomationInput & { saveReport?: boolean } = {
      name: 'Repository check',
      prompt: 'Inspect the repository.',
      projectPath: '',
      backendId: 'codex',
      mode: 'auto',
      schedule: { kind: 'manual' },
      workspace: 'none',
      overlapPolicy: 'skip',
      catchUp: true,
      saveReport: true,
      notify: 'off',
      maxRunMinutes: 30,
      keepRuns: 50
    }
    const automation = await manager.create(input)
    assert.equal('saveReport' in automation, false)

    await manager.runNow(automation.id)
    const [run] = manager.snapshot().runs
    assert.equal(run.status, 'success')
    assert.equal(run.summary, 'Checked the repository.')
    assert.equal('reportId' in run, false)
    await assert.rejects(access(reportsFile))

    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { automations: Array<Record<string, unknown>> }
    assert.equal('saveReport' in persisted.automations[0], false)
  } finally {
    await manager.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
