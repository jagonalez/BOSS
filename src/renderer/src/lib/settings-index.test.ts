import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { SETTINGS_INDEX, searchSettings } from './settings-index.ts'

test('every word has to match, so a phrase narrows rather than widens', () => {
  const sizes = searchSettings('terminal size')
  assert.ok(sizes.length > 0, 'expected a match for "terminal size"')
  assert.ok(sizes.every((hit) => /size/i.test(hit.label)), 'a two-word query should not return everything mentioning a terminal')
})

test('a word in a title outranks the same word in a keyword', () => {
  const hits = searchSettings('theme')
  assert.equal(hits[0].label, 'Theme')
})

test('the settings people cannot find are findable', () => {
  // The three the audit called out: filed where nobody would look for them.
  assert.equal(searchSettings('terminal location')[0]?.section, 'worktrees')
  // "cli" legitimately means two things here — the runtime's own binary, and the `boss` command
  // — so it is enough that both are offered rather than that one wins.
  const cli = searchSettings('cli').map((hit) => hit.section)
  assert.ok(cli.includes('updates') && cli.includes('connections'), `expected both cli settings, saw ${cli}`)
  assert.equal(searchSettings('boss command')[0]?.section, 'updates')
  assert.equal(searchSettings('binary path')[0]?.section, 'connections')
  assert.equal(searchSettings('bot token')[0]?.section, 'telegram')
})

test('a word people use is found even when the label does not contain it', () => {
  assert.equal(searchSettings('font size')[0]?.section, 'appearance')
  assert.equal(searchSettings('quota')[0]?.section, 'usage')
  assert.equal(searchSettings('password')[0]?.section, 'mobile')
  assert.equal(searchSettings('dark')[0]?.section, 'appearance')
  assert.equal(searchSettings('system')[0]?.label, 'Theme')
  assert.equal(searchSettings('solarized')[0]?.label, 'Theme')
  assert.equal(searchSettings('gruvbox')[0]?.label, 'Theme')
  assert.equal(searchSettings('kanagawa')[0]?.label, 'Theme')
})

test('an empty query offers nothing rather than everything', () => {
  assert.deepEqual(searchSettings(''), [])
  assert.deepEqual(searchSettings('   '), [])
})

test('a query that matches nothing returns nothing', () => {
  assert.deepEqual(searchSettings('xyzzy'), [])
})

test('every section in the sidebar has at least one entry', () => {
  // A section with nothing indexed is unreachable by search, which is worse than not shipping it.
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'SettingsModal.tsx'), 'utf8')
  const groups = source.slice(source.indexOf('const SETTINGS_GROUPS'), source.indexOf('function resetDescription'))
  const sections = [...groups.matchAll(/id: '([a-z]+)'/g)].map((match) => match[1])
  assert.ok(sections.length >= 9, `expected to find the section list, saw ${sections.length}`)
  for (const section of sections) {
    assert.ok(
      SETTINGS_INDEX.some((entry) => entry.section === section),
      `section "${section}" has no indexed setting, so nothing in it can be searched for`
    )
  }
})

test('every indexed entry points at a section that exists', () => {
  // The other direction: an entry naming a section that was renamed would go nowhere.
  const source = readFileSync(join(import.meta.dirname, '..', 'components', 'SettingsModal.tsx'), 'utf8')
  const groups = source.slice(source.indexOf('const SETTINGS_GROUPS'), source.indexOf('function resetDescription'))
  const sections = new Set([...groups.matchAll(/id: '([a-z]+)'/g)].map((match) => match[1]))
  for (const entry of SETTINGS_INDEX) {
    assert.ok(sections.has(entry.section), `"${entry.label}" points at "${entry.section}", which is not a section`)
  }
})
