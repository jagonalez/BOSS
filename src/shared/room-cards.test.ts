import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { lineMark, parseCard, splitCards } from './room-cards.ts'

test('a card carries a kind, a title, its lines, and what to do', () => {
  const card = parseCard(['kind: gate', 'title: Ready to ship', '11 files changed', 'do: Ship it', 'do: Hold'].join('\n'))
  assert.equal(card?.kind, 'gate')
  assert.equal(card?.title, 'Ready to ship')
  assert.deepEqual(card?.lines, ['11 files changed'])
  assert.deepEqual(card?.actions, ['Ship it', 'Hold'])
})

test('a card offers at most two things to do', () => {
  // One way forward and one way out. More than that turns a decision into a
  // form, and a form is what the old surfaces were.
  const card = parseCard(['title: Pick', 'do: One', 'do: Two', 'do: Three', 'do: Four'].join('\n'))
  assert.deepEqual(card?.actions, ['One', 'Two'])
})

test('extra actions do not throw the whole card away', () => {
  // Dropping the card over one extra button would lose the message with it.
  const card = parseCard(['title: Pick', 'do: One', 'do: Two', 'do: Three'].join('\n'))
  assert.equal(card?.title, 'Pick')
})

test('a card with no title is not a card', () => {
  // Without one there is nothing to set apart from the prose, and the text is
  // better left as the agent wrote it.
  assert.equal(parseCard('kind: gate\nsome words'), undefined)
  assert.equal(parseCard(''), undefined)
})

test('an unknown kind falls back to a plain note rather than being refused', () => {
  const card = parseCard('kind: explosion\ntitle: Something')
  assert.equal(card?.kind, 'note')
})

test('a card can link the thread it names', () => {
  // BOSS quotes another room, and this is how the user gets to it rather than
  // being told where to look.
  const card = parseCard('title: Reviewed\nopen: Saved searches@thread-42')
  assert.deepEqual(card?.link, { label: 'Saved searches', threadId: 'thread-42' })
})

test('a link with no thread id is dropped, not half-rendered', () => {
  const card = parseCard('title: Reviewed\nopen: Saved searches')
  assert.equal(card?.link, undefined)
})

test('a message with no card is left exactly as written', () => {
  const segments = splitCards('Just some prose.')
  assert.deepEqual(segments, [{ type: 'text', text: 'Just some prose.' }])
})

test('prose and cards keep the order the agent wrote them in', () => {
  // An agent explains a card before or after it, so reordering would separate
  // the two.
  const text = 'Before.\n```boss-card\ntitle: A card\n```\nAfter.'
  const segments = splitCards(text)
  assert.deepEqual(segments.map((segment) => segment.type), ['text', 'card', 'text'])
  assert.match(String(segments[0].text), /Before/)
  assert.match(String(segments[2].text), /After/)
})

test('a malformed card stays visible as text', () => {
  // An agent that writes a broken card must still be readable. Swallowing it
  // would lose whatever it was trying to say.
  const text = 'Look:\n```boss-card\nkind: gate\nno title here\n```'
  const segments = splitCards(text)
  assert.deepEqual(segments.map((segment) => segment.type), ['text'])
  assert.match(String(segments[0].text), /no title here/)
})

test('two cards in one message both render', () => {
  const text = '```boss-card\ntitle: One\n```\n```boss-card\ntitle: Two\n```'
  const segments = splitCards(text)
  assert.deepEqual(segments.map((segment) => segment.card?.title), ['One', 'Two'])
})

test('a line says whether it is done, off plan, or waiting', () => {
  assert.deepEqual(lineMark('✓ tests passed'), { mark: 'done', text: 'tests passed' })
  assert.deepEqual(lineMark('≠ capped at 50'), { mark: 'gap', text: 'capped at 50' })
  assert.deepEqual(lineMark('○ scroll position'), { mark: 'waiting', text: 'scroll position' })
  assert.deepEqual(lineMark('just a line'), { text: 'just a line' })
})

test('a title containing a colon survives', () => {
  const card = parseCard('title: Ready: ship it')
  assert.equal(card?.title, 'Ready: ship it')
})
