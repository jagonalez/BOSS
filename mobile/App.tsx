// Must be first: installs crypto.subtle, btoa and atob, which React Native
// does not ship and every sealed frame needs.
import './src/polyfills'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { PairScreen } from './src/PairScreen'
import { ThreadsScreen, type ThreadRow } from './src/ThreadsScreen'
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

  const relay = useRef<RelayConnection | null>(null)
  // Read inside callbacks that outlive a render, so they never see a stale id.
  const openRef = useRef<string | null>(null)
  openRef.current = openThread

  const refreshThreads = useCallback(async () => {
    const connection = relay.current
    if (!connection) return
    try {
      const snapshot = await connection.request<{ threads?: ThreadRow[] }>({ type: 'supervision.snapshot' })
      setThreads(snapshot?.threads ?? [])
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
    if (type.startsWith('session.')) void refreshThreads()
    if (type.startsWith('message.') && sid && sid === openRef.current) void refreshMessages(sid)
  }, [refreshMessages, refreshThreads])

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
        setCredentials(next)
        setError(undefined)
        void refreshThreads()
      }
    })
    relay.current = connection

    void loadCredentials().then((saved) => {
      setLoaded(true)
      if (!saved) return
      setCredentials(saved)
      void connection.start(saved).then(() => refreshThreads())
    })

    // Coming back from the background often leaves a frozen socket that never
    // fired close, so re-check rather than trust it.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') connection.resume()
    })
    return () => {
      subscription.remove()
      connection.stop()
    }
  }, [applyEvent, refreshMessages, refreshThreads])

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
          onSend={(text) => {
            setSending(true)
            void relay.current
              ?.request({ type: 'thread.send', threadId, parts: [{ type: 'text', text }] })
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

  return (
    <SafeAreaView style={styles.fill}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>BOSS</Text>
        <View style={[styles.statusDot, connected && desktopOnline && styles.statusOk]} />
        <Pressable onPress={() => void clearCredentials().then(() => setCredentials(null))}>
          <Text style={styles.back}>Unpair</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {/* Connection state, so a stall says which half is missing rather than
          surfacing only as a request timeout. */}
      <Text style={styles.status}>
        {`socket ${connected ? 'open' : 'connecting'} · desktop ${desktopOnline ? 'online' : 'offline'}`}
      </Text>
      <ThreadsScreen
        threads={threads}
        offline={!desktopOnline}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true)
          void refreshThreads().finally(() => setRefreshing(false))
        }}
        onOpen={(id) => {
          setOpenThread(id)
          void refreshMessages(id)
        }}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
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
  error: { color: theme.red, fontSize: 13, paddingHorizontal: 14, paddingTop: 8 },
  status: { color: theme.faint, fontSize: 11, paddingHorizontal: 14, paddingTop: 6 }
})
