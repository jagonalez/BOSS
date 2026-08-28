import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldScheduleMessageHistoryRefresh } from './live-message-refresh.ts'

test('does not refetch message history while a thread is busy or streaming', () => {
  assert.equal(shouldScheduleMessageHistoryRefresh({
    sessionBusy: { thread: true },
    streaming: {}
  }, 'thread'), false)
  assert.equal(shouldScheduleMessageHistoryRefresh({
    sessionBusy: {},
    streaming: { thread: true }
  }, 'thread'), false)
})

test('allows a trailing refresh for an idle message event', () => {
  assert.equal(shouldScheduleMessageHistoryRefresh({
    sessionBusy: { thread: false },
    streaming: { thread: false }
  }, 'thread'), true)
})
