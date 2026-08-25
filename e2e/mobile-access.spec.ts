import { test, expect } from '@playwright/test'
import { mobileRequestAllowed, mobileTransportRequestAllowed } from '../src/shared/mobile'

test('a control phone can manage the follow-up queue through either transport', () => {
  // This is the request sequence used by the native composer and queue UI.
  // It must remain whole: accepting add but rejecting list or edit still leaves
  // the user with a message error as soon as they open or manage a thread.
  const requests = [
    'thread.followups.list',
    'thread.followups.add',
    'thread.followups.update',
    'thread.followups.move',
    'thread.followups.steer',
    'thread.followups.remove'
  ] as const

  for (const type of requests) {
    expect(mobileRequestAllowed(type, 'control'), type).toBe(true)
    expect(mobileTransportRequestAllowed(type, 'local'), `local: ${type}`).toBe(true)
    expect(mobileTransportRequestAllowed(type, 'relay'), `relay: ${type}`).toBe(true)
  }
})

test('a viewer can list queued messages but cannot change them', () => {
  expect(mobileRequestAllowed('thread.followups.list', 'read-only')).toBe(true)
  for (const type of [
    'thread.followups.add',
    'thread.followups.update',
    'thread.followups.move',
    'thread.followups.steer',
    'thread.followups.remove'
  ] as const) {
    expect(mobileRequestAllowed(type, 'read-only'), type).toBe(false)
  }
})
