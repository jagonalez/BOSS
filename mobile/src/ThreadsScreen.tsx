import React from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { attentionLabel, projectLabel, sortThreads, type ThreadRow } from './parts'
import { theme } from './theme'

export type { ThreadRow } from './parts'

function ago(ts?: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

/** Attention drives the row's colour, because it is the reason to look. */
function tone(thread: ThreadRow): string {
  switch (thread.attention?.kind) {
    case 'permission':
    case 'question': return theme.yellow
    case 'error': return theme.red
    case 'completed': return theme.green
    default: return theme.faint
  }
}

export function ThreadsScreen({ threads, offline, refreshing, onRefresh, onOpen }: {
  threads: ThreadRow[]
  /** The desktop is asleep or unreachable; say so rather than showing an empty list. */
  offline: boolean
  refreshing: boolean
  onRefresh(): void
  onOpen(threadId: string): void
}): React.JSX.Element {
  const sorted = sortThreads(threads)
  const waiting = sorted.filter((t) => t.attention?.kind === 'permission' || t.attention?.kind === 'question').length

  return (
    <View style={styles.fill}>
      {offline ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Your desktop is offline</Text>
          <Text style={styles.bannerBody}>Open BOSS on your desktop to continue.</Text>
        </View>
      ) : null}
      {waiting ? (
        <Text style={styles.waiting}>
          {waiting} {waiting === 1 ? 'thread needs' : 'threads need'} you
        </Text>
      ) : null}
      <FlatList
        data={sorted}
        keyExtractor={(t) => t.threadId}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>{offline ? '' : 'No threads yet.'}</Text>
        }
        renderItem={({ item }) => {
          const project = projectLabel(item)
          const colour = tone(item)
          return (
            <Pressable
              style={[styles.card, item.attention ? { borderColor: colour } : null]}
              onPress={() => onOpen(item.threadId)}
            >
              <View style={styles.row}>
                <View style={[styles.dot, { backgroundColor: item.running ? theme.green : colour }]} />
                <Text style={styles.title} numberOfLines={1}>{item.title || 'Untitled'}</Text>
                <Text style={styles.time}>{ago(item.updatedAt)}</Text>
              </View>
              {item.attention ? (
                <Text style={[styles.attention, { color: colour }]} numberOfLines={2}>
                  {attentionLabel(item.attention.kind)}
                  {item.attention.detail ? ` — ${item.attention.detail}` : ''}
                </Text>
              ) : null}
              <Text style={styles.sub} numberOfLines={1}>
                {[project, item.backendId, item.running ? 'working' : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
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
  waiting: {
    color: theme.yellow,
    fontSize: 12.5,
    fontWeight: '600',
    paddingHorizontal: 14,
    paddingTop: 10
  },
  card: {
    backgroundColor: theme.pane,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 4
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { color: theme.text, fontSize: 15, fontWeight: '600', flex: 1 },
  time: { color: theme.faint, fontSize: 12 },
  attention: { fontSize: 13, fontWeight: '600' },
  sub: { color: theme.muted, fontSize: 12.5 },
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
