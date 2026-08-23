import React from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { type ProjectGroup } from './parts'
import { theme } from './theme'

/**
 * The top of the app: which project, then which thread inside it.
 *
 * Projects are derived from the threads themselves — every thread reports the
 * path it runs in — because the desktop's own project list travels on an IPC
 * channel the relay does not carry. That means a project with no threads yet
 * does not appear here, which is the right trade: this screen exists to get to
 * work, and work is threads.
 */
export function ProjectsScreen({ projects, offline, refreshing, onRefresh, onOpen, onNew }: {
  projects: ProjectGroup[]
  offline: boolean
  refreshing: boolean
  onRefresh(): void
  onOpen(path: string): void
  onNew(): void
}): React.JSX.Element {
  const waiting = projects.reduce((n, p) => n + p.waiting, 0)

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Projects</Text>
          <Text style={styles.sub}>
            {offline ? 'Desktop offline' : waiting ? `${waiting} waiting for you` : 'Nothing waiting'}
          </Text>
        </View>
        <Pressable style={styles.new} onPress={onNew} accessibilityLabel="New thread">
          <Text style={styles.newText}>New</Text>
        </Pressable>
      </View>

      <FlatList
        data={projects}
        keyExtractor={(p) => p.path || 'none'}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.faint} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {offline ? 'Waiting for your desktop…' : 'No threads yet. Start one with New.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onOpen(item.path)}>
            <View style={styles.rowMain}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {item.threads.length} thread{item.threads.length === 1 ? '' : 's'}
                {item.running ? ` · ${item.running} running` : ''}
              </Text>
            </View>
            {item.waiting ? <View style={styles.badge}><Text style={styles.badgeText}>{item.waiting}</Text></View> : null}
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12
  },
  headerText: { flex: 1 },
  title: { color: theme.text, fontSize: 28, fontWeight: '700' },
  sub: { color: theme.faint, fontSize: 13, marginTop: 2 },
  new: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.accent
  },
  newText: { color: theme.bg, fontWeight: '700', fontSize: 15 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line
  },
  rowMain: { flex: 1 },
  name: { color: theme.text, fontSize: 17, fontWeight: '600' },
  meta: { color: theme.faint, fontSize: 13, marginTop: 3 },
  badge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 11,
    backgroundColor: theme.yellow,
    alignItems: 'center',
    marginRight: 8
  },
  badgeText: { color: theme.bg, fontWeight: '700', fontSize: 12 },
  chevron: { color: theme.faint, fontSize: 22 },
  empty: { color: theme.faint, textAlign: 'center', marginTop: 48, paddingHorizontal: 32 }
})
