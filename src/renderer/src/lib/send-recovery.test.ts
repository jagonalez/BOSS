import assert from 'node:assert/strict'
import test from 'node:test'
import { composerRecovery, retryPayload, type Attachmentish } from './send-recovery.ts'

const shot: Attachmentish = { id: 'a1', name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }

test('a send that fails puts the text back in an empty composer', () => {
  const next = composerRecovery(false, 'the message I typed', [], '', [])

  assert.equal(next.text, 'the message I typed', 'the text is not lost')
  assert.equal(next.restored, true)
})

test('a failed send restores its attachments, not just its text', () => {
  const next = composerRecovery(false, 'look at this', [shot], '', [])

  assert.deepEqual(next.attachments, [shot], 'the pasted image survives the failure')
})

test('a successful send leaves the composer alone', () => {
  const next = composerRecovery(true, 'sent fine', [shot], '', [])

  assert.equal(next.text, '', 'the composer stays cleared')
  assert.deepEqual(next.attachments, [], 'the attachments stay cleared')
  assert.equal(next.restored, false)
})

test('a failure never overwrites something the user typed meanwhile', () => {
  const next = composerRecovery(false, 'the failed message', [shot], 'a new thought', [])

  assert.equal(next.text, 'a new thought', 'the newer text wins')
  assert.equal(next.restored, false, 'nothing was restored over it')
})

test('a failure does not clobber attachments the user added meanwhile', () => {
  const other: Attachmentish = { ...shot, id: 'a2', name: 'other.png' }
  const next = composerRecovery(false, 'failed', [shot], '', [other])

  assert.deepEqual(next.attachments, [other], 'the newer attachments win')
})

test('a retry resends the failed text together with its attachments', () => {
  const payload = retryPayload({ text: 'retry me', attachments: [shot], error: 'network' })

  assert.deepEqual(payload, { text: 'retry me', attachments: [shot] })
})

test('an attachment-only message is still retryable', () => {
  const payload = retryPayload({ text: '', attachments: [shot], error: 'network' })

  assert.deepEqual(payload?.attachments, [shot], 'a bare image send can be retried')
})

test('there is nothing to retry without a failed send', () => {
  assert.equal(retryPayload(undefined), null)
  assert.equal(retryPayload({ text: '   ', attachments: [], error: 'network' }), null)
})
