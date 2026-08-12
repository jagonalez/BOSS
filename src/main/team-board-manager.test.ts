import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { BackendRequest } from '../shared/backend.ts'
import type { TeamSnapshot } from '../shared/team.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application builds use bundler resolution.
import { TEAM_PROTOCOL, teamProtocolsCompatible } from '../shared/team.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application builds use bundler resolution.
import { TeamBoardManager, type TeamTaskHost } from './team-board-manager.ts'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application builds use bundler resolution.
import { webAccessRequestAllowed } from './web-access-policy.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function manager(name = 'host'): { manager: TeamBoardManager; prompts: string[]; events: Record<string, unknown>[] } {
  const directory = mkdtempSync(join(tmpdir(), `ralf-team-${name}-`))
  temporaryDirectories.push(directory)
  const prompts: string[] = []
  const events: Record<string, unknown>[] = []
  const host: TeamTaskHost = {
    async startTeamTask(input) {
      prompts.push(input.prompt)
      return { threadId: 'local-thread-1', worktreeBranch: input.worktree ? 'ralf/team-task-1' : undefined }
    },
    emit(event) { events.push(event) }
  }
  return { manager: new TeamBoardManager(join(directory, 'team.json'), host), prompts, events }
}

async function snapshot(boardManager: TeamBoardManager): Promise<TeamSnapshot> {
  return boardManager.handle({ type: 'team.snapshot' }) as Promise<TeamSnapshot>
}

test('hosts a board and starts claimed work in a private local thread', async () => {
  const setup = manager()
  let state = await setup.manager.handle({
    type: 'team.create',
    name: 'Vibe Code Friday',
    brief: 'Ship the onboarding fix.',
    memberName: 'Jeremy'
  }) as TeamSnapshot
  const boardId = state.board!.id

  state = await setup.manager.handle({
    type: 'team.task.create',
    boardId,
    input: { title: 'Repair signup', summary: 'Keep existing accounts working.', acceptanceCriteria: ['New users can sign up'], status: 'ready' }
  }) as TeamSnapshot
  const taskId = state.board!.tasks[0].id

  const started = await setup.manager.handle({
    type: 'team.task.start',
    input: { boardId, taskId, backendId: 'codex', projectPath: '/private/local/project', worktree: true }
  }) as { snapshot: TeamSnapshot; threadId: string }

  const task = started.snapshot.board!.tasks[0]
  assert.equal(started.threadId, 'local-thread-1')
  assert.equal(task.status, 'working')
  assert.equal(task.assigneeName, 'Jeremy')
  assert.equal(task.execution?.backendId, 'codex')
  assert.equal(task.execution?.worktreeBranch, 'ralf/team-task-1')
  assert.ok(!('threadId' in task.execution!))
  assert.ok(!('projectPath' in task.execution!))
  assert.match(setup.prompts[0], /Ship the onboarding fix/)
  assert.match(setup.prompts[0], /New users can sign up/)
  assert.match(setup.prompts[0], /private conversation stays on this machine/)

  const visible = await setup.manager.agentCall('local-thread-1', 'ralf_team_board_read', {}) as { currentTaskId?: string }
  assert.equal(visible.currentTaskId, taskId)
  const published = await setup.manager.agentCall('local-thread-1', 'ralf_team_task_publish', {
    update: 'Implementation is ready for a teammate to verify.',
    status: 'review'
  }) as { status: string; updates: Array<{ body: string }> }
  assert.equal(published.status, 'review')
  assert.equal(published.updates[0].body, 'Implementation is ready for a teammate to verify.')

  await setup.manager.handleBackendEvent({ type: 'permission.asked', properties: { sessionID: 'local-thread-1' } })
  state = await snapshot(setup.manager)
  assert.equal(state.board!.tasks[0].execution?.state, 'needs-attention')
})

test('a planning agent can propose tasks but cannot publish another thread task', async () => {
  const setup = manager('planner')
  const state = await setup.manager.handle({ type: 'team.create', name: 'Planning', brief: 'Prepare the launch.', memberName: 'Owner' }) as TeamSnapshot
  const planning = await setup.manager.handle({
    type: 'team.plan.start',
    input: { boardId: state.board!.id, backendId: 'claude', projectPath: '/private/local/project' }
  }) as { threadId: string }
  assert.match(setup.prompts[0], /Prepare the launch/)
  assert.match(setup.prompts[0], /ralf_team_tasks_propose/)
  const board = await setup.manager.agentCall(planning.threadId, 'ralf_team_tasks_propose', {
    tasks: [
      { title: 'Write migration guide', summary: 'Cover rollback.', acceptanceCriteria: ['Reviewed by support'], projectHint: 'docs' },
      { title: 'Exercise upgrade path', projectHint: 'api' }
    ]
  }) as NonNullable<TeamSnapshot['board']>
  assert.equal(board.id, state.board?.id)
  assert.deepEqual(board.tasks.map((task) => task.title), ['Write migration guide', 'Exercise upgrade path'])
  assert.ok(board.tasks.every((task) => task.status === 'proposed'))
  await assert.rejects(
    setup.manager.agentCall(planning.threadId, 'ralf_team_task_publish', { status: 'done' }),
    /not started from a team task/
  )
})

