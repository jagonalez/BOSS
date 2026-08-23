import React from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { theme } from './theme'

export interface AutomationRow {
  id: string
  name: string
  enabled: boolean
  projectPath: string
  nextRunAt?: number
  lastRunAt?: number
  schedule?: { kind: 'cron' | 'manual'; expression?: string }
}

export interface AutomationRunRow {
  id: string
  automationId: string
  threadId?: string
  status: 'running' | 'success' | 'failure' | 'timeout' | 'skipped' | 'aborted'
  summary?: string
  error?: string
  changedFiles: number
  startedAt: number
  finishedAt?: number
}

function when(at?: number): string {
  if (!at) return ''
  const delta = at - Date.now()
  const abs = Math.abs(delta)
  const minutes = Math.round(abs / 60_000)
  const unit = minutes < 60
    ? `${minutes}m`
    : abs < 86_400_000 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
  return delta > 0 ? `in ${unit}` : `${unit} ago`
}

/** The one status worth a colour: something failed and nobody has looked. */
function statusTone(status: AutomationRunRow['status']): string {
  if (status === 'failure' || status === 'timeout') return theme.red
  if (status === 'running') return theme.green
  return theme.faint
}

/**
 * Scheduled work, and how the last run went.
 *
 * The desktop already exposes automation.list, .run and .stop over the relay
 * and forwards automations.updated, so this screen is the only piece that was
 * missing — the phone could watch threads but not the things that start them.
 */
export function AutomationsScreen({
  automations, runs, offline, refreshing, busy, onRefresh, onRun, onStop, onOpenThread
}: {
  automations: AutomationRow[]
  runs: AutomationRunRow[]
  offline: boolean
  refreshing: boolean
  /** Automation ids with a request in flight, so a tap cannot be sent twice. */
  busy: Record<string, boolean>
  onRefresh(): void
  onRun(id: string): void
  onStop(id: string): void
  onOpenThread(threadId: string): void
}): React.JSX.Element {
  // Newest run per automation, which is the only one a row shows.
  const latest = new Map<string, AutomationRunRow>()
  for (const run of runs) {
    const held = latest.get(run.automationId)
    if (!held || run.startedAt > held.startedAt) latest.set(run.automationId, run)
  }

  return (
    <View style={styles.fill}>
      <FlatList
        data={automations}
        keyExtractor={(a) => a.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.faint} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {offline ? 'Waiting for your desktop…' : 'No automations yet. Create one on your desktop.'}
          </Text>
        }
        renderItem={({ item }) => {
          const run = latest.get(item.id)
          const running = run?.status === 'running'
          const pending = busy[item.id] === true
          return (
            <View style={styles.row}>
              <View style={styles.head}>
                <View style={styles.headText}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {!item.enabled
                      ? 'Paused'
                      : item.nextRunAt
                        ? `Next ${when(item.nextRunAt)}`
                        : item.schedule?.kind === 'cron' ? 'Scheduled' : 'Manual'}
                  </Text>
                </View>
                <Pressable
                  style={[styles.action, running && styles.stop, pending && styles.pending]}
                  onPress={() => (running ? onStop(item.id) : onRun(item.id))}
                  disabled={pending || offline}
                >
                  <Text style={[styles.actionText, running && styles.stopText]}>
                    {pending ? '…' : running ? 'Stop' : 'Run'}
                  </Text>
                </Pressable>
              </View>

              {run ? (
                <Pressable
                  style={styles.last}
                  onPress={() => run.threadId && onOpenThread(run.threadId)}
                  disabled={!run.threadId}
                >
                  <View style={[styles.dot, { backgroundColor: statusTone(run.status) }]} />
                  <Text style={styles.lastText} numberOfLines={2}>
                    {run.summary || run.error || run.status}
                    {run.changedFiles
                      ? ` · ${run.changedFiles} file${run.changedFiles === 1 ? '' : 's'}`
                      : ''}
                  </Text>
                  {run.threadId ? <Text style={styles.open}>›</Text> : null}
                </Pressable>
              ) : null}
            </View>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.line
  },
  head: { flexDirection: 'row', alignItems: 'center' },
  headText: { flex: 1, marginRight: 12 },
  name: { color: theme.text, fontSize: 16, fontWeight: '600' },
  sub: { color: theme.faint, fontSize: 13, marginTop: 3 },
  action: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line
  },
  stop: { borderColor: theme.red },
  pending: { opacity: 0.5 },
  actionText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  stopText: { color: theme.red },
  last: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  lastText: { color: theme.muted, fontSize: 13, flex: 1 },
  open: { color: theme.faint, fontSize: 18 },
  empty: { color: theme.faint, textAlign: 'center', marginTop: 48, paddingHorizontal: 32 }
})
