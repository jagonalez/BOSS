import React, { useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { theme } from './theme'

/** The slice of the desktop's BackendDescriptor this screen needs. */
export interface BackendOption {
  id: string
  label: string
  available: boolean
  unavailableReason?: string
  modes: { id: string; label: string }[]
}

export interface ModelOption {
  id: string
  name?: string
  provider?: string
  /** Thinking levels this model offers, when it offers any. */
  variants?: string[]
}

/**
 * Start work from the phone: pick the agent, the model, how much thinking, and
 * how much it may do without asking.
 *
 * Everything here is a choice the desktop already models — this screen only
 * puts the same options behind a thumb. The defaults come from the desktop's
 * saved preferences, so sending without touching anything matches what the
 * desktop would have done.
 */
export function NewThreadScreen({
  backends, models, loadingModels, sending, error, project, onPickBackend, onCancel, onCreate
}: {
  backends: BackendOption[]
  models: ModelOption[]
  loadingModels: boolean
  sending: boolean
  error?: string
  /** Where the thread will run, for confirmation. Empty means the default. */
  project?: string
  onPickBackend(backendId: string): void
  onCancel(): void
  onCreate(input: {
    backendId: string
    prompt: string
    model?: { modelID: string; providerID: string; variant?: string }
    mode?: string
  }): void
}): React.JSX.Element {
  const usable = backends.filter((b) => b.available)
  const [backendId, setBackendId] = useState(usable[0]?.id ?? '')
  const [modelId, setModelId] = useState<string | undefined>()
  const [variant, setVariant] = useState<string | undefined>()
  const [mode, setMode] = useState<string | undefined>()
  const [prompt, setPrompt] = useState('')

  const backend = backends.find((b) => b.id === backendId)
  const model = models.find((m) => m.id === modelId)
  const canSend = Boolean(backendId) && prompt.trim().length > 0 && !sending

  function create(): void {
    if (!canSend) return
    onCreate({
      backendId,
      prompt: prompt.trim(),
      model: model ? { modelID: model.id, providerID: model.provider ?? '', variant } : undefined,
      mode
    })
  }

  function pickBackend(id: string): void {
    setBackendId(id)
    // Models belong to a backend, so anything chosen for the previous one is
    // meaningless here. Clearing beats sending a model the backend rejects.
    setModelId(undefined)
    setVariant(undefined)
    setMode(undefined)
    onPickBackend(id)
  }

  return (
    // Without this the keyboard covers the composer on iOS, which is the very
    // thing this screen exists to fill in.
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={8}><Text style={styles.cancel}>Cancel</Text></Pressable>
        <Text style={styles.title}>New thread</Text>
        <Pressable onPress={create} hitSlop={8} disabled={!canSend}>
          <Text style={[styles.start, !canSend && styles.disabled]}>{sending ? '…' : 'Start'}</Text>
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        {project ? <Text style={styles.project} numberOfLines={1}>in {project}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.label}>Agent</Text>
        <View style={styles.chips}>
          {backends.map((b) => (
            <Pressable
              key={b.id}
              onPress={() => b.available && pickBackend(b.id)}
              style={[styles.chip, b.id === backendId && styles.chipOn, !b.available && styles.chipOff]}
            >
              <Text style={[styles.chipText, b.id === backendId && styles.chipTextOn]}>{b.label}</Text>
            </Pressable>
          ))}
        </View>
        {backend && !backend.available ? (
          <Text style={styles.hint}>{backend.unavailableReason ?? 'Not available on this desktop.'}</Text>
        ) : null}

        <Text style={styles.label}>Model</Text>
        {loadingModels ? (
          <ActivityIndicator color={theme.faint} style={styles.spinner} />
        ) : models.length ? (
          <View style={styles.chips}>
            <Pressable
              onPress={() => { setModelId(undefined); setVariant(undefined) }}
              style={[styles.chip, !modelId && styles.chipOn]}
            >
              <Text style={[styles.chipText, !modelId && styles.chipTextOn]}>Default</Text>
            </Pressable>
            {models.map((m) => (
              <Pressable
                key={m.id}
                onPress={() => { setModelId(m.id); setVariant(undefined) }}
                style={[styles.chip, m.id === modelId && styles.chipOn]}
              >
                <Text style={[styles.chipText, m.id === modelId && styles.chipTextOn]}>{m.name ?? m.id}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.hint}>This agent does not offer a model choice.</Text>
        )}

        {model?.variants?.length ? (
          <>
            <Text style={styles.label}>Thinking</Text>
            <View style={styles.chips}>
              {model.variants.map((v) => (
                <Pressable
                  key={v}
                  onPress={() => setVariant(v === variant ? undefined : v)}
                  style={[styles.chip, v === variant && styles.chipOn]}
                >
                  <Text style={[styles.chipText, v === variant && styles.chipTextOn]}>{v}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {backend?.modes.length ? (
          <>
            <Text style={styles.label}>Permission</Text>
            <View style={styles.chips}>
              {backend.modes.map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => setMode(m.id === mode ? undefined : m.id)}
                  style={[styles.chip, m.id === mode && styles.chipOn]}
                >
                  <Text style={[styles.chipText, m.id === mode && styles.chipTextOn]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        <Text style={styles.label}>First message</Text>
        {/* Send sits beside the field, not only in the header.
            Every other composer in the app puts it here, so a header-only
            Start made the one screen you meet first the one that broke the
            rule — you had to go looking for the way to send. */}
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should it work on?"
            placeholderTextColor={theme.faint}
            multiline
            autoFocus
          />
          <Pressable
            style={[styles.send, !canSend && styles.sendOff]}
            onPress={create}
            disabled={!canSend}
          >
            <Text style={[styles.sendText, !canSend && styles.sendTextOff]}>
              {sending ? '…' : 'Start'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.line
  },
  title: { color: theme.text, fontSize: 17, fontWeight: '600' },
  cancel: { color: theme.faint, fontSize: 16 },
  start: { color: theme.accent, fontSize: 16, fontWeight: '700' },
  disabled: { color: theme.faint },
  body: { padding: 16, paddingBottom: 48 },
  project: { color: theme.faint, fontSize: 13, marginBottom: 12 },
  error: { color: theme.red, fontSize: 13, marginBottom: 12 },
  label: { color: theme.muted, fontSize: 13, fontWeight: '600', marginTop: 18, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.line
  },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipOff: { opacity: 0.4 },
  chipText: { color: theme.text, fontSize: 14 },
  chipTextOn: { color: theme.bg, fontWeight: '700' },
  hint: { color: theme.faint, fontSize: 13 },
  spinner: { alignSelf: 'flex-start' },
  composer: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  input: {
    flex: 1,
    color: theme.text,
    // 16px or larger, or iOS zooms the view when the field takes focus.
    fontSize: 16,
    backgroundColor: theme.inset,
    borderRadius: 12,
    padding: 12,
    minHeight: 120,
    textAlignVertical: 'top'
  },
  send: {
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.accent,
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  sendOff: { backgroundColor: theme.inset, borderColor: theme.line },
  sendText: { color: theme.bg, fontWeight: '700', fontSize: 13.5 },
  sendTextOff: { color: theme.faint }
})
