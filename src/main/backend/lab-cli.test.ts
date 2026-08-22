import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { isMode, parseArgs, parseCommand, resolveSession } from './lab-cli.ts'

test('parseArgs defaults resume the last session and ask on a TTY', () => {
  const args = parseArgs([], { tty: true })
  assert.equal(args.mode, 'ask')
  assert.equal(args.newSession, false)
  assert.equal(args.prompt, undefined)
})

test('parseArgs defaults to auto when piped (no TTY)', () => {
  const args = parseArgs([], { tty: false })
  assert.equal(args.mode, 'auto')
})

test('parseArgs joins positional text into the prompt', () => {
  const args = parseArgs(['fix', 'the', 'tests'], { tty: true })
  assert.equal(args.prompt, 'fix the tests')
})

test('parseArgs handles flags', () => {
  const args = parseArgs(['--new', '--mode', 'plan', '--model', 'gpt-5.6', '--cwd', '/tmp/x'], { tty: true })
  assert.equal(args.newSession, true)
  assert.equal(args.mode, 'plan')
  assert.equal(args.model, 'gpt-5.6')
  assert.equal(args.cwd, '/tmp/x')
})

test('parseArgs rejects an unknown mode or option', () => {
  assert.throws(() => parseArgs(['--mode', 'banana'], { tty: true }), /Unknown mode/)
  assert.throws(() => parseArgs(['--bogus'], { tty: true }), /Unknown option/)
  assert.throws(() => parseArgs(['--store'], { tty: true }), /Missing value/)
})

test('parseArgs --sessions and --models flags', () => {
  const args = parseArgs(['--sessions'], { tty: true })
  assert.equal(args.listSessions, true)
  const models = parseArgs(['--models'], { tty: true })
  assert.equal(models.listModels, true)
})

test('isMode accepts only the four permission modes', () => {
  assert.equal(isMode('ask'), true)
  assert.equal(isMode('auto'), true)
  assert.equal(isMode('accept-edits'), true)
  assert.equal(isMode('plan'), true)
  assert.equal(isMode('banana'), false)
})

test('parseCommand understands the slash commands', () => {
  assert.deepEqual(parseCommand('/exit'), { type: 'exit' })
  assert.deepEqual(parseCommand('/quit'), { type: 'exit' })
  assert.deepEqual(parseCommand('/new'), { type: 'new' })
  assert.deepEqual(parseCommand('/sessions'), { type: 'sessions' })
  assert.deepEqual(parseCommand('/models'), { type: 'models' })
  assert.deepEqual(parseCommand('/model llama3.1'), { type: 'model', arg: 'llama3.1' })
  assert.deepEqual(parseCommand('/mode auto'), { type: 'mode', arg: 'auto' })
  assert.deepEqual(parseCommand('/help'), { type: 'help' })
  assert.equal(parseCommand('write a test'), undefined)
  assert.equal(parseCommand('/mode banana'), undefined)
})

test('resolveSession reuses the most recent session by default', () => {
  const sessions = [
    { id: 'a', title: 'old', time: { updated: 100 } },
    { id: 'b', title: 'new', time: { updated: 200 } }
  ] as Parameters<typeof resolveSession>[0]
  assert.deepEqual(resolveSession(sessions, {}), { action: 'reuse', id: 'b' })
  assert.deepEqual(resolveSession([], {}), { action: 'create' })
})

test('resolveSession honors --new and an explicit id', () => {
  const sessions = [{ id: 'a', title: 'x', time: { updated: 100 } }] as Parameters<typeof resolveSession>[0]
  assert.deepEqual(resolveSession(sessions, { newSession: true }), { action: 'create' })
  assert.deepEqual(resolveSession(sessions, { sessionId: 'a' }), { action: 'reuse', id: 'a' })
  assert.throws(() => resolveSession(sessions, { sessionId: 'missing' }), /Unknown session/)
})