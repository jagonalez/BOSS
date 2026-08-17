import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
// @ts-expect-error Application code uses bundler resolution.
import { CORE_TOOL_DEFINITIONS, FileSnapshots, alwaysGrantsAllow, applyEdit, fileTreeFromPaths, globFiles, globToRegExp, grepFiles, inferToolName, lineSlice, parseGitLog, parseGitStatus, parseNumStat, pathExists, permissionForTool, resolveInCwd, resolveToolGate, runTool } from './lab-tools.ts'

async function withDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-tools-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A small project tree: src/a.ts, src/nested/b.ts, src/ignored/other.js,
 *  node_modules/pkg/index.js, and a readme. */
function seedProject(dir: string): void {
  mkdirSync(join(dir, 'src/nested'), { recursive: true })
  mkdirSync(join(dir, 'src/ignored'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'export const answer = 42\n// TODO finish this\n')
  writeFileSync(join(dir, 'src/nested/b.ts'), 'import { answer } from "../a"\nconsole.log(answer)\n')
  writeFileSync(join(dir, 'src/ignored/other.js'), 'const todo = "TODO inside"')
  writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'export const todo = "TODO in deps"')
  writeFileSync(join(dir, 'README.md'), '# project\n')
}

test('permissionForTool classifies reads, writes, and shell', () => {
  assert.equal(permissionForTool('read_file'), 'read')
  assert.equal(permissionForTool('write_file'), 'write')
  assert.equal(permissionForTool('edit_file'), 'write')
  assert.equal(permissionForTool('bash'), 'shell')
  assert.equal(permissionForTool('spawn_subagent'), 'write')
  assert.equal(permissionForTool('abort_subagent'), 'write')
  assert.equal(permissionForTool('list_subagents'), 'read')
  assert.equal(permissionForTool('wait_subagent'), 'read')
  assert.equal(permissionForTool('grep'), 'read')
  assert.equal(permissionForTool('glob'), 'read')
  assert.equal(permissionForTool('unknown'), 'read')
})

test('alwaysGrantsAllow matches stored grants only', () => {
  assert.equal(alwaysGrantsAllow(['bash'], 'bash'), true)
  assert.equal(alwaysGrantsAllow(['bash'], 'write_file'), false)
  assert.equal(alwaysGrantsAllow(undefined, 'bash'), false)
  assert.equal(alwaysGrantsAllow([], 'bash'), false)
})

test('inferToolName recovers a dropped tool name from the arguments', () => {
  assert.equal(inferToolName({ command: 'ls' }), 'bash')
  assert.equal(inferToolName({ path: 'x', content: 'y' }), 'write_file')
  assert.equal(inferToolName({ path: 'x', old_string: 'a', new_string: 'b' }), 'edit_file')
  assert.equal(inferToolName({ path: 'x' }), 'read_file')
  assert.equal(inferToolName({ pattern: '**/*.ts' }), 'glob')
  assert.equal(inferToolName({ pattern: 'class Foo' }), 'grep')
  assert.equal(inferToolName({ pattern: 'dot', path: 'tests' }), 'grep')
  assert.equal(inferToolName({ instruction: 'do' }), 'spawn_subagent')
  assert.equal(inferToolName({ todos: [] }), 'todos')
  assert.equal(inferToolName({ subagent_id: 'x' }), 'wait_subagent')
  assert.equal(inferToolName({}), undefined)
})

test('resolveToolGate always allows reads', () => {
  assert.equal(resolveToolGate('ask', 'read'), 'allow')
  assert.equal(resolveToolGate('plan', 'read'), 'allow')
  assert.equal(resolveToolGate('auto', 'read'), 'allow')
  assert.equal(resolveToolGate('accept-edits', 'read'), 'allow')
})

test('resolveToolGate plan denies writes and shell', () => {
  assert.equal(resolveToolGate('plan', 'write'), 'deny')
  assert.equal(resolveToolGate('plan', 'shell'), 'deny')
})

test('resolveToolGate auto approves writes and shell', () => {
  assert.equal(resolveToolGate('auto', 'write'), 'allow')
  assert.equal(resolveToolGate('auto', 'shell'), 'allow')
})

test('resolveToolGate accept-edits approves writes but asks for shell', () => {
  assert.equal(resolveToolGate('accept-edits', 'write'), 'allow')
  assert.equal(resolveToolGate('accept-edits', 'shell'), 'ask')
})

test('resolveToolGate ask leaves writes and shell to the user', () => {
  assert.equal(resolveToolGate('ask', 'write'), 'ask')
  assert.equal(resolveToolGate('ask', 'shell'), 'ask')
})

