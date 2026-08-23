import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { THEMES, THEME_FAMILIES, normalizeUiDensity, normalizeUiFontSize, themeForPreference } from './themes.ts'

function rgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  assert.equal(clean.length, 6, `expected opaque six-digit color: ${hex}`)
  return [0, 2, 4].map((offset) => Number.parseInt(clean.slice(offset, offset + 2), 16)) as [number, number, number]
}

function luminance(hex: string): number {
  const channel = (value: number): number => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = rgb(hex).map(channel)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test('every theme family offers a real light and dark variant', () => {
  const ids = new Set(THEMES.map((theme) => theme.id))
  assert.equal(ids.size, THEMES.length, 'theme ids should be unique')

  for (const family of THEME_FAMILIES) {
    assert.ok(ids.has(family.light), `${family.id} is missing its light theme`)
    assert.ok(ids.has(family.dark), `${family.id} is missing its dark theme`)
    assert.equal(themeForPreference({ family: family.id, appearance: 'light' }).appearance, 'light')
    assert.equal(themeForPreference({ family: family.id, appearance: 'dark' }).appearance, 'dark')
  }
})

test('system appearance resolves within the selected family', () => {
  assert.equal(themeForPreference({ family: 'catppuccin', appearance: 'system' }, 'light').id, 'catppuccin-latte')
  assert.equal(themeForPreference({ family: 'catppuccin', appearance: 'system' }, 'dark').id, 'catppuccin-mocha')
  for (const [family, light, dark] of [
    ['gruvbox', 'gruvbox-light', 'gruvbox-dark'],
    ['everforest', 'everforest-light', 'everforest-dark'],
    ['kanagawa', 'kanagawa-lotus', 'kanagawa-wave'],
    ['ayu', 'ayu-light', 'ayu-dark']
  ] as const) {
    assert.equal(themeForPreference({ family, appearance: 'system' }, 'light').id, light)
    assert.equal(themeForPreference({ family, appearance: 'system' }, 'dark').id, dark)
  }
})

test('every theme gives diff text WCAG-readable contrast', () => {
  for (const theme of THEMES) {
    for (const [label, foreground, background] of [
      ['addition', theme.colors.diffAdditionText, theme.colors.diffAdditionBg],
      ['deletion', theme.colors.diffDeletionText, theme.colors.diffDeletionBg],
      ['hunk', theme.colors.diffHunkText, theme.colors.diffHunkBg]
    ] as const) {
      assert.ok(contrast(foreground, background) >= 4.5, `${theme.id} ${label} contrast is ${contrast(foreground, background).toFixed(2)}`)
    }
  }
})

test('every theme gives ink on a filled control WCAG-readable contrast', () => {
  // A primary button, an allow button, a mic indicator and a revert banner all draw text on top of
  // a filled accent, danger or warning. That ink used to be #fff for everyone, which failed on
  // every theme whose accent is a pale blue — boss-dark's was 2.53:1 against a required 4.5.
  for (const theme of THEMES) {
    for (const [fill, ink, name] of [
      [theme.colors.accent, theme.colors.accentInk, 'accent'],
      [theme.colors.danger, theme.colors.dangerInk, 'danger'],
      [theme.colors.warning, theme.colors.warningInk, 'warning']
    ] as const) {
      const ratio = contrast(ink, fill)
      assert.ok(ratio >= 4.5, `${theme.id} ${name}: ink ${ink} on ${fill} is ${ratio.toFixed(2)}:1, want >= 4.5`)
    }
  }
})

test('every theme names a backend hue', () => {
  // Badges and tabs drew the same agent in the same frozen hue, in two places. They now share a
  // token, so a theme that wants its own must be able to say so.
  for (const theme of THEMES) {
    for (const hue of [theme.colors.backendClaude, theme.colors.backendCodex, theme.colors.backendPi]) {
      assert.match(hue, /^#[0-9a-f]{6}$/i, `${theme.id} should name an opaque backend hue`)
    }
  }
})

test('appearance preferences fall back to their defaults on junk', () => {
  assert.equal(normalizeUiFontSize('large'), 'large')
  assert.equal(normalizeUiFontSize('enormous'), 'default')
  assert.equal(normalizeUiFontSize(null), 'default')
  assert.equal(normalizeUiDensity('compact'), 'compact')
  assert.equal(normalizeUiDensity('cramped'), 'comfortable')
  assert.equal(normalizeUiDensity(undefined), 'comfortable')
})
