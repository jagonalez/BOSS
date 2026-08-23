import React, { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { BackendOption, ModelOption } from './NewThreadScreen'
import { theme } from './theme'

/** Where the worker runs, mirroring the desktop's DelegatePlacement. */
export type Placement = 'same-checkout' | 'new-worktree'

/**
 * Confirm a delegation before it happens.
 *
 * Delegating used to fire the moment the button was pressed: a hardcoded task,
 * the source thread's backend, and a new worktree, with no way to see or change
 * any of it. That is a thread, a branch, and a running agent created by one
 * unconfirmed tap — the desktop has asked for these same choices in a modal all
 * along.
 *
 * The options are the desktop's, minus competing attempts: describing a task
 * and comparing several diffs is not phone work. The delegated thread opens as
 * soon as it exists, because on a phone the worker you just started is the
 * thing you want to be looking at.
 */
export function DelegateScreen({
  source, sourceBackendId, backends, models, loadingModels, sending, error, canWorktree,
  onPickBackend, onCancel, onDelegate
}: {
  /** The thread being delegated from, named so the screen can say so. */
  source: string
  /** Its backend, which the worker inherits unless told otherwise. */
  sourceBackendId?: string
  backends: BackendOption[]
  models: ModelOption[]
  loadingModels: boolean
  sending: boolean
  error?: string
  /** Projectless chats have no repository to branch, so they cannot fan out. */
  canWorktree: boolean
  onPickBackend(backendId: string): void
  onCancel(): void
  onDelegate(input: {
    backendId: string
    instruction: string
    placement: Placement
    model?: { modelID: string; providerID: string; variant?: string }
    mode?: string
  }): void
}): React.JSX.Element {
  const usable = backends.filter((b) => b.available)
  // Default to the source thread's agent, as the desktop's modal does: a
  // delegate continues that thread's work, so its agent is the better guess
  // than whichever happens to be listed first.
  const [backendId, setBackendId] = useState(
    (sourceBackendId && usable.some((b) => b.id === sourceBackendId) ? sourceBackendId : usable[0]?.id) ?? ''
  )
  const [modelId, setModelId] = useState<string | undefined>()
  const [variant, setVariant] = useState<string | undefined>()
  const [mode, setMode] = useState<string | undefined>()
  const [instruction, setInstruction] = useState('')
  const [placement, setPlacement] = useState<Placement>(canWorktree ? 'new-worktree' : 'same-checkout')

  const backend = backends.find((b) => b.id === backendId)
  const model = models.find((m) => m.id === modelId)
  const canStart = Boolean(backendId) && instruction.trim().length > 0 && !sending

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
    <View style={styles.fill}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={8}><Text style={styles.cancel}>Cancel</Text></Pressable>
        <Text style={styles.title}>Delegate</Text>
        <Pressable
          onPress={() => canStart && onDelegate({
            backendId,
            instruction: instruction.trim(),
            placement,
            model: model ? { modelID: model.id, providerID: model.provider ?? '', variant } : undefined,
            mode
          })}
          hitSlop={8}
          disabled={!canStart}
        >
          <Text style={[styles.start, !canStart && styles.disabled]}>{sending ? '…' : 'Start'}</Text>
        </Pressable>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Text style={styles.source} numberOfLines={1}>from {source}</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Text style={styles.label}>Task</Text>
        <TextInput
          style={styles.input}
          value={instruction}
          onChangeText={setInstruction}
          placeholder="What should the worker accomplish?"
          placeholderTextColor={theme.faint}
          multiline
          autoFocus
        />
        <Text style={styles.hint}>The transcript so far and a summary of changed files are sent along.</Text>

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

        <Text style={styles.label}>Working directory</Text>
        <View style={styles.chips}>
          <Pressable
            onPress={() => setPlacement('same-checkout')}
            style={[styles.chip, placement === 'same-checkout' && styles.chipOn]}
          >
            <Text style={[styles.chipText, placement === 'same-checkout' && styles.chipTextOn]}>
              Current checkout
            </Text>
          </Pressable>
          <Pressable
            onPress={() => canWorktree && setPlacement('new-worktree')}
            style={[styles.chip, placement === 'new-worktree' && styles.chipOn, !canWorktree && styles.chipOff]}
          >
            <Text style={[styles.chipText, placement === 'new-worktree' && styles.chipTextOn]}>
              New worktree
            </Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          {canWorktree
            ? placement === 'new-worktree'
              ? 'The worker gets its own branch and folder, so it cannot disturb this one.'
              : 'The worker shares this thread’s files. Both editing at once can conflict.'
            : 'This chat has no project, so there is no repository to branch.'}
        </Text>
      </ScrollView>
    </View>
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
  source: { color: theme.faint, fontSize: 13, marginBottom: 12 },
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
  hint: { color: theme.faint, fontSize: 13, marginTop: 8 },
  spinner: { alignSelf: 'flex-start' },
  input: {
    color: theme.text,
    fontSize: 16,
    backgroundColor: theme.inset,
    borderRadius: 12,
    padding: 12,
    minHeight: 110,
    textAlignVertical: 'top'
  }
})
