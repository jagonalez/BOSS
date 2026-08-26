import assert from 'node:assert/strict'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { codexToolOutput } from './codex-tool-output.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('custom tool output preserves interleaved snake-case text and images', () => {
  assert.deepEqual(codexToolOutput([
    { type: 'input_text', text: 'Before.' },
    { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'high' },
    { type: 'input_text', text: 'Between.' },
    { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    { type: 'input_text', text: 'After.' }
  ]), [
    { type: 'text', text: 'Before.' },
    { type: 'image', mimeType: 'image/png', data: PNG },
    { type: 'text', text: 'Between.' },
    { type: 'image', mimeType: 'image/png', data: PNG },
    { type: 'text', text: 'After.' }
  ])
})

test('camel-case dynamic output uses the same image path', () => {
  assert.deepEqual(codexToolOutput([
    { type: 'inputText', text: 'Result' },
    { type: 'inputImage', imageUrl: `data:image/png;base64,${PNG}` }
  ]), [
    { type: 'text', text: 'Result' },
    { type: 'image', mimeType: 'image/png', data: PNG }
  ])
})

test('unsafe image URLs and formats become explanations without exposing their payloads', () => {
  const svg = 'PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4='
  const result = codexToolOutput([
    { type: 'input_image', image_url: 'https://example.com/private.png?token=secret' },
    { type: 'input_image', image_url: `data:image/svg+xml;base64,${svg}` }
  ])

  assert.deepEqual(result, [
    { type: 'text', text: '[Image omitted: Codex returned a non-embedded image URL.]' },
    { type: 'text', text: '[Image omitted: image/svg+xml is not a supported image format.]' }
  ])
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.ok(!JSON.stringify(result).includes(svg))
})

test('text-only arrays keep the existing compact output', () => {
  assert.equal(codexToolOutput([
    { type: 'input_text', text: 'One' },
    { type: 'input_text', text: 'Two' }
  ]), 'One\nTwo')
})
