/**
 * Routing table for the relay. Kept in a separate module with no I/O so the
 * pairing and forwarding rules are testable without a live socket.
 *
 * The relay holds no secrets and no chat content. A room is only a device id
 * plus the sockets currently attached to it, and it disappears when the last
 * socket closes. Nothing is written to disk.
 */

import { timingSafeEqual } from 'node:crypto'

export type Side = 'desktop' | 'phone'

/** Compare proofs without leaking their contents through timing. */
function sameProof(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface Peer<S> {
  peerId: string
  side: Side
  socket: S
}

export interface Room<S> {
  desktop: Peer<S> | null
  phones: Map<string, Peer<S>>
  /**
   * Proof-of-secret recorded from the first socket to claim this device id.
   * Later sockets must present the same value. The relay never sees the
   * secret itself, only this one-way derivation of it.
   */
  proof: string
}

/** One phone per device id is too strict — the user may carry a phone and a tablet. */
export const MAX_PHONES_PER_DEVICE = 8

export class Rooms<S> {
  private readonly rooms = new Map<string, Room<S>>()

  private room(deviceId: string, proof: string): Room<S> {
    let room = this.rooms.get(deviceId)
    if (!room) {
      room = { desktop: null, phones: new Map(), proof }
      this.rooms.set(deviceId, room)
    }
    return room
  }

  /**
   * Attach a socket. Returns the peer it displaced, if any: a second desktop
   * for the same device id replaces the first, because that is what a restart
   * or a moved install looks like.
   *
   * A caller that cannot present the room's proof is rejected, so knowing a
   * device id alone is not enough to join a room or evict its desktop.
   */
  join(deviceId: string, proof: string, peer: Peer<S>): { displaced?: Peer<S>; rejected?: string } {
    const room = this.room(deviceId, proof)
    if (!sameProof(room.proof, proof)) return { rejected: 'device id and pairing proof do not match' }
    if (peer.side === 'desktop') {
      const previous = room.desktop
      room.desktop = peer
      return previous && previous.peerId !== peer.peerId ? { displaced: previous } : {}
    }
    if (room.phones.size >= MAX_PHONES_PER_DEVICE && !room.phones.has(peer.peerId)) {
      return { rejected: 'too many paired devices are connected' }
    }
    room.phones.set(peer.peerId, peer)
    return {}
  }

  leave(deviceId: string, peerId: string): void {
    const room = this.rooms.get(deviceId)
    if (!room) return
    if (room.desktop?.peerId === peerId) room.desktop = null
    room.phones.delete(peerId)
    if (!room.desktop && room.phones.size === 0) this.rooms.delete(deviceId)
  }

  desktopOnline(deviceId: string): boolean {
    return this.rooms.get(deviceId)?.desktop != null
  }

  /**
   * Where a frame goes. A phone's frame goes to the desktop only. A desktop's
   * frame goes to the addressed phone, or to every phone when `to` is absent
   * (that is how events fan out). A phone can never reach another phone.
   */
  route(deviceId: string, from: Side, to?: string): Peer<S>[] {
    const room = this.rooms.get(deviceId)
    if (!room) return []
    if (from === 'phone') return room.desktop ? [room.desktop] : []
    if (to) {
      const target = room.phones.get(to)
      return target ? [target] : []
    }
    return [...room.phones.values()]
  }

  phonesOf(deviceId: string): Peer<S>[] {
    return [...(this.rooms.get(deviceId)?.phones.values() ?? [])]
  }

  get size(): number {
    return this.rooms.size
  }
}
