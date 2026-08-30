import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { authorTone } from './author-tone.ts'

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
