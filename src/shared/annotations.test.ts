import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires explicit extensions.
// @ts-expect-error Application code uses bundler resolution.
import { MAX_QUOTE_LENGTH, annotationsPrompt, clampQuote, composeAnnotatedPrompt, createAnnotation, isAnnotatableSelection, remainingAnnotations, sideChatSeedPrompt, stripAnchors, type Annotation } from './annotations.ts'

const anchor = { messageId: 'msg-1', start: 4, end: 12 }

test('a quote keeps its line breaks so code and lists survive the round trip', () => {
  const quote = clampQuote('function add(a, b) {\n  return a + b\n}')
  assert.equal(quote, 'function add(a, b) {\n  return a + b\n}')
})

test('trailing whitespace and blank edges are tidied without joining lines', () => {
  assert.equal(clampQuote('\n\nfirst   \n  second  \n\n'), 'first\n  second')
})

test('carriage returns normalise so a Windows-sourced selection quotes cleanly', () => {
  assert.equal(clampQuote('first\r\nsecond'), 'first\nsecond')
})

test('a select-all is clamped so it cannot flood the prompt', () => {
  const quote = clampQuote('x'.repeat(MAX_QUOTE_LENGTH * 2))
  assert.equal(quote.length, MAX_QUOTE_LENGTH + 1)
  assert.ok(quote.endsWith('…'), 'the clamp marks that it cut the quote')
})

test('a quote at exactly the limit is not marked as cut', () => {
  const quote = clampQuote('x'.repeat(MAX_QUOTE_LENGTH))
  assert.equal(quote.length, MAX_QUOTE_LENGTH)
  assert.ok(!quote.endsWith('…'))
})

test('only a selection with visible text is worth annotating', () => {
  assert.ok(isAnnotatableSelection('a passage'))
  assert.ok(!isAnnotatableSelection('   \n  '), 'a mis-drag across a margin is not an annotation')
  assert.ok(!isAnnotatableSelection(''))
})

test('a new annotation clamps its quote and remembers where it came from', () => {
  const annotation = createAnnotation('a1', '  spaced  ', anchor, 'my note')
  assert.equal(annotation.quote, 'spaced')
  assert.equal(annotation.note, 'my note')
  assert.deepEqual(annotation.anchor, anchor)
})

test('an annotation starts with no note, because the quote alone is a reference', () => {
  assert.equal(createAnnotation('a1', 'text', anchor).note, '')
})

test('the prompt quotes the model back to itself, then adds the note', () => {
  const prompt = annotationsPrompt([{ id: 'a1', quote: 'the claim', note: 'why?' }])
  assert.match(prompt, /^Annotations on your earlier output/)
  assert.ok(prompt.includes('> the claim'), 'the quote is a blockquote')
  assert.ok(prompt.includes('why?'))
  assert.ok(prompt.indexOf('> the claim') < prompt.indexOf('why?'), 'quote precedes the note')
})

test('every line of a multi-line quote is marked as quoted', () => {
  const prompt = annotationsPrompt([{ id: 'a1', quote: 'first\nsecond', note: '' }])
  assert.ok(prompt.includes('> first\n> second'), 'a bare second line would read as the note')
})

test('several annotations are all carried, in the order they were made', () => {
  const prompt = annotationsPrompt([
    { id: 'a1', quote: 'first claim', note: 'one' },
    { id: 'a2', quote: 'second claim', note: 'two' }
  ])
  assert.ok(prompt.indexOf('first claim') < prompt.indexOf('second claim'))
  assert.ok(prompt.includes('one') && prompt.includes('two'))
})

test('nothing to say produces nothing, so callers can concatenate blindly', () => {
  assert.equal(annotationsPrompt([]), '')
  assert.equal(annotationsPrompt([{ id: 'a1', quote: '   ', note: 'note' }]), '')
})

test('annotations and typed text combine, annotations first', () => {
  const composed = composeAnnotatedPrompt(
    [{ id: 'a1', quote: 'the claim', note: 'why?' }],
    'also, what about the edge case?'
  )
  assert.ok(composed.includes('> the claim'))
  assert.ok(composed.indexOf('> the claim') < composed.indexOf('also, what about'))
})

test('annotations alone are a complete message', () => {
  const composed = composeAnnotatedPrompt([{ id: 'a1', quote: 'the claim', note: 'why?' }], '   ')
  assert.ok(composed.includes('> the claim'))
  assert.ok(!composed.endsWith('\n'), 'no dangling separator where the typed text would go')
})

test('typed text alone is untouched by the annotation machinery', () => {
  assert.equal(composeAnnotatedPrompt([], '  just a question  '), 'just a question')
})

test('sending drops anchors, because the rendering they point into is superseded', () => {
  const annotations: Annotation[] = [
    { id: 'a1', quote: 'one', note: 'first', anchor },
    { id: 'a2', quote: 'two', note: 'second', anchor: { ...anchor, messageId: 'msg-2' } }
  ]
  const sent = stripAnchors(annotations)
  assert.ok(
    sent.every((item) => item.anchor === undefined),
    'a sent annotation keeps no position'
  )
  assert.deepEqual(
    sent.map((item) => [item.id, item.quote, item.note]),
    [
      ['a1', 'one', 'first'],
      ['a2', 'two', 'second']
    ],
    'everything except the anchor survives'
  )
})

test('stripping anchors does not mutate the drafts still on screen', () => {
  const annotations: Annotation[] = [{ id: 'a1', quote: 'one', note: 'first', anchor }]
  stripAnchors(annotations)
  assert.deepEqual(annotations[0].anchor, anchor, 'the highlight is still anchored while composing')
})

test('a side chat seeded from a note points at the passage and carries the note', () => {
  const seed = sideChatSeedPrompt({ id: 'a1', quote: 'the claim', note: 'is this right?' })
  assert.ok(seed.includes('> the claim'))
  assert.ok(seed.includes('is this right?'))
})

test('a side chat seeded from a bare highlight still names what it is about', () => {
  const seed = sideChatSeedPrompt({ id: 'a1', quote: 'the claim', note: '' })
  assert.ok(seed.includes('> the claim'))
  assert.ok(/focus on this part/i.test(seed), 'the opening line stands in for the missing note')
})

test('a send clears only the annotations it actually carried', () => {
  // The user highlights something else while the send is awaiting the backend.
  // That highlight belongs to the next prompt, so it must survive.
  const current: Annotation[] = [
    { id: 'a1', quote: 'sent one', note: '' },
    { id: 'a2', quote: 'added mid-send', note: '' }
  ]
  assert.deepEqual(
    remainingAnnotations(current, ['a1']).map((item) => item.id),
    ['a2']
  )
})

test('a send that carried everything leaves nothing behind', () => {
  const current: Annotation[] = [{ id: 'a1', quote: 'one', note: '' }]
  assert.deepEqual(remainingAnnotations(current, ['a1']), [])
})

test('clearing ids that are no longer present is harmless', () => {
  const current: Annotation[] = [{ id: 'a2', quote: 'two', note: '' }]
  assert.deepEqual(
    remainingAnnotations(current, ['a1']).map((item) => item.id),
    ['a2']
  )
})
