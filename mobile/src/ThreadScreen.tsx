import React, { useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { theme } from './theme'

export interface MessagePart { type?: string; text?: string }
export interface ThreadMessage {
  id?: string
  info?: { role?: string }
  parts?: MessagePart[]
}

export interface PendingPermission {
  id: string
  permission?: string
  patterns?: string[]
  metadata?: { command?: string }
}

function textOf(message: ThreadMessage): string {
  return (message.parts ?? [])
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n')
}

function toolCount(message: ThreadMessage): number {
  return (message.parts ?? []).filter((p) => p.type === 'tool').length
}

export function ThreadScreen({ messages, busy, permission, sending, onSend, onStop, onPermission }: {
  messages: ThreadMessage[]
  busy: boolean
  permission?: PendingPermission
  sending: boolean
  onSend(text: string): void
  onStop(): void
  onPermission(response: 'once' | 'always' | 'reject'): void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const list = useRef<FlatList<ThreadMessage>>(null)

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        ref={list}
        data={messages.filter((m) => textOf(m) || toolCount(m))}
        keyExtractor={(m, i) => m.id ?? String(i)}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => {
          const role = item.info?.role === 'user' ? 'user' : 'assistant'
          const text = textOf(item)
          const tools = toolCount(item)
          return (
            <View style={styles.msg}>
              <Text style={styles.who}>{role === 'user' ? 'You' : 'Agent'}</Text>
              {tools ? <Text style={styles.steps}>{tools} step{tools === 1 ? '' : 's'}</Text> : null}
              {text ? (
                <View style={role === 'user' ? styles.userBody : undefined}>
                  <Text style={styles.body}>{text}</Text>
                </View>
              ) : null}
            </View>
          )
        }}
      />

      {permission ? (
        <View style={styles.perm}>
          <Text style={styles.permTitle}>Permission requested</Text>
          <Text style={styles.permDesc}>
            {permission.metadata?.command ?? permission.patterns?.join(', ') ?? permission.permission ?? ''}
          </Text>
          <View style={styles.permRow}>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={() => onPermission('once')}>
              <Text style={styles.btnPrimaryText}>Allow once</Text>
            </Pressable>
            <Pressable style={styles.btn} onPress={() => onPermission('always')}>
              <Text style={styles.btnText}>Always</Text>
            </Pressable>
            <Pressable style={styles.btn} onPress={() => onPermission('reject')}>
              <Text style={styles.btnDanger}>Deny</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {busy ? (
        <Pressable style={styles.working} onPress={onStop}>
          <ActivityIndicator size="small" color={theme.green} />
          <Text style={styles.workingText}>Working — tap to stop</Text>
        </Pressable>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Reply…"
          placeholderTextColor={theme.faint}
          multiline
        />
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={send} disabled={sending}>
          <Text style={styles.btnPrimaryText}>{sending ? '…' : 'Send'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  list: { padding: 12, paddingBottom: 20 },
  msg: { marginBottom: 14 },
  who: {
    color: theme.faint,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 3
  },
  steps: { color: theme.faint, fontSize: 12, marginVertical: 4 },
  body: { color: theme.text, fontSize: 15, lineHeight: 21 },
  userBody: { backgroundColor: theme.inset, borderRadius: 12, padding: 11 },
  perm: {
    margin: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.yellow,
    borderRadius: 12,
    backgroundColor: theme.pane
  },
  permTitle: { color: theme.yellow, fontWeight: '700', fontSize: 13, marginBottom: 6 },
  permDesc: { color: theme.muted, fontSize: 13, marginBottom: 10 },
  permRow: { flexDirection: 'row', gap: 8 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 6 },
  workingText: { color: theme.green, fontSize: 12.5 },
  composer: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: theme.line,
    alignItems: 'flex-end'
  },
  input: {
    flex: 1,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 10,
    color: theme.text,
    // 16px or larger, or iOS zooms the view when the field takes focus.
    fontSize: 16,
    paddingHorizontal: 11,
    paddingVertical: 9,
    maxHeight: 120
  },
  btn: {
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.inset,
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnText: { color: theme.text, fontWeight: '600', fontSize: 13.5 },
  btnPrimaryText: { color: theme.bg, fontWeight: '700', fontSize: 13.5 },
  btnDanger: { color: theme.red, fontWeight: '600', fontSize: 13.5 }
})
