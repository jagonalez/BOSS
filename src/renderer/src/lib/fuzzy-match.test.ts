import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { bestFuzzyScore, fuzzyScore } from './fuzzy-match.ts'

test('a query missing a character in order does not match', () => {
  assert.equal(fuzzyScore('stngsx', 'Open Settings'), null)
  assert.equal(fuzzyScore('xyz', 'New Thread'), null)
})

test('matching is case-insensitive', () => {
  assert.notEqual(fuzzyScore('settings', 'Open Settings'), null)
  assert.notEqual(fuzzyScore('OPEN SETTINGS', 'open settings'), null)
})

test('an empty query matches neutrally so the palette lists before typing', () => {
  assert.equal(fuzzyScore('', 'Anything'), 0)
})

test('a word-start match outranks the same letters from mid-word', () => {
  const atWordStart = fuzzyScore('s', 'Settings open')
  const midWord = fuzzyScore('s', 'threads')
  assert.notEqual(atWordStart, null)
  assert.notEqual(midWord, null)
  assert.ok(atWordStart! > midWord!)
})

test('adjacent characters outrank scattered ones', () => {
  const adjacent = fuzzyScore('set', 'set')
  const scattered = fuzzyScore('set', 's om e t ext')
  assert.notEqual(adjacent, null)
  assert.notEqual(scattered, null)
  assert.ok(adjacent! > scattered!)
})

test('an exact prefix beats an infix match of the same query', () => {
  const prefix = fuzzyScore('new', 'New Thread')
  const infix = fuzzyScore('new', 'Renew subscription')
  assert.ok(prefix! > infix!)
})

test('spaces in the query are free, so multi-word queries work across words', () => {
  assert.notEqual(fuzzyScore('op set', 'Open Settings'), null)
  assert.equal(fuzzyScore('op x', 'Open Settings'), null)
})

test('camelCase boundaries count as word starts', () => {
  const camel = fuzzyScore('c', 'newChat')
  assert.notEqual(camel, null)
  assert.ok(camel! >= fuzzyScore('c', 'access')!)
})

test('bestFuzzyScore takes the highest field and null only when all miss', () => {
  assert.equal(bestFuzzyScore('zzz', ['Open Settings', 'theme preferences']), null)
  assert.ok(bestFuzzyScore('pref', ['Open Settings', 'theme preferences'])! > 0)
})
