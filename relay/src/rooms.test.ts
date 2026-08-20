import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
import { Rooms, MAX_PHONES_PER_DEVICE } from './rooms.ts'

function peer(peerId: string, side: 'desktop' | 'phone'): { peerId: string; side: 'desktop' | 'phone'; socket: string } {
  return { peerId, side, socket: peerId }
}

test('a phone reaches the desktop and never another phone', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('desk', 'desktop'))
  rooms.join('dev1', peer('phoneA', 'phone'))
  rooms.join('dev1', peer('phoneB', 'phone'))

  const fromPhone = rooms.route('dev1', 'phone')
  assert.deepEqual(fromPhone.map((p) => p.peerId), ['desk'])
})

test('an unaddressed desktop frame fans out to every phone', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('desk', 'desktop'))
  rooms.join('dev1', peer('phoneA', 'phone'))
  rooms.join('dev1', peer('phoneB', 'phone'))

  const broadcast = rooms.route('dev1', 'desktop')
  assert.deepEqual(broadcast.map((p) => p.peerId).sort(), ['phoneA', 'phoneB'])

  const addressed = rooms.route('dev1', 'desktop', 'phoneB')
  assert.deepEqual(addressed.map((p) => p.peerId), ['phoneB'])
})

test('rooms are isolated by device id', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('deskOne', 'desktop'))
  rooms.join('dev2', peer('deskTwo', 'desktop'))
  rooms.join('dev2', peer('phoneTwo', 'phone'))

  assert.deepEqual(rooms.route('dev1', 'desktop').map((p) => p.peerId), [])
  assert.deepEqual(rooms.route('dev2', 'phone').map((p) => p.peerId), ['deskTwo'])
})

// Who may enter a room is no longer this class's decision — the server proves
// it by signature before calling join(), and identity.test.ts covers that.
// What remains here is only where an admitted socket goes.

test('a reconnecting desktop displaces the stale socket', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('deskOld', 'desktop'))
  const result = rooms.join('dev1', peer('deskNew', 'desktop'))

  assert.equal(result.displaced?.peerId, 'deskOld')
  rooms.join('dev1', peer('phoneA', 'phone'))
  assert.deepEqual(rooms.route('dev1', 'phone').map((p) => p.peerId), ['deskNew'])
})

test('phones are capped per device', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('desk', 'desktop'))
  for (let i = 0; i < MAX_PHONES_PER_DEVICE; i += 1) {
    assert.equal(rooms.join('dev1', peer(`phone${i}`, 'phone')).rejected, undefined)
  }
  assert.match(String(rooms.join('dev1', peer('extra', 'phone')).rejected), /too many/)
})

test('a phone sees the desktop as offline when it is gone', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('desk', 'desktop'))
  rooms.join('dev1', peer('phoneA', 'phone'))
  assert.equal(rooms.desktopOnline('dev1'), true)

  rooms.leave('dev1', 'desk')
  assert.equal(rooms.desktopOnline('dev1'), false)
  assert.deepEqual(rooms.route('dev1', 'phone'), [])
})

test('a room is forgotten once every peer leaves', () => {
  const rooms = new Rooms<string>()
  rooms.join('dev1', peer('desk', 'desktop'))
  rooms.join('dev1', peer('phoneA', 'phone'))
  rooms.leave('dev1', 'desk')
  rooms.leave('dev1', 'phoneA')
  assert.equal(rooms.size, 0)
})
