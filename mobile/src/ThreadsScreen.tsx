import React from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
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

/**
 * One colour, one meaning: yellow means this thread cannot continue without
 * you. Red for failed and green for finished told you the past rather than
 * what to do, and with three colours in play neither the list order nor the
 * dots read as anything without a key.
 */
function tone(thread: ThreadRow): string {
  const kind = thread.attention?.kind
  return kind === 'permission' || kind === 'question' ? theme.yellow : theme.faint
}

export interface TranscriptHit {
  threadId: string
  title: string
  snippet: string
  role: 'user' | 'assistant'
}

/** What the desktop's supervision.search returns, of which this app uses part. */
export interface TranscriptSearchRow extends TranscriptHit {
  messageId: string
  projectPath: string
  kind: 'message' | 'reasoning' | 'tool'
  timestamp?: number
}

export function ThreadsScreen({
  threads, offline, refreshing, onRefresh, onOpen, onNew, query, onQuery, hits, searching
}: {
  threads: ThreadRow[]
  /** The desktop is asleep or unreachable; say so rather than showing an empty list. */
  offline: boolean
  refreshing: boolean
  onRefresh(): void
  onOpen(threadId: string): void
  onNew(): void
  query: string
  onQuery(query: string): void
  /** Matches from inside transcripts, which the desktop searches for us. */
  hits: TranscriptHit[]
  searching: boolean
}): React.JSX.Element {
  const clean = query.trim().toLowerCase()
  // Titles filter here because the rows are already on the phone; message text
  // cannot, so it comes back from the desktop as `hits`.
  const matching = clean
    ? threads.filter((t) => `${t.title ?? ''} ${projectLabel(t) ?? ''}`.toLowerCase().includes(clean))
    : threads
  const sorted = sortThreads(matching)
  const waiting = sorted.filter((t) => t.attention?.kind === 'permission' || t.attention?.kind === 'question').length
  // A thread already listed by title does not need a second card for its text.
  const titled = new Set(sorted.map((t) => t.threadId))
  const extra = clean ? hits.filter((h) => !titled.has(h.threadId)) : []

  return (
    <View style={styles.fill}>
      {offline ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Your desktop is offline</Text>
          <Text style={styles.bannerBody}>Open BOSS on your desktop to continue.</Text>
        </View>
      ) : null}
      <View style={styles.search}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={onQuery}
          placeholder="Search threads and messages"
          placeholderTextColor={theme.faint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>
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
          <Text style={styles.empty}>
            {offline ? '' : clean ? '' : 'No threads yet.'}
          </Text>
        }
        ListFooterComponent={
          clean ? (
            <View>
              {extra.length ? <Text style={styles.section}>In messages</Text> : null}
              {extra.map((hit) => (
                <Pressable
                  key={`${hit.threadId}-${hit.snippet.slice(0, 24)}`}
                  style={styles.card}
                  onPress={() => onOpen(hit.threadId)}
                >
                  <Text style={styles.title} numberOfLines={1}>{hit.title || 'Untitled'}</Text>
                  <Text style={styles.snippet} numberOfLines={2}>{hit.snippet}</Text>
                </Pressable>
              ))}
              {!sorted.length && !extra.length ? (
                <Text style={styles.empty}>
                  {searching ? 'Searching…' : `Nothing matches “${query.trim()}”.`}
                </Text>
              ) : null}
            </View>
          ) : null
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
      <Pressable style={styles.fab} onPress={onNew} accessibilityLabel="New thread">
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 28,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center'
  },
  fabText: { color: theme.bg, fontSize: 30, fontWeight: '700', marginTop: -3 },
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
  search: { paddingHorizontal: 12, paddingTop: 10 },
  searchInput: {
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 10,
    color: theme.text,
    // 16px or larger, or iOS zooms the view when the field takes focus.
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  section: {
    color: theme.faint,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 4
  },
  snippet: { color: theme.muted, fontSize: 12.5, lineHeight: 17 },
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
