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
