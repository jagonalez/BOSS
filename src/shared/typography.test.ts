import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { DEFAULT_TYPOGRAPHY, MONO_FONTS, READING_SIZE, TERMINAL_SIZE, UI_FONTS, clampSize, monoFontStack, stepSize, typographyOrDefault, typographyTokens, uiFontStack } from './typography.ts'

test('a size is held inside its range', () => {
  assert.equal(clampSize(READING_SIZE, 4), READING_SIZE.min)
  assert.equal(clampSize(READING_SIZE, 99), READING_SIZE.max)
  assert.equal(clampSize(READING_SIZE, 16), 16)
  // Half a point is a real step at these sizes, so it survives.
  assert.equal(clampSize(READING_SIZE, 14.5), 14.5)
  assert.equal(clampSize(READING_SIZE, 14.7), 14.5)
})

test('a size that is not a number falls back rather than propagating NaN', () => {
  assert.equal(clampSize(READING_SIZE, Number.NaN), READING_SIZE.default)
  assert.equal(clampSize(READING_SIZE, Number.POSITIVE_INFINITY), READING_SIZE.default)
})

test('stepping holds at the ends instead of wrapping', () => {
  assert.equal(stepSize(READING_SIZE, READING_SIZE.max, 1), READING_SIZE.max)
  assert.equal(stepSize(READING_SIZE, READING_SIZE.min, -1), READING_SIZE.min)
  assert.equal(stepSize(READING_SIZE, 15, 1), 16)
  assert.equal(stepSize(READING_SIZE, 15, -1), 14)
})

test('the terminal and the conversation have their own ranges', () => {
  // A terminal is scanned in columns and runs smaller than prose read continuously.
  assert.ok(TERMINAL_SIZE.default < READING_SIZE.default)
  assert.ok(TERMINAL_SIZE.min < READING_SIZE.min)
})

test('every offered face falls through to the system stack behind it', () => {
  // Nothing here is bundled, so a machine without the face still has to draw something.
  for (const font of UI_FONTS) assert.match(font.stack, /-apple-system|BlinkMacSystemFont/)
  for (const font of MONO_FONTS) assert.match(font.stack, /ui-monospace|SF Mono/)
})

test('an unknown face resolves to the system stack', () => {
  assert.equal(uiFontStack('no-such-font'), UI_FONTS[0].stack)
  assert.equal(monoFontStack('no-such-font'), MONO_FONTS[0].stack)
})

test('stored settings survive a round trip', () => {
  const stored = { uiFont: 'inter', monoFont: 'fira-code', readingSize: 17, terminalSize: 15 }
  assert.deepEqual(typographyOrDefault(stored), stored)
})

test('a stored value the app no longer offers falls back', () => {
  const read = typographyOrDefault({ uiFont: 'comic-sans', monoFont: 'wingdings', readingSize: 900, terminalSize: -4 })
  assert.equal(read.uiFont, DEFAULT_TYPOGRAPHY.uiFont)
  assert.equal(read.monoFont, DEFAULT_TYPOGRAPHY.monoFont)
  assert.equal(read.readingSize, READING_SIZE.max)
  assert.equal(read.terminalSize, TERMINAL_SIZE.min)
})

test('nothing stored is the default', () => {
  assert.deepEqual(typographyOrDefault(undefined), DEFAULT_TYPOGRAPHY)
  assert.deepEqual(typographyOrDefault(null), DEFAULT_TYPOGRAPHY)
  assert.deepEqual(typographyOrDefault('not an object'), DEFAULT_TYPOGRAPHY)
})

test('the tokens name only the two things that resize', () => {
  const tokens = typographyTokens(DEFAULT_TYPOGRAPHY)
  assert.deepEqual(Object.keys(tokens).sort(), ['--font-mono', '--font-ui', '--type-reading', '--type-terminal'])
  // Chrome keeps the sizes it was designed at: a reading size must never move a row height.
  for (const chrome of ['--type-control', '--type-label', '--type-meta', '--type-body']) {
    assert.ok(!(chrome in tokens), `${chrome} is chrome and must not follow the reading size`)
  }
})
