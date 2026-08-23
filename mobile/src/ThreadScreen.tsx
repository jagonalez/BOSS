import React, { useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import {
  blocks,
  isError,
  isRunning,
  reasoningOf,
  summarise,
  textOf,
  toolKind,
  toolSummary,
  type Message,
  type Part
} from './parts'
import { theme } from './theme'

export type { Message as ThreadMessage } from './parts'

export interface PendingPermission {
  id: string
  permission?: string
  patterns?: string[]
  metadata?: { command?: string }
}

/** Code keeps its own scroll, so a long line does not squeeze the transcript. */
function CodeBlock({ content, language }: { content: string; language?: string }): React.JSX.Element {
  return (
    <View style={styles.code}>
      {language ? <Text style={styles.codeLang}>{language}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText} selectable>{content}</Text>
      </ScrollView>
    </View>
  )
}

function Body({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {blocks(text).map((block, i) =>
        block.kind === 'code'
          ? <CodeBlock key={i} content={block.content} language={block.language} />
          : <Text key={i} style={styles.body} selectable>{block.content}</Text>
      )}
    </>
  )
}

/** What the agent did, collapsed by default and openable for the detail. */
function Steps({ tools }: { tools: Part[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = tools.some((t) => isRunning(t.state?.status))
  const failed = tools.some((t) => isError(t.state?.status))

  return (
    <View style={styles.steps}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.stepsHeader}>
        {running ? <ActivityIndicator size="small" color={theme.green} /> : null}
        <Text style={[styles.stepsSummary, failed && styles.failed]}>
          {summarise(tools) || `${tools.length} steps`}
        </Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.stepsList}>
          {tools.map((tool, i) => (
            <View key={i} style={styles.step}>
              <Text style={styles.stepKind}>{toolKind(tool)}</Text>
              <Text
                style={[styles.stepText, isError(tool.state?.status) && styles.failed]}
                numberOfLines={3}
                selectable
              >
                {toolSummary(tool)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function Thinking({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.steps}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.stepsHeader}>
        <Text style={styles.stepsSummary}>Thinking</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? <Text style={styles.thinking} selectable>{text}</Text> : null}
    </View>
  )
}

export function ThreadScreen({
  messages, busy, permission, sending, modes, mode, variants, variant,
  onSend, onStop, onPermission, onMode, onVariant, onDelegate
}: {
  messages: Message[]
  busy: boolean
  permission?: PendingPermission
  sending: boolean
  /** What this thread's backend allows. Empty when the backend has one mode. */
  modes: { id: string; label: string }[]
  mode?: string
  /** Thinking levels the thread's model offers, when it offers any. */
  variants: string[]
  variant?: string
  onSend(text: string): void
  onVariant(variant?: string): void
  onDelegate(): void
  onStop(): void
  onPermission(response: 'once' | 'always' | 'reject'): void
  onMode(mode: string): void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const list = useRef<FlatList<Message>>(null)
  /** Whether the view is parked at the newest message. Only then does new
   *  content scroll; otherwise reading history fights the stream. */
  const atTail = useRef(true)

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  const visible = messages.filter((m) => {
    const parts = m.parts ?? []
    return parts.some((p) => (p.type === 'text' && p.text?.trim()) || p.type === 'tool' || p.type === 'reasoning')
  })

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        ref={list}
        data={visible}
        keyExtractor={(m, i) => m.id ?? String(i)}
        contentContainerStyle={styles.list}
        // Follow the tail only while the user is already at it.
        //
        // This used to scroll on EVERY content size change, and a streaming run
        // changes it many times a second: the view was yanked to the bottom
        // while you were reading further up, which reads as the text jittering.
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          const fromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height
          atTail.current = fromBottom < 80
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (atTail.current) list.current?.scrollToEnd({ animated: false })
        }}
        renderItem={({ item }) => {
          const role = item.info?.role === 'user' ? 'user' : 'assistant'
          const text = textOf(item)
          const reasoning = reasoningOf(item)
          const tools = (item.parts ?? []).filter((p) => p.type === 'tool')
          return (
            <View style={styles.msg}>
              <Text style={styles.who}>{role === 'user' ? 'You' : 'Agent'}</Text>
              {reasoning ? <Thinking text={reasoning} /> : null}
              {tools.length ? <Steps tools={tools} /> : null}
              {text ? (
                <View style={role === 'user' ? styles.userBody : undefined}>
                  <Body text={text} />
                </View>
              ) : null}
            </View>
          )
        }}
      />

      {permission ? (
        <View style={styles.perm}>
          <Text style={styles.permTitle}>Permission requested</Text>
          <Text style={styles.permDesc} selectable>
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

      {modes.length > 1 ? (
        <View style={styles.modes}>
          {modes.map((m) => (
            <Pressable
              key={m.id}
              onPress={() => onMode(m.id)}
              style={[styles.modeChip, m.id === mode && styles.modeChipOn]}
            >
              <Text style={[styles.modeText, m.id === mode && styles.modeTextOn]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Thinking is not stored on the thread — it rides on each message — so
          this sets what the NEXT message asks for rather than changing state. */}
      {variants.length ? (
        <View style={styles.modes}>
          <Text style={styles.stripLabel}>Thinking</Text>
          {variants.map((v) => (
            <Pressable
              key={v}
              onPress={() => onVariant(v === variant ? undefined : v)}
              style={[styles.modeChip, v === variant && styles.modeChipOn]}
            >
              <Text style={[styles.modeText, v === variant && styles.modeTextOn]}>{v}</Text>
            </Pressable>
          ))}
          <Pressable onPress={onDelegate} style={styles.modeChip}>
            <Text style={styles.modeText}>Delegate</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.modes}>
          <Pressable onPress={onDelegate} style={styles.modeChip}>
            <Text style={styles.modeText}>Delegate</Text>
          </Pressable>
        </View>
      )}

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
  modes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8
  },
  modeChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line
  },
  modeChipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  modeText: { color: theme.muted, fontSize: 12 },
  stripLabel: { color: theme.faint, fontSize: 12, alignSelf: 'center', marginRight: 2 },
  modeTextOn: { color: theme.bg, fontWeight: '700' },
  fill: { flex: 1, backgroundColor: theme.bg },
  list: { padding: 12, paddingBottom: 20 },
  msg: { marginBottom: 16 },
  who: {
    color: theme.faint,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 4
  },
  body: { color: theme.text, fontSize: 15, lineHeight: 22, marginBottom: 6 },
  userBody: { backgroundColor: theme.inset, borderRadius: 12, padding: 11 },
  code: {
    backgroundColor: theme.inset,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 10,
    marginVertical: 6
  },
  codeLang: { color: theme.faint, fontSize: 10, marginBottom: 6, textTransform: 'uppercase' },
  codeText: {
    color: theme.text,
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'
  },
  steps: {
    borderLeftWidth: 2,
    borderLeftColor: theme.line,
    paddingLeft: 10,
    marginBottom: 8
  },
  stepsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  stepsSummary: { color: theme.muted, fontSize: 12.5, flex: 1 },
  chevron: { color: theme.faint, fontSize: 12 },
  stepsList: { paddingTop: 4, gap: 6 },
  step: { gap: 2 },
  stepKind: { color: theme.faint, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 },
  stepText: {
    color: theme.muted,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'
  },
  thinking: { color: theme.faint, fontSize: 13, lineHeight: 19, paddingVertical: 6, fontStyle: 'italic' },
  failed: { color: theme.red },
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
