import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { restoreShellPath } from './shell-path.ts'

// Each fake shell prints its payload with a `PATH=... env -0` prefix, which replaces PATH
// for that one command. `env` must therefore be named by absolute path: a bare `env` would
// be looked up in the fake PATH, fail, and print nothing — testing the shell's own command
// lookup instead of the parser under test.
const ENV_BIN = '/usr/bin/env'

/** Build a fake login shell that prints `env -0` the way a real one would. */
function fakeShell(dir: string, body: string): string {
  const path = join(dir, 'fake-shell')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function withEnv(patch: Record<string, string | undefined>, run: () => void): void {
  const original = { ...process.env }
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    // Restore wholesale: the function under test mutates process.env by design.
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
  }
}

test('imports PATH entries the GUI environment lacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-shell-path-'))
  try {
    // A shell whose profile adds /opt/agents/bin, as nvm or bun would.
    const shell = fakeShell(dir, `printf '__BOSS_ENV_START__'; PATH=/opt/agents/bin ${ENV_BIN} -0; printf '__BOSS_ENV_END__'`)
    withEnv({ SHELL: shell, PATH: '/usr/bin:/bin' }, () => {
      const result = restoreShellPath().split(delimiter)
      assert.ok(result.includes('/opt/agents/bin'), 'shell-only directory is imported')
      assert.ok(result.includes('/usr/bin'), 'inherited entries survive')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('survives a shell that prints a banner before the payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-shell-path-'))
  try {
    // powerlevel10k/gitstatus write startup noise to stdout; the delimiters must win.
    const shell = fakeShell(
      dir,
      `echo 'gitstatus failed to initialize'; printf '__BOSS_ENV_START__'; PATH=/opt/agents/bin ${ENV_BIN} -0; printf '__BOSS_ENV_END__'; echo trailing`
    )
    withEnv({ SHELL: shell, PATH: '/usr/bin' }, () => {
      const result = restoreShellPath().split(delimiter)
      assert.ok(result.includes('/opt/agents/bin'))
      assert.ok(!result.some((entry) => entry.includes('gitstatus')), 'banner text is not treated as a path')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('falls back to known install directories when the shell probe fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-shell-path-'))
  try {
    // Stands in for nushell, which rejects `-ilc` outright.
    const shell = fakeShell(dir, 'exit 1')
    withEnv({ SHELL: shell, PATH: '/usr/bin' }, () => {
      const result = restoreShellPath().split(delimiter)
      assert.ok(result.includes('/opt/homebrew/bin'), 'fallback directories are still added')
      assert.ok(result.includes('/usr/bin'), 'inherited PATH is preserved')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('imports shell variables without overwriting ones the launcher set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-shell-path-'))
  try {
    const shell = fakeShell(
      dir,
      `printf '__BOSS_ENV_START__'; PATH=/usr/bin AGENT_TOKEN=from-shell EXISTING=from-shell ${ENV_BIN} -0; printf '__BOSS_ENV_END__'`
    )
    withEnv({ SHELL: shell, PATH: '/usr/bin', EXISTING: 'from-launcher', AGENT_TOKEN: undefined }, () => {
      restoreShellPath()
      assert.equal(process.env.AGENT_TOKEN, 'from-shell', 'unset variables come from the shell')
      assert.equal(process.env.EXISTING, 'from-launcher', 'explicit values are not clobbered')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('does not import the shell process own location variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-shell-path-'))
  try {
    const shell = fakeShell(
      dir,
      `printf '__BOSS_ENV_START__'; PATH=/usr/bin PWD=/somewhere/else ${ENV_BIN} -0; printf '__BOSS_ENV_END__'`
    )
    withEnv({ SHELL: shell, PATH: '/usr/bin', PWD: undefined }, () => {
      restoreShellPath()
      assert.notEqual(process.env.PWD, '/somewhere/else')
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
