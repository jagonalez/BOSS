import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const css = readFileSync(join(import.meta.dirname, '..', 'styles.css'), 'utf8')
/** Everything after the :root block, which is where the raw palette is allowed to live. */
const rules = css.slice(css.indexOf('\n}', css.indexOf(':root')))

/**
 * A colour written as a literal outside :root cannot follow the theme, so a light or
 * high-contrast theme keeps whatever the dark one was designed with. These are the only ones that
 * should stay: each draws something that is not a themed surface, and each says so in a comment.
 */
const ALLOWED = [
  // Frames a swatch of every theme, so it cannot take the current theme's colour.
  'rgba(127, 127, 127, 0.22)',
  'rgba(127, 127, 127, 0.18)',
  // Scrims over the user's own image and over the app behind a modal.
  'rgba(0, 0, 0, 0.7)',
  'rgba(0, 0, 0, 0.6)',
  // The checkerboard that means "transparent".
  'rgba(128, 128, 128, 0.12)',
  // The one white left: the ✕ on the dark scrim above, which is not a themed fill.
  '#fff'
]

test('colours outside :root come from the theme', () => {
  const literals = rules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9][^)]*\)/g) ?? []
  const unexpected = literals.filter((literal) => !ALLOWED.includes(literal))
  assert.deepEqual(unexpected, [], `these colours cannot follow the theme:\n  ${unexpected.join('\n  ')}`)
  // The allowance is a short list on purpose: if one stops being used, it should leave the list
  // rather than sit here licensing a future literal that happens to match.
  const white = literals.filter((literal) => literal === '#fff')
  assert.equal(white.length, 1, 'expected exactly one bare white, on the image scrim')
})

test('white ink is never painted straight onto a themed fill', () => {
  // Five of the six themes have an accent too pale to carry white text. The ink token picks a
  // colour per theme; a bare #fff on a var() fill is the bug this replaced.
  for (const fill of ['var(--accent)', 'var(--red)', 'var(--yellow)']) {
    const pattern = new RegExp(`background: ${fill.replace(/[()-]/g, '\\$&')};\\s*\\n\\s*color: #(fff|ffffff);`, 'i')
    assert.ok(!pattern.test(rules), `white ink is painted onto ${fill}; use the matching ink token`)
  }
})
