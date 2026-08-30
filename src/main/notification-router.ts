import { Notification } from 'electron'
import type { BossEvent, NotifyLevel, Presence } from '../shared/notification'
import { presenceAllows, shouldNotify } from '../shared/notification'

export interface NotificationSettings {
  desktop: NotifyLevel
  webhook: NotifyLevel
  webhookUrl: string
  /** Hold back the webhook while a BOSS window is focused.
   *
   *  On by default. A push exists to reach you where BOSS is not, so sending
   *  one to your phone while you are reading the same event on screen is pure
   *  noise. Turn it off if you keep BOSS open on a machine you walk away from
   *  and want the phone to stay authoritative. */
  webhookOnlyWhenAway: boolean
}

/** How many held events survive a long quiet spell. Enough for a working day
 *  of real interruptions; past that the oldest are the least useful. */
const HELD_CAP = 100

export const NOTIFICATION_DEFAULTS: NotificationSettings = {
  desktop: 'attention',
  webhook: 'off',
  webhookUrl: '',
  webhookOnlyWhenAway: true
}

/** One place every BOSS event passes through on its way to a person.
 *
 *  Before this, automations posted to a webhook and threads raised desktop
 *  notifications, and neither knew about the other — so a thread that needed
 *  permission could never reach a phone. Senders now describe what happened and
 *  this decides who hears about it.
 *
 *  Delivery is best-effort by design. A webhook that is down must not fail the
 *  run that reported the event.
 */
export class NotificationRouter {
  private settings: NotificationSettings = { ...NOTIFICATION_DEFAULTS }
  /** Set by the host so a notification can be skipped while the user is
   *  already looking at BOSS. */
  private isForeground: () => boolean = () => false
  /** Where the user is, which sets the bar for interrupting them.
   *
   *  Three modes, because two were not enough: at the desk everything gets
   *  through, away means only what needs a decision, and do not disturb is
   *  silence with no exceptions — not even a failed release. Real paging stays
   *  with the user's monitoring, which already wakes them, and one exception
   *  here would make the setting untrustworthy. */
  private presence: Presence = 'desk'
  /** What arrived while quiet, so returning does not mean finding out by
   *  accident that something needed an answer two hours ago. */
  private held: BossEvent[] = []

  configure(settings: Partial<NotificationSettings>): NotificationSettings {
    this.settings = { ...this.settings, ...settings }
    return this.current()
  }

  current(): NotificationSettings {
    return { ...this.settings }
  }

  onForeground(probe: () => boolean): void {
    this.isForeground = probe
  }

  /** Say where the user is. Returns what was held back while they were away, so
   *  the caller can tell them what waited rather than leaving them to notice.
   *
   *  Held events are returned whenever the bar comes down, not only on the way
   *  out of silence: going from away to the desk should also hand back the
   *  routine things that were withheld. */
  setPresence(presence: Presence): BossEvent[] {
    const wasBarred = this.presence !== 'desk'
    this.presence = presence
    if (presence === 'quiet' || !wasBarred) return []
    const waiting = this.held.filter((event) => presenceAllows(presence, event.type))
    this.held = this.held.filter((event) => !presenceAllows(presence, event.type))
    return waiting
  }

  currentPresence(): Presence {
    return this.presence
  }

  /** Deliver an event to every channel that wants it. */
  publish(event: BossEvent): void {
    if (!presenceAllows(this.presence, event.type)) {
      // Held rather than dropped. Work keeps running while the user is away;
      // what needed them is what they came back for.
      this.held.push(event)
      if (this.held.length > HELD_CAP) this.held.splice(0, this.held.length - HELD_CAP)
      return
    }
    if (shouldNotify(this.settings.desktop, event.type) && !this.isForeground()) {
      this.desktop(event)
    }
    const heldBack = this.settings.webhookOnlyWhenAway && this.isForeground()
    if (this.settings.webhookUrl && shouldNotify(this.settings.webhook, event.type) && !heldBack) {
      this.webhook(event)
    }
  }

  private desktop(event: BossEvent): void {
    if (!Notification.isSupported()) return
    try {
      new Notification({ title: event.title, body: event.body }).show()
    } catch {
      /* Notifications are best-effort. */
    }
  }

  private webhook(event: BossEvent): void {
    // ntfy-compatible: plain-text body, title in a header. Any webhook that
    // accepts a text POST works, which covers ntfy, Telegram bridges, and a
    // plain endpoint of your own.
    void fetch(this.settings.webhookUrl, {
      method: 'POST',
      headers: {
        title: event.title,
        'content-type': 'text/plain',
        'x-boss-event': event.type
      },
      body: event.body
    }).catch(() => {
      /* Push is best-effort; the run record is the source of truth. */
    })
  }
}
