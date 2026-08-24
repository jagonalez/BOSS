import React, { useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
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
  spans,
  segmentsOf,
  isError,
  type Span,
  isRunning,
  reasoningOf,
  summarise,
  textOf,
  toolKind,
  toolSummary,
  type Message,
  type Part
} from './parts'
import { FollowUps, type FollowUp } from './FollowUps'
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

/** One run and whatever is nested in it. Nested <Text> inherits, so a span
 *  sets only what it changes and the size and colour around it carry through —
 *  which is what makes bold code come out bold *and* monospaced. */
function Run({ span }: { span: Span }): React.JSX.Element {
  const inner = span.children
    ? span.children.map((child, i) => <Run key={i} span={child} />)
    : span.text

  if (span.kind === 'code') return <Text style={styles.inlineCode}>{span.text}</Text>
  if (span.kind === 'link') {
    return (
      <Text
        style={styles.link}
        onPress={() => { void Linking.openURL(span.href ?? span.text).catch(() => {}) }}
      >
        {inner}
      </Text>
    )
  }
  const style = span.kind === 'bold' ? styles.bold
    : span.kind === 'italic' ? styles.italic
    : span.kind === 'strike' ? styles.strike
    : undefined
  return <Text style={style}>{inner}</Text>
}

function Inline({ text }: { text: string }): React.JSX.Element {
  return <>{spans(text).map((span, i) => <Run key={i} span={span} />)}</>
}

function Body({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {blocks(text).map((block, i) => {
        if (block.kind === 'code') {
          return <CodeBlock key={i} content={block.content} language={block.language} />
        }
        if (block.kind === 'rule') return <View key={i} style={styles.rule} />
        if (block.kind === 'heading') {
          // Three sizes for six levels: past h3 a phone has no room left to
          // signal depth, and every deeper heading reads the same anyway.
          return (
            <Text
              key={i}
              style={[
                styles.body,
                [styles.h1, styles.h2, styles.h3][Math.min((block.level ?? 1) - 1, 2)]
              ]}
              selectable
            >
              <Inline text={block.content} />
            </Text>
          )
        }
        if (block.kind === 'quote') {
          return (
            <View key={i} style={styles.quote}>
              <Text style={[styles.body, styles.quoteText]} selectable>
                <Inline text={block.content} />
              </Text>
            </View>
          )
        }
        if (block.kind === 'bullet' || block.kind === 'number') {
          return (
            <View key={i} style={[styles.item, { marginLeft: 10 + (block.indent ?? 0) * 14 }]}>
              <Text style={[styles.body, styles.marker]}>
                {block.kind === 'bullet' ? '•' : `${block.marker ?? ''}.`}
              </Text>
              <Text style={[styles.body, styles.itemText]} selectable>
                <Inline text={block.content} />
              </Text>
            </View>
          )
        }
        return (
          <Text key={i} style={styles.body} selectable>
            <Inline text={block.content} />
          </Text>
        )
      })}
    </>
  )
}

/** What the agent did, collapsed by default and openable for the detail.
 *
 *  Output arrives trimmed — it is most of a transcript's bytes and none of what
 *  this draws — so a step that was cut says so, and fetches the rest when it is
 *  opened rather than when the thread loads. */
