import assert from 'node:assert/strict'
import test from 'node:test'
import { asUrl } from './browse-guests.ts'

test('a url is left alone', () => {
  assert.equal(asUrl('https://example.com'), 'https://example.com')
  assert.equal(asUrl('http://example.com/path?q=1'), 'http://example.com/path?q=1')
})

test('a hostname gets https', () => {
  assert.equal(asUrl('example.com'), 'https://example.com')
  assert.equal(asUrl('example.com/path'), 'https://example.com/path')
  assert.equal(asUrl('sub.example.co.uk'), 'https://sub.example.co.uk')
})

test('localhost and bare addresses stay on http', () => {
  // Nothing is listening on https at a dev port, and defaulting to it means a
  // certificate error rather than the page you meant.
  assert.equal(asUrl('localhost:5173'), 'http://localhost:5173')
  assert.equal(asUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080')
})

test('anything else is a search', () => {
  assert.equal(asUrl('electron webview'), 'https://www.google.com/search?q=electron%20webview')
  assert.equal(asUrl('typescript'), 'https://www.google.com/search?q=typescript')
  // A dot is not enough when there are spaces around it: this is a sentence,
  // not a host.
  assert.equal(asUrl('what is node.js'), 'https://www.google.com/search?q=what%20is%20node.js')
})
