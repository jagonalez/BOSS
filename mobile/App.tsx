// Must be first: installs crypto.subtle, btoa and atob, which React Native
// does not ship and every sealed frame needs.
import './src/polyfills'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { PairScreen } from './src/PairScreen'
import { ThreadsScreen, type ThreadRow } from './src/ThreadsScreen'
import { ProjectsScreen } from './src/ProjectsScreen'
import { NewThreadScreen, type BackendOption, type ModelOption } from './src/NewThreadScreen'
import { groupByProject, visibleThreads } from './src/parts'
import { AutomationsScreen, type AutomationRow, type AutomationRunRow } from './src/AutomationsScreen'
import { ThreadScreen, type PendingPermission, type ThreadMessage } from './src/ThreadScreen'
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
  const [backends, setBackends] = useState<BackendOption[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [threadModes, setThreadModes] = useState<Record<string, string>>({})
  // Thinking level is not stored on a thread — it rides on each message — so
  // this is what the next send will ask for.
  const [threadVariants, setThreadVariants] = useState<Record<string, string | undefined>>({})
  const [tab, setTab] = useState<'work' | 'automations'>('work')
  const [automations, setAutomations] = useState<AutomationRow[]>([])
  const [runs, setRuns] = useState<AutomationRunRow[]>([])
  const [automationBusy, setAutomationBusy] = useState<Record<string, boolean>>({})

  const relay = useRef<RelayConnection | null>(null)
  // Read inside callbacks that outlive a render, so they never see a stale id.
  const openRef = useRef<string | null>(null)
  openRef.current = openThread

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
    if (type === 'automations.updated') void refreshAutomations()
    if (type.startsWith('session.')) void refreshThreads()
    // Coalesce. A streaming run emits a message event per token, and each one
    // used to refetch all 60 messages and replace the list — every row
    // re-rendering many times a second, which is what made the text jitter.
    // One refetch per burst shows the same result at a fraction of the work.
    if (type.startsWith('message.') && sid && sid === openRef.current) queueMessages(sid)
  }, [queueMessages, refreshAutomations, refreshThreads])

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

  const threadId = openThread
  if (threadId) {
    const title = threads.find((t) => t.threadId === threadId)?.title ?? 'Thread'
    return (
      <SafeAreaView style={styles.fill}>
        <StatusBar barStyle="light-content" />
        <View style={styles.header}>
          <Pressable onPress={() => setOpenThread(null)}>
            <Text style={styles.back}>‹ Threads</Text>
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
        </View>
        <ThreadScreen
          messages={messages[threadId] ?? []}
          busy={Boolean(busy[threadId])}
          permission={permissions[threadId]}
          sending={sending}
          modes={backends.find((b) => b.id === threads.find((t) => t.threadId === threadId)?.backendId)?.modes ?? []}
          mode={threadModes[threadId] ?? threads.find((t) => t.threadId === threadId)?.mode}
          variants={models.find((m) => m.id === threads.find((t) => t.threadId === threadId)?.model?.modelID)?.variants ?? []}
          variant={threadVariants[threadId]}
          onVariant={(next) => setThreadVariants((prev) => ({ ...prev, [threadId]: next }))}
          onDelegate={() => {
            const instruction = 'Continue this work in a separate thread.'
            void relay.current
              ?.request({
                type: 'thread.delegate',
                threadId,
                backendId: threads.find((t) => t.threadId === threadId)?.backendId ?? 'opencode',
                instruction,
                placement: 'new-worktree'
              })
              .then(() => refreshThreads())
              .catch((e) => setError(e instanceof Error ? e.message : String(e)))
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
            setSending(true)
            void relay.current
              ?.request({
                type: 'thread.send',
                threadId,
                parts: [{ type: 'text', text }],
                // A variant alone is not a legal model: providerID and
                // modelID are required beside it, so the thread's current
                // model is carried through unchanged.
                ...(threadVariants[threadId] && current?.model
                  ? { options: { model: { ...current.model, variant: threadVariants[threadId] } } }
                  : {})
              })
              .then(() => refreshMessages(threadId))
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
  back: { color: theme.accent, fontSize: 15 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.faint },
  statusOk: { backgroundColor: theme.green },
  error: { color: theme.red, fontSize: 13, paddingHorizontal: 14, paddingTop: 8 }
})
