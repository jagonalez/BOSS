import { contextBridge, ipcRenderer } from 'electron'
import type { BossApi } from '../shared/api'
import { IpcChannels, type ApiRequest, type ApiResponse, type ProjectInfo } from '../shared/ipc'
import type {
  BackendDescriptor,
  BackendId,
  BackendModeId,
  BackendModelDescriptor,
  BackendModelPreference,
  LabConnectionsSettings,
  BackendRequest,
  QueuedFollowUp
} from '../shared/backend'
import { isAbortError, THREAD_BUSY_ERROR } from '../shared/backend'
import type { MessageWithParts, SessionInfo } from '../shared/opencode'
import { contextHandoffPacket, delegatedContextInstruction } from '../shared/context-handoff'
import { titleFromFirstPrompt } from '../shared/thread-title'
import type { LabAssistantSnapshot } from '../shared/lab-assistant'

type RecordedCall =
  | { channel: 'api'; request: ApiRequest }
  | { channel: 'backend'; request: BackendRequest }
  | { channel: 'export'; request: import('../shared/ipc').ThreadExportRequest }
  | { channel: 'git'; path: string; args: string[] }

interface GitFixtureState {
  branch: string
  branches: string[]
  staged: string[]
  unstaged: string[]
  untracked: string[]
  stashes: Array<{
    oid: string
    staged: string[]
    unstaged: string[]
    untracked: string[]
  }>
  nextStash: number
}

const PROJECT = '/tmp/boss-e2e/project'
const CHECKOUT = `${PROJECT}/checkout`
const THREAD_TITLE_SETTINGS_KEY = 'boss-e2e-thread-title-settings'
/** Pins survive a renderer reload here the way they survive one in the real
 *  app's backend-threads.json, so the reload test exercises the same contract
 *  the manager keeps. */
const THREAD_PINS_KEY = 'boss-e2e-thread-pins'

interface E2EStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function e2eStorage(): E2EStorage | undefined {
  return (globalThis as unknown as { sessionStorage?: E2EStorage }).sessionStorage
}

function savedThreadTitleSettings(): { autoNameFromFirstPrompt: boolean } {
  try {
    const stored = e2eStorage()?.getItem(THREAD_TITLE_SETTINGS_KEY)
    if (!stored) return { autoNameFromFirstPrompt: false }
    const parsed: unknown = JSON.parse(stored)
    return typeof parsed === 'object' && parsed !== null && 'autoNameFromFirstPrompt' in parsed
      && typeof parsed.autoNameFromFirstPrompt === 'boolean'
      ? { autoNameFromFirstPrompt: parsed.autoNameFromFirstPrompt }
      : { autoNameFromFirstPrompt: false }
  } catch {
    return { autoNameFromFirstPrompt: false }
  }
}

function savedThreadPins(): Record<string, boolean> {
  try {
    const stored = e2eStorage()?.getItem(THREAD_PINS_KEY)
    if (!stored) return {}
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const pins: Record<string, boolean> = {}
    for (const [threadId, pinned] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof pinned === 'boolean') pins[threadId] = pinned
    }
    return pins
  } catch {
    return {}
  }
}

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
  nativeAutoMode: true,
  // Only opencode implements revert in main; the others are no-ops there.
  revert: false,
  compact: true
}

const backends: BackendDescriptor[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode test backend',
    available: true,
    healthy: true,
    version: 'e2e',
    // Opencode has no native steering: BOSS stops the run and sends the queued
    // instruction next, which is what makes it report an abort.
    capabilities: { ...capabilities, nativeAutoMode: false, steering: 'stop-and-redirect', revert: true },
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
    capabilities: { ...capabilities, permissions: false },
    modes: [{ id: 'auto', label: 'Approved', description: 'Pi policy.' }]
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
    capabilities: { ...capabilities, nativeFork: false, steering: 'stop-and-redirect', compact: false },
    modes: [
      { id: 'ask', label: 'Ask', description: 'Ask before protected actions.' },
      { id: 'accept-edits', label: 'Accept edits', description: 'Accept file edits.' },
      { id: 'auto', label: 'Auto', description: 'Approve supported actions.' },
      { id: 'plan', label: 'Plan', description: 'Read-only planning.' }
    ]
  },
  {
    id: 'lab',
    label: 'Lab',
    description: 'Lab test backend',
    available: true,
    healthy: true,
    version: 'e2e',
    capabilities: { ...capabilities, nativeFork: false, mcp: false },
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
  ],
  lab: [{ id: 'lab-e2e', name: 'Lab E2E', provider: 'lab-local', providerName: 'Local test' }]
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
    backendId: 'opencode',
    nativeSessionId: 'native-source',
    projectId: 'boss-e2e',
    projectPath: PROJECT,
    executionPath: CHECKOUT,
    title: 'Source thread',
    time: { created: Date.now() - 60_000, updated: Date.now() - 2_000 },
    model: { id: 'gpt-5.6', provider: 'openai' }
  }
}

function initialDuplicateSession(): SessionInfo {
  return {
    id: 'thread-duplicate',
    backendId: 'opencode',
    nativeSessionId: 'native-duplicate',
    projectId: 'boss-e2e',
    projectPath: PROJECT,
    executionPath: CHECKOUT,
    title: 'Duplicate transcript',
    time: { created: Date.now() - 55_000, updated: Date.now() - 3_000 },
    model: { id: 'gpt-5.6', provider: 'openai' }
  }
}

function initialClaudeSession(): SessionInfo {
  return {
    id: 'thread-claude',
    backendId: 'claude',
    nativeSessionId: 'native-claude',
    projectId: 'boss-e2e',
    projectPath: PROJECT,
    executionPath: CHECKOUT,
    title: 'Claude stop thread',
    time: { created: Date.now() - 45_000, updated: Date.now() - 1_000 },
    model: { id: 'claude-opus-5', provider: 'anthropic' }
  }
}

function initialOpenCodeStopSession(): SessionInfo {
  return {
    id: 'thread-opencode-stop',
    backendId: 'opencode',
    nativeSessionId: 'native-opencode-stop',
    projectId: 'boss-e2e',
    projectPath: PROJECT,
    executionPath: CHECKOUT,
    title: 'OpenCode stop thread',
    time: { created: Date.now() - 30_000, updated: Date.now() - 1_000 },
    model: { id: 'gpt-5.6', provider: 'openai' }
  }
}

function initialAutomationReportSession(): SessionInfo {
  return {
    id: 'thread-report-source',
    backendId: 'opencode',
    nativeSessionId: 'native-report-source',
    projectId: 'boss-e2e',
    projectPath: PROJECT,
    executionPath: CHECKOUT,
    title: 'Automation report source',
    archived: true,
    time: { created: Date.now() - 610_000, updated: Date.now() - 600_000 },
    model: { id: 'gpt-5.6', provider: 'openai' }
  }
}

