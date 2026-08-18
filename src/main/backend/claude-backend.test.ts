import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { claudeMessageContent, claudePermissionMode, claudePermissionDecision, claudeQuestionInput, claudeResultError, claudeStreamedPartId, parseClaudeQuestions } from './claude-protocol.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('a message with no image is sent as plain text', () => {
  assert.equal(claudeMessageContent([{ type: 'text', text: 'Hello' }]), 'Hello')
})

test('an attached image is sent as an image block', () => {
  // Claude Code accepts the same image block the Anthropic API does. Flattening
  // it to text described the picture rather than sending it, so the model
  // answered as if it had seen nothing.
  assert.deepEqual(
    claudeMessageContent([
      { type: 'file', mime: 'image/png', filename: 'shot.png', url: `data:image/png;base64,${PNG}` },
      { type: 'text', text: 'What is this?' }
    ]),
    [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: 'What is this?' }
    ]
  )
})

test('a file Claude cannot read is named rather than dropped', () => {
  // A pdf, or an image behind a url whose bytes BOSS does not hold: the model
  // should know something was attached even though it cannot see it.
  assert.equal(
    claudeMessageContent([{ type: 'file', mime: 'application/pdf', filename: 'report.pdf' }]),
    '[Attached file: report.pdf]'
  )
  assert.equal(
    claudeMessageContent([{ type: 'file', mime: 'image/png', filename: 'remote.png', url: 'https://example.com/remote.png' }]),
    '[Attached file: remote.png]'
  )
})

test('an image sent with no text is still a block array', () => {
  assert.deepEqual(
    claudeMessageContent([{ type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG}` }]),
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]
  )
})

test('maps BOSS modes to current Claude permission modes', () => {
  assert.equal(claudePermissionMode('ask'), 'default')
  assert.equal(claudePermissionMode('accept-edits'), 'acceptEdits')
  assert.equal(claudePermissionMode('auto'), 'auto')
  assert.equal(claudePermissionMode('plan'), 'plan')
})

test('an intentionally stopped Claude turn is not reported as a failure', () => {
  const failed = { type: 'result', subtype: 'error_during_execution' }
  assert.equal(claudeResultError(failed), 'Claude Code failed.')
  assert.equal(claudeResultError({ ...failed, error: 'Actual failure' }), 'Actual failure')
  assert.equal(claudeResultError(failed, true), undefined)
  assert.equal(claudeResultError({ type: 'result', subtype: 'success' }), undefined)
})

test('builds once, always, and deny decisions for canUseTool', () => {
  const suggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'WebSearch' }] }
  // The shape canUseTool hands back, which the SDK awaits in place of the
  // control_response BOSS used to write down the pipe.
  const pending = { input: { query: 'current pricing' }, suggestions: [suggestion] }

  assert.equal(claudePermissionDecision(pending, 'once').behavior, 'allow')
  const once = claudePermissionDecision(pending, 'once')
  assert.deepEqual((once as { updatedInput: unknown }).updatedInput, { query: 'current pricing' })
  // Only "always" carries the suggestions, which is what stops Claude asking
  // again for the same tool this session.
  assert.equal((once as { updatedPermissions?: unknown[] }).updatedPermissions, undefined)

  const always = claudePermissionDecision(pending, 'always')
  assert.deepEqual((always as { updatedPermissions: unknown[] }).updatedPermissions, [suggestion])

  assert.equal(claudePermissionDecision(pending, 'reject').behavior, 'deny')
})

/** What canUseTool hands parseClaudeQuestions. The SDK parses the control
 *  request itself and passes these fields, so tests build them directly. */
const toolRequest = (toolName: string, input: Record<string, unknown>, requestId = 'req-1') => ({
  requestId,
  toolName,
  input,
  suggestions: []
})

test('an AskUserQuestion request is read as questions, not a tool approval', () => {
  // It arrives as an ordinary permission request. Shown as one, the question
  // was invisible and denying it reported a dismissal the user never made.
  const request = toolRequest('AskUserQuestion', {
    questions: [{
      question: 'Which repository?',
      header: 'Repo',
      options: [{ label: 'ralf', description: 'the page in your browser' }, { label: 'autofix' }],
      multiSelect: false
    }]
  }, 'ask-1')
  const questions = parseClaudeQuestions(request)
  assert.equal(questions?.length, 1)
  assert.equal(questions?.[0].question, 'Which repository?')
  assert.equal(questions?.[0].header, 'Repo')
  assert.deepEqual(questions?.[0].options.map((option) => option.label), ['ralf', 'autofix'])
  assert.equal(questions?.[0].options[0].description, 'the page in your browser')
  assert.equal(questions?.[0].multiple, false)
})

test('any other tool is left as a permission request', () => {
  const request = toolRequest('Bash', { command: 'ls' }, 'perm-1')
  assert.equal(parseClaudeQuestions(request), undefined)
})

test('a malformed question falls back to the permission prompt', () => {
  // Better an "allow this tool?" prompt than an empty dialog with no way out.
  const ask = (input: Record<string, unknown>) =>
    parseClaudeQuestions(toolRequest('AskUserQuestion', input, 'ask-2'))
  assert.equal(ask({}), undefined)
  assert.equal(ask({ questions: 'why' }), undefined)
  assert.equal(ask({ questions: [] }), undefined)
  assert.equal(ask({ questions: [{ question: '   ' }] }), undefined)
})

test('a question with no options still reaches the user', () => {
  // An open question is a question. Dropping it would hang the thread.
  const questions = parseClaudeQuestions(toolRequest('AskUserQuestion', {
    questions: [{ question: 'What should I name it?' }]
  }, 'ask-3'))
  assert.equal(questions?.length, 1)
  assert.deepEqual(questions?.[0].options, [])
})

/** The request BOSS answers in the tests below, as Claude Code sends it. */
const askRequest = (questions: unknown[]) => ({
  requestId: 'ask-1',
  toolName: 'AskUserQuestion',
  input: { questions },
  suggestions: []
})

const twoQuestions = [
  {
    question: 'Which repository?',
    header: 'Repo',
    options: [{ label: 'ralf', description: 'the page in your browser' }, { label: 'autofix' }],
    multiSelect: false
  },
  {
    question: 'Which checks should run?',
    header: 'Checks',
    options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    multiSelect: true
  }
]

// What questionRespond resolves canUseTool with: an allow whose updatedInput
// is the tool input Claude will read.
const answered = (questions: unknown[], answers: string[][]) =>
  ({ behavior: 'allow', updatedInput: claudeQuestionInput(askRequest(questions), answers) }) as Record<string, unknown>

test('answers go back as the tool result Claude is waiting for', () => {
  const inner = answered(twoQuestions, [['ralf'], ['a', 'b']])
  assert.equal(inner.behavior, 'allow', 'a question is answered, not denied')
  assert.deepEqual(inner.updatedInput, {
    questions: twoQuestions,
    // Keyed by question text, and one string per question: several selections
    // join with a comma rather than staying a list.
    answers: { 'Which repository?': 'ralf', 'Which checks should run?': 'a, b' }
  })
})

test('an answered question keeps the fields its schema requires', () => {
  // Claude Code validates the returned input against the AskUserQuestion
  // schema. Rebuilding the array from the answers alone dropped question,
  // header, and options, and the user's choice came back as a validation
  // error instead of an answer.
  const inner = answered(twoQuestions, [['ralf'], ['a', 'b']])
  const questions = (inner.updatedInput as { questions: Array<Record<string, unknown>> }).questions
  assert.equal(questions.length, 2)
  for (const question of questions) {
    assert.equal(typeof question.question, 'string')
    assert.ok((question.question as string).length > 0, 'the question text survives')
    assert.equal(typeof question.header, 'string')
    assert.ok((question.header as string).length > 0, 'the header survives')
    assert.ok(Array.isArray(question.options) && question.options.length > 0, 'the options survive')
  }
})

test('a question the user skipped is left unanswered', () => {
  // Fewer answers than questions, and an empty selection, both mean no choice
  // was made. An empty string would read to Claude as a real answer.
  const inner = answered(twoQuestions, [[]])
  assert.deepEqual((inner.updatedInput as { answers: unknown }).answers, {})
  const first = answered(twoQuestions, [['ralf']])
  assert.deepEqual((first.updatedInput as { answers: unknown }).answers, { 'Which repository?': 'ralf' })
})

test('extra answers cannot invent a question', () => {
  // The pairing is by index into the questions Claude sent, so a stray answer
  // has nothing to attach to and is dropped.
  const inner = answered([twoQuestions[0]], [['ralf'], ['a']])
  assert.deepEqual((inner.updatedInput as { answers: unknown }).answers, { 'Which repository?': 'ralf' })
  assert.equal((inner.updatedInput as { questions: unknown[] }).questions.length, 1)
})

test('a streamed block keeps its id when the finished message lands', () => {
  // The live part is published under a fixed id as deltas arrive. If the
  // completed message used a different one, the reply would appear twice —
  // once from the projection and once from the finished block.
  assert.equal(claudeStreamedPartId('msg-1', 'text', 1, 1, 0), 'msg-1-text')
  assert.equal(claudeStreamedPartId('msg-1', 'thinking', 0, 1, 0), 'msg-1-thinking')
})

test('only the first block of each kind takes the streamed id', () => {
  // The deltas carry no index, so a second thinking block cannot be told from
  // more of the first. Later blocks get their own ids and render separately.
  assert.equal(claudeStreamedPartId('msg-1', 'thinking', 2, 1, 0), 'msg-1-thinking-2')
  assert.equal(claudeStreamedPartId('msg-1', 'text', 3, 1, 0), 'msg-1-text-3')
})

test('thinking and text do not collide', () => {
  // Both are first in their own kind and both must survive: a turn that
  // thought and then answered has one of each.
  const thinking = claudeStreamedPartId('msg-1', 'thinking', 0, 1, 0)
  const text = claudeStreamedPartId('msg-1', 'text', 1, 1, 0)
  assert.notEqual(thinking, text)
})

test('a message with no thinking still ids its text', () => {
  // findIndex returns -1 when there is none, which must not match a real index.
  assert.equal(claudeStreamedPartId('msg-1', 'text', 0, 0, -1), 'msg-1-text')
  assert.equal(claudeStreamedPartId('msg-1', 'tool_use', 1, 0, -1), 'msg-1-tool_use-1')
})

/** Claude imports @shared as a value, an alias only the bundler resolves, so
 *  the class cannot be constructed here. Reading the source holds the wiring in
 *  place: the risk is the refusal going back to a prose string, and that is
 *  visible in the text. */
const backendSource = readFileSync(join(import.meta.dirname, 'claude-backend.ts'), 'utf8')

test('a send that arrives while Claude still holds its turn is refused as busy', () => {
  // Claude frees its turn slot at the result, a moment after main clears its
  // own busy flag on idle. A message sent in that gap passes main's check and
  // reaches the backend. Described in prose, the refusal looked like an
  // unrelated failure: the renderer queues only what it recognises as busy, so
  // it dropped the message and the text the user had typed was gone.
  const start = backendSource.indexOf('async sendMessage(')
  assert.ok(start > 0, 'expected a sendMessage method')
  const guard = backendSource.slice(start, backendSource.indexOf('const record =', start))
  assert.ok(
    /this\.runs\.has\(sessionId\)\)\s*throw new Error\(THREAD_BUSY_ERROR\)/.test(guard),
    'the busy refusal must throw THREAD_BUSY_ERROR so the renderer queues the message'
  )
  assert.ok(
    !/already working on this thread/.test(backendSource.slice(start, start + 400)),
    'the refusal must not be a prose string the renderer cannot classify'
  )
})

test('a refused message is never half-recorded', () => {
  // The guard runs before the transcript echo, so a message the backend would
  // not accept leaves no user bubble behind for a later reload to keep.
  const start = backendSource.indexOf('async sendMessage(')
  assert.ok(
    backendSource.indexOf('THREAD_BUSY_ERROR', start) < backendSource.indexOf('this.upsert(sessionId', start),
    'the busy guard must precede the transcript record'
  )
})
