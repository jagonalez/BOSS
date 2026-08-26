import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Application code uses bundler resolution.
import { ImageStore } from './image-store.ts'

// A one-pixel PNG, so the bytes written are a real image rather than a string.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function store() {
  return new ImageStore(mkdtempSync(join(tmpdir(), 'boss-images-')))
}

test('a stored image reads back through the url it was given', () => {
  const images = store()
  const written = images.write('thread-1', 'image/png', PNG)
  assert.ok(written)
  assert.match(written.url, /^boss-image:\/\/thread-1\//)
  assert.equal(written.mime, 'image/png')

  const read = images.read(written.url)
  assert.ok(read)
  assert.equal(read.mime, 'image/png')
  assert.deepEqual(read.data, Buffer.from(PNG, 'base64'))
})

test('storing a native-history replay reuses the live image', () => {
  const images = store()
  const live = images.write('thread-1', 'image/png', PNG)
  const history = images.write('thread-1', 'image/png', PNG)

  assert.ok(live)
  assert.deepEqual(history, live)
})

test('a url pointing outside the store reads nothing', () => {
  // The host and path come from the renderer, so escaping has to fail here
  // rather than reach the filesystem. A real file is planted where the escape
  // lands, so the guard is what stops the read rather than the file's absence.
  const root = mkdtempSync(join(tmpdir(), 'boss-images-'))
  const images = new ImageStore(join(root, 'images'))
  writeFileSync(join(root, 'secret.png'), Buffer.from(PNG, 'base64'))

  assert.equal(images.read('boss-image://../secret.png'), undefined)
  assert.equal(images.read('file:///etc/passwd'), undefined)
  assert.equal(images.read('not a url'), undefined)
})

test('a type with no image behind it is not stored', () => {
  const images = store()
  assert.equal(images.write('thread-1', 'application/pdf', PNG), undefined)
  assert.equal(images.write('thread-1', 'text/html', PNG), undefined)
})

test('forgetting a thread removes the images it owned', () => {
  const images = store()
  const written = images.write('thread-1', 'image/png', PNG)
  assert.ok(written)
  const other = images.write('thread-2', 'image/png', PNG)
  assert.ok(other)

  images.forget('thread-1')

  assert.equal(images.read(written.url), undefined)
  // Only that thread's: another thread's images are untouched.
  assert.ok(images.read(other.url))
})

test('forgetting cannot be aimed outside the store', () => {
  const root = mkdtempSync(join(tmpdir(), 'boss-images-'))
  const outside = join(root, 'keep.txt')
  writeFileSync(outside, 'keep')
  const images = new ImageStore(join(root, 'images'))

  images.forget('..')

  assert.ok(existsSync(outside))
})