test('rejects stale task edits instead of overwriting a teammate', async () => {
  const setup = manager()
  let state = await setup.manager.handle({ type: 'team.create', name: 'Release', memberName: 'Host' }) as TeamSnapshot
  const boardId = state.board!.id
  state = await setup.manager.handle({ type: 'team.task.create', boardId, input: { title: 'Prepare release' } }) as TeamSnapshot
  const task = state.board!.tasks[0]
  await setup.manager.handle({ type: 'team.task.update', boardId, taskId: task.id, patch: { summary: 'Fresh edit' }, expectedRevision: task.revision })
  await assert.rejects(
    setup.manager.handle({ type: 'team.task.update', boardId, taskId: task.id, patch: { summary: 'Stale edit' }, expectedRevision: task.revision }),
    /changed on another R\.A\.L\.F/
  )
})

test('peers stay peers after mutations and retain a board copy when the host goes offline', async () => {
  const host = manager('remote-host').manager
  const peer = manager('peer').manager
  const hosted = await host.handle({ type: 'team.create', name: 'Connected team', memberName: 'Alice' }) as TeamSnapshot
  const access = await host.handle({ type: 'team.access' }) as { token: string }
  const originalFetch = globalThis.fetch
  let online = true
  globalThis.fetch = async (_input, init) => {
    if (!online) throw new TypeError('host offline')
    const authorization = new Headers(init?.headers).get('authorization')
    if (authorization !== `Bearer ${access.token}`) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    try {
      const request = JSON.parse(String(init?.body)) as BackendRequest
      return Response.json({ ok: true, result: await host.handle(request) })
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 })
    }
  }
  try {
    let peerState = await peer.handle({ type: 'team.connect', url: 'http://team-host.test', token: access.token, memberName: 'Bob' }) as TeamSnapshot
    assert.equal(peerState.mode, 'peer')
    assert.equal(peerState.board?.id, hosted.board?.id)
    assert.equal(peerState.connection?.connected, true)

    peerState = await peer.handle({ type: 'team.task.create', boardId: hosted.board!.id, input: { title: 'Peer task', status: 'ready' } }) as TeamSnapshot
    assert.equal(peerState.mode, 'peer')
    assert.equal(peerState.board?.tasks[0].title, 'Peer task')
    assert.equal(peerState.board?.tasks[0].createdByName, 'Bob')

    online = false
    peerState = await snapshot(peer)
    assert.equal(peerState.mode, 'peer')
    assert.equal(peerState.connection?.connected, false)
    assert.equal(peerState.board?.tasks[0].title, 'Peer task')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('team tokens cannot control private desktop capabilities', () => {
  assert.equal(webAccessRequestAllowed('team', 'team.snapshot'), true)
  assert.equal(webAccessRequestAllowed('team', 'team.task.claim'), true)
  assert.equal(webAccessRequestAllowed('team', 'thread.list'), false)
  assert.equal(webAccessRequestAllowed('team', 'thread.send'), false)
  assert.equal(webAccessRequestAllowed('team', 'thread.permission'), false)
  assert.equal(webAccessRequestAllowed('team', 'automation.run'), false)
  assert.equal(webAccessRequestAllowed('control', 'thread.send'), true)
})

test('negotiates collaboration protocol ranges and rejects incompatible peers', async () => {
  const host = manager('protocol-host').manager
  await host.handle({ type: 'team.create', name: 'Versioned team', memberName: 'Host' })
  assert.equal(teamProtocolsCompatible(TEAM_PROTOCOL), true)
  assert.equal(teamProtocolsCompatible({ current: 2, minimumCompatible: 1 }), true)
  assert.equal(teamProtocolsCompatible({ current: 2, minimumCompatible: 2 }), false)
  assert.equal(teamProtocolsCompatible(undefined), false)

  const compatible = await host.handle({
    type: 'team.snapshot',
    viaPeer: true,
    actorId: 'future-peer',
    actorName: 'Future peer',
    protocol: { current: 2, minimumCompatible: 1 }
  }) as TeamSnapshot
  assert.equal(compatible.protocol.current, TEAM_PROTOCOL.current)

  await assert.rejects(host.handle({
    type: 'team.snapshot',
    viaPeer: true,
    actorId: 'too-new-peer',
    actorName: 'Too new',
    protocol: { current: 2, minimumCompatible: 2 }
  }), /Update R\.A\.L\.F\. on the older device/)

  await assert.rejects(host.handle({
    type: 'team.snapshot',
    viaPeer: true,
    actorId: 'unversioned-peer',
    actorName: 'Old peer'
  }), /unversioned protocol/)
})