test('resolveInCwd allows paths inside the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-tools-'))
  try {
    const resolved = resolveInCwd(dir, 'src/index.ts')
    assert.equal(resolved, join(dir, 'src/index.ts'))
    assert.equal(resolveInCwd(dir, join(dir, 'a.txt')), join(dir, 'a.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveInCwd refuses traversal outside the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-tools-'))
  try {
    assert.throws(() => resolveInCwd(dir, '../secret.txt'), /escapes/)
    assert.throws(() => resolveInCwd(dir, '/etc/passwd'), /escapes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyEdit replaces a single match and rejects ambiguous edits', () => {
  assert.equal(applyEdit('foo bar foo', { oldString: 'bar', newString: 'BAZ' }), 'foo BAZ foo')
  assert.throws(() => applyEdit('foo bar foo', { oldString: 'foo', newString: 'X' }), /more than once/)
  assert.throws(() => applyEdit('foo', { oldString: 'zzz', newString: 'X' }), /not found/)
  assert.throws(() => applyEdit('foo', { oldString: '', newString: 'X' }), /non-empty/)
})

test('applyEdit replace_all swaps every occurrence', () => {
  assert.equal(applyEdit('a-b-a', { oldString: 'a', newString: 'X', replaceAll: true }), 'X-b-X')
})

test('runTool read_file returns contents', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'hello lab')
    const result = await runTool('read_file', { path: 'a.txt' }, { cwd: dir })
    assert.equal(result.output, 'hello lab')
  })
})

test('runTool write_file creates parents and the file', async () => {
  await withDir(async (dir) => {
    const result = await runTool('write_file', { path: 'nested/deep/b.txt', content: 'data' }, { cwd: dir })
    assert.match(result.output, /Wrote 4 bytes/)
    assert.equal(readFileSync(join(dir, 'nested/deep/b.txt'), 'utf8'), 'data')
  })
})

test('runTool edit_file applies and persists an edit', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'the old text')
    await runTool('edit_file', { path: 'x.txt', old_string: 'old', new_string: 'new' }, { cwd: dir })
    assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'the new text')
  })
})

test('runTool edit_file with replace_all replaces every match', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'a a')
    await runTool('edit_file', { path: 'x.txt', old_string: 'a', new_string: 'b', replace_all: true }, { cwd: dir })
    assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'b b')
  })
})

test('runTool edit_file throws when the match appears twice', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'hi hi')
    await assert.rejects(
      runTool('edit_file', { path: 'x.txt', old_string: 'hi', new_string: 'bye' }, { cwd: dir }),
      /more than once/
    )
  })
})

