import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { applyProfilePresets, configFromEnv, loadDotEnv } from './lab-config.ts'

function withEnv(run: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LAB_')) saved[key] = process.env[key]
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LAB_')) delete process.env[key]
  }
  try {
    run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LAB_')) delete process.env[key]
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('no profile defaults to the cloud tier', () => {
  withEnv(() => {
    const config = configFromEnv()
    assert.equal(config.tools, 'all')
    assert.equal(config.contextChars, 80_000)
    assert.equal(config.maxToolIterations, 32)
  })
})

test('local profile picks lean tools and a small context', () => {
  withEnv(() => {
    process.env.LAB_PROFILE = 'local'
    const config = configFromEnv()
    assert.equal(config.tools, 'core')
    assert.equal(config.contextChars, 12_000)
    assert.equal(config.maxToolIterations, 32)
  })
})

test('go profile points at OpenCode Zen with DeepSeek V4 Flash', () => {
  withEnv(() => {
    process.env.LAB_PROFILE = 'go'
    const config = configFromEnv()
    assert.equal(config.baseUrl, 'https://opencode.ai/zen/go/v1')
    assert.equal(config.defaultModel, 'deepseek-v4-flash')
    assert.equal(config.tools, 'all')
    assert.equal(config.maxToolIterations, 32)
  })
})

test('explicit env vars beat profile defaults', () => {
  withEnv(() => {
    process.env.LAB_PROFILE = 'go'
    process.env.LAB_MODEL = 'my-model'
    const config = configFromEnv()
    assert.equal(config.defaultModel, 'my-model')
  })
})

test('applyProfilePresets returns the resolved profile name', () => {
  withEnv(() => {
    assert.equal(applyProfilePresets('local'), 'local')
    assert.equal(applyProfilePresets('nonsense'), 'cloud')
    assert.equal(applyProfilePresets(undefined), 'cloud')
  })
})

test('loadDotEnv fills unset LAB_ vars from a file but never overrides env', () => {
  withEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-config-'))
    const file = join(dir, '.env')
    try {
      writeFileSync(file, '# comment\nLAB_API_KEY=secret\nLAB_MODEL="from-file"\nLAB_PROFILE=go\n')
      process.env.LAB_MODEL = 'from-env'
      loadDotEnv(file)
      assert.equal(process.env.LAB_API_KEY, 'secret')
      assert.equal(process.env.LAB_MODEL, 'from-env')
      assert.equal(process.env.LAB_PROFILE, 'go')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
