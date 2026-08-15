import { contextBridge } from 'electron'
import type { BossApi } from '../shared/api'
import type { ApiRequest, ApiResponse, ProjectInfo } from '../shared/ipc'
import type {
  BackendDescriptor,
  BackendId,
  BackendModelDescriptor,
  BackendModelPreference,
  BackendRequest
} from '../shared/backend'
import type { SessionInfo } from '../shared/opencode'

type RecordedCall =
  | { channel: 'api'; request: ApiRequest }
  | { channel: 'backend'; request: BackendRequest }

const PROJECT = '/tmp/boss-e2e/project'
const CHECKOUT = `${PROJECT}/checkout`

const capabilities = {
  streaming: true,
  models: true,
  permissions: true,
  nativeFork: true,
  steering: 'native' as const,
  branching: 'thread' as const,
  images: true,
  mcp: true,
  interactiveQuestions: true,
  nativeAutoMode: false
}

const backends: BackendDescriptor[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode test backend',
    available: true,
    healthy: true,
    version: 'e2e',
    capabilities,
    modes: [
      { id: 'ask', label: 'Ask', description: 'Ask before protected actions.' },
      { id: 'auto', label: 'Auto', description: 'Approve supported actions.' },
      { id: 'plan', label: 'Plan', description: 'Read-only planning.' }
    ]
  },
  {
    id: 'pi',
    label: 'Pi',
    description: 'Pi test backend',
    available: true,
    healthy: true,
    version: 'e2e',
    capabilities: { ...capabilities, nativeFork: false },
    modes: [{ id: 'ask', label: 'Ask', description: 'Pi policy.' }]
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'Codex test backend',
    available: true,
    healthy: true,
    version: 'e2e',
    capabilities,
    modes: [
      { id: 'ask', label: 'Ask', description: 'Ask before protected actions.' },
      { id: 'auto', label: 'Auto', description: 'Approve supported actions.' },
      { id: 'plan', label: 'Plan', description: 'Read-only planning.' }
    ]
  },
  {
    id: 'claude',
    label: 'Claude Code',
    description: 'Claude test backend',
    available: true,
    healthy: true,
    version: 'e2e',
    capabilities,
    modes: [
      { id: 'ask', label: 'Ask', description: 'Ask before protected actions.' },
      { id: 'accept-edits', label: 'Accept edits', description: 'Accept file edits.' },
      { id: 'auto', label: 'Auto', description: 'Approve supported actions.' },
      { id: 'plan', label: 'Plan', description: 'Read-only planning.' }
    ]
  }
]

const models: Record<BackendId, BackendModelDescriptor[]> = {
  opencode: [
    { id: 'gpt-5.6', name: 'GPT-5.6', provider: 'openai', variants: ['low', 'high', 'max'] },
    { id: 'qwen-local', name: 'Qwen Local', provider: 'ollama', source: 'local' }
  ],
  pi: [{ id: 'pi-e2e', name: 'Pi E2E', provider: 'pi' }],
  codex: [{ id: 'gpt-5.6-codex', name: 'GPT-5.6 Codex', provider: 'openai', variants: ['low', 'high', 'xhigh'] }],
  claude: [
    { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic', variants: ['low', 'high'] },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', variants: ['low', 'high'] }
  ]
}

const projectInfo: ProjectInfo = {
  path: PROJECT,
  checkoutPath: CHECKOUT,
  checkouts: [{ path: CHECKOUT, branch: 'main', main: true }],
  healthy: true
}

function initialSession(): SessionInfo {
  return {
    id: 'thread-source',
    backendId: 'codex',
    nativeSessionId: 'native-source',
    projectId: 'boss-e2e',
    projectPath: PROJECT,
    executionPath: CHECKOUT,
    title: 'Source thread',
    time: { created: Date.now() - 60_000, updated: Date.now() - 2_000 },
    model: { id: 'gpt-5.6-codex', provider: 'openai' }
  }
}

/** Replace external I/O while preserving the real Electron window, preload
 * boundary, React tree, localStorage, and user interactions. This module is
 * reachable only when the main process explicitly starts with BOSS_E2E=1. */
