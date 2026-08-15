import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { threadContextPrompt } from './thread-context.ts'

test('a thread is told its project and where the files are', () => {
  const prompt = threadContextPrompt({
    projectName: 'autofix',
    projectPath: '/Users/jeremy/dev/autofix',
    executionPath: '/Users/jeremy/dev/autofix'
  })
  assert.match(prompt, /working in the autofix project/)
  assert.match(prompt, /\/Users\/jeremy\/dev\/autofix/)
})

test('a worktree says so, and says which branch', () => {
  // The case that caused the trouble: an agent that misses this reasons about
  // the main checkout while working in a second one.
  const prompt = threadContextPrompt({
    projectName: 'ralf',
    projectPath: '/Users/jeremy/dev/ralf',
    executionPath: '/Users/jeremy/dev/ralf/.worktrees/emoji',
    branch: 'no-ticket/chat-emoji-clean',
    worktree: true
  })
  assert.match(prompt, /Git worktree on the no-ticket\/chat-emoji-clean branch/)
  assert.match(prompt, /not the main checkout/)
  // The worktree path, not the project root: that is where the agent runs.
  assert.match(prompt, /\.worktrees\/emoji/)
})

test('a thread on the main checkout names its branch without the worktree wording', () => {
  const prompt = threadContextPrompt({ projectName: 'ralf', projectPath: '/src/ralf', branch: 'main' })
  assert.match(prompt, /on the main branch/)
  assert.doesNotMatch(prompt, /worktree/)
})

test('a chat with no project is told nothing', () => {
  // Better silence than a paragraph explaining it has no project.
  assert.equal(threadContextPrompt({}), '')
})

test('the agent is told to take it as given', () => {
  // Without this it still reasons about which repository it is in, which is
  // what it did when it guessed from a browser tab.
  const prompt = threadContextPrompt({ projectName: 'ralf', projectPath: '/src/ralf' })
  assert.match(prompt, /rather than working it out/)
})