test('runTool bash runs in the project cwd and returns exit code', async () => {
  await withDir(async (dir) => {
    const result = await runTool('bash', { command: 'pwd && printf hello' }, { cwd: dir })
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /hello/)
    assert.match(result.output, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test('runTool bash reports a failing command exit code', async () => {
  await withDir(async (dir) => {
    const result = await runTool('bash', { command: 'exit 7' }, { cwd: dir })
    assert.equal(result.exitCode, 7)
  })
})

test('runTool bash caps output', async () => {
  await withDir(async (dir) => {
    const result = await runTool('bash', { command: 'printf "aaaaaaaaaa"' }, { cwd: dir, maxOutputChars: 5 })
    assert.equal(result.output, 'aaaaa')
    assert.equal(result.truncated, true)
  })
})

test('runTool bash chains commands deterministically', async () => {
  await withDir(async (dir) => {
    const result = await runTool('bash', { command: 'echo one; echo two' }, { cwd: dir })
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /one/)
    assert.match(result.output, /two/)
  })
})

test('runTool unknown tool throws', async () => {
  await withDir(async (dir) => {
    await assert.rejects(runTool('nope', {}, { cwd: dir }), /Unknown tool/)
  })
})

test('runTool missing required args throw', async () => {
  await withDir(async (dir) => {
    await assert.rejects(runTool('read_file', {}, { cwd: dir }), /requires a path/)
    await assert.rejects(runTool('bash', {}, { cwd: dir }), /requires a command/)
  })
})

test('pathExists reports presence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss-lab-tools-'))
  try {
    writeFileSync(join(dir, 'yes.txt'), 'x')
    assert.equal(pathExists(join(dir, 'yes.txt')), true)
    assert.equal(pathExists(join(dir, 'no.txt')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('globToRegExp matches stars, globstars, questions, and braces', () => {
  const cases: Array<[string, string, boolean]> = [
    ['*.ts', 'a.ts', true],
    ['*.ts', 'dir/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/nested/b.ts', true],
    ['src/**/*.ts', 'src/nested/b.ts', true],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/nested/b.ts', false],
    ['?at.ts', 'cat.ts', true],
    ['{a,b}.ts', 'a.ts', true],
    ['{a,b}.ts', 'b.ts', true],
    ['{a,b}.ts', 'c.ts', false]
  ]
  for (const [pattern, candidate, expected] of cases) {
    assert.equal(globToRegExp(pattern).test(candidate), expected, `${pattern} ~ ${candidate}`)
  }
})

test('grep finds matches with file, line, and content', async () => {
  await withDir(async (dir) => {
    seedProject(dir)
    const { matches, truncated } = grepFiles(dir, 'TODO')
    assert.equal(truncated, false)
    assert.deepEqual(matches.map((match) => match.file).sort(), ['src/a.ts', 'src/ignored/other.js'])
    const aMatch = matches.find((match) => match.file === 'src/a.ts')
    assert.equal(aMatch?.line, 2)
    assert.match(aMatch?.content ?? '', /TODO finish/)
  })
})

test('grep skips dependency and build directories', async () => {
  await withDir(async (dir) => {
    seedProject(dir)
    const { matches } = grepFiles(dir, 'TODO')
    assert.ok(!matches.some((match) => match.file.startsWith('node_modules/')), 'node_modules must be skipped')
  })
})

test('grep respects the path argument and case sensitivity', async () => {
  await withDir(async (dir) => {
    seedProject(dir)
    const scoped = grepFiles(dir, 'TODO', { path: join(dir, 'src') })
    assert.deepEqual(scoped.matches.map((match) => match.file).sort(), ['src/a.ts', 'src/ignored/other.js'])
    const caseSensitive = grepFiles(dir, 'todo')
    assert.equal(caseSensitive.matches.length, 1) // only src/ignored/other.js has lowercase "todo"
    assert.equal(caseSensitive.matches[0].file, 'src/ignored/other.js')
    const insensitive = grepFiles(dir, 'todo', { caseInsensitive: true })
    assert.ok(insensitive.matches.length > 1)
  })
})

test('grep caps results and reports truncation', async () => {
  await withDir(async (dir) => {
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `f${i}.txt`), `hit ${i}\n`)
    const { matches, truncated } = grepFiles(dir, 'hit', { max: 3 })
    assert.equal(matches.length, 3)
    assert.equal(truncated, true)
  })
})

test('grep throws on an invalid pattern', () => {
  assert.throws(() => grepFiles('/tmp', '(['), /Invalid regular expression/)
})

test('glob lists matching relative paths and skips ignored directories', async () => {
  await withDir(async (dir) => {
    seedProject(dir)
    const { files } = globFiles(dir, '**/*.ts')
    assert.deepEqual(files.sort(), ['src/a.ts', 'src/nested/b.ts'])
    const topOnly = globFiles(dir, '*.md')
    assert.deepEqual(topOnly.files, ['README.md'])
  })
})

test('lineSlice numbers a requested range', () => {
  const content = 'one\ntwo\nthree\nfour\n'
  assert.equal(lineSlice(content, 2, 3), '2: two\n3: three')
  assert.equal(lineSlice(content, 3), '3: three\n4: four')
  assert.throws(() => lineSlice(content, 4, 2), /after end_line/)
})

test('runTool grep returns structured JSON', async () => {
  await withDir(async (dir) => {
    seedProject(dir)
    const result = await runTool('grep', { pattern: 'TODO' }, { cwd: dir })
    const json = result.output.replace(/^\[truncated[^\n]*\n/, '')
    const parsed = JSON.parse(json) as Array<{ file: string; line: number; content: string }>
    assert.ok(Array.isArray(parsed))
    assert.ok(parsed.some((match) => match.file === 'src/a.ts'))
  })
})

test('runTool read_file honors start_line/end_line', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'line one\nline two\nline three\n')
    const whole = await runTool('read_file', { path: 'x.txt' }, { cwd: dir })
    assert.equal(whole.output, 'line one\nline two\nline three\n')
    const ranged = await runTool('read_file', { path: 'x.txt', start_line: 2, end_line: 3 }, { cwd: dir })
    assert.equal(ranged.output, '2: line two\n3: line three')
  })
})

/** A fresh git repo with one committed file. */
function seedGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'lab@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Lab Test'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'one\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir })
}

test('parseGitStatus reads porcelain entries and renames', () => {
  const entries = parseGitStatus(' M src/a.ts\n?? new.txt\nR  old.txt -> new/name.txt\n')
  assert.deepEqual(entries, [
    { path: 'src/a.ts', index: ' ', worktree: 'M' },
    { path: 'new.txt', index: '?', worktree: '?' },
    { path: 'new/name.txt', index: 'R', worktree: ' ' }
  ])
})

