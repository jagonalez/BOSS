import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { claudePermissionMode, claudePermissionResponse, claudeQuestionResponse, parseClaudePermission, parseClaudeQuestions } from './claude-protocol.ts'

test('maps BOSS modes to current Claude permission modes', () => {
  assert.equal(claudePermissionMode('ask'), 'manual')
  assert.equal(claudePermissionMode('accept-edits'), 'acceptEdits')
  assert.equal(claudePermissionMode('auto'), 'auto')
  assert.equal(claudePermissionMode('plan'), 'plan')
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
