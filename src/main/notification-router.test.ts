import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { BossEvent } from '../shared/notification.ts'

// Two things stop this module loading under the type-stripping test runner:
// it imports electron, which needs an Electron process, and it uses bundler
// resolution, which leaves relative imports without a file extension. Stub the
// first and add the extension for the second, so the routing decisions — the
// part that actually broke — are tested for real rather than by reading source.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'boss-stub:electron', shortCircuit: true }
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'boss-stub:electron') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const Notification = { isSupported: () => false }'
      }
    }
    return next(url, context)
  }
})

// @ts-expect-error Application code uses bundler resolution.
const { NotificationRouter, NOTIFICATION_DEFAULTS } = await import('./notification-router.ts')

const EVENT: BossEvent = {
  type: 'task.needs_attention',
  title: 'A thread needs you',
  body: 'Allow the edit?',
  createdAt: 0
}

/** A router whose webhook is configured and whose fetch is captured. */
function harness(overrides = {}) {
  const posted: string[] = []
  const router = new NotificationRouter()
  router.configure({ webhookUrl: 'https://ntfy.sh/topic', webhook: 'attention', ...overrides })
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    posted.push(String(url))
    return new Response('')
  }) as typeof fetch
  return {
    posted,
    publish: (foreground: boolean) => {
      router.onForeground(() => foreground)
      try {
        router.publish(EVENT)
      } finally {
        globalThis.fetch = realFetch
      }
    }
  }
}

test('the push is held back while a BOSS window is focused', () => {
  // The bug: the foreground check gated only the desktop channel, so the phone
  // buzzed for an event already on screen in front of you.
  const h = harness()
  h.publish(true)
  assert.deepEqual(h.posted, [], 'a focused window should suppress the push')
})

test('the push goes out when no BOSS window is focused', () => {
  const h = harness()
  h.publish(false)
  assert.deepEqual(h.posted, ['https://ntfy.sh/topic'], 'being away is the case a push exists for')
})

test('turning the setting off restores a push that always fires', () => {
  // For a desktop left open on a machine you walk away from, the focused
  // window is not evidence that you are reading it.
  const h = harness({ webhookOnlyWhenAway: false })
  h.publish(true)
  assert.deepEqual(h.posted, ['https://ntfy.sh/topic'], 'the opt-out should push regardless of focus')
})

test('the setting gates only the push, not the event level', () => {
  // webhookOnlyWhenAway must not become a second way to silence a channel: an
  // event the level already drops stays dropped, and turning the hold-back off
  // must not promote an event the level never wanted.
  const h = harness({ webhook: 'off', webhookOnlyWhenAway: false })
  h.publish(false)
  assert.deepEqual(h.posted, [], 'a webhook level of off outranks the hold-back setting')
})

test('the setting defaults to on so existing installs get the fix', () => {
  // Absent in the state file means on. A default of off would leave every
  // current user with the duplicate-notification bug until they found a toggle.
  assert.equal(NOTIFICATION_DEFAULTS.webhookOnlyWhenAway, true)
})

test('an unconfigured webhook stays silent whatever the focus', () => {
  for (const foreground of [true, false]) {
    const h = harness({ webhookUrl: '' })
    h.publish(foreground)
    assert.deepEqual(h.posted, [], `no URL should post nothing (foreground: ${foreground})`)
  }
})
