// Must be first: installs crypto.subtle, btoa and atob, which React Native
// does not ship and every sealed frame needs.
import './src/polyfills'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { PairScreen } from './src/PairScreen'
import {
  ThreadsScreen,
  type ThreadRow,
  type TranscriptHit,
  type TranscriptSearchRow
} from './src/ThreadsScreen'
import { ProjectsScreen } from './src/ProjectsScreen'
import { NewThreadScreen, type BackendOption, type ModelOption } from './src/NewThreadScreen'
import { DelegateScreen } from './src/DelegateScreen'
import { groupByProject, visibleThreads } from './src/parts'
import { AutomationsScreen, type AutomationRow, type AutomationRunRow } from './src/AutomationsScreen'
import { WorkScreen, type DiffFile, type Todo } from './src/WorkScreen'
import { ThreadScreen, type PendingPermission, type ThreadMessage } from './src/ThreadScreen'
import { type FollowUp } from './src/FollowUps'
import { RelayConnection, clearCredentials, loadCredentials, type RelayCredentials } from './src/relay'
import { theme } from './src/theme'

/**
 * BOSS on a phone.
 *
 * Speaks the same encrypted protocol as the desktop and the web page, over a
 * relay that only ever sees ciphertext. Native rather than a web app because
 * iOS blocks the pieces this needs from an installed PWA: camera access for
 * pairing, crypto.subtle outside a secure context, and background delivery.
 */
