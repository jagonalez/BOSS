import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { MOBILE_PAGE } from './mobile-page.ts'
// @ts-expect-error Application code uses bundler resolution.
import { mobileRequestAllowed, mobileTransportRequestAllowed } from '../shared/mobile.ts'

test('mobile page contains valid JavaScript and uses the shared supervision API', () => {
  const match = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)
  assert.ok(match?.[1], 'embedded script missing')
  assert.doesNotThrow(() => new Function(match[1]))
  assert.match(match[1], /supervision\.snapshot/)
  assert.match(match[1], /api\/access/)
})

test('the page keeps both transports and picks the relay only when paired', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  // The Tailscale path must survive: same endpoints, same event stream.
  assert.match(script, /fetch\('\/api\/request'/)
  assert.match(script, /new EventSource\('\/api\/events/)
  // The relay path is chosen inside api() and listen(), not by duplicating the UI.
  assert.match(script, /if \(relay\) return relayRequest\(request\)/)
  assert.match(script, /if \(relay\) \{ relayConnect\(\); return; \}/)
})

test('the page seals relay frames and never sends the pairing secret in the clear', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  assert.match(script, /AES-GCM/)
  // Every relay frame leaves through seal(); nothing writes a bare payload.
  assert.match(script, /relaySocket\.send\(JSON\.stringify\(\{ sealed: sealed \}\)\)/)
  assert.equal(/relaySocket\.send\(JSON\.stringify\(\{ kind:/.test(script), false)
})

test('the page registers a service worker and a manifest so it installs', () => {
  assert.match(MOBILE_PAGE, /<link rel="manifest" href="\.\/manifest\.webmanifest">/)
  assert.match(MOBILE_PAGE, /navigator\.serviceWorker\.register\('\.\/sw\.js'\)/)
  assert.match(MOBILE_PAGE, /apple-mobile-web-app-capable/)
})

test('the phone tracks event sequence and resumes after being away', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  // Sequence survives the page being unloaded by a locked screen.
  assert.match(script, /localStorage\.getItem\('boss\.seq'/)
  assert.match(script, /localStorage\.setItem\('boss\.seq'/)
  // Reconnecting asks for what was missed rather than silently carrying on.
  assert.match(script, /kind: 'resume', since: lastSeq/)
  // iOS often freezes a socket instead of closing it, so waking must re-check.
  assert.match(script, /visibilitychange/)
})

test('a gap refetches instead of replaying a partial stream', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  assert.match(script, /if \(message\.gap\)/)
  // On a gap the phone reloads state; showing a stream with holes is worse.
  assert.match(script, /message\.gap[\s\S]{0,200}refreshThreads\(\)/)
})

test('read-only access cannot mutate task or automation state', () => {
  for (const type of [
    'thread.send',
    'thread.abort',
    'thread.permission',
    'thread.delegate',
    'thread.relay',
    'automation.run',
    'automation.stop',
    'report.read',
    'assistant.answer',
    'assistant.task.create',
    'assistant.task.update',
    'assistant.task.assign',
    'assistant.workflow.start'
  ] as const) {
    assert.equal(mobileRequestAllowed(type, 'read-only'), false, type)
    assert.equal(mobileRequestAllowed(type, 'control'), true, type)
  }
})

test('read-only access can inspect supervision and transcripts', () => {
  for (const type of [
    'supervision.snapshot',
    'supervision.search',
    'thread.list',
    'thread.messages',
    'thread.diff',
    'automation.list',
    'report.list',
    'report.get',
    'assistant.snapshot'
  ] as const) {
    assert.equal(mobileRequestAllowed(type, 'read-only'), true, type)
  }
})

test('both mobile transports expose the complete follow-up queue contract', () => {
  for (const type of [
    'thread.followups.list',
    'thread.followups.add',
    'thread.followups.update',
    'thread.followups.remove',
    'thread.followups.move',
    'thread.followups.steer'
  ] as const) {
    assert.equal(mobileTransportRequestAllowed(type, 'local'), true, `local: ${type}`)
    assert.equal(mobileTransportRequestAllowed(type, 'relay'), true, `relay: ${type}`)
  }
})

test('the phone has a reports inbox and durable report detail', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  assert.match(script, /function refreshReports/)
  assert.match(script, /type: 'report\.list'/)
  assert.match(script, /type: 'report\.get'/)
  assert.match(script, /function renderReports/)
  assert.match(script, /function renderReport/)
  assert.match(script, />Reports<\/button>/)
  assert.match(script, /Source thread/)
})

test('the page sorts what needs the user above everything else', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  // The phone exists to answer these, so they cannot be buried in a list
  // sorted only by time.
  assert.match(script, /function attentionReason/)
  assert.match(script, /Needs permission/)
  assert.match(script, /Needs an answer/)
  assert.match(script, /need' \+ \(needsMe\.length === 1 \? 's' : ''\) \+ ' you/)
})

test('the page shows a worker the thread it came from', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  // A narrow screen cannot indent a tree, so lineage is named instead.
  assert.match(script, /t\.lineage && t\.lineage\.sourceThreadId/)
  assert.match(script, /from ' \+ esc\(origin\)/)
})

test('the phone has a Lab Assistant inbox with durable decision actions', () => {
  const script = MOBILE_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ''
  assert.match(script, /function refreshAssistant/)
  assert.match(script, /function renderAssistant/)
  assert.match(script, /type: 'assistant\.snapshot'/)
  assert.match(script, /type: 'assistant\.answer'/)
  assert.match(script, /type: 'assistant\.task\.create'/)
  assert.match(script, /type: 'assistant\.task\.update'/)
  assert.match(script, /type: 'assistant\.task\.assign'/)
  assert.match(script, /type: 'assistant\.workflow\.start'/)
  // Managed runs execute on the workflow engine now; the phone keeps the
  // start action but no longer renders a run strip of its own.
  assert.doesNotMatch(script, /assistant\.workflowRuns/)
  assert.match(script, /Start workflow/)
  assert.match(script, /function renderAssistant/)
  assert.match(script, /Task queue/)
  assert.match(script, /CI monitoring/)
  assert.match(script, /assistant\.ciIncidents/)
  assert.match(script, /Run failed before GitHub reported a failed job or step/)
  assert.match(script, />Assistant<\/button>/)
})
