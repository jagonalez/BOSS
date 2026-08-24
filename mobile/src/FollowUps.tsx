import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { theme } from './theme'

/** The slice of the desktop's QueuedFollowUp this screen needs. */
export interface FollowUp {
  id: string
  text: string
  attachments?: { id: string }[]
  steeredAt?: number
}

/**
 * What is waiting to be sent, and the ways to change it.
 *
 * A thread that is working does not take a new message — it queues one — so
 * this is where anything typed during a run lives until the run ends. It shows
 * only when something is queued, because an empty panel above the composer is
 * a permanent tax for an occasional state.
 *
 * One row per item, with the same moves the desktop has: edit the text, move it
 * earlier or later, send it now, or drop it. A phone has no hover and no room
 * for a toolbar, so editing swaps the row for a field and the rest are small
 * targets in a line beneath the text.
 */
export function FollowUps({ items, busy, steering, onEdit, onMove, onSteer, onRemove }: {
  items: FollowUp[]
  /** Whether the thread is mid-run, which is what "send now" has to mean. */
  busy: boolean
  /** How this thread's backend interrupts: fold into the run, or stop first. */
  steering: 'native' | 'stop-and-redirect'
  onEdit(id: string, text: string): void
  onMove(id: string, toIndex: number): void
  onSteer(id: string): void
  onRemove(id: string): void
}): React.JSX.Element | null {
  const [editing, setEditing] = useState<string | undefined>()
  const [draft, setDraft] = useState('')

  if (!items.length) return null

  // The same button means three things, so it says which one it means: with
  // nothing running there is no turn to fold into and no run to stop, and the
  // backends that cannot steer have to stop the run to change its direction.
  const steerLabel = !busy ? 'Send now'
    : steering === 'native' ? 'Steer now'
    : 'Stop & redirect'

  // Saving is explicit rather than on blur: tapping Cancel blurs the field
  // first, so a save-on-blur would race the discard and win.
  const commit = (id: string): void => {
    const text = draft.trim()
    if (text) onEdit(id, text)
    setEditing(undefined)
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>
        Up next · {items.length} queued
      </Text>

      {items.map((item, index) => (
        <View key={item.id} style={styles.item}>
          {editing === item.id ? (
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              autoFocus
              multiline
            />
          ) : (
            <Text style={styles.text} numberOfLines={3}>
              {item.text || `${item.attachments?.length ?? 0} attachments`}
            </Text>
          )}

          <View style={styles.actions}>
            {editing === item.id ? (
              <>
                <Pressable onPress={() => commit(item.id)} hitSlop={6}>
                  <Text style={styles.action}>Save</Text>
                </Pressable>
                <Pressable onPress={() => setEditing(undefined)} hitSlop={6}>
                  <Text style={styles.action}>Cancel</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  onPress={() => { setEditing(item.id); setDraft(item.text) }}
                  hitSlop={6}
                >
                  <Text style={styles.action}>Edit</Text>
                </Pressable>
                <Pressable
                  onPress={() => onMove(item.id, index - 1)}
                  disabled={index === 0}
                  hitSlop={6}
                >
                  <Text style={[styles.action, index === 0 && styles.off]}>↑</Text>
                </Pressable>
                <Pressable
                  onPress={() => onMove(item.id, index + 1)}
                  disabled={index === items.length - 1}
                  hitSlop={6}
                >
                  <Text style={[styles.action, index === items.length - 1 && styles.off]}>↓</Text>
                </Pressable>
                <Pressable onPress={() => onSteer(item.id)} hitSlop={6}>
                  <Text style={[styles.action, styles.steer]}>{steerLabel}</Text>
                </Pressable>
                <Pressable onPress={() => onRemove(item.id)} hitSlop={6}>
                  <Text style={[styles.action, styles.remove]}>Delete</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: 1,
    borderTopColor: theme.line,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 8
  },
  title: {
    color: theme.faint,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  item: { gap: 5 },
  text: { color: theme.text, fontSize: 13.5, lineHeight: 19 },
  input: {
    color: theme.text,
    // 16px or larger, or iOS zooms the view when the field takes focus.
    fontSize: 16,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  action: { color: theme.muted, fontSize: 12.5, fontWeight: '600' },
  steer: { color: theme.accent },
  remove: { color: theme.red },
  off: { color: theme.line }
})
