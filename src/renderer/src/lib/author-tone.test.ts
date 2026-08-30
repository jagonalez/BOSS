import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { authorName, authorTone  } from './author-tone.ts'

test('the same name always draws the same colour', () => {
  // Nothing is stored, so an agent has to look the same in every session and
  // after every restart purely from its name.
  assert.equal(authorTone('builder'), authorTone('builder'))
  assert.equal(authorTone('Reviewer'), authorTone('Reviewer'))
})

test('BOSS keeps a colour of its own', () => {
  // It is the one name that is always the same agent, so it does not share
  // whatever its letters happen to land on.
  assert.equal(authorTone('boss'), 'one')
  assert.equal(authorTone('BOSS'), 'one')
})

test('another agent never takes the colour BOSS holds', () => {
  const others = ['builder', 'reviewer', 'planner', 'researcher', 'releaser', 'Codey']
  for (const name of others) {
    assert.notEqual(authorTone(name), 'one', `${name} must not look like BOSS`)
  }
})

test('a role the user renamed still gets a colour', () => {
  // Names are the user's own, so there is no fixed list to colour by hand.
  assert.ok(['two', 'three', 'four'].includes(authorTone('Codey McCodeface')))
})

test('a speaker is named in the words the user gave it', () => {
  // The transcript stores a role's id. Shown raw, an agent the user named
  // "Reviewer" was labelled "reviewer".
  const roles = [{ id: 'reviewer', label: 'Second pair of eyes' }]
  assert.equal(authorName('reviewer', roles), 'Second pair of eyes')
})

test('BOSS keeps its capitals even with no team to read', () => {
  assert.equal(authorName('boss'), 'BOSS')
  assert.equal(authorName('boss', []), 'BOSS')
})

test('a role the user deleted is still named, by its id', () => {
  // It spoke. A message with no name at all would be worse than one named
  // oddly.
  assert.equal(authorName('releaser', [{ id: 'builder', label: 'Builder' }]), 'releaser')
})