export default function App(): React.JSX.Element {
  const [credentials, setCredentials] = useState<RelayCredentials | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [connected, setConnected] = useState(false)
  const [desktopOnline, setDesktopOnline] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, ThreadMessage[]>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [permissions, setPermissions] = useState<Record<string, PendingPermission>>({})
  const [sending, setSending] = useState(false)
  // Which project's threads are open. null means the project list itself.
  const [openProject, setOpenProject] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  /** The thread being delegated from, while its options are being chosen. */
  const [delegating, setDelegating] = useState<string | null>(null)
  const [backends, setBackends] = useState<BackendOption[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [threadModes, setThreadModes] = useState<Record<string, string>>({})
  // Thinking level is not stored on a thread — it rides on each message — so
  // this is what the next send will ask for. Same for the model: switching one
  // is a choice about the next turn, not an edit to what already ran.
  const [threadVariants, setThreadVariants] = useState<Record<string, string | undefined>>({})
  const [threadModels, setThreadModels] = useState<Record<string, { modelID: string; providerID: string }>>({})
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TranscriptHit[]>([])
  const [searching, setSearching] = useState(false)
  const [find, setFind] = useState('')
  const [findHits, setFindHits] = useState<{ messageId: string; snippet: string }[]>([])
  const [finding, setFinding] = useState(false)
  const [followUps, setFollowUps] = useState<Record<string, FollowUp[]>>({})
  const [tab, setTab] = useState<'work' | 'automations'>('work')
  const [automations, setAutomations] = useState<AutomationRow[]>([])
  const [runs, setRuns] = useState<AutomationRunRow[]>([])
  const [automationBusy, setAutomationBusy] = useState<Record<string, boolean>>({})
  // The plan-and-changes panel for the open thread.
  const [showWork, setShowWork] = useState(false)
  const [todos, setTodos] = useState<Todo[]>([])
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([])
  const [openFile, setOpenFile] = useState<string | undefined>()
  const [fileBody, setFileBody] = useState<DiffFile | undefined>()
  const [loadingWork, setLoadingWork] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)

  const relay = useRef<RelayConnection | null>(null)
  // Read inside callbacks that outlive a render, so they never see a stale id.
  const openRef = useRef<string | null>(null)
  openRef.current = openThread
  // Read inside the event handler, which outlives the render that set it.
  const workRef = useRef(false)
  workRef.current = showWork

  const refreshThreads = useCallback(async () => {
    const connection = relay.current
    if (!connection) return
    try {
      const snapshot = await connection.request<{ threads?: ThreadRow[] }>({ type: 'supervision.snapshot' })
      // Archived and delegated-worker threads are hidden on the desktop, so
      // they are hidden here: the phone used to list every thread ever created.
      setThreads(visibleThreads(snapshot?.threads ?? []))
      setBusy((prev) => {
        const next = { ...prev }
        for (const t of snapshot?.threads ?? []) next[t.threadId] = Boolean(t.running)
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const refreshMessages = useCallback(async (threadId: string) => {
    const connection = relay.current
    if (!connection) return
    try {
      const list = await connection.request<ThreadMessage[]>({
        type: 'thread.messages', threadId, limit: 60
      })
      setMessages((prev) => ({ ...prev, [threadId]: list ?? [] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** Which agents this desktop can run, and what each one allows. */
  const loadBackends = useCallback(async () => {
    const connection = relay.current
    if (!connection) return
    try {
      const list = await connection.request<BackendOption[]>({ type: 'backend.list' })
      setBackends(list ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** Models belong to a backend, so this reloads whenever the agent changes. */
  const loadModels = useCallback(async (backendId: string) => {
    const connection = relay.current
    if (!connection) return
    setLoadingModels(true)
    try {
      const list = await connection.request<ModelOption[]>({ type: 'thread.models', backendId })
      setModels(list ?? [])
    } catch {
      // A backend that cannot list models is not an error worth a banner —
      // the screen says so and the thread still starts on the default.
      setModels([])
    } finally {
      setLoadingModels(false)
    }
  }, [])

  /**
   * Refetch a thread's messages soon, and once, however many events arrive.
   *
   * The desktop sends an event per streaming token. Refetching on each one
   * meant dozens of full 60-message loads a second, all but the last of them
   * discarded before anyone could read them.
   */
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queueMessages = useCallback((threadId: string) => {
    if (messageTimer.current) return
    messageTimer.current = setTimeout(() => {
      messageTimer.current = null
      void refreshMessages(threadId)
    }, 250)
  }, [refreshMessages])
  const refreshAutomations = useCallback(async () => {
    const connection = relay.current
    if (!connection) return
    try {
      const snapshot = await connection.request<{
        automations?: AutomationRow[]
        runs?: AutomationRunRow[]
      }>({ type: 'automation.list' })
      setAutomations(snapshot?.automations ?? [])
      setRuns(snapshot?.runs ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /** Run or stop an automation, holding the button until the desktop answers. */
  const commandAutomation = useCallback(async (id: string, action: 'run' | 'stop') => {
    const connection = relay.current
    if (!connection) return
    setAutomationBusy((prev) => ({ ...prev, [id]: true }))
    try {
      await connection.request({
        type: action === 'run' ? 'automation.run' : 'automation.stop',
        automationId: id
      })
      await refreshAutomations()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAutomationBusy((prev) => ({ ...prev, [id]: false }))
    }
  }, [refreshAutomations])

  /** The agent's plan, and which files it has changed so far. */
  const loadWork = useCallback(async (threadId: string) => {
    const connection = relay.current
    if (!connection) return
    setLoadingWork(true)
    try {
      const [plan, changes] = await Promise.all([
        connection.request<Todo[]>({ type: 'thread.todos', threadId }),
        // summary: paths and counts only. The full reply carries every changed
        // file's contents and does not fit in one relay frame.
        connection.request<DiffFile[]>({ type: 'thread.diff', threadId, summary: true })
      ])
      setTodos(plan ?? [])
      setDiffFiles(changes ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingWork(false)
    }
  }, [])

  /** One file's contents, fetched only when it is opened. */
  const loadFile = useCallback(async (threadId: string, path: string) => {
    const connection = relay.current
    if (!connection) return
    setOpenFile(path)
    setFileBody(undefined)
    setLoadingFile(true)
    try {
      const found = await connection.request<DiffFile[]>({ type: 'thread.diff', threadId, path })
      setFileBody(found?.[0])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingFile(false)
    }
  }, [])

  /** One event handler for both the live stream and a resume replay. */
  const applyEvent = useCallback((event: Record<string, unknown>) => {
    const props = (event.properties ?? {}) as Record<string, never>
    const sid = (props.sessionID ?? (props.part as { sessionID?: string })?.sessionID
      ?? (props.info as { sessionID?: string; id?: string })?.sessionID
      ?? (props.info as { id?: string })?.id) as string | undefined
    const type = String(event.type ?? '')

    if (type === 'session.status' && sid) {
      const status = (props.status ?? {}) as { type?: string }
      setBusy((prev) => ({ ...prev, [sid]: status.type === 'busy' || status.type === 'retry' }))
    }
    if ((type === 'session.idle' || type === 'session.error') && sid) {
      setBusy((prev) => ({ ...prev, [sid]: false }))
    }
    if ((type === 'permission.asked' || type === 'permission.updated') && sid) {
      setPermissions((prev) => ({ ...prev, [sid]: props as unknown as PendingPermission }))
    }
    if (type === 'permission.replied' && sid) {
      setPermissions((prev) => {
        const next = { ...prev }
        delete next[sid]
        return next
      })
    }
    if (type === 'thread.followups.updated') {
      // Carries threadId rather than sessionID, and the whole queue rather than
      // a delta — so this replaces, and does not need a refetch behind it.
      const threadId = props.threadId as string | undefined
      const queue = props.followUps as FollowUp[] | undefined
      if (threadId) setFollowUps((prev) => ({ ...prev, [threadId]: queue ?? [] }))
    }
    if (type === 'automations.updated') void refreshAutomations()
    if (type.startsWith('session.')) void refreshThreads()
    // Coalesce. A streaming run emits a message event per token, and each one
    // used to refetch all 60 messages and replace the list — every row
    // re-rendering many times a second, which is what made the text jitter.
    // One refetch per burst shows the same result at a fraction of the work.
    if (type.startsWith('message.') && sid && sid === openRef.current) queueMessages(sid)
    // The plan changes as the agent works, so a panel left open should follow
    // it. Guarded on the panel being open: nobody is watching otherwise.
    if (type === 'session.idle' && sid && sid === openRef.current && workRef.current) void loadWork(sid)
  }, [loadWork, queueMessages, refreshAutomations, refreshThreads])

  // Start the connection once, from whatever is in the Keychain.
  useEffect(() => {
    const connection = new RelayConnection({
      onEvent: applyEvent,
      // The desktop could not replay far enough back, so reload rather than
      // show a transcript with holes in it.
      onGap: () => {
        void refreshThreads()
        if (openRef.current) void refreshMessages(openRef.current)
      },
      onStateChange: (state) => {
        setConnected(state.connected)
        setDesktopOnline(state.desktopOnline)
      },
      onPaired: (next) => {
        // Do not load here: the replacement socket is still opening, so a
        // request would be rejected before it could be sent. onReady fires
        // once the hello is out.
        setCredentials(next)
        setError(undefined)
      },
      onReady: () => {
        setError(undefined)
        // Backends describe each thread's available modes, so the thread
        // screen needs them too — not just the compose screen.
        void loadBackends()
        void refreshAutomations()
        void refreshThreads()
        if (openRef.current) void refreshMessages(openRef.current)
      }
    })
    relay.current = connection

    void loadCredentials().then((saved) => {
      setLoaded(true)
      if (!saved) return
      setCredentials(saved)
      // onReady drives the load for both paths — startup and pairing — so the
      // request is never issued against a socket that is still opening.
      void connection.start(saved)
    })

    // Coming back from the background often leaves a frozen socket that never
    // fired close, so re-check rather than trust it.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') connection.resume()
    })
    return () => {
      subscription.remove()
      connection.stop()
      // A pending refetch must not fire into a torn-down screen.
      if (messageTimer.current) clearTimeout(messageTimer.current)
    }
  }, [applyEvent, loadBackends, refreshAutomations, refreshMessages, refreshThreads])

  /** Every queue request answers with the whole new queue, so one path applies
   *  them all rather than four that differ only in what they ask for. */
  const queueRequest = useCallback((threadId: string, request: Record<string, unknown>) => {
    void relay.current
      ?.request<FollowUp[]>(request as never)
      .then((queue) => setFollowUps((prev) => ({ ...prev, [threadId]: queue ?? [] })))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  // Message text lives in the desktop's transcript database, not on the phone,
  // so the search goes over the relay. Debounced because it runs a scan per
  // keystroke otherwise, and skipped under two characters where every thread
  // would match anyway.
  useEffect(() => {
    const clean = query.trim()
    if (clean.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void relay.current
        ?.request<TranscriptSearchRow[]>({ type: 'supervision.search', query: clean, limit: 40 })
        .then((results) => setHits((results ?? []).map((r) => ({
          threadId: r.threadId,
          title: r.title,
          snippet: r.snippet,
          role: r.role
        }))))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  // A find belongs to the thread it was typed in; carrying it to the next one
  // would open that thread already filtered by a term you have forgotten.
  useEffect(() => { setFind('') }, [openThread])

  // Find-in-thread. Scoped server-side rather than filtered afterwards: the
  // limit is spent on the most recent matches anywhere, so a busy neighbour
  // thread would otherwise crowd this thread's older matches out entirely.
  useEffect(() => {
    const clean = find.trim()
    if (!openThread || clean.length < 2) {
      setFindHits([])
      setFinding(false)
      return
    }
    setFinding(true)
    const timer = setTimeout(() => {
      void relay.current
        ?.request<TranscriptSearchRow[]>({
          type: 'supervision.search', query: clean, limit: 100, threadId: openThread
        })
        .then((results) => setFindHits((results ?? []).map((r) => ({
          messageId: r.messageId, snippet: r.snippet
        }))))
        .catch(() => setFindHits([]))
        .finally(() => setFinding(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [find, openThread])

  // Events only carry changes, so an already-queued follow-up would be
  // invisible until something moved it. Load the queue when a thread opens.
  useEffect(() => {
    if (!openThread) return
    void relay.current
      ?.request<FollowUp[]>({ type: 'thread.followups.list', threadId: openThread } as never)
      .then((queue) => setFollowUps((prev) => ({ ...prev, [openThread]: queue ?? [] })))
      .catch(() => {})
  }, [openThread])

  // The open thread needs its backend's models for the picker. Every route into
  // a thread lands here, so this covers them all rather than each caller
  // remembering to fetch.
  //
  // Keyed on the backend id rather than the thread list: that list refreshes on
  // every poll, and depending on it would refetch the same models forever.
  const openBackendId = openThread
    ? threads.find((t) => t.threadId === openThread)?.backendId
    : undefined
  useEffect(() => {
    if (openBackendId) void loadModels(openBackendId)
  }, [openBackendId, loadModels])

  /**
   * Start a thread and send its first message.
   *
   * Two requests, because the desktop models them separately: create returns a
   * thread, send puts the first message in it with the chosen model and mode.
   * The thread opens either way — if the send fails, an empty thread the user
   * can retry in beats losing what they typed.
   */
  const createThread = useCallback(async (input: {
    backendId: string
    prompt: string
    model?: { modelID: string; providerID: string; variant?: string }
    mode?: string
  }) => {
    const connection = relay.current
    if (!connection) return
    setSending(true)
    try {
      const created = await connection.request<{ id?: string }>({
        type: 'thread.create',
        backendId: input.backendId,
        ...(openProject ? { executionPath: openProject } : {})
      })
      const id = created?.id
      if (!id) throw new Error('The desktop did not return a thread.')

      setComposing(false)
      setOpenThread(id)
      await connection.request({
        type: 'thread.send',
        threadId: id,
        parts: [{ type: 'text', text: input.prompt }],
        options: {
          ...(input.model ? { model: input.model } : {}),
          ...(input.mode ? { mode: input.mode } : {})
        }
      })
      await refreshThreads()
      await refreshMessages(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [openProject, refreshMessages, refreshThreads])

  /**
   * Delegate to a new worker thread, then open it.
   *
   * One request, unlike createThread: the desktop's delegate builds the context
   * packet and sends the first message itself, so the options ride along with
   * the delegation rather than following it. Opening the worker is the point —
   * on a phone there is no second pane to watch it in.
   */
  const startDelegate = useCallback(async (from: string, input: {
    backendId: string
    instruction: string
    placement: 'same-checkout' | 'new-worktree'
    model?: { modelID: string; providerID: string; variant?: string }
    mode?: string
  }) => {
    const connection = relay.current
    if (!connection) return
    setSending(true)
    try {
      const created = await connection.request<{ id?: string }>({
        type: 'thread.delegate',
        threadId: from,
        backendId: input.backendId,
        instruction: input.instruction,
        placement: input.placement,
        options: {
          ...(input.model ? { model: input.model } : {}),
          ...(input.mode ? { mode: input.mode } : {})
        }
      })
      setDelegating(null)
      setError(undefined)
      const id = created?.id
      // A delegate with no id still ran on the desktop; the list will show it.
      if (id) {
        setOpenThread(id)
        await refreshThreads()
        await refreshMessages(id)
      } else {
        await refreshThreads()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [refreshMessages, refreshThreads])

  if (!loaded) return <View style={styles.fill} />

  if (!credentials?.token) {
    return (
      <SafeAreaView style={styles.fill}>
        <StatusBar barStyle="light-content" />
        <PairScreen
          error={error}
          onScanned={(payload) => {
            setError(undefined)
            void relay.current?.pair(payload)
          }}
        />
      </SafeAreaView>
    )
  }

  // Before the thread branch: choosing how to delegate replaces the thread it
  // was started from, the way composing replaces the list.
  if (delegating) {
    const from = threads.find((t) => t.threadId === delegating)
    return (
      <SafeAreaView style={styles.fill}>
        <StatusBar barStyle="light-content" />
        <DelegateScreen
          source={from?.title || 'Untitled thread'}
          sourceBackendId={from?.backendId}
          backends={backends}
          models={models}
          loadingModels={loadingModels}
          sending={sending}
          error={error}
          canWorktree={Boolean(from?.projectPath)}
          onPickBackend={(id) => void loadModels(id)}
          onCancel={() => { setDelegating(null); setError(undefined) }}
          onDelegate={(input) => void startDelegate(delegating, input)}
        />
      </SafeAreaView>
    )
  }

  const threadId = openThread
  if (threadId) {
    const title = threads.find((t) => t.threadId === threadId)?.title ?? 'Thread'
    return (
      <SafeAreaView style={styles.fill}>
        <StatusBar barStyle="light-content" />
        <View style={styles.header}>
          <Pressable onPress={() => (showWork ? setShowWork(false) : setOpenThread(null))}>
            <Text style={styles.back}>{showWork ? '‹ Chat' : '‹ Threads'}</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          <Pressable
            onPress={() => {
              const next = !showWork
              setShowWork(next)
              setOpenFile(undefined)
              if (next) void loadWork(threadId)
            }}
            hitSlop={8}
          >
            <Text style={[styles.back, showWork && styles.backOn]}>
              {diffFiles.length ? `Work · ${diffFiles.length}` : 'Work'}
            </Text>
          </Pressable>
        </View>
        {showWork ? (
          <WorkScreen
            todos={todos}
            files={diffFiles}
            openFile={openFile}
            fileBody={fileBody}
            loading={loadingWork}
            loadingFile={loadingFile}
            onOpenFile={(path) => void loadFile(threadId, path)}
            onCloseFile={() => { setOpenFile(undefined); setFileBody(undefined) }}
          />
        ) : (
        <ThreadScreen
          messages={messages[threadId] ?? []}
          busy={Boolean(busy[threadId])}
          permission={permissions[threadId]}
          sending={sending}
          modes={backends.find((b) => b.id === threads.find((t) => t.threadId === threadId)?.backendId)?.modes ?? []}
          mode={threadModes[threadId] ?? threads.find((t) => t.threadId === threadId)?.mode}
          variants={models.find((m) => m.id === (threadModels[threadId]?.modelID
            ?? threads.find((t) => t.threadId === threadId)?.model?.modelID))?.variants ?? []}
          variant={threadVariants[threadId]}
          onVariant={(next) => setThreadVariants((prev) => ({ ...prev, [threadId]: next }))}
          find={find}
          onFind={setFind}
          findHits={findHits}
          finding={finding}
          followUps={followUps[threadId] ?? []}
          steering={backends.find((b) => b.id === threads.find((t) => t.threadId === threadId)?.backendId)
            ?.capabilities?.steering ?? 'stop-and-redirect'}
          onEditFollowUp={(id, text) => queueRequest(threadId, {
            type: 'thread.followups.update', threadId, followUpId: id, text
          })}
          onMoveFollowUp={(id, toIndex) => queueRequest(threadId, {
            type: 'thread.followups.move', threadId, followUpId: id, toIndex
          })}
          onSteerFollowUp={(id) => queueRequest(threadId, {
            type: 'thread.followups.steer', threadId, followUpId: id
          })}
          onRemoveFollowUp={(id) => queueRequest(threadId, {
            type: 'thread.followups.remove', threadId, followUpId: id
          })}
          models={models}
          modelId={threadModels[threadId]?.modelID
            ?? threads.find((t) => t.threadId === threadId)?.model?.modelID}
          onModel={(next) => {
            const picked = models.find((m) => m.id === next)
            if (!picked) return
            setThreadModels((prev) => ({
              ...prev,
              [threadId]: { modelID: picked.id, providerID: picked.provider ?? '' }
            }))
            // A thinking level chosen for the old model means nothing to the
            // new one, so it goes back to the default rather than being sent
            // as a level the model may not offer.
            setThreadVariants((prev) => ({ ...prev, [threadId]: undefined }))
          }}
          onDelegate={() => {
            // Only opens the options. Delegating creates a thread, a branch,
            // and a running agent, which is too much for one unconfirmed tap.
            setError(undefined)
            setDelegating(threadId)
            const backendId = threads.find((t) => t.threadId === threadId)?.backendId
            if (backendId) void loadModels(backendId)
          }}
          onMode={(next) => {
            // Optimistic: the desktop has no event for a mode change, so the
            // chip would not move until a refresh that never comes.
            setThreadModes((prev) => ({ ...prev, [threadId]: next }))
            void relay.current
              ?.request({ type: 'thread.mode.set', threadId, mode: next })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }}
          onSend={(text) => {
            const current = threads.find((t) => t.threadId === threadId)
            // A switch picked here outranks what the thread last ran on; the
            // desktop learns of it from this message, the same way it learns
            // of a model chosen when the thread was created.
            const base = threadModels[threadId] ?? current?.model
            const variant = threadVariants[threadId]
            setSending(true)
            // Always the queue, never thread.send.
            //
            // A busy thread rejects a send, and deciding between the two from
            // the phone's copy of the busy flag loses the race the desktop
            // documents: two sends in quick succession both read "idle". The
            // queue has no such edge — it delivers immediately when the thread
            // is idle and holds the message when it is not, so one call is
            // correct in both states.
            void relay.current
              ?.request({
                type: 'thread.followups.add',
                threadId,
                text,
                // A variant alone is not a legal model: providerID and
                // modelID are required beside it, so they are always sent
                // together.
                ...(base && (threadModels[threadId] || variant)
                  ? { options: { model: { ...base, ...(variant ? { variant } : {}) } } }
                  : {})
              })
              .then((queue) => {
                setFollowUps((prev) => ({ ...prev, [threadId]: (queue as FollowUp[]) ?? [] }))
                return refreshMessages(threadId)
              })
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setSending(false))
          }}
          onStop={() => void relay.current?.request({ type: 'thread.abort', threadId }).catch(() => {})}
          onPermission={(response) => {
            const pending = permissions[threadId]
            if (!pending) return
            void relay.current?.request({
              type: 'thread.permission', threadId, permissionId: pending.id, response
            }).then(() => {
              setPermissions((prev) => {
                const next = { ...prev }
                delete next[threadId]
                return next
              })
            }).catch((e) => setError(e instanceof Error ? e.message : String(e)))
          }}
        />
        )}
      </SafeAreaView>
    )
  }

  if (composing) {
    return (
      <SafeAreaView style={styles.fill}>
        <StatusBar barStyle="light-content" />
        <NewThreadScreen
          backends={backends}
          models={models}
          loadingModels={loadingModels}
          sending={sending}
          error={error}
          project={openProject ? openProject.split('/').filter(Boolean).pop() : undefined}
          onPickBackend={(id) => void loadModels(id)}
          onCancel={() => { setComposing(false); setError(undefined) }}
          onCreate={(input) => void createThread(input)}
        />
      </SafeAreaView>
    )
  }

  const projects = groupByProject(threads)

  // Inside a project: its threads. Otherwise the project list.
  const project = openProject === null ? null : projects.find((p) => p.path === openProject)

  const tabs = (
    <View style={styles.tabs}>
      <Pressable
        style={styles.tab}
        onPress={() => setTab('work')}
      >
        <Text style={[styles.tabText, tab === 'work' && styles.tabTextOn]}>Work</Text>
      </Pressable>
      <Pressable
        style={styles.tab}
        onPress={() => {
          setTab('automations')
          void refreshAutomations()
        }}
      >
        <Text style={[styles.tabText, tab === 'automations' && styles.tabTextOn]}>Automations</Text>
      </Pressable>
    </View>
  )

  if (tab === 'automations') {
    return (
      <SafeAreaView style={styles.fill}>
        <StatusBar barStyle="light-content" />
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Automations</Text>
          <View style={[styles.statusDot, connected && desktopOnline && styles.statusOk]} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AutomationsScreen
          automations={automations}
          runs={runs}
          offline={!desktopOnline}
          refreshing={refreshing}
          busy={automationBusy}
          onRefresh={() => {
            setRefreshing(true)
            void refreshAutomations().finally(() => setRefreshing(false))
          }}
          onRun={(id) => void commandAutomation(id, 'run')}
          onStop={(id) => void commandAutomation(id, 'stop')}
          onOpenThread={(id) => {
            // Jump straight to the run's thread; the Work tab is where
            // transcripts live.
            setTab('work')
            setOpenThread(id)
            void refreshMessages(id)
          }}
        />
        {tabs}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.fill}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        {project ? (
          <Pressable onPress={() => setOpenProject(null)}>
            <Text style={styles.back}>‹ Projects</Text>
          </Pressable>
        ) : null}
        <Text style={styles.headerTitle} numberOfLines={1}>{project ? project.name : 'BOSS'}</Text>
        <View style={[styles.statusDot, connected && desktopOnline && styles.statusOk]} />
        {project ? null : (
          <Pressable onPress={() => void clearCredentials().then(() => setCredentials(null))}>
            <Text style={styles.back}>Unpair</Text>
          </Pressable>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {project ? (
        <ThreadsScreen
          threads={project.threads}
          query={query}
          onQuery={setQuery}
          // The list is one project's threads, so results from elsewhere would
          // point at threads this screen cannot show.
          hits={hits.filter((h) => project.threads.some((t) => t.threadId === h.threadId))}
          searching={searching}
          offline={!desktopOnline}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void refreshThreads().finally(() => setRefreshing(false))
          }}
          onOpen={(id) => {
            setOpenThread(id)
            void refreshMessages(id)
            // The thinking chips come from the thread's own model, which means
            // this thread's backend must be the one loaded.
            const backendId = threads.find((t) => t.threadId === id)?.backendId
            if (backendId) void loadModels(backendId)
          }}
          onNew={() => {
            setError(undefined)
            setComposing(true)
            void loadBackends()
          }}
        />
      ) : (
        <ProjectsScreen
          projects={projects}
          offline={!desktopOnline}
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void refreshThreads().finally(() => setRefreshing(false))
          }}
          onOpen={(path) => setOpenProject(path)}
          onNew={() => {
            setError(undefined)
            setComposing(true)
            void loadBackends()
          }}
        />
      )}
      {tabs}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line,
    paddingTop: 6,
    paddingBottom: 2
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  tabText: { color: theme.faint, fontSize: 13, fontWeight: '600' },
  tabTextOn: { color: theme.accent },
  fill: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.line
  },
  headerTitle: { color: theme.text, fontSize: 15, fontWeight: '600', flex: 1 },
  backOn: { color: theme.accent, fontWeight: '700' },
  back: { color: theme.accent, fontSize: 15 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.faint },
  statusOk: { backgroundColor: theme.green },
  error: { color: theme.red, fontSize: 13, paddingHorizontal: 14, paddingTop: 8 }
})
