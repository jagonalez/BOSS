import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
// Node's type-stripping test runner requires the explicit extension.
// @ts-expect-error Application code uses bundler resolution.
import { OPEN_FLAG, openTargetMessage, openTargetProblem, parseOpenTarget } from './cli-open.ts'

describe('parseOpenTarget', () => {
  test('reads the flag as a separate argument', () => {
    strictEqual(parseOpenTarget(['/x/BOSS', OPEN_FLAG, '/repos/api'], '/tmp'), '/repos/api')
  })

  test('reads the flag joined by =', () => {
    strictEqual(parseOpenTarget(['/x/BOSS', `${OPEN_FLAG}=/repos/api`], '/tmp'), '/repos/api')
  })

  test('resolves a relative path against the shell cwd, not the app cwd', () => {
    strictEqual(parseOpenTarget([OPEN_FLAG, '.'], '/repos/api'), '/repos/api')
    strictEqual(parseOpenTarget([OPEN_FLAG, '../web'], '/repos/api'), '/repos/web')
  })

  test('normalises a messy absolute path', () => {
    strictEqual(parseOpenTarget([OPEN_FLAG, '/repos/api/../api/'], '/tmp'), '/repos/api')
  })

  test('is null when the flag is absent', () => {
    strictEqual(parseOpenTarget(['/x/BOSS'], '/tmp'), null)
    strictEqual(parseOpenTarget([], '/tmp'), null)
  })

  test('is null when the flag has no value or a blank one', () => {
    strictEqual(parseOpenTarget([OPEN_FLAG], '/tmp'), null)
    strictEqual(parseOpenTarget([OPEN_FLAG, '   '], '/tmp'), null)
  })

  // Chromium and the sandbox add their own switches to argv, so the flag has to
  // be found among them rather than at a fixed position.
  test('ignores the switches Electron adds around it', () => {
    const argv = [
      '/Applications/BOSS.app/Contents/MacOS/BOSS',
      '--enable-features=SomeFeature',
      OPEN_FLAG,
      '/repos/api',
      '--no-sandbox'
    ]
    strictEqual(parseOpenTarget(argv, '/tmp'), '/repos/api')
  })

  test('does not confuse a lookalike flag for ours', () => {
    strictEqual(parseOpenTarget([`${OPEN_FLAG}-later`, '/repos/api'], '/tmp'), null)
  })

  test('a path containing spaces survives as one argument', () => {
    strictEqual(parseOpenTarget([OPEN_FLAG, '/repos/my api'], '/tmp'), '/repos/my api')
  })
})

describe('openTargetProblem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-cli-open-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  test('a real folder has no problem', () => {
    const project = join(dir, 'project')
    mkdirSync(project)
    strictEqual(openTargetProblem(project), null)
  })

  test('a missing path is reported as missing', () => {
    strictEqual(openTargetProblem(join(dir, 'nope')), 'missing')
  })

  test('a file is reported as not a directory', () => {
    const file = join(dir, 'readme.md')
    writeFileSync(file, '# hi')
    strictEqual(openTargetProblem(file), 'not-a-directory')
  })

  test('every problem names the path it is about', () => {
    const problems = ['missing', 'not-a-directory'] as const
    deepStrictEqual(
      problems.map((problem) => openTargetMessage('/repos/api', problem).includes('/repos/api')),
      [true, true]
    )
  })
})
