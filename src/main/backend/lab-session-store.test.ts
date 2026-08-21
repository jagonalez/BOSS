import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { LabSessionStore } from './lab-session-store.ts'

function withStore(run: (store: LabSessionStore, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-store-'))
  const file = join(dir, 'lab-threads.json')
  try {
    run(new LabSessionStore(file), file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('creates, lists, gets, renames, and deletes sessions', () => {
  withStore((store) => {
    const created = store.create('My task', '/work')
    assert.equal(created.title, 'My task')
    assert.equal(created.directory, '/work')

    const listed = store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, created.id)

    const got = store.get(created.id)
    assert.equal(got.id, created.id)
    assert.deepEqual(got.messages, [])

    const renamed = store.rename(created.id, 'New title')
    assert.equal(renamed.title, 'New title')
    assert.equal(store.get(created.id).title, 'New title')

    store.delete(created.id)
    assert.deepEqual(store.list(), [])
    assert.throws(() => store.get(created.id), /not found/)
  })
})

test('persists sessions and history to disk across instances', () => {
  withStore((store, file) => {
    const session = store.create('Persisted', '/work')
    const message = {
      info: { id: 'm1', sessionID: session.id, role: 'assistant' as const },
      parts: [{ id: 'p1', type: 'text' as const, sessionID: session.id, messageID: 'm1', text: 'hello' }]
    }
    store.upsertMessage(session.id, message)

    const reloaded = new LabSessionStore(file)
    assert.equal(reloaded.list().length, 1)
    assert.equal(reloaded.get(session.id).title, 'Persisted')
    assert.equal(reloaded.messages(session.id).length, 1)
    assert.equal(reloaded.messages(session.id)[0].parts[0].text, 'hello')
  })
})

test('upsertMessage replaces a message with the same id instead of duplicating', () => {
  withStore((store) => {
    const session = store.create()
    const first = {
      info: { id: 'm1', sessionID: session.id, role: 'assistant' as const },
      parts: [{ id: 'p1', type: 'text' as const, sessionID: session.id, messageID: 'm1', text: 'par' }]
    }
    const second = {
      info: { id: 'm1', sessionID: session.id, role: 'assistant' as const },
      parts: [{ id: 'p1', type: 'text' as const, sessionID: session.id, messageID: 'm1', text: 'partition' }]
    }
    store.upsertMessage(session.id, first)
    store.upsertMessage(session.id, second)
    const messages = store.messages(session.id)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].parts[0].text, 'partition')
  })
})

test('updatePart updates a part within a message and records tool output', () => {
  withStore((store) => {
    const session = store.create()
    const part = {
      id: 'call-1',
      type: 'tool' as const,
      sessionID: session.id,
      messageID: 'm1',
      state: { status: 'running' as const, tool: 'read_file', input: { path: 'x' } }
    }
    store.upsertMessage(session.id, {
      info: { id: 'm1', sessionID: session.id, role: 'assistant' as const },
      parts: [part]
    })
    store.updatePart(session.id, 'm1', {
      ...part,
      state: { ...part.state, status: 'completed' as const, output: 'file contents' }
    })
    const stored = store.messages(session.id)[0].parts[0]
    assert.equal(stored.state?.status, 'completed')
    assert.equal(stored.state?.output, 'file contents')
  })
})

test('setDirectory moves a session onto its checkout', () => {
  withStore((store) => {
    const session = store.create('t', '/one')
    store.setDirectory(session.id, '/two')
    assert.equal(store.get(session.id).directory, '/two')
    assert.equal(store.list()[0].directory, '/two')
    // An empty path must not clobber a real directory.
    store.setDirectory(session.id, '')
    assert.equal(store.get(session.id).directory, '/two')
  })
})

test('list sorts by most recently updated', () => {
  withStore((store) => {
    store.create('a')
    store.create('b')
    const c = store.create('c')
    store.rename(c.id, 'c-updated')
    const order = store.list().map((session) => session.title)
    // Renaming c bumps it above its same-millisecond siblings.
    assert.equal(order[0], 'c-updated')
    assert.ok(order.includes('a') && order.includes('b'))
  })
})

test('survives a corrupt store file by starting fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-store-'))
  const file = join(dir, 'lab-threads.json')
  try {
    writeFileSync(file, '{not json')
    const store = new LabSessionStore(file)
    assert.deepEqual(store.list(), [])
    const session = store.create('recovered')
    assert.equal(store.get(session.id).title, 'recovered')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('messages limit keeps only the most recent', () => {
  withStore((store) => {
    const session = store.create()
    for (let i = 0; i < 5; i++) {
      store.upsertMessage(session.id, {
        info: { id: `m${i}`, sessionID: session.id, role: 'assistant' as const },
        parts: [{ id: `m${i}-p`, type: 'text' as const, sessionID: session.id, messageID: `m${i}`, text: String(i) }]
      })
    }
    const limited = store.messages(session.id, 2)
    assert.deepEqual(limited.map((message) => message.info.id), ['m3', 'm4'])
  })
})

test('readFileSync is used so persistence actually round-trips', () => {
  withStore((store, file) => {
    store.create('disk', '/work')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(Object.keys(onDisk.sessions).length, 1)
  })
})

test('createParented links and tracks child sessions under a parent', () => {
  withStore((store) => {
    const parent = store.create('parent')
    const child = store.createParented('writer', '/work', parent.id)
    store.setStatus(child.id, 'running')
    store.setStatus(child.id, 'completed')

    const children = store.childrenOf(parent.id)
    assert.equal(children.length, 1)
    assert.equal(children[0].id, child.id)
    assert.equal(children[0].parentID, parent.id)
    const summary = store.subAgentSummary(children[0])
    assert.equal(summary.title, 'writer')
    assert.equal(summary.status, 'completed')
    assert.equal(store.subAgentSummary(store.get(parent.id)).title, 'parent')
  })
})

test('childrenOf keeps siblings in creation order and ignores other trees', () => {
  withStore((store) => {
    const a = store.create('a')
    const b = store.create('b')
    const child = store.createParented('child a1', '/w', a.id)
    store.createParented('child a2', '/w', a.id)
    store.createParented('child b1', '/w', b.id)
    const aChildren = store.childrenOf(a.id)
    assert.deepEqual(aChildren.map((record) => record.title), ['child a1', 'child a2'])
    assert.equal(store.childrenOf(b.id).length, 1)
    assert.equal(store.childrenOf(child.id).length, 0)
  })
})

test('lastAssistantText returns the most recent assistant summary', () => {
  withStore((store) => {
    const session = store.create('parent')
    store.upsertMessage(session.id, {
      info: { id: 'm1', sessionID: session.id, role: 'assistant' as const },
      parts: [{ id: 'm1-p', type: 'text' as const, sessionID: session.id, messageID: 'm1', text: 'thinking' }]
    })
    store.upsertMessage(session.id, {
      info: { id: 'm2', sessionID: session.id, role: 'user' as const },
      parts: [{ id: 'm2-p', type: 'text' as const, sessionID: session.id, messageID: 'm2', text: 'ignored-user' }]
    })
    store.upsertMessage(session.id, {
      info: { id: 'm3', sessionID: session.id, role: 'assistant' as const },
      parts: [{ id: 'm3-p', type: 'text' as const, sessionID: session.id, messageID: 'm3', text: 'the summary' }]
    })
    assert.equal(store.lastAssistantText(session.id), 'the summary')
  })
})

test('grantAlways and takeAlways persist per-thread tool grants', () => {
  withStore((store) => {
    const session = store.create('parent')
    store.grantAlways(session.id, 'bash')
    store.grantAlways(session.id, 'bash')
    store.grantAlways(session.id, 'write_file')
    assert.deepEqual(store.get(session.id).alwaysAllow, ['bash', 'write_file'])
    store.takeAlways(session.id, 'bash')
    assert.deepEqual(store.get(session.id).alwaysAllow, ['write_file'])

    // Grants belong to their thread only.
    const other = store.create('other')
    assert.equal(store.get(other.id).alwaysAllow, undefined)
  })
})

test('runningChildren reports children left marked running', () => {
  withStore((store) => {
    const parent = store.create('parent')
    const child = store.createParented('child', '/w', parent.id)
    assert.deepEqual(store.runningChildren(), [])
    store.setStatus(child.id, 'running')
    const survivors = store.runningChildren()
    assert.equal(survivors.length, 1)
    assert.equal(survivors[0].id, child.id)
  })
})

test('todosOf and setTodos persist the model task list', () => {
  withStore((store, file) => {
    const session = store.create('parent')
    assert.deepEqual(store.todosOf(session.id), [])
    const todos = [
      { id: 't1', content: 'read the code', status: 'in_progress' as const, sessionID: session.id },
      { id: 't2', content: 'write the fix', status: 'pending' as const, sessionID: session.id }
    ]
    store.setTodos(session.id, todos)
    assert.deepEqual(store.todosOf(session.id), todos)
    const reloaded = new LabSessionStore(file)
    assert.equal(reloaded.todosOf(session.id).length, 2)
  })
})

test('setMessages replaces the whole history', () => {
  withStore((store) => {
    const session = store.create()
    for (let i = 0; i < 3; i++) {
      store.upsertMessage(session.id, {
        info: { id: `m${i}`, sessionID: session.id, role: 'assistant' as const },
        parts: [{ id: `m${i}-p`, type: 'text' as const, sessionID: session.id, messageID: `m${i}`, text: String(i) }]
      })
    }
    const summary = {
      info: { id: 's', sessionID: session.id, role: 'assistant' as const },
      parts: [{ id: 's-p', type: 'compaction' as const, sessionID: session.id, messageID: 's', text: 'summary' }]
    }
    store.setMessages(session.id, [summary])
    const messages = store.messages(session.id)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].info.id, 's')
    assert.equal(messages[0].parts[0].type, 'compaction')
  })
})
