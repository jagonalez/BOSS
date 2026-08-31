import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The one warning that is hidden, and everything that is not.
 *
 *  The agent SDK warns that a named tool is approved before the permission
 *  callback runs. That is true and intended here: the list holds this app's own
 *  tools, which an agent uses without asking. The user's approval still covers
 *  editing files and running commands, which are not on the list.
 *
 *  It printed several hundred lines per run and buried the output people read
 *  while debugging. */
test('only the known SDK warning is hidden', () => {
  const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
  assert.match(source, /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/, 'the filter names one warning')
  // Wrapping the emitter, not listening for the event. A listener does not
  // replace Node's own printing: the warning still appeared, and every other
  // warning appeared twice.
  assert.match(source, /process\.emitWarning = /, 'the emitter is wrapped')
  assert.doesNotMatch(
    source,
    /process\.on\('warning'/,
    'a listener would not silence anything'
  )
})