test('parseGitLog splits the tab format', () => {
  const entries = parseGitLog('abc123\tJane\te\tfirst commit\n')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].hash, 'abc123')
  assert.equal(entries[0].author, 'Jane')
  assert.equal(entries[0].subject, 'first commit')
})

test('parseNumStat reads additions and deletions per file', () => {
  const entries = parseNumStat('10\t2\tsrc/a.ts\n-\t-\tbinary.bin\n1\t1\tsrc with spaces/n.ts\n')
  assert.deepEqual(entries, [
    { path: 'src/a.ts', additions: 10, deletions: 2 },
    { path: 'binary.bin', additions: 0, deletions: 0 },
    { path: 'src with spaces/n.ts', additions: 1, deletions: 1 }
  ])
})

test('fileTreeFromPaths builds a nested tree with project-relative paths', () => {
  const tree = fileTreeFromPaths('/proj', [
    '/proj/README.md',
    '/proj/src/a.ts',
    '/proj/src/nested/b.ts'
  ])
  assert.equal(tree.length, 2)
  const readme = tree.find((node) => node.path === 'README.md')
  assert.ok(readme)
  assert.equal(readme?.type, 'file')
  const src = tree.find((node) => node.path === 'src')
  assert.equal(src?.type, 'directory')
  assert.ok(src?.children?.some((node) => node.path === 'src/a.ts'))
  assert.ok(src?.children?.some((node) => node.path === 'src/nested'))
})

test('git_status reports tracked edits and untracked files', async () => {
  await withDir(async (dir) => {
    seedGitRepo(dir)
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'untracked.txt'), 'x')
    const result = await runTool('git_status', {}, { cwd: dir })
    const entries = JSON.parse(result.output) as Array<{ path: string; index: string; worktree: string }>
    assert.ok(entries.some((entry) => entry.path === 'tracked.txt' && entry.worktree === 'M'))
    assert.ok(entries.some((entry) => entry.path === 'untracked.txt' && entry.index === '?'))
  })
})

test('git_diff shows the working-tree change', async () => {
  await withDir(async (dir) => {
    seedGitRepo(dir)
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
    const result = await runTool('git_diff', {}, { cwd: dir })
    assert.match(result.output, /diff --git/)
    assert.match(result.output, /\+two/)
  })
})

test('git_commit records a commit that git_log then lists', async () => {
  await withDir(async (dir) => {
    seedGitRepo(dir)
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
    const committed = await runTool('git_commit', { message: 'add two', all: true }, { cwd: dir })
    assert.equal(committed.exitCode, undefined)
    assert.match(committed.output, /1 file changed|master|files changed/)

    const log = await runTool('git_log', { limit: 3 }, { cwd: dir })
    const entries = JSON.parse(log.output) as Array<{ hash: string; subject: string }>
    assert.equal(entries[0].subject, 'add two')
    assert.equal(entries.length, 2)
  })
})

test('permissionForTool classifies git tools', () => {
  assert.equal(permissionForTool('git_status'), 'read')
  assert.equal(permissionForTool('git_diff'), 'read')
  assert.equal(permissionForTool('git_log'), 'read')
  assert.equal(permissionForTool('git_commit'), 'write')
  assert.equal(permissionForTool('revert_file'), 'write')
})

test('FileSnapshots captures once, reverts, and forgets', () => {
  const snapshots = new FileSnapshots()
  assert.equal(snapshots.revert('/x').had, false)
  snapshots.capture('/x', 'one')
  snapshots.capture('/x', 'two') // first capture wins
  assert.equal(snapshots.snapshotFor('/x'), 'one')
  const reverted = snapshots.revert('/x')
  assert.equal(reverted.had, true)
  assert.equal(reverted.content, 'one')
  assert.equal(snapshots.revert('/x').had, false)
})

test('edit_file then revert_file restores the original content', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'the old text')
    const snapshots = new FileSnapshots()
    await runTool('edit_file', { path: 'x.txt', old_string: 'old', new_string: 'new' }, { cwd: dir, snapshots })
    assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'the new text')
    const reverted = await runTool('revert_file', { path: 'x.txt' }, { cwd: dir, snapshots })
    assert.match(reverted.output, /Reverted/)
    assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'the old text')
  })
})

test('revert_file reports when nothing was captured', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'content')
    const result = await runTool('revert_file', { path: 'x.txt' }, { cwd: dir, snapshots: new FileSnapshots() })
    assert.match(result.output, /nothing to revert/)
  })
})

test('write_file captures the previous content for revert', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'x.txt'), 'before')
    const snapshots = new FileSnapshots()
    await runTool('write_file', { path: 'x.txt', content: 'after' }, { cwd: dir, snapshots })
    await runTool('revert_file', { path: 'x.txt' }, { cwd: dir, snapshots })
    assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'before')
  })
})