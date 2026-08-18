import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { claudeExitError, claudeMessageContent, claudePermissionMode, claudePermissionResponse, claudeQuestionResponse, claudeResultError, claudeStreamedPartId, parseClaudePermission, parseClaudeQuestions } from './claude-protocol.ts'

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
  assert.equal(claudePermissionMode('ask'), 'manual')
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
  assert.equal(claudeExitError(1, 'Process failure'), 'Process failure')
  assert.equal(claudeExitError(1, '', false), 'Claude Code exited with 1.')
  assert.equal(claudeExitError(1, 'Expected interrupt', true), undefined)
  assert.equal(claudeExitError(0, ''), undefined)
})

test('parses Claude tool requests and builds once, always, and deny responses', () => {
  const suggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'WebSearch' }] }
  const permission = parseClaudePermission({
    type: 'control_request',
    request_id: 'permission-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'WebSearch',
      input: { query: 'current pricing' },
      title: 'Search the web',
      tool_use_id: 'tool-1',
      permission_suggestions: [suggestion]
    }
  })
  assert.deepEqual(permission, {
    requestId: 'permission-1',
    toolName: 'WebSearch',
    input: { query: 'current pricing' },
    suggestions: [suggestion],
    title: 'Search the web',
    description: undefined,
    displayName: undefined,
    toolUseId: 'tool-1'
  })
  assert.equal((claudePermissionResponse('permission-1', permission!, 'once').response as { response: { behavior: string } }).response.behavior, 'allow')
  const always = claudePermissionResponse('permission-1', permission!, 'always')
  assert.deepEqual((always.response as { response: { updatedPermissions: unknown[] } }).response.updatedPermissions, [suggestion])
  assert.equal((claudePermissionResponse('permission-1', permission!, 'reject').response as { response: { behavior: string } }).response.behavior, 'deny')
})

test('an AskUserQuestion request is read as questions, not a tool approval', () => {
  // It arrives as an ordinary permission request. Shown as one, the question
  // was invisible and denying it reported a dismissal the user never made.
  const request = parseClaudePermission({
    type: 'control_request',
    request_id: 'ask-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Which repository?',
          header: 'Repo',
          options: [{ label: 'ralf', description: 'the page in your browser' }, { label: 'autofix' }],
          multiSelect: false
        }]
      }
    }
  })
  const questions = parseClaudeQuestions(request!)
  assert.equal(questions?.length, 1)
  assert.equal(questions?.[0].question, 'Which repository?')
  assert.equal(questions?.[0].header, 'Repo')
  assert.deepEqual(questions?.[0].options.map((option) => option.label), ['ralf', 'autofix'])
  assert.equal(questions?.[0].options[0].description, 'the page in your browser')
  assert.equal(questions?.[0].multiple, false)
})

test('any other tool is left as a permission request', () => {
  const request = parseClaudePermission({
    type: 'control_request',
    request_id: 'perm-1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } }
  })
  assert.equal(parseClaudeQuestions(request!), undefined)
})

test('a malformed question falls back to the permission prompt', () => {
  // Better an "allow this tool?" prompt than an empty dialog with no way out.
  const ask = (input: unknown) => parseClaudeQuestions(parseClaudePermission({
    type: 'control_request',
    request_id: 'ask-2',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input }
  })!)
  assert.equal(ask({}), undefined)
  assert.equal(ask({ questions: 'why' }), undefined)
  assert.equal(ask({ questions: [] }), undefined)
  assert.equal(ask({ questions: [{ question: '   ' }] }), undefined)
})

test('a question with no options still reaches the user', () => {
  // An open question is a question. Dropping it would hang the thread.
  const questions = parseClaudeQuestions(parseClaudePermission({
    type: 'control_request',
    request_id: 'ask-3',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'What should I name it?' }] } }
  })!)
  assert.equal(questions?.length, 1)
  assert.deepEqual(questions?.[0].options, [])
})

test('answers go back as the tool result Claude is waiting for', () => {
  const response = claudeQuestionResponse('ask-1', [['ralf'], ['a', 'b']])
  const inner = (response.response as Record<string, unknown>).response as Record<string, unknown>
  assert.equal(inner.behavior, 'allow', 'a question is answered, not denied')
  assert.deepEqual(inner.updatedInput, { questions: [{ answers: ['ralf'] }, { answers: ['a', 'b'] }] })
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
    /this\.processes\.has\(sessionId\)\)\s*throw new Error\(THREAD_BUSY_ERROR\)/.test(guard),
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
