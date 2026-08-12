import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { claudePermissionMode, claudePermissionResponse, parseClaudePermission } from './claude-protocol.ts'

test('maps R.A.L.F. modes to current Claude permission modes', () => {
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
