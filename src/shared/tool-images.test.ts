import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { mcpToolResultContent, toolResultImage, isDisplayableImageMime, DISPLAYABLE_IMAGE_MIMES } from './qa.ts'

// A one-pixel PNG, so the payload is a real image rather than a placeholder.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('an MCP image block becomes an image rather than stringified base64', () => {
  const { text, image } = mcpToolResultContent([
    { type: 'text', text: 'Here is the chart.' },
    { type: 'image', data: PNG, mimeType: 'image/png' }
  ])
  assert.equal(text, 'Here is the chart.')
  assert.deepEqual(image, { mimeType: 'image/png', data: PNG })
  // The regression this guards: the base64 must not reach the transcript text.
  assert.ok(!text.includes(PNG))
})

test('an image-only MCP result still carries the image', () => {
  const { text, image } = mcpToolResultContent([{ type: 'image', data: PNG, mimeType: 'image/png' }])
  assert.equal(text, '')
  assert.equal(image?.data, PNG)
})

test('an MCP image in a format BOSS cannot show is described, not dropped', () => {
  const { text, image } = mcpToolResultContent([{ type: 'image', data: PNG, mimeType: 'image/tiff' }])
  assert.equal(image, undefined)
  assert.match(text, /image\/tiff/)
  assert.ok(!text.includes(PNG), 'the base64 must not be printed as text')
})

test('only the first image is carried and the rest are named', () => {
  const { image, text } = mcpToolResultContent([
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'image', data: PNG, mimeType: 'image/gif' }
  ])
  assert.equal(image?.mimeType, 'image/png')
  assert.match(text, /Additional image\/gif image omitted/)
  assert.ok(!text.includes(PNG))
})

test('a text-only MCP result is unchanged and carries no image', () => {
  const { text, image } = mcpToolResultContent([
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' }
  ])
  assert.equal(text, 'first\nsecond')
  assert.equal(image, undefined)
})

test('an unknown block keeps its old stringified behaviour', () => {
  const { text } = mcpToolResultContent([{ type: 'resource_link', uri: 'file:///x' }])
  assert.match(text, /resource_link/)
})

test('a malformed image block is not mistaken for an image', () => {
  // No data, and a non-string mime: neither shape is satisfied.
  const { image } = mcpToolResultContent([{ type: 'image', mimeType: 'image/png' }])
  assert.equal(image, undefined)
})

test('a Claude tool_result image block is recognised in its nested shape', () => {
  const found = toolResultImage({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG }
  })
  assert.deepEqual(found, { mimeType: 'image/png', data: PNG })
})

test('an MCP-shaped image block is recognised by the same reader', () => {
  const found = toolResultImage({ type: 'image', data: PNG, mimeType: 'image/webp' })
  assert.deepEqual(found, { mimeType: 'image/webp', data: PNG })
})

test('a text block is not an image', () => {
  assert.equal(toolResultImage({ type: 'text', text: 'hello' }), undefined)
  assert.equal(toolResultImage(null), undefined)
  assert.equal(toolResultImage('string'), undefined)
})

test('the displayable list matches what the image store actually accepts', async () => {
  // The store repeats this list rather than importing it, because the test
  // runner does not resolve the @shared alias there. Asserting against the
  // real store is what stops the copy drifting: a mime allowed here but
  // rejected on disk would render as a broken image, which is the whole bug.
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // @ts-expect-error Application code uses bundler resolution.
  const { ImageStore } = await import('../main/image-store.ts')
  const store = new ImageStore(mkdtempSync(join(tmpdir(), 'boss-mime-')))

  for (const mime of DISPLAYABLE_IMAGE_MIMES) {
    assert.ok(isDisplayableImageMime(mime), `${mime} should be displayable`)
    assert.ok(store.write('thread-mime', mime, PNG), `the store should accept ${mime}`)
  }
  for (const mime of ['image/tiff', 'application/pdf', 'image/svg+xml']) {
    assert.ok(!isDisplayableImageMime(mime), `${mime} should not be displayable`)
    assert.equal(store.write('thread-mime', mime, PNG), undefined, `the store should reject ${mime}`)
  }
})