function sourceMessages(): MessageWithParts[] {
  const sessionID = 'thread-source'
  return [
    {
      info: { id: 'source-search-user', sessionID, role: 'user', time: { created: Date.now() - 50_000 } },
      parts: [
        {
          id: 'source-search-user-image',
          type: 'file',
          sessionID,
          messageID: 'source-search-user',
          state: { status: 'completed', name: 'source.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }
        },
        { id: 'source-search-user-text', type: 'text', sessionID, messageID: 'source-search-user', text: 'Search marker: first result.' }
      ]
    },
    {
      info: { id: 'source-search-agent', sessionID, role: 'assistant', time: { created: Date.now() - 49_000, completed: Date.now() - 48_000 } },
      parts: [
        { id: 'source-search-agent-text', type: 'text', sessionID, messageID: 'source-search-agent', text: 'Search marker: second result.' },
        // A fenced block, so the transcript exercises what agents actually send:
        // code the reader may want to copy, with a language tag to highlight by.
        { id: 'source-search-agent-code', type: 'text', sessionID, messageID: 'source-search-agent', text: 'Here is how to count:\n```ts\nconst answer = 42\nconsole.log(answer)\n```' }
      ]
    },
    {
      info: { id: 'source-stale-user', sessionID, role: 'user', time: { created: Date.now() - 47_000 } },
      parts: [{ id: 'source-stale-user-text', type: 'text', sessionID, messageID: 'source-stale-user', text: 'Spin up a Codex thread to review this PR.' }]
    }
  ]
}

function longTranscriptMessages(sessionID: string, turnCount: number): MessageWithParts[] {
  const result: MessageWithParts[] = []
  for (let index = 0; index < turnCount; index += 1) {
    const userId = `${sessionID}-user-${index}`
    const assistantId = `${sessionID}-assistant-${index}`
    result.push({
      info: { id: userId, sessionID, role: 'user', time: { created: index * 2 } },
      parts: [{
        id: `${userId}-text`, type: 'text', sessionID, messageID: userId,
        text: index === 17 ? 'Deep virtual search target near the start.' : `Long transcript prompt ${index}.`
      }]
    })
    result.push({
      info: { id: assistantId, sessionID, role: 'assistant', time: { created: index * 2 + 1, completed: index * 2 + 2 } },
      parts: [{
        id: `${assistantId}-text`, type: 'text', sessionID, messageID: assistantId,
        text: index === turnCount - 19 ? 'Deep virtual search target near the end.' : `Long transcript response ${index}.\n\nA stable second line gives this turn a measurable height.`
      }]
    })
  }
  return result
}

function claudeMessages(): MessageWithParts[] {
  const sessionID = 'thread-claude'
  return [
    {
      info: { id: 'claude-user', sessionID, role: 'user', time: { created: Date.now() - 20_000 } },
      parts: [{ id: 'claude-user-text', type: 'text', sessionID, messageID: 'claude-user', text: 'Can this thread compact or revert?' }]
    },
    {
      info: { id: 'claude-agent', sessionID, role: 'assistant', time: { created: Date.now() - 19_000, completed: Date.now() - 18_000 } },
      parts: [{ id: 'claude-agent-text', type: 'text', sessionID, messageID: 'claude-agent', text: 'Claude history controls are unavailable.' }]
    }
  ]
}

function duplicateMessages(): MessageWithParts[] {
  const sessionID = 'thread-duplicate'
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  return [
    {
      info: { id: 'source-duplicate-user', sessionID, role: 'user', time: { created: Date.now() - 40_000 } },
      parts: [
        {
          id: 'source-duplicate-image', type: 'file', sessionID, messageID: 'source-duplicate-user',
          state: { status: 'completed', path: 'duplicate-example.png', name: 'duplicate-example.png', mime: 'image/png', url: image }
        },
        { id: 'source-duplicate-user-text', type: 'text', sessionID, messageID: 'source-duplicate-user', text: 'Here is the duplicate example.' }
      ]
    },
    {
      // BOSS versions before screenshot ownership was fixed wrote the image as
      // an assistant message of its own. Keep one in the fixture so the real
      // renderer proves it is re-homed once rather than appended after every
      // later assistant update.
      info: { id: 'assistant-tool-image-legacy', sessionID, role: 'assistant', time: { created: Date.now() - 39_500 } },
      parts: [{
        id: 'legacy-boss-screenshot',
        type: 'file',
        sessionID,
        messageID: 'assistant-tool-image-legacy',
        state: { status: 'completed', name: 'boss_browser_screenshot', mime: 'image/png', url: image }
      }]
    },
    {
      info: { id: 'source-live-agent', sessionID, role: 'assistant', time: { created: Date.now() - 39_000, completed: Date.now() - 38_000 } },
      parts: [
        {
          id: 'owned-boss-screenshot', type: 'file', sessionID, messageID: 'source-live-agent',
          state: { status: 'completed', name: 'boss_browser_screenshot', mime: 'image/png', url: image }
        },
        { id: 'source-live-command', type: 'tool', sessionID, messageID: 'source-live-agent', state: { status: 'completed', tool: 'shell', input: { command: 'sed' } } },
        { id: 'source-live-text', type: 'text', sessionID, messageID: 'source-live-agent', text: 'Critical find. Let me inspect it.' }
      ]
    },
    {
      info: { id: 'source-history-agent', sessionID, role: 'assistant', time: { created: Date.now() - 37_000, completed: Date.now() - 36_000 } },
      parts: [
        { id: 'source-history-text', type: 'text', sessionID, messageID: 'source-history-agent', text: 'Critical find. Let me inspect it.' },
        { id: 'source-history-command', type: 'tool', sessionID, messageID: 'source-history-agent', state: { status: 'completed', tool: 'shell', input: { command: 'rg' } } }
      ]
    }
  ]
}

/** Replace external I/O while preserving the real Electron window, preload
 * boundary, React tree, localStorage, and user interactions. This module is
 * reachable only when the main process explicitly starts with BOSS_E2E=1. */
export function installE2EApi(boss: BossApi): void {
  let threadPins = savedThreadPins()
  const applyPins = (list: SessionInfo[]): SessionInfo[] =>
    list.map((session) => (threadPins[session.id] === undefined ? session : { ...session, pinned: threadPins[session.id] }))
  let sessions = applyPins([
    initialSession(),
    initialDuplicateSession(),
    initialClaudeSession(),
    initialOpenCodeStopSession(),
    initialAutomationReportSession()
  ])
  const messages: Record<string, MessageWithParts[]> = {
    'thread-source': sourceMessages(),
    'thread-duplicate': duplicateMessages(),
    'thread-claude': claudeMessages()
  }
  const revertedMessages: Record<string, MessageWithParts[]> = {}
  let defaults: Partial<Record<BackendId, BackendModelPreference>> = {}
  let labConnections: LabConnectionsSettings = {
    connections: [{
      id: 'lab-local',
      name: 'Local test',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyConfigured: false,
      healthy: true,
      manualModels: ['lab-e2e'],
      models: [{ id: 'lab-e2e', name: 'Lab E2E', source: 'local' }]
    }]
  }
  let modesBySession: Record<string, BackendModeId> = {}
  let followUps: Record<string, QueuedFollowUp[]> = {
    'thread-claude': [{
      id: 'followup-claude',
      threadId: 'thread-claude',
      text: 'Continue with the corrected instruction.',
      attachments: [],
      createdAt: Date.now()
    }],
    // On its own thread, not thread-source: a thread that starts with something
    // queued cannot also be used to test what an ordinary first send does.
    'thread-opencode-stop': [{
      id: 'followup-source',
      threadId: 'thread-opencode-stop',
      text: 'Redirect this opencode run instead.',
      attachments: [],
      createdAt: Date.now()
    }]
  }
  let calls: RecordedCall[] = []
  let lastContextHandoff = ''
  let nextExportError: string | undefined
  let holdNextPin = false
  let releasePin: (() => void) | undefined
  const clipboardWrites: string[] = []
  // The real manager persists this in BOSS's data store. Keep the fixture's
  // equivalent in session storage so a renderer reload exercises that contract.
  let threadTitleSettings = savedThreadTitleSettings()
  let sandboxSettings = { networkAccess: true }
  let nextThread = 1
  let nextFollowUp = 1
  let nextAutomation = 1
  // One webhook-triggered automation ships pre-seeded so cards can be asserted
  // without driving the whole editor first.
  let automationsFixture: Array<Record<string, unknown>> = [{
    id: 'automation-webhook-seed',
    name: 'Review incoming PRs',
    prompt: 'Review pull request {{pr_number}} against {{repo}}.',
    projectPath: PROJECT,
    backendId: 'opencode',
    mode: 'auto',
    schedule: { kind: 'manual' },
    webhook: { events: ['pull_request'], branch: 'main' },
    workspace: 'worktree',
    overlapPolicy: 'skip',
    catchUp: true,
    saveReport: true,
    notify: 'events',
    maxRunMinutes: 30,
    keepRuns: 50,
    enabled: true,
    missedRuns: 0,
    lastWebhookAt: Date.now() - 300_000,
    lastWebhookLabel: 'pull_request · #14 · opened · octo/hello',
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000
  }]
  const automationRunsFixture: Array<Record<string, unknown>> = [{
    id: 'run-report-seed',
    automationId: 'automation-webhook-seed',
    reportId: 'report-codex-seed',
    threadId: 'thread-report-source',
    trigger: 'schedule',
    status: 'success',
    summary: 'Codex added report history and improved mobile review.',
    changedFiles: 0,
    startedAt: Date.now() - 610_000,
    finishedAt: Date.now() - 600_000
  }]
  let reportsFixture: Array<Record<string, unknown>> = [
    {
      id: 'report-agent-seed',
      source: { kind: 'agent', backendId: 'claude' },
      threadId: 'thread-report-source',
      projectPath: PROJECT,
      title: 'Launch readiness brief',
      summary: 'A Claude-created artifact with launch risks and recommendations.',
      body: '## Recommendation\n\nShip behind a feature flag.\n\n| Risk | Mitigation |\n| --- | --- |\n| Adoption | Guided rollout |',
      createdAt: Date.now() - 300_000,
      updatedAt: Date.now() - 300_000
    },
    {
      id: 'report-codex-seed',
      source: {
        kind: 'automation',
        automationId: 'automation-webhook-seed',
        automationName: 'Review incoming PRs',
        runId: 'run-report-seed',
        status: 'success'
      },
      threadId: 'thread-report-source',
      projectPath: PROJECT,
      title: 'Codex changelog',
      summary: 'Codex added report history and improved mobile review.',
      body: '## Highlights\n\n- Added durable automation reports.\n- Made every report available on mobile.\n\n| Area | Result |\n| --- | --- |\n| Reports | Ready |',
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now() - 600_000
    }
  ]
  let assistantFixture: LabAssistantSnapshot = {
    generatedAt: Date.now(),
    tasks: [
      {
        id: 'assistant-task-plan', title: 'Plan task workflow', projectPath: PROJECT,
        status: 'ready', dependsOn: [], createdAt: Date.now() - 40_000, updatedAt: Date.now() - 40_000
      },
      {
        id: 'assistant-task-ship', title: 'Ship task workflow', projectPath: PROJECT,
        status: 'blocked', dependsOn: ['assistant-task-plan'], createdAt: Date.now() - 35_000, updatedAt: Date.now() - 35_000
      }
    ],
    taskPlans: {},
    ciIncidents: [{
      id: 'octo/hello:workflow:7:eval-foundation',
      repository: 'octo/hello',
      workflowId: 7,
      workflow: 'CI',
      runId: 801,
      runNumber: 19,
      runAttempt: 2,
      url: 'https://github.com/octo/hello/actions/runs/801',
      headBranch: 'eval-foundation',
      headSha: 'abc123',
      pullRequestId: 'octo/hello#22',
      conclusion: 'failure',
      status: 'failing',
      jobs: [{
        name: 'Electron end-to-end',
        url: 'https://github.com/octo/hello/actions/runs/801/job/9',
        conclusion: 'failure',
        failedSteps: ['Run npm run test:e2e']
      }],
      occurrenceCount: 2,
      firstFailedAt: Date.now() - 50_000,
      updatedAt: Date.now() - 10_000,
      taskId: 'assistant-task-plan',
      routedTo: 'thread-source',
      routedDeliveryKey: '801:2:failure',
      lastDeliveryKey: '801:2:failure'
    }],
    pullRequests: [
      {
        id: 'octo/hello#21', repository: 'octo/hello', number: 21, title: 'Mobile polish',
        url: 'https://github.com/octo/hello/pull/21', headBranch: 'mobile-polish', baseBranch: 'main',
        state: 'open', mergeability: 'clean', updatedAt: Date.now() - 30_000
      },
      {
        id: 'octo/hello#22', repository: 'octo/hello', number: 22, title: 'Eval foundation',
        url: 'https://github.com/octo/hello/pull/22', headBranch: 'eval-foundation', baseBranch: 'main',
        state: 'open', mergeability: 'clean', updatedAt: Date.now() - 20_000
      }
    ],
    questions: [{
      id: 'assistant-question-order',
      key: 'merge-order:octo/hello:main:octo/hello#21,octo/hello#22',
      repository: 'octo/hello',
      prompt: 'Two pull requests are ready for main. Which should merge first?',
      options: [
        { id: 'octo/hello#21', label: '#21 · Mobile polish' },
        { id: 'octo/hello#22', label: '#22 · Eval foundation' }
      ],
      status: 'open',
      createdAt: Date.now() - 10_000
    }],
    activities: [],
    mergeOrders: {}
  }
  // Mirrors TelegramBot.status(): off and tokenless until settings turn it on.
  const telegramFixture = {
    enabled: false,
    running: false,
    threadId: '',
    allowedChatIds: [] as number[],
    tokenSet: false,
    username: undefined as string | undefined
  }
  const eventListeners = new Set<(data: string) => void>()
  const intentionallyStopped = new Set<string>()
  const busyThreads = new Set<string>()
  let nextBackendFailure: { type: BackendRequest['type']; message: string } | null = null
  let nextCodexTurn = 1

  const recordBackend = (request: BackendRequest): void => {
    calls.push({ channel: 'backend', request: structuredClone(request) })
  }

  // A tiny deterministic repository standing in for `git` itself. Only the
  // commands the review and commit surfaces issue are modelled; everything
  // else answers empty so an unexpected call is visible in the recording.
  let gitState: GitFixtureState = {
    branch: 'main',
    branches: ['conflict', 'feature', 'main'],
    staged: ['src/staged.ts'],
    unstaged: ['src/edited.ts'],
    untracked: ['scratch.ts'],
    stashes: [],
    nextStash: 1
  }
  const branchChanges: Record<string, string[]> = {
    conflict: ['src/edited.ts'],
    feature: ['src/feature-only.ts'],
    main: [],
    'origin/main': ['src/committed.ts']
  }
  const heldGitCommands = new Set<string>()
  const heldGitResolvers = new Map<string, Array<() => void>>()
  const FILE_PATCH = [
    '@@ -1,4 +1,4 @@',
    ' const first = unchanged()',
    '-const total = compute(a, b)',
    '+const sum = compute(a, b)',
    ' const last = unchanged()',
    ' done()',
    ''
  ].join('\n')

  const gitRunStub = async (path: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    calls.push({ channel: 'git', path: structuredClone(path), args: structuredClone(args) })
    const [command] = args
    const out = (stdout = ''): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: '' })
    const fail = (stderr: string): { code: number; stdout: string; stderr: string } => ({ code: 1, stdout: '', stderr })
    if (heldGitCommands.has(command)) {
      await new Promise<void>((resolve) => {
        heldGitResolvers.set(command, [...(heldGitResolvers.get(command) ?? []), resolve])
      })
    }
    switch (command) {
      case 'status':
        return out([
          ...gitState.staged.map((file) => `M  ${file}`),
          ...gitState.unstaged.map((file) => ` M ${file}`),
          ...gitState.untracked.map((file) => `?? ${file}`),
          ''
        ].join(args.includes('-z') ? '\0' : '\n'))
      case 'diff': {
        if (args.includes('--name-only')) {
          const range = args.find((arg) => arg.startsWith('HEAD..'))
          const target = range?.slice('HEAD..'.length)
          const comparison = !target && args[1] && !args[1].startsWith('-') ? args[1] : undefined
          const paths = target
            ? branchChanges[target] ?? []
            : comparison
              ? branchChanges[comparison] ?? []
            : args.includes('--cached')
              ? gitState.staged
              : gitState.unstaged
          const separator = args.includes('-z') ? '\0' : '\n'
          return out(paths.length ? [...paths].sort().join(separator) + (args.includes('-z') ? '\0' : '') : '')
        }
        if (args.includes('--no-index')) return { code: 1, stdout: FILE_PATCH, stderr: '' }
        const separator = args.indexOf('--')
        const file = separator >= 0 ? args[separator + 1] : undefined
        if (args.includes('--cached')) return out(file && gitState.staged.includes(file) ? FILE_PATCH : '')
        if (args[1] && !args[1].startsWith('-')) return out(file && branchChanges[args[1]]?.includes(file) ? FILE_PATCH : '')
        return out(file && gitState.unstaged.includes(file) ? FILE_PATCH : '')
      }
      case 'branch':
        return out(args.includes('--show-current')
          ? `${gitState.branch}\n`
          : [...gitState.branches, ...(args.includes('--all') ? ['origin/HEAD', 'origin/main'] : [])].sort().join('\n') + '\n')
      case 'symbolic-ref':
        return out('origin/main\n')
      case 'log':
        return out('abc1234567 Initial commit\ndef2345678 Second commit\n')
      case 'rev-parse':
        if (args.at(-1) === 'HEAD') return out('e2eheaddeadbeef\n')
        if (args.at(-1) === 'refs/stash') return gitState.stashes[0] ? out(`${gitState.stashes[0].oid}\n`) : fail('unknown revision')
        return out('')
      case 'add': {
        for (const file of args.slice(2)) {
          gitState = {
            ...gitState,
            unstaged: gitState.unstaged.filter((f) => f !== file),
            untracked: gitState.untracked.filter((f) => f !== file),
            staged: gitState.staged.includes(file) ? gitState.staged : [...gitState.staged, file]
          }
        }
        return out()
      }
      case 'restore': {
        for (const file of args.slice(3)) {
          if (!gitState.staged.includes(file)) continue
          gitState = {
            ...gitState,
            staged: gitState.staged.filter((f) => f !== file),
            unstaged: gitState.unstaged.includes(file) ? gitState.unstaged : [...gitState.unstaged, file]
          }
        }
        return out()
      }
      case 'commit':
        gitState = { ...gitState, staged: [] }
        return out()
      case 'push':
        return out()
      case 'stash': {
        if (args[1] === 'push') {
          if (gitState.staged.length + gitState.unstaged.length + gitState.untracked.length === 0) return out('No local changes to save\n')
          const stash = {
            oid: `e2estash${String(gitState.nextStash).padStart(4, '0')}`,
            staged: [...gitState.staged],
            unstaged: [...gitState.unstaged],
            untracked: [...gitState.untracked]
          }
          gitState = {
            ...gitState,
            staged: [],
            unstaged: [],
            untracked: [],
            stashes: [stash, ...gitState.stashes],
            nextStash: gitState.nextStash + 1
          }
          return out('Saved working directory and index state\n')
        }
        if (args[1] === 'list') return out(gitState.stashes.map((stash) => stash.oid).join('\n') + (gitState.stashes.length ? '\n' : ''))
        if (args[1] === 'pop') {
          const match = /^stash@\{(\d+)\}$/.exec(args[2] ?? '')
          const index = match ? Number(match[1]) : 0
          const stash = gitState.stashes[index]
          if (!stash) return fail('No stash entry found')
          gitState = {
            ...gitState,
            staged: [...stash.staged],
            unstaged: [...stash.unstaged],
            untracked: [...stash.untracked],
            stashes: gitState.stashes.filter((_, itemIndex) => itemIndex !== index)
          }
          return out()
        }
        return out()
      }
      case 'checkout': {
        const target = args.includes('-b') ? args[args.indexOf('-b') + 1] : args[1]
        if (target) {
          gitState = {
            ...gitState,
            branch: target,
            branches: gitState.branches.includes(target) ? gitState.branches : [...gitState.branches, target]
          }
        }
        return out()
      }
      default:
        return out()
    }
  }

  /** A real WAV the browser will actually play, so speakText() reaches its
   *  playing state without any audio hardware or network. Pure silence: the
   *  bytes after the header are all zero. */
  const silentWavDataUrl = (durationMs: number): string => {
    const rate = 8000
    const samples = Math.max(1, Math.floor((rate * durationMs) / 1000))
    const bytes = new Uint8Array(44 + samples * 2)
    const view = new DataView(bytes.buffer)
    const tag = (offset: number, value: string): void => {
      for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
    }
    tag(0, 'RIFF')
    view.setUint32(4, 36 + samples * 2, true)
    tag(8, 'WAVE')
    tag(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    tag(36, 'data')
    view.setUint32(40, samples * 2, true)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return `data:audio/wav;base64,${btoa(binary)}`
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
    if (nextBackendFailure?.type === request.type) {
      const failure = nextBackendFailure
      nextBackendFailure = null
      throw new Error(failure.message)
    }
    // Kept structurally typed so this fixture still builds on branches from
    // before thread.mode.set was added to BackendRequest. On current main the
    // renderer sends this immediately when a running thread changes mode.
    const modeRequest = request as unknown as {
      type: string
      threadId?: string
      mode?: BackendModeId
    }
    if (modeRequest.type === 'thread.mode.set' && modeRequest.threadId && modeRequest.mode) {
      modesBySession = { ...modesBySession, [modeRequest.threadId]: modeRequest.mode }
      const session = sessions.find((item) => item.id === modeRequest.threadId)
      return session?.backendId === 'codex' && busyThreads.has(modeRequest.threadId)
        ? { ...session, pendingUntilNextMessage: true }
        : session
    }
    switch (request.type) {
      case 'backend.list': return backends
      case 'backend.auth.status':
        return backends.map((backend) => ({ backendId: backend.id, state: 'connected', detail: 'E2E fixture' }))
      case 'backend.subscription-usage':
        return [
          { backendId: 'opencode', plan: 'OpenCode Go', updatedAt: 1_800_000_000_000, windows: [
            { label: '5-hour limit', usedPercent: 12, resetsAt: 1_800_000_000_000 },
            { label: 'Weekly limit', usedPercent: 34, resetsAt: 1_800_050_000_000 },
            { label: 'Monthly limit', usedPercent: 56, resetsAt: 1_800_100_000_000 }
          ] },
          { backendId: 'codex', plan: 'ChatGPT Plus', updatedAt: 1_800_000_000_000, windows: [
            { group: 'Codex', label: '5-hour limit', usedPercent: 35, resetsAt: 1_800_000_000_000 },
            { group: 'Codex', label: '7-day limit', usedPercent: 62, resetsAt: 1_800_050_000_000 },
            { group: 'GPT-5.3-Codex-Spark', label: '5-hour limit', usedPercent: 4, resetsAt: 1_800_025_000_000 }
          ] },
          { backendId: 'claude', plan: 'Claude Max', updatedAt: 1_800_000_000_000, windows: [
            { label: 'Current session', usedPercent: 8, resetLabel: 'Aug 22 at 12:50pm (America/Edmonton)' }
          ] },
          { backendId: 'pi', updatedAt: 1_800_000_000_000, windows: [], unavailableReason: 'Pi has no subscription of its own; its limits belong to the provider accounts it uses.' },
          { backendId: 'lab', updatedAt: 1_800_000_000_000, windows: [], unavailableReason: 'Lab API usage is not connected to a provider billing account.' }
        ]
      case 'backend.defaults.set':
        defaults = structuredClone(request.defaults)
        return undefined
      case 'lab.connections.get': return labConnections
      case 'lab.connection.save': {
        const current = request.connection.id
          ? labConnections.connections.find((connection) => connection.id === request.connection.id)
          : undefined
        const id = request.connection.id ?? `lab-connection-${labConnections.connections.length + 1}`
        const manualModels = request.connection.manualModels
        const connection = {
          id,
          name: request.connection.name,
          baseUrl: request.connection.baseUrl,
          apiKeyConfigured: request.connection.clearApiKey ? false : Boolean(request.connection.apiKey) || current?.apiKeyConfigured || false,
          healthy: true,
          manualModels,
          models: manualModels.map((modelId) => ({ id: modelId, name: modelId, source: 'custom' as const }))
        }
        labConnections = { connections: current
          ? labConnections.connections.map((item) => item.id === id ? connection : item)
          : [...labConnections.connections, connection] }
        models.lab = labConnections.connections.flatMap((item) => item.models.map((model) => ({
          ...model,
          provider: item.id,
          providerName: item.name
        })))
        return labConnections
      }
      case 'lab.connection.delete':
        labConnections = { connections: labConnections.connections.filter((connection) => connection.id !== request.connectionId) }
        models.lab = labConnections.connections.flatMap((item) => item.models.map((model) => ({ ...model, provider: item.id, providerName: item.name })))
        return labConnections
      case 'thread.title.settings.get': return threadTitleSettings
      case 'thread.title.settings.set':
        threadTitleSettings = { autoNameFromFirstPrompt: request.autoNameFromFirstPrompt }
        e2eStorage()?.setItem(THREAD_TITLE_SETTINGS_KEY, JSON.stringify(threadTitleSettings))
        return threadTitleSettings
      case 'sandbox.settings.get': return sandboxSettings
      case 'sandbox.settings.set':
        sandboxSettings = { networkAccess: request.networkAccess }
        return sandboxSettings
      case 'backend.bin.get': return {}
      case 'backend.bin.set': return request.path ? { [request.backendId]: request.path } : {}
      // Main stops the server and returns the descriptors; nothing about a
      // backend's advertised capabilities changes because it was restarted.
      case 'backend.restart': return backends
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
      case 'thread.pin': {
        if (holdNextPin) {
          holdNextPin = false
          await new Promise<void>((resolve) => { releasePin = resolve })
          releasePin = undefined
        }
        const found = sessions.find((session) => session.id === request.threadId)
        if (!found) throw new Error(`Unknown fixture thread ${request.threadId}`)
        const changed = { ...found, pinned: request.pinned }
        sessions = sessions.map((session) => session.id === request.threadId ? changed : session)
        threadPins = { ...threadPins, [request.threadId]: request.pinned }
        e2eStorage()?.setItem(THREAD_PINS_KEY, JSON.stringify(threadPins))
        return changed
      }
      // The source thread is the one with a recorded transcript, so it is the
      // one with reported tokens; every other thread reports nothing at all,
      // which is what makes its meter hide.
      case 'thread.usage':
        return request.threadId === 'thread-source'
          ? {
              threadId: request.threadId,
              totals: { runs: 4, durationMs: 95_000, tokens: 12_400, tokenRuns: 3, toolCalls: 11 },
              lastRun: {
                status: 'completed',
                startedAt: Date.now() - 20_000,
                finishedAt: Date.now(),
                durationMs: 20_000,
                tokens: 3_100,
                toolCalls: 4
              }
            }
          : { threadId: request.threadId, totals: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 } }
      case 'thread.messages': return messages[request.threadId] ?? []
      case 'thread.revert': {
        const current = messages[request.threadId] ?? []
        const index = current.findIndex((message) => message.info.id === request.messageId)
        if (index >= 0) {
          revertedMessages[request.threadId] = current.slice(index)
          messages[request.threadId] = current.slice(0, index)
        }
        return undefined
      }
      case 'thread.unrevert': {
        const reverted = revertedMessages[request.threadId] ?? []
        messages[request.threadId] = [...(messages[request.threadId] ?? []), ...reverted]
        delete revertedMessages[request.threadId]
        return undefined
      }
      case 'thread.compact': {
        const sessionID = request.threadId
        messages[sessionID] = [{
          info: { id: `${sessionID}-compact-summary`, sessionID, role: 'assistant', time: { created: Date.now(), completed: Date.now() } },
          parts: [{
            id: `${sessionID}-compact-summary-text`,
            type: 'text',
            sessionID,
            messageID: `${sessionID}-compact-summary`,
            text: 'Compacted context summary.'
          }]
        }]
        return undefined
      }
      // Main allows one run per thread and refuses the rest, because only it
      // knows without a race. The renderer is expected to queue what it refuses
      // rather than drop it.
      case 'thread.send': {
        if (busyThreads.has(request.threadId)) throw new Error(THREAD_BUSY_ERROR)
        const found = sessions.find((session) => session.id === request.threadId)
        if (threadTitleSettings.autoNameFromFirstPrompt) {
          // Codex stands in for a successful cheap model call; Claude has no
          // title generator in BOSS and exercises the local fallback.
          const title = found?.backendId === 'codex'
            ? 'Improve automatic thread naming'
            : titleFromFirstPrompt(found?.title, request.parts)
          if (found && title) {
            const changed = { ...found, title, time: { ...found.time, updated: Date.now() } }
            sessions = sessions.map((session) => session.id === request.threadId ? changed : session)
            const data = JSON.stringify({ type: 'session.updated', properties: { info: changed }, backendId: changed.backendId })
            for (const listener of eventListeners) listener(data)
          }
        }
        busyThreads.add(request.threadId)
        // Codex's turn/start acknowledgement publishes the user's input before
        // the delayed native userMessage event. Mirror that main/backend seam
        // so E2E can hold the visible contract without real Codex credentials.
        if (found?.backendId === 'codex') {
          // Main announces the run before waiting for the backend. The public
          // event also changes the composer into its follow-up state, proving
          // the message below is visible while Codex is genuinely busy.
          const busy = JSON.stringify({
            type: 'session.status',
            properties: { sessionID: request.threadId, status: { type: 'busy' } },
            backendId: found.backendId
          })
          for (const listener of eventListeners) listener(busy)
          const messageId = `user-e2e-turn-${nextCodexTurn++}-0`
          const info: MessageWithParts['info'] = {
            id: messageId,
            sessionID: request.threadId,
            role: 'user',
            time: { created: Date.now() }
          }
          const text = request.parts
            .filter((part): part is { type: string; text: string } => Boolean(
              part && typeof part === 'object' && (part as { type?: string }).type === 'text'
            ))
            .map((part) => part.text)
            .join('\n')
          const transcript: MessageWithParts = {
            info,
            parts: text
              ? [{ id: `${messageId}-text`, type: 'text', sessionID: request.threadId, messageID: messageId, text }]
              : []
          }
          messages[request.threadId] = [...(messages[request.threadId] ?? []), transcript]
          for (const listener of eventListeners) {
            listener(JSON.stringify({ type: 'message.updated', properties: { info }, backendId: 'codex' }))
            for (const part of transcript.parts) {
              listener(JSON.stringify({ type: 'message.part.updated', properties: { part }, backendId: 'codex' }))
            }
          }
        }
        return undefined
      }
      case 'thread.todos': return []
      case 'thread.diff': return []
      case 'thread.models': return models[request.backendId ?? sessions.find((session) => session.id === request.threadId)?.backendId ?? 'opencode']
      case 'thread.followups.list': return followUps[request.threadId] ?? []
      case 'thread.followups.add': {
        const queued: QueuedFollowUp = {
          id: `followup-added-${nextFollowUp++}`,
          threadId: request.threadId,
          text: request.text,
          attachments: request.attachments ?? [],
          options: request.options,
          createdAt: Date.now()
        }
        followUps = { ...followUps, [request.threadId]: [...(followUps[request.threadId] ?? []), queued] }
        return followUps[request.threadId]
      }
      case 'thread.followups.update': return followUps[request.threadId] ?? []
      case 'thread.followups.remove':
        followUps = {
          ...followUps,
          [request.threadId]: (followUps[request.threadId] ?? []).filter((item) => item.id !== request.followUpId)
        }
        return followUps[request.threadId]
      case 'thread.followups.move': return followUps[request.threadId] ?? []
      case 'thread.followups.steer':
        followUps = {
          ...followUps,
          [request.threadId]: (followUps[request.threadId] ?? []).filter((item) => item.id !== request.followUpId)
        }
        // A backend that cannot steer is stopped instead, and reports that stop
        // as an error on the run. Main recognises its own stop and settles the
        // thread rather than forwarding a failure, so nothing is emitted here.
        intentionallyStopped.add(request.threadId)
        return followUps[request.threadId]
      case 'thread.clone':
      case 'thread.delegate': {
        const source = sessions.find((session) => session.id === request.threadId)
        lastContextHandoff = contextHandoffPacket({
          sourceThread: source?.title ?? request.threadId,
          sourceBackend: source?.backendId ?? 'opencode',
          project: source?.projectId === 'global' ? 'Global chat' : source?.projectPath ?? '',
          instruction: request.type === 'thread.delegate'
            ? delegatedContextInstruction(request.instruction.trim())
            : request.instruction,
          messages: messages[request.threadId] ?? []
        })
        return createThread(request.backendId, request.type === 'thread.delegate' ? 'Delegated worker' : 'Continued thread')
      }
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
            // Source is intentionally recent so Home's card export path is
            // covered as well as the sidebar row.
            attention: session.id === 'thread-source'
              ? { kind: 'completed', createdAt: Date.now() - 1_000, detail: 'Fixture run completed' }
              : undefined,
            usage: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
          })),
          totals: { runs: 0, durationMs: 0, tokenRuns: 0, toolCalls: 0 }
        }
      case 'supervision.search': return []
      case 'supervision.acknowledge': return backendRequest({ type: 'supervision.snapshot' })
      case 'assistant.snapshot': return structuredClone(assistantFixture)
      case 'assistant.answer': {
        assistantFixture = {
          ...assistantFixture,
          generatedAt: Date.now(),
          questions: assistantFixture.questions.map((question) => question.id === request.questionId
            ? { ...question, status: 'answered', answerId: request.answerId, answeredAt: Date.now() }
            : question),
          mergeOrders: {
            ...assistantFixture.mergeOrders,
            'octo/hello:main': [request.answerId, ...assistantFixture.pullRequests.map((pullRequest) => pullRequest.id).filter((id) => id !== request.answerId)]
          }
        }
        const data = JSON.stringify({ type: 'assistant.updated', properties: { snapshot: assistantFixture } })
        for (const listener of eventListeners) listener(data)
        return structuredClone(assistantFixture)
      }
      case 'assistant.task.create': {
        const now = Date.now()
        const dependencies = request.input.dependsOn ?? []
        const blocked = dependencies.some((id) => assistantFixture.tasks.find((task) => task.id === id)?.status !== 'done')
        assistantFixture = {
          ...assistantFixture,
          generatedAt: now,
          tasks: [...assistantFixture.tasks, {
            id: `assistant-task-${assistantFixture.tasks.length + 1}`,
            title: request.input.title,
            ...(request.input.details ? { details: request.input.details } : {}),
            ...(request.input.projectPath ? { projectPath: request.input.projectPath } : {}),
            status: blocked ? 'blocked' : 'ready',
            dependsOn: dependencies,
            createdAt: now,
            updatedAt: now
          }]
        }
        return structuredClone(assistantFixture)
      }
      case 'assistant.task.update': {
        const now = Date.now()
        const updatedTasks = assistantFixture.tasks.map((task) => task.id === request.taskId
          ? {
              ...task,
              ...request.patch,
              projectPath: request.patch.projectPath === null ? undefined : request.patch.projectPath ?? task.projectPath,
              updatedAt: now,
              ...(request.patch.status === 'done' ? { completedAt: now } : {})
            }
          : task)
        assistantFixture = {
          ...assistantFixture,
          generatedAt: now,
          tasks: updatedTasks.map((task) => task.status === 'blocked' && task.dependsOn.every((id) => updatedTasks.find((candidate) => candidate.id === id)?.status === 'done')
            ? { ...task, status: 'ready', updatedAt: now }
            : task)
        }
        return structuredClone(assistantFixture)
      }
      case 'assistant.task.assign': {
        const now = Date.now()
        assistantFixture = {
          ...assistantFixture,
          generatedAt: now,
          tasks: assistantFixture.tasks.map((task) => task.id === request.taskId
            ? { ...task, status: 'running', assignedThreadId: request.threadId, updatedAt: now }
            : task)
        }
        return structuredClone(assistantFixture)
      }
      case 'thread.policy.get': return undefined
      case 'thread.policy.set': return request.policy
      case 'worktree.list': return []
      case 'worktree.settings.get': return { autoCleanupEnabled: true, cleanupAfterDays: 30, location: 'app-data' }
      case 'worktree.settings.set': return { autoCleanupEnabled: true, cleanupAfterDays: 30, location: 'app-data', ...request }
      case 'mcp.list': return []
      case 'mcp.import.scan': return []
      case 'automation.list': return { automations: automationsFixture, runs: automationRunsFixture, webhookUrl: '' }
      case 'report.list': return {
        reports: reportsFixture.map((item) => {
          const summary = { ...item }
          delete summary.body
          return structuredClone(summary)
        })
      }
      case 'report.get': {
        const report = reportsFixture.find((item) => item.id === request.reportId)
        if (!report) throw new Error(`Unknown fixture report ${request.reportId}`)
        return structuredClone(report)
      }
      case 'report.read': {
        const report = reportsFixture.find((item) => item.id === request.reportId)
        if (!report) throw new Error(`Unknown fixture report ${request.reportId}`)
        if (!report.readAt) report.readAt = Date.now()
        return structuredClone(report)
      }
      case 'automation.create': {
        const now = Date.now()
        const created = {
          ...structuredClone(request.input),
          id: `automation-created-${nextAutomation++}`,
          enabled: true,
          missedRuns: 0,
          createdAt: now,
          updatedAt: now
        }
        automationsFixture = [...automationsFixture, created]
        return created
      }
      case 'automation.update': {
        const found = automationsFixture.find((item) => item.id === request.automationId)
        if (!found) throw new Error(`Unknown fixture automation ${request.automationId}`)
        const updated = {
          ...found,
          ...structuredClone(request.patch),
          updatedAt: Date.now()
        }
        if (updated.webhook == null) delete updated.webhook
        automationsFixture = automationsFixture.map((item) => item.id === request.automationId ? updated : item)
        return updated
      }
      case 'automation.delete':
        automationsFixture = automationsFixture.filter((item) => item.id !== request.automationId)
        return undefined
      // The real token lives in main's state file; the fixture hands back a
      // stable stand-in so the editor can render a copyable URL.
      case 'automation.webhook.token':
        return {
          token: `fixture-hook-${request.automationId}`,
          url: `http://127.0.0.1:4528/hooks/${request.automationId}/fixture-hook-${request.automationId}`
        }
      case 'automation.webhook.get': return { url: '', onlyWhenAway: true }
      case 'telegram.status': {
        const running = telegramFixture.enabled && telegramFixture.tokenSet
        return { ...telegramFixture, running, ...(running && telegramFixture.username ? { username: telegramFixture.username } : {}) }
      }
      case 'telegram.set': {
        const patch = request.patch
        if (patch.threadId !== undefined) telegramFixture.threadId = patch.threadId
        if (patch.allowedChats !== undefined) telegramFixture.allowedChatIds = [...new Set(patch.allowedChats)]
        if (patch.token !== undefined && patch.token.trim()) {
          telegramFixture.tokenSet = true
          telegramFixture.username = 'boss_e2e_bot'
        }
        if (patch.clearToken) {
          telegramFixture.tokenSet = false
          telegramFixture.enabled = false
          telegramFixture.username = undefined
        }
        if (patch.enabled !== undefined) telegramFixture.enabled = patch.enabled
        const status = telegramFixture as unknown as Record<string, unknown>
        status.running = telegramFixture.enabled && telegramFixture.tokenSet
        return status
      }
      case 'mobile.status': return { enabled: false, running: false, port: 0, tailscale: false }
      case 'thread.bus.get':
      case 'thread.bus.clear-failures':
        return { projectId: 'boss-e2e', projectPath: PROJECT, policy: 'collaborate', defaultPolicy: 'off', source: 'project', overrides: [], threads: [], messages: [], toolBackends: [] }
      case 'thread.bus.policy':
        return { projectId: 'boss-e2e', projectPath: PROJECT, policy: request.policy ?? 'off', defaultPolicy: 'off', source: request.policy ? 'project' : 'default', overrides: [], threads: [], messages: [], toolBackends: [] }
      case 'thread.bus.default-policy':
        return { projectId: 'boss-e2e', projectPath: PROJECT, policy: request.policy, defaultPolicy: request.policy, source: 'default', overrides: [], threads: [], messages: [], toolBackends: [] }
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
    gitRun: gitRunStub,
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
    // Keep the lifecycle real so restart coverage exercises main's persisted
    // preference. The fixture launches main with a deterministic fake driver.
    computerUseStatus: () => ipcRenderer.invoke(IpcChannels.ComputerUseStatus),
    computerUsePermissions: async () => ({ available: false, accessibility: false, screenRecording: false }),
    projectList: async () => [PROJECT],
    projectForget: async () => [],
    projectReorder: async (paths: string[]) => paths,
    projectCurrent: async () => projectInfo,
    projectSet: async () => projectInfo,
    projectChoose: async () => PROJECT,
    // Recorded rather than written: the suite asserts what the renderer asked
    // to copy and never touches a real system clipboard.
    clipboardWrite: (text: string) => { clipboardWrites.push(text) },
    ttsSpeak: async () => ({ ok: true, dataUrl: silentWavDataUrl(1_500) }),
    backendRequest,
    ttsStatus: async () => ({ available: false, ready: false, speaking: false }),
    onSpeechStatusChanged: () => () => {},
    sitesList: async () => [],
    onSitesChanged: () => () => {},
    sitesCfGet: async () => ({ configured: false }),
    updateStatus: async () => ({ currentVersion: 'e2e', channel: 'stable', checking: false, available: false, url: '' }),
    updateCheck: async () => ({ currentVersion: 'e2e', channel: 'stable', checking: false, available: false, url: '' }),
    onUpdateChanged: () => () => {},
    onMenuCommand: () => () => {},
    // Stands in for the real save dialog: records what the renderer handed
    // over and resolves a path, so the export flow can be asserted without a
    // native dialog or the user's disk.
    exportThreadMarkdown: async (req) => {
      calls.push({ channel: 'export', request: structuredClone(req) })
      if (nextExportError) {
        const message = nextExportError
        nextExportError = undefined
        throw new Error(message)
      }
      return `/tmp/boss-e2e/exports/${req.defaultName}`
    }
  } satisfies Partial<BossApi>)

  contextBridge.exposeInMainWorld('bossE2E', {
    /** The project list main actually holds, not the stub above.
     *
     *  projectList/projectSet are stubbed so the suite never depends on the
     *  user's real projects. That stub cannot show what the `boss` command
     *  recorded, which is exactly what those tests are about, so this reaches
     *  the real channel. Reading only — it creates nothing. */
    realProjectList: (): Promise<string[]> => ipcRenderer.invoke(IpcChannels.ProjectList),
    calls: () => structuredClone(calls),
    sessions: () => structuredClone(sessions),
    defaults: () => structuredClone(defaults),
    contextHandoff: () => lastContextHandoff,
    clipboardWrites: () => structuredClone(clipboardWrites),
    resetCalls: () => {
      calls = []
      lastContextHandoff = ''
    },
    failNextExport: (message: string) => { nextExportError = message },
    holdNextPin: () => { holdNextPin = true },
    releasePin: () => { releasePin?.() },
    holdGit: (command: string) => { heldGitCommands.add(command) },
    releaseGit: (command: string) => {
      heldGitCommands.delete(command)
      for (const resolve of heldGitResolvers.get(command) ?? []) resolve()
      heldGitResolvers.delete(command)
    },
    failNextBackendRequest: (type: BackendRequest['type'], message: string) => {
      nextBackendFailure = { type, message }
    },
    /** Add a thread the way an agent's spawn does: created in main, carrying
     *  the model main resolved, and never passing through renderer state.
     *  Announced with the same event main sends, which is what makes the
     *  renderer list it. */
    spawnThread: (backendId: BackendId, title: string) => {
      const session = createThread(backendId, title)
      const data = JSON.stringify({ type: 'session.created', properties: { info: session }, backendId })
      for (const listener of eventListeners) listener(data)
      return structuredClone(session)
    },
    installLongThread: (turnCount = 320) => {
      const id = 'thread-long-performance'
      const existing = sessions.find((item) => item.id === id)
      if (existing) return structuredClone(existing)
      const session: SessionInfo = {
        id,
        backendId: 'opencode',
        nativeSessionId: 'native-long-performance',
        projectId: 'boss-e2e',
        projectPath: PROJECT,
        executionPath: CHECKOUT,
        title: 'Long performance thread',
        time: { created: Date.now(), updated: Date.now() },
        model: { id: 'gpt-5.6', provider: 'openai' }
      }
      sessions = [session, ...sessions]
      messages[id] = longTranscriptMessages(id, turnCount)
      const data = JSON.stringify({ type: 'session.created', properties: { info: session }, backendId: 'opencode' })
      for (const listener of eventListeners) listener(data)
      return structuredClone(session)
    },
    emit: (event: Record<string, unknown>) => {
      // Current BOSS resolves host-managed Auto/Plan requests in main and only
      // forwards genuine user decisions to the renderer. Reproduce that seam
      // here; older branches fall through and exercise their renderer-owned
      // equivalent, which keeps the harness useful across a moving merge base.
      const eventType = typeof event.type === 'string' ? event.type : ''
      const properties = event.properties as { sessionID?: string; id?: string } | undefined
      if ((eventType === 'permission.asked' || eventType === 'permission.updated')
        && properties?.sessionID && properties.id) {
        const session = sessions.find((item) => item.id === properties.sessionID)
        const backend = backends.find((item) => item.id === session?.backendId)
        const mode = modesBySession[properties.sessionID]
        const response = mode === 'plan'
          ? 'reject'
          : mode === 'auto' && !backend?.capabilities.nativeAutoMode
            ? 'once'
            : undefined
        if (response) {
          recordBackend({
            type: 'thread.permission',
            threadId: properties.sessionID,
            permissionId: properties.id,
            response
          })
          return
        }
      }
      // The other seam main owns: an abort a thread was stopped with is the
      // end of that stop, not a failure, so main settles the run and forwards
      // nothing. Any other error still reaches the renderer.
      if (eventType === 'session.error' && properties?.sessionID
        && intentionallyStopped.has(properties.sessionID)
        && isAbortError((event.properties as { error?: unknown } | undefined)?.error)) {
        intentionallyStopped.delete(properties.sessionID)
        const idle = JSON.stringify({ type: 'session.idle', properties: { sessionID: properties.sessionID } })
        for (const listener of eventListeners) listener(idle)
        return
      }
      // Keep the fixture's own busy state in step with what the test says the
      // thread is doing, the way main keeps its busyThreads set.
      if (properties?.sessionID) {
        const status = (event.properties as { status?: { type?: string } } | undefined)?.status?.type
        if (eventType === 'session.idle' || status === 'idle') busyThreads.delete(properties.sessionID)
        else if (status === 'busy' || status === 'retry') busyThreads.add(properties.sessionID)
      }
      // Main's TranscriptStore records message events before forwarding them.
      // Keep the fixture equally reload-safe so a completion event that calls
      // thread.messages cannot erase the synthetic notice emitted just before
      // it.
      const message = (event.properties as { info?: MessageWithParts['info'] } | undefined)?.info
      if (eventType === 'message.updated' && message?.sessionID) {
        const current = messages[message.sessionID] ?? []
        const index = current.findIndex((item) => item.info.id === message.id)
        messages[message.sessionID] = index >= 0
          ? current.map((item, itemIndex) => itemIndex === index ? { ...item, info: { ...item.info, ...message } } : item)
          : [...current, { info: message, parts: [] }]
      }
      const part = (event.properties as { part?: MessageWithParts['parts'][number] } | undefined)?.part
      if ((eventType === 'message.part.updated' || eventType === 'message.part.created') && part?.sessionID) {
        const current = messages[part.sessionID] ?? []
        const messageIndex = current.findIndex((item) => item.info.id === part.messageID)
        if (messageIndex >= 0) {
          messages[part.sessionID] = current.map((item, itemIndex) => {
            if (itemIndex !== messageIndex) return item
            const partIndex = item.parts.findIndex((existing) => existing.id === part.id)
            const parts = partIndex >= 0
              ? item.parts.map((existing, index) => index === partIndex ? { ...existing, ...part } : existing)
              : [...item.parts, part]
            return { ...item, parts }
          })
        }
      }
      const data = JSON.stringify(event)
      for (const listener of eventListeners) listener(data)
    }
  })
}
