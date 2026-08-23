import assert from 'node:assert/strict'
import test from 'node:test'
import { retryTurnPayload, type RetryTurnMessage } from './regenerate.ts'

test('a retry resends the user turn text', () => {
  const message: RetryTurnMessage = {
    parts: [{ type: 'text', text: 'Explain this function.' }]
  }

  assert.deepEqual(retryTurnPayload(message), { text: 'Explain this function.', attachments: [] })
})

test('a retry carries the images the user attached', () => {
  const message: RetryTurnMessage = {
    parts: [
      {
        type: 'file',
        state: { mime: 'image/png', url: 'data:image/png;base64,AAAA', name: 'shot.png' }
      },
      { type: 'text', text: 'What is wrong here?' }
    ]
  }

  const payload = retryTurnPayload(message)
  assert.equal(payload?.text, 'What is wrong here?')
  assert.deepEqual(payload?.attachments, [
    { id: 'retry-0-shot.png', name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }
  ])
})

test('a screenshot the agent took is not resent as an attachment', () => {
  // Its bytes live behind a boss-image:// pointer into BOSS's store; resending
  // that pointer as an attachment would hand the model a broken reference.
  const message: RetryTurnMessage = {
    parts: [{ type: 'file', state: { mime: 'image/png', url: 'boss-image://abc', name: 'grab.png' } }]
  }

  assert.equal(retryTurnPayload(message), null)
})

test('a user message with no text and no restorable image is not a retry', () => {
  assert.equal(retryTurnPayload({ parts: [] }), null)
  assert.equal(retryTurnPayload({ parts: [{ type: 'text', text: '   ' }] }), null)
  assert.equal(retryTurnPayload(undefined), null)
})

test('multi-part text rejoins in order with the line breaks between them', () => {
  const message: RetryTurnMessage = {
    parts: [
      { type: 'text', text: 'First part.' },
      { type: 'text', text: 'Second part.' }
    ]
  }

  assert.equal(retryTurnPayload(message)?.text, 'First part.\nSecond part.')
})