function Steps({ tools, onOutput }: {
  tools: Part[]
  onOutput(part: Part): Promise<string>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<Record<number, string>>({})
  const [loading, setLoading] = useState<number | undefined>()
  const running = tools.some((t) => isRunning(t.state?.status))
  const failed = tools.some((t) => isError(t.state?.status))

  const output = (tool: Part, i: number): void => {
    if (shown[i] !== undefined) { setShown((prev) => { const next = { ...prev }; delete next[i]; return next }) ; return }
    setLoading(i)
    void onOutput(tool)
      .then((text) => setShown((prev) => ({ ...prev, [i]: text })))
      .catch((e) => setShown((prev) => ({ ...prev, [i]: e instanceof Error ? e.message : String(e) })))
      .finally(() => setLoading(undefined))
  }

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
          {tools.map((tool, i) => {
            const hasOutput = Boolean(tool.state?.output) || Boolean(tool.state?.outputTruncated)
            return (
              <Pressable
                key={i}
                style={styles.step}
                onPress={hasOutput ? () => output(tool, i) : undefined}
              >
                <Text style={styles.stepKind}>{toolKind(tool)}</Text>
                <View style={styles.stepBody}>
                  <Text
                    style={[styles.stepText, isError(tool.state?.status) && styles.failed]}
                    numberOfLines={3}
                    selectable
                  >
                    {toolSummary(tool)}
                  </Text>
                  {shown[i] !== undefined ? (
                    <Text style={styles.stepOutput} selectable>{shown[i]}</Text>
                  ) : hasOutput ? (
                    <Text style={styles.stepMore}>
                      {loading === i ? 'Loading…' : 'Show output'}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            )
          })}
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
  models, modelId, onModel,
  find, onFind, findHits, finding,
  followUps, steering, onEditFollowUp, onMoveFollowUp, onSteerFollowUp, onRemoveFollowUp,
  onToolOutput,
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
  /** Models this thread's backend offers. Empty until they load, or when the
   *  backend offers no choice. */
  models: { id: string; name?: string }[]
  modelId?: string
  onModel(modelId: string): void
  /** Find-in-thread. Text already on the phone filters locally; the desktop
   *  searches the rest of the transcript, which the phone has not loaded. */
  find: string
  onFind(find: string): void
  findHits: { messageId: string; snippet: string }[]
  finding: boolean
  /** Messages waiting for the current run to end. */
  followUps: FollowUp[]
  /** How this thread's backend interrupts a run, which names the steer action. */
  steering: 'native' | 'stop-and-redirect'
  onEditFollowUp(id: string, text: string): void
  onMoveFollowUp(id: string, toIndex: number): void
  onSteerFollowUp(id: string): void
  onRemoveFollowUp(id: string): void
  /** Fetch one tool call's untrimmed output, for a step the user opened. */
  onToolOutput(part: Part): Promise<string>
  onSend(text: string): void
  onVariant(variant?: string): void
  onDelegate(): void
  onStop(): void
  onPermission(response: 'once' | 'always' | 'reject'): void
  onMode(mode: string): void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const list = useRef<FlatList<Message>>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const modeLabel = modes.find((m) => m.id === mode)?.label
  const modelLabel = models.find((m) => m.id === modelId)?.name ?? modelId

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  const rendered = messages.filter((m) => {
    const parts = m.parts ?? []
    return parts.some((p) => (p.type === 'text' && p.text?.trim()) || p.type === 'tool' || p.type === 'reasoning')
  })

  // While finding, the transcript becomes the result list: the matches, in
  // order, rather than a cursor stepping through a thread that keeps scrolling
  // under it. A phone has no room for a match counter and jump arrows.
  // Inverted lists take the data backwards. useMemo keeps the identity stable
  // between renders so FlatList is not handed a new array for the same content.
  const needle = find.trim().toLowerCase()
  const hitIds = new Set(findHits.map((h) => h.messageId))
  const visible = needle
    ? rendered.filter((m) => {
        if (m.id && hitIds.has(m.id)) return true
        return `${textOf(m)} ${reasoningOf(m) ?? ''}`.toLowerCase().includes(needle)
      })
    : rendered
  const ordered = useMemo(() => [...visible].reverse(), [visible])

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {findOpen ? (
        <View style={styles.find}>
          <TextInput
            style={styles.findInput}
            value={find}
            onChangeText={onFind}
            placeholder="Find in this thread"
            placeholderTextColor={theme.faint}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {needle ? (
            <Text style={styles.findCount}>
              {finding && !visible.length ? '…' : `${visible.length}`}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Inverted: the newest message sits at the visual bottom because the
          list is upside down, not because anything scrolled there.

          Chasing the tail by hand could not be made to sit still. The list
          scrolled to the end on every content size change, and during a run
          that fires constantly — messages refetch four times a second, each
          refetch replaces every row, and virtualization re-measures as rows
          come into view. Each scrollToEnd aimed at a content height that had
          already changed, and the scroll it performed fed the next one. That
          feedback loop is the jitter.

          Inverting removes the loop rather than damping it: with offset 0 at
          the bottom, new content extends away from the viewport and the
          position you are looking at never moves. */}
      <FlatList
        ref={list}
        inverted
        data={ordered}
        keyExtractor={(m, i) => m.id ?? String(i)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          needle ? (
            // Counter-rotated: everything inside an inverted list is upside
            // down, and this is text rather than a message.
            <Text style={[styles.findEmpty, styles.uninvert]}>
              {finding ? 'Searching…' : `Nothing in this thread matches “${find.trim()}”.`}
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const role = item.info?.role === 'user' ? 'user' : 'assistant'
          // In order, rather than all the thinking, then all the tools, then
          // all the text. That fixed order is fine for a backend that sends one
          // message per reply, and unreadable for Codex, which reports a whole
          // session as one message: the replies inside it ran together into a
          // single block and every tool call collapsed into one summary at the
          // end, so the conversation looked like it was missing.
          const segments = segmentsOf(item)
          return (
            <View style={styles.msg}>
              <Text style={styles.who}>{role === 'user' ? 'You' : 'Agent'}</Text>
              {segments.map((segment, i) => {
                if (segment.kind === 'reasoning') {
                  return <Thinking key={i} text={segment.text ?? ''} />
                }
                if (segment.kind === 'tools') {
                  return <Steps key={i} tools={segment.parts ?? []} onOutput={onToolOutput} />
                }
                return (
                  <View key={i} style={role === 'user' ? styles.userBody : styles.said}>
                    <Body text={segment.text ?? ''} />
                  </View>
                )
              })}
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

      {/* Always mounted, hidden when idle.
          Mounting this on `busy` made everything below it jump by the banner's
          height every time it appeared — and session.status fires repeatedly
          during a run (busy, retry, busy), so it appeared and vanished over and
          over. Reserving the row costs one hidden view and holds the layout
          still. */}
      <Pressable
        style={[styles.working, !busy && styles.workingIdle]}
        onPress={busy ? onStop : undefined}
        pointerEvents={busy ? 'auto' : 'none'}
        accessibilityElementsHidden={!busy}
      >
        {busy ? (
          <>
            <ActivityIndicator size="small" color={theme.green} />
            <Text style={styles.workingText}>Working — tap to stop</Text>
          </>
        ) : null}
      </Pressable>

      {/* One line that reads as a sentence, tapped to change.
          This was three permanent rows — modes, thinking, and a Delegate button
          duplicated across two branches — sitting above the composer on every
          thread. They are settings you touch occasionally taking space you look
          at constantly, so they collapse to their current values and open only
          when asked. */}
      <Pressable style={styles.summary} onPress={() => setOptionsOpen((open) => !open)}>
        <Text style={styles.summaryText} numberOfLines={1}>
          {[modelLabel, modeLabel, variant].filter(Boolean).join(' · ') || 'Options'}
        </Text>
        <Text style={styles.chevron}>{optionsOpen ? '⌄' : '⌃'}</Text>
      </Pressable>

      {optionsOpen ? (
        <View style={styles.options}>
          {modes.length > 1 ? (
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>Permission</Text>
              <View style={styles.chips}>
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
            </View>
          ) : null}

          {/* Like Thinking, the model rides on the next message rather than
              being set on the thread. Switching keeps the history — every
              backend resumes the session — but it does drop the prompt cache,
              so the next turn can cost a little more. */}
          {models.length ? (
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>Model</Text>
              {/* One scrolling line, not a wrapping grid like the rows above.
                  Those have a handful of short options; a backend can list
                  every model of every provider it knows, which wrapped would
                  bury the composer under a wall of chips. */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.modelStrip}
              >
                {models.map((m) => (
                  <Pressable
                    key={m.id}
                    onPress={() => onModel(m.id)}
                    style={[styles.modeChip, m.id === modelId && styles.modeChipOn]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[styles.modeText, m.id === modelId && styles.modeTextOn]}
                    >
                      {m.name ?? m.id}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {/* Thinking is not stored on the thread — it rides on each message —
              so this sets what the NEXT message asks for. */}
          {variants.length ? (
            <View style={styles.optionRow}>
              <Text style={styles.optionLabel}>Thinking</Text>
              <View style={styles.chips}>
                {variants.map((v) => (
                  <Pressable
                    key={v}
                    onPress={() => onVariant(v === variant ? undefined : v)}
                    style={[styles.modeChip, v === variant && styles.modeChipOn]}
                  >
                    <Text style={[styles.modeText, v === variant && styles.modeTextOn]}>{v}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          <Pressable
            onPress={() => { setFindOpen((open) => !open); if (findOpen) onFind('') }}
            style={styles.delegate}
          >
            <Text style={styles.delegateText}>{findOpen ? 'Close find' : 'Find in thread'}</Text>
          </Pressable>

          <Pressable onPress={onDelegate} style={styles.delegate}>
            <Text style={styles.delegateText}>Delegate to a new thread</Text>
          </Pressable>
        </View>
      ) : null}

      <FollowUps
        items={followUps}
        busy={busy}
        steering={steering}
        onEdit={onEditFollowUp}
        onMove={onMoveFollowUp}
        onSteer={onSteerFollowUp}
        onRemove={onRemoveFollowUp}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          // Say what the button will do before it is pressed: a run in progress
          // means this joins the queue rather than going out now.
          placeholder={busy ? 'Queue a follow-up…' : 'Reply…'}
          placeholderTextColor={theme.faint}
          multiline
        />
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={send} disabled={sending}>
          <Text style={styles.btnPrimaryText}>{sending ? '…' : busy ? 'Queue' : 'Send'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7
  },
  summaryText: { color: theme.faint, fontSize: 12.5, flex: 1 },
  options: { paddingHorizontal: 14, paddingBottom: 10, gap: 10 },
  optionRow: { gap: 6 },
  optionLabel: { color: theme.muted, fontSize: 12, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  delegate: {
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: theme.inset,
    alignItems: 'center'
  },
  delegateText: { color: theme.text, fontSize: 13.5 },
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
  modeTextOn: { color: theme.bg, fontWeight: '700' },
  fill: { flex: 1, backgroundColor: theme.bg },
  // Inverted, so paddingTop is the gap above the newest message — the one
  // nearest the composer — and paddingBottom is the breathing room at the top
  // of the thread. They read backwards here on purpose.
  list: { padding: 12, paddingTop: 20 },
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
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through', color: theme.muted },
  link: { color: theme.accent, textDecorationLine: 'underline' },
  inlineCode: {
    color: theme.green,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    // Menlo runs large beside the body face, and there is no per-span
    // background in React Native — colour and face carry the distinction.
    fontSize: 13
  },
  h1: { fontSize: 20, fontWeight: '700', lineHeight: 27, marginTop: 8, marginBottom: 4 },
  h2: { fontSize: 17.5, fontWeight: '700', lineHeight: 24, marginTop: 8, marginBottom: 4 },
  h3: { fontSize: 15.5, fontWeight: '700', lineHeight: 22, marginTop: 6, marginBottom: 3 },
  rule: { height: 1, backgroundColor: theme.line, marginVertical: 10 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.line,
    paddingLeft: 10,
    marginVertical: 2
  },
  quoteText: { color: theme.muted, marginBottom: 2 },
  item: { flexDirection: 'row', gap: 7, marginBottom: 2 },
  // Fixed width so wrapped text lines up under itself rather than under the
  // marker, and so 9. and 10. do not shift the column.
  marker: { color: theme.muted, marginBottom: 0, minWidth: 16, textAlign: 'right' },
  itemText: { flex: 1, marginBottom: 0 },
  userBody: { backgroundColor: theme.inset, borderRadius: 12, padding: 11 },
  // Separates one thing the agent said from the next stretch of work, now that
  // a message can hold many of both.
  said: { marginBottom: 2 },
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
  stepBody: { flex: 1, gap: 3 },
  stepOutput: {
    color: theme.muted,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: theme.bg,
    borderRadius: 6,
    padding: 8
  },
  stepMore: { color: theme.accent, fontSize: 12, fontWeight: '600' },
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
  // A fixed height so the row occupies the same space whether or not the agent
  // is working. Without it the empty view collapses and the jump returns.
  working: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 26,
    paddingHorizontal: 14
  },
  workingIdle: { opacity: 0 },
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
  modelStrip: { flexDirection: 'row', gap: 6, paddingRight: 12 },
  find: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.line
  },
  findInput: {
    flex: 1,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 10,
    color: theme.text,
    // 16px or larger, or iOS zooms the view when the field takes focus.
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  findCount: { color: theme.faint, fontSize: 13, fontWeight: '600', minWidth: 24, textAlign: 'right' },
  findEmpty: { color: theme.faint, textAlign: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  uninvert: { transform: [{ scaleY: -1 }] },
  btnPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  btnText: { color: theme.text, fontWeight: '600', fontSize: 13.5 },
  btnPrimaryText: { color: theme.bg, fontWeight: '700', fontSize: 13.5 },
  btnDanger: { color: theme.red, fontWeight: '600', fontSize: 13.5 }
})
