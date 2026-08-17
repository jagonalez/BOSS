import React from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { theme } from './theme'

export interface ThreadRow {
  threadId: string
  title?: string
  backendId?: string
  running?: boolean
  updatedAt?: number
  lastRun?: { status?: string; toolCalls?: number }
}

function ago(ts?: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

export function ThreadsScreen({ threads, offline, refreshing, onRefresh, onOpen }: {
  threads: ThreadRow[]
  /** The desktop is asleep or unreachable; say so rather than showing an empty list. */
  offline: boolean
  refreshing: boolean
  onRefresh(): void
  onOpen(threadId: string): void
}): React.JSX.Element {
  return (
    <View style={styles.fill}>
      {offline ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Your desktop is offline</Text>
          <Text style={styles.bannerBody}>Open BOSS on your desktop to continue.</Text>
        </View>
      ) : null}
      <FlatList
        data={threads}
        keyExtractor={(t) => t.threadId}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>{offline ? '' : 'No threads yet.'}</Text>
        }
        renderItem={({ item }) => {
          const state = item.lastRun?.status === 'error'
            ? 'failed'
            : item.running ? 'working' : 'idle'
          return (
            <Pressable style={styles.card} onPress={() => onOpen(item.threadId)}>
              <View style={styles.row}>
                <View style={[styles.dot, item.running && styles.dotBusy]} />
                <View style={styles.grow}>
                  <Text style={styles.title} numberOfLines={1}>{item.title || 'Untitled'}</Text>
                  <Text style={styles.sub}>
                    {item.backendId ?? ''}
                    {item.lastRun?.toolCalls ? ` · ${item.lastRun.toolCalls} tools` : ''}
                  </Text>
                </View>
                <Text style={[styles.badge, state === 'failed' && styles.badgeBad, state === 'working' && styles.badgeGood]}>
                  {state}
                </Text>
                <Text style={styles.sub}>{ago(item.updatedAt)}</Text>
              </View>
            </Pressable>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  list: { padding: 12, paddingBottom: 40 },
  card: {
    backgroundColor: theme.pane,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.faint },
  dotBusy: { backgroundColor: theme.green },
  title: { color: theme.text, fontSize: 15, fontWeight: '600' },
  sub: { color: theme.muted, fontSize: 12.5, marginTop: 2 },
  badge: {
    color: theme.muted,
    fontSize: 10.5,
    fontWeight: '700',
    textTransform: 'uppercase',
    backgroundColor: theme.inset,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden'
  },
  badgeGood: { color: theme.green },
  badgeBad: { color: theme.red },
  empty: { color: theme.faint, textAlign: 'center', paddingVertical: 40 },
  banner: {
    margin: 12,
    marginBottom: 0,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.yellow,
    backgroundColor: theme.pane
  },
  bannerTitle: { color: theme.yellow, fontWeight: '700', fontSize: 14 },
  bannerBody: { color: theme.muted, fontSize: 12.5, marginTop: 2 }
})
