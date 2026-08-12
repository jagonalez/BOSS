import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution omits it in application code.
import { TranscriptStore } from './transcript-store.ts'

const source = {
  threadId: 'ralf-thread',
  backendId: 'codex' as const,
  nativeSessionId: 'native-thread'
}

test('keeps live tool details across lossy history refreshes and restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ralf-transcripts-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'ralf-transcripts-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'ralf-transcripts-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'ralf-transcripts-'))
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
  const directory = mkdtempSync(join(tmpdir(), 'ralf-transcripts-'))
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