export function installE2EApi(boss: BossApi): void {
  let sessions = [initialSession()]
  let defaults: Partial<Record<BackendId, BackendModelPreference>> = {}
  let calls: RecordedCall[] = []
  let nextThread = 1
  const eventListeners = new Set<(data: string) => void>()

  const recordBackend = (request: BackendRequest): void => {
    calls.push({ channel: 'backend', request: structuredClone(request) })
  }

  const createThread = (backendId: BackendId, title?: string): SessionInfo => {
    const preference = defaults[backendId]
    const id = `thread-created-${nextThread++}`
    const session: SessionInfo = {
      id,
      backendId,
      nativeSessionId: `native-${id}`,
      projectId: 'boss-e2e',
      projectPath: PROJECT,
      executionPath: CHECKOUT,
      title: title || `New ${backendId} thread`,
      time: { created: Date.now(), updated: Date.now() },
      model: preference ? { id: preference.modelID, provider: preference.providerID } : undefined
    }
    sessions = [...sessions, session]
    return session
  }

  const backendRequest = async (request: BackendRequest): Promise<unknown> => {
    recordBackend(request)
    switch (request.type) {
      case 'backend.list': return backends
      case 'backend.auth.status':
        return backends.map((backend) => ({ backendId: backend.id, state: 'connected', detail: 'E2E fixture' }))
      case 'backend.defaults.set':
        defaults = structuredClone(request.defaults)
        return undefined
      case 'backend.bin.get': return {}
      case 'backend.bin.set': return request.path ? { [request.backendId]: request.path } : {}
      case 'thread.list': return sessions
      case 'thread.create': return createThread(request.backendId, request.title)
      case 'thread.get': return sessions.find((session) => session.id === request.threadId)
      case 'thread.backend.set': {
        const found = sessions.find((session) => session.id === request.threadId)
        if (!found) throw new Error(`Unknown fixture thread ${request.threadId}`)
        const changed = { ...found, backendId: request.backendId }
        sessions = sessions.map((session) => session.id === request.threadId ? changed : session)
        return changed
      }
      case 'thread.delete':
        sessions = sessions.filter((session) => session.id !== request.threadId)
        return undefined
      case 'thread.rename': {
        const found = sessions.find((session) => session.id === request.threadId)
        if (!found) throw new Error(`Unknown fixture thread ${request.threadId}`)
        const changed = { ...found, title: request.title }
        sessions = sessions.map((session) => session.id === request.threadId ? changed : session)
        return changed
      }
      case 'thread.messages': return []
      case 'thread.todos': return []
      case 'thread.diff': return []
      case 'thread.models': return models[request.backendId ?? sessions.find((session) => session.id === request.threadId)?.backendId ?? 'opencode']
      case 'thread.followups.list':
      case 'thread.followups.add':
      case 'thread.followups.update':
      case 'thread.followups.remove':
      case 'thread.followups.move':
      case 'thread.followups.steer': return []
      case 'thread.clone':
      case 'thread.delegate': return createThread(request.backendId, request.type === 'thread.delegate' ? 'Delegated worker' : 'Continued thread')
      case 'thread.fork':
      case 'thread.worktree.create': return createThread(sessions.find((session) => session.id === request.threadId)?.backendId ?? 'opencode', 'Forked thread')
      case 'thread.relay': return sessions.find((session) => session.id === request.targetThreadId)
      case 'supervision.snapshot':
        return {
          generatedAt: Date.now(),
          threads: sessions.map((session) => ({
            threadId: session.id,
            backendId: session.backendId ?? 'opencode',
            title: session.title || 'Untitled',
            projectPath: session.projectPath || '',
            executionPath: session.executionPath || '',
            updatedAt: session.time?.updated || Date.now(),
            running: false,
            usage: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
          })),
          totals: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
        }
      case 'supervision.search': return []
      case 'supervision.acknowledge': return backendRequest({ type: 'supervision.snapshot' })
      case 'thread.policy.get': return undefined
      case 'thread.policy.set': return request.policy
      case 'worktree.list': return []
      case 'worktree.settings.get': return { autoCleanupEnabled: true, cleanupAfterDays: 30, location: 'app-data' }
      case 'worktree.settings.set': return { autoCleanupEnabled: true, cleanupAfterDays: 30, location: 'app-data', ...request }
      case 'mcp.list': return []
      case 'mcp.import.scan': return []
      case 'automation.list': return { automations: [], runs: [], webhookUrl: '' }
      case 'automation.webhook.get': return ''
      case 'mobile.status': return { enabled: false, running: false, port: 0, tailscale: false }
      case 'thread.bus.get':
      case 'thread.bus.clear-failures':
        return { projectId: 'boss-e2e', projectPath: PROJECT, policy: 'collaborate', threads: [], messages: [], toolBackends: [] }
      case 'thread.bus.policy':
        return { projectId: 'boss-e2e', projectPath: PROJECT, policy: request.policy, threads: [], messages: [], toolBackends: [] }
      case 'thread.qa.get': return { policy: 'suggest', source: 'default' }
      case 'thread.qa.policy': return { policy: request.policy ?? 'suggest', source: request.policy ? 'thread' : 'default' }
      case 'qa.default.get': return 'suggest'
      case 'qa.default.policy': return request.policy
      default: return undefined
    }
  }

  const apiRequest = async (request: ApiRequest): Promise<ApiResponse> => {
    calls.push({ channel: 'api', request: structuredClone(request) })
    const bodies: Record<string, unknown> = {
      '/agent': [
        { id: 'build', description: 'Default build agent' },
        { id: 'reviewer', description: 'Review-only fixture agent' }
      ],
      '/provider': {
        all: [{ id: 'openai', name: 'OpenAI', models: models.opencode }],
        connected: ['openai'],
        default: { openai: 'gpt-5.6' }
      },
      '/config': {},
      '/project/current': { id: 'boss-e2e', path: PROJECT, directory: CHECKOUT },
      '/command': [],
      '/file': [],
      '/file/content': { path: String(request.query?.path ?? ''), content: '' },
      '/find/file': []
    }
    return { status: 200, body: bodies[request.path] ?? true }
  }

  Object.assign(boss, {
    platform: () => 'darwin',
    serverInfo: async () => ({ port: 0, url: 'e2e://boss', version: 'e2e', healthy: true }),
    onServerStatusChanged: () => () => {},
    apiRequest,
    subscribeEvents: async () => true,
    unsubscribeEvents: async () => true,
    onEvent: (callback: (data: string) => void) => {
      eventListeners.add(callback)
      return () => eventListeners.delete(callback)
    },
    onBrowseNavigation: () => () => {},
    onBrowseAgentActivity: () => () => {},
    onBrowseExternal: () => () => {},
    optionalList: async () => [
      { id: 'opencode', installed: true, optional: false, version: 'e2e' },
      { id: 'browser-core', installed: true, optional: true, version: 'e2e' },
      { id: 'computer-use', installed: false, optional: true }
    ],
    onOptionalProgress: () => () => {},
    computerUseStatus: async () => ({ supported: false, enabled: false, running: false }),
    computerUsePermissions: async () => ({ available: false, accessibility: false, screenRecording: false }),
    projectList: async () => [PROJECT],
    projectCurrent: async () => projectInfo,
    projectSet: async () => projectInfo,
    projectChoose: async () => PROJECT,
    backendRequest,
    ttsStatus: async () => ({ available: false, ready: false, speaking: false }),
    onSpeechStatusChanged: () => () => {},
    sitesList: async () => [],
    onSitesChanged: () => () => {},
    sitesCfGet: async () => ({ configured: false }),
    updateStatus: async () => ({ currentVersion: 'e2e', checking: false, available: false, url: '' }),
    updateCheck: async () => ({ currentVersion: 'e2e', checking: false, available: false, url: '' }),
    onUpdateChanged: () => () => {},
    onMenuCommand: () => () => {}
  } satisfies Partial<BossApi>)

  contextBridge.exposeInMainWorld('bossE2E', {
    calls: () => structuredClone(calls),
    sessions: () => structuredClone(sessions),
    defaults: () => structuredClone(defaults),
    resetCalls: () => { calls = [] },
    emit: (event: Record<string, unknown>) => {
      const data = JSON.stringify(event)
      for (const listener of eventListeners) listener(data)
    }
  })
}
