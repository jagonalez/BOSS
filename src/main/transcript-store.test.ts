import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { TranscriptStore } from './transcript-store.ts'

const source = {
  threadId: 'boss-thread',
  backendId: 'codex' as const,
  nativeSessionId: 'native-thread'
}

test('keeps live tool details across lossy history refreshes and restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    let store = new TranscriptStore(path)
    store.recordMessage(source, {
      id: 'assistant-turn',
      sessionID: source.nativeSessionId,
      role: 'assistant',
      time: { created: 1 }
    })
    store.recordPart(source, {
      id: 'call-1',
      type: 'tool',
      sessionID: source.nativeSessionId,
      messageID: 'assistant-turn',
      state: { status: 'running', tool: 'browser', input: { url: 'https://example.com' } }
    })
    store.recordPart(source, {
      id: 'call-1',
      type: 'tool',
      sessionID: source.nativeSessionId,
      messageID: 'assistant-turn',
      state: { status: 'completed', output: 'ok' }
    })
    store.reconcile(source, [{
      info: {
        id: 'assistant-turn',
        sessionID: source.nativeSessionId,
        role: 'assistant',
        time: { completed: 2 }
      },
      parts: [{
        id: 'final',
        type: 'text',
        sessionID: source.nativeSessionId,
        messageID: 'assistant-turn',
        text: 'Done'
      }]
    }])

    let tool = store.messages(source.threadId)[0]?.parts.find((part) => part.id === 'call-1')
    assert.deepEqual(
      { status: tool?.state?.status, tool: tool?.state?.tool, output: tool?.state?.output },
      { status: 'completed', tool: 'browser', output: 'ok' }
    )
    store.close()

    store = new TranscriptStore(path)
    tool = store.messages(source.threadId)[0]?.parts.find((part) => part.id === 'call-1')
    assert.equal(tool?.state?.output, 'ok')
    store.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('can prune messages only after native history is authoritative', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  try {
    store.recordMessage(source, {
      id: 'removed-message',
      sessionID: source.nativeSessionId,
      role: 'assistant'
    })
    store.flush()
    store.reconcile(source, [])
    assert.equal(store.messages(source.threadId).length, 1)
    store.reconcile(source, [], { pruneMissingMessages: true })
    assert.equal(store.messages(source.threadId).length, 0)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconciles duplicate live and native narrative parts without dropping tool details', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  try {
    store.recordMessage(source, {
      id: 'assistant-turn', sessionID: source.nativeSessionId, role: 'assistant'
    })
    store.recordPart(source, {
      id: 'live-text', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'assistant-turn', text: 'This response must appear once.'
    })
    store.recordPart(source, {
      id: 'live-tool', type: 'tool', sessionID: source.nativeSessionId,
      messageID: 'assistant-turn', state: { status: 'completed', tool: 'shell', output: 'kept' }
    })
    store.reconcile(source, [{
      info: { id: 'assistant-turn', sessionID: source.nativeSessionId, role: 'assistant' },
      parts: [{
        id: 'native-text', type: 'text', sessionID: source.nativeSessionId,
        messageID: 'assistant-turn', text: 'This response must appear once.'
      }]
    }])

    const parts = store.messages(source.threadId)[0].parts
    assert.deepEqual(parts.filter((part) => part.type === 'text').map((part) => part.id), ['native-text'])
    assert.equal(parts.find((part) => part.id === 'live-tool')?.state?.output, 'kept')
    store.close()

    const reopened = new TranscriptStore(join(directory, 'transcripts.sqlite'))
    assert.equal(
      reopened.messages(source.threadId)[0].parts.filter((part) => part.type === 'text').length,
      1
    )
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('does not render duplicate narrative rows already persisted under different ids', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  try {
    for (const id of ['stream-text', 'history-text']) {
      store.recordPart(source, {
        id, type: 'text', sessionID: source.nativeSessionId,
        messageID: 'assistant-turn', text: 'Same semantic response.'
      })
    }
    const texts = store.messages(source.threadId)[0].parts.filter((part) => part.type === 'text')
    assert.equal(texts.length, 1)
    assert.equal(texts[0].text, 'Same semantic response.')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('deduplicates live and history text across assistant message ids in one turn', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  try {
    store.recordMessage(source, {
      id: 'live-assistant', sessionID: source.nativeSessionId, role: 'assistant'
    })
    store.recordPart(source, {
      id: 'live-text', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'live-assistant', text: 'Critical find. Let me inspect it.'
    })
    store.recordPart(source, {
      id: 'live-tool', type: 'tool', sessionID: source.nativeSessionId,
      messageID: 'live-assistant', state: { status: 'completed', tool: 'shell', output: 'first' }
    })
    store.recordMessage(source, {
      id: 'history-assistant', sessionID: source.nativeSessionId, role: 'assistant'
    })
    store.recordPart(source, {
      id: 'history-text', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'history-assistant', text: 'Critical  find.\nLet me inspect it.'
    })
    store.recordPart(source, {
      id: 'history-tool', type: 'tool', sessionID: source.nativeSessionId,
      messageID: 'history-assistant', state: { status: 'completed', tool: 'shell', output: 'second' }
    })

    const turn = store.messages(source.threadId)
    assert.equal(turn.flatMap((message) => message.parts).filter((part) => part.type === 'text').length, 1)
    assert.deepEqual(
      turn.flatMap((message) => message.parts).filter((part) => part.type === 'tool').map((part) => part.state?.output),
      ['first', 'second'],
      'dedupe must not discard the work interleaved with the repeated line'
    )

    store.recordMessage(source, {
      id: 'next-user', sessionID: source.nativeSessionId, role: 'user'
    })
    store.recordPart(source, {
      id: 'next-user-text', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'next-user', text: 'Say that again.'
    })
    store.recordMessage(source, {
      id: 'next-assistant', sessionID: source.nativeSessionId, role: 'assistant'
    })
    store.recordPart(source, {
      id: 'next-assistant-text', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'next-assistant', text: 'Critical find. Let me inspect it.'
    })
    assert.equal(
      store.messages(source.threadId).flatMap((message) => message.parts).filter((part) => part.type === 'text').length,
      3,
      'the same prose remains valid after a new user turn'
    )
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('recovers an active run and marks unfinished tools as interrupted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    let store = new TranscriptStore(path)
    store.beginRun(source)
    store.recordMessage(source, {
      id: 'assistant-turn',
      sessionID: source.nativeSessionId,
      role: 'assistant'
    })
    store.recordPart(source, {
      id: 'call-1',
      type: 'tool',
      sessionID: source.nativeSessionId,
      messageID: 'assistant-turn',
      state: { status: 'running', tool: 'shell' }
    })
    store.close()

    store = new TranscriptStore(path)
    const tool = store.messages(source.threadId)[0]?.parts.find((part) => part.id === 'call-1')
    assert.equal(tool?.state?.status, 'interrupted')
    assert.match(tool?.state?.error ?? '', /stopped before this step completed/i)
    store.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps run history with backend-reported tokens and tool counts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  try {
    store.beginRun(source)
    store.recordMessage(source, {
      id: 'assistant-one', sessionID: source.nativeSessionId, role: 'assistant', tokens: 321
    })
    store.recordPart(source, {
      id: 'tool-one', type: 'tool', sessionID: source.nativeSessionId,
      messageID: 'assistant-one', state: { status: 'completed', tool: 'shell', output: 'ok' }
    })
    store.finishRun(source, 'completed')
    store.beginRun(source)
    store.recordMessage(source, {
      id: 'assistant-two', sessionID: source.nativeSessionId, role: 'assistant'
    })
    store.finishRun(source, 'error')

    const usage = store.usage(source.threadId)
    assert.equal(usage.totals.runs, 2)
    assert.equal(usage.totals.tokens, 321)
    assert.equal(usage.totals.tokenRuns, 1)
    assert.equal(usage.totals.toolCalls, 1)
    assert.equal(usage.lastRun?.status, 'error')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('confines a search to one thread when asked', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  const other = { threadId: 'other-thread', backendId: 'codex' as const, nativeSessionId: 'native-other' }
  try {
    store.recordMessage(source, {
      id: 'assistant-scoped', sessionID: source.nativeSessionId, role: 'assistant', time: { created: 1 }
    })
    store.recordPart(source, {
      id: 'text-scoped', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'assistant-scoped', text: 'A deployment note worth finding.'
    })
    store.recordMessage(other, {
      id: 'assistant-other', sessionID: other.nativeSessionId, role: 'assistant', time: { created: 2 }
    })
    store.recordPart(other, {
      id: 'text-other', type: 'text', sessionID: other.nativeSessionId,
      messageID: 'assistant-other', text: 'A deployment note in another thread.'
    })

    assert.equal(store.search('deployment note').length, 2)

    const scoped = store.search('deployment note', 40, source.threadId)
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].threadId, source.threadId)

    // The scope must survive a limit that the busier thread would otherwise
    // consume, which is the whole reason it is a WHERE and not a post-filter.
    const tight = store.search('deployment note', 1, source.threadId)
    assert.equal(tight.length, 1)
    assert.equal(tight[0].threadId, source.threadId)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('searches normalized transcript text and tool activity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const store = new TranscriptStore(join(directory, 'transcripts.sqlite'))
  try {
    store.recordMessage(source, {
      id: 'assistant-search', sessionID: source.nativeSessionId, role: 'assistant',
      time: { created: 123 }
    })
    store.recordPart(source, {
      id: 'text-search', type: 'text', sessionID: source.nativeSessionId,
      messageID: 'assistant-search', text: 'The authentication regression is fixed.'
    })
    store.recordPart(source, {
      id: 'tool-search', type: 'tool', sessionID: source.nativeSessionId,
      messageID: 'assistant-search', state: { status: 'completed', tool: 'shell', input: 'npm test' }
    })

    const textResults = store.search('authentication')
    assert.equal(textResults.length, 1)
    assert.match(textResults[0].snippet, /authentication regression/i)
    assert.equal(textResults[0].backendId, 'codex')
    const toolResults = store.search('npm test')
    assert.equal(toolResults[0]?.kind, 'tool')
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconciling an idle thread keeps a steered message the backend never reports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    const store = new TranscriptStore(path)
    // What echoSteeredMessage writes: a bubble BOSS authored, with an id no
    // backend will ever hand back in its native history.
    store.recordMessage(source, {
      id: 'steer-followup-1',
      sessionID: source.nativeSessionId,
      role: 'user',
      time: { created: 1 }
    })
    store.recordPart(source, {
      id: 'steer-followup-1-text',
      type: 'text',
      sessionID: source.nativeSessionId,
      messageID: 'steer-followup-1',
      text: 'the steered instruction'
    })

    // The thread goes idle and the backend reports a history without it.
    store.reconcile(source, [
      {
        info: { id: 'native-turn', sessionID: source.nativeSessionId, role: 'assistant', time: { created: 2 } },
        parts: [{ id: 'native-text', type: 'text', sessionID: source.nativeSessionId, messageID: 'native-turn', text: 'a reply' }]
      }
    ], { pruneMissingMessages: true })

    const ids = store.messages(source.threadId).map((message) => message.info.id)
    assert.ok(ids.includes('steer-followup-1'), 'the steered message must survive the prune')
    assert.ok(ids.includes('native-turn'), 'the backend history is still reconciled in')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a BOSS-authored compaction notice survives native history reconciliation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    const store = new TranscriptStore(path)
    store.recordMessage(source, {
      id: 'compaction-notice-1',
      sessionID: source.nativeSessionId,
      role: 'user',
      time: { created: 2, completed: 2 }
    })
    store.recordPart(source, {
      id: 'compaction-notice-1-part',
      type: 'compaction',
      sessionID: source.nativeSessionId,
      messageID: 'compaction-notice-1',
      auto: true,
      state: { status: 'completed', metadata: { trigger: 'auto' } }
    })

    store.reconcile(source, [], { pruneMissingMessages: true })

    const notice = store.messages(source.threadId).find((message) => message.info.id === 'compaction-notice-1')
    assert.ok(notice, 'native history cannot report the notice, so pruning must retain it')
    assert.equal(notice.parts[0]?.type, 'compaction')
    assert.equal(notice.parts[0]?.auto, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a steered echo is retired once the backend reports the same message', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    const store = new TranscriptStore(path)
    // BOSS echoes every steered message now, so it renders the instant it is
    // accepted rather than after the backend takes a round trip to report it.
    store.recordMessage(source, {
      id: 'steer-followup-1',
      sessionID: source.nativeSessionId,
      role: 'user',
      time: { created: 1 }
    })
    store.recordPart(source, {
      id: 'steer-followup-1-text',
      type: 'text',
      sessionID: source.nativeSessionId,
      messageID: 'steer-followup-1',
      text: 'the steered instruction'
    })

    // Codex folds the steered text into its running turn and reports it under
    // its own id. Without the dedupe the user reads the same message twice.
    store.reconcile(source, [
      {
        info: { id: 'codex-user-2', sessionID: source.nativeSessionId, role: 'user', time: { created: 2 } },
        parts: [{ id: 'codex-user-2-text', type: 'text', sessionID: source.nativeSessionId, messageID: 'codex-user-2', text: 'the steered instruction' }]
      }
    ], { pruneMissingMessages: true })

    const messages = store.messages(source.threadId)
    const ids = messages.map((message) => message.info.id)
    assert.ok(!ids.includes('steer-followup-1'), 'the echo must be retired once the backend reports it')
    assert.ok(ids.includes('codex-user-2'), 'the backend copy is what remains')
    const texts = messages.flatMap((message) => message.parts.map((part) => part.text))
    assert.equal(
      texts.filter((text) => text === 'the steered instruction').length,
      1,
      'the steered text must appear exactly once'
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a steered echo survives when the backend reports a different message', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    const store = new TranscriptStore(path)
    store.recordMessage(source, {
      id: 'steer-followup-1',
      sessionID: source.nativeSessionId,
      role: 'user',
      time: { created: 1 }
    })
    store.recordPart(source, {
      id: 'steer-followup-1-text',
      type: 'text',
      sessionID: source.nativeSessionId,
      messageID: 'steer-followup-1',
      text: 'the steered instruction'
    })

    // A backend that never recorded the steer reports only the earlier message.
    // Retiring the echo here is exactly the swallow the echo exists to prevent.
    store.reconcile(source, [
      {
        info: { id: 'codex-user-1', sessionID: source.nativeSessionId, role: 'user', time: { created: 2 } },
        parts: [{ id: 'codex-user-1-text', type: 'text', sessionID: source.nativeSessionId, messageID: 'codex-user-1', text: 'something else entirely' }]
      }
    ], { pruneMissingMessages: true })

    const ids = store.messages(source.threadId).map((message) => message.info.id)
    assert.ok(ids.includes('steer-followup-1'), 'an unreported steer must keep its echo')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconciling still prunes a backend message that really did go away', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boss-transcripts-'))
  const path = join(directory, 'transcripts.sqlite')
  try {
    const store = new TranscriptStore(path)
    store.recordMessage(source, {
      id: 'native-old',
      sessionID: source.nativeSessionId,
      role: 'user',
      time: { created: 1 }
    })

    store.reconcile(source, [
      {
        info: { id: 'native-kept', sessionID: source.nativeSessionId, role: 'assistant', time: { created: 2 } },
        parts: []
      }
    ], { pruneMissingMessages: true })

    const ids = store.messages(source.threadId).map((message) => message.info.id)
    assert.ok(!ids.includes('native-old'), 'a compacted-away backend message is still pruned')
    assert.ok(ids.includes('native-kept'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the local-id prefixes match the shared definition', () => {
  // transcript-store keeps its own copy so the node test runner can load it —
  // a value import from @shared/* cannot resolve here. That copy is only safe
  // while it agrees with the shared one, so pin them together: adding a prefix
  // in one place and not the other would silently re-arm the delete.
  const shared = readFileSync(join(import.meta.dirname, '..', 'shared', 'opencode.ts'), 'utf8')
  const local = readFileSync(join(import.meta.dirname, 'transcript-store.ts'), 'utf8')
  const prefixes = (text: string): string[] => {
    const match = /const LOCAL_MESSAGE_PREFIXES = \[([^\]]*)\]/.exec(text)
    assert.ok(match, 'expected a LOCAL_MESSAGE_PREFIXES declaration')
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]).sort()
  }
  assert.deepEqual(prefixes(local), prefixes(shared), 'the two prefix lists must stay identical')
})
