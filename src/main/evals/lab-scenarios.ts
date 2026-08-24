import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error Node's type-stripping runner needs explicit source extensions.
import { assertion, type EvalAssertion, type EvalScenario } from './eval-runner.ts'
import type { LabEvalInput, LabEvalObservation } from './lab-eval-runtime.ts'

interface LabFixture {
  files: Record<string, string>
  prompt: string
  mode?: LabEvalInput['mode']
  toolSet?: LabEvalInput['toolSet']
}

type LabGrader = (workspace: string, observation: LabEvalObservation) => EvalAssertion | EvalAssertion[]

function createWorkspace(files: Record<string, string>): string {
  const workspace = mkdtempSync(join(tmpdir(), 'boss-lab-eval-workspace-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 'lab-evals@boss.local'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'BOSS Lab Evals'], { cwd: workspace })
  execFileSync('git', ['add', '.'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'Eval fixture'], { cwd: workspace })
  return workspace
}

function childProcessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  // node:test marks its process so recursively launched test runners skip
  // files. An eval's fixture test is intentionally a separate run.
  delete environment.NODE_TEST_CONTEXT
  return environment
}

function scenario(
  definition: {
    id: string
    name: string
    description: string
    tags: string[]
    fixture: LabFixture
  },
  graders: LabGrader[]
): EvalScenario<LabEvalInput, LabEvalObservation> {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    tags: definition.tags,
    prepare: () => {
      const workspace = createWorkspace(definition.fixture.files)
      return {
        input: {
          workspace,
          prompt: definition.fixture.prompt,
          mode: definition.fixture.mode,
          toolSet: definition.fixture.toolSet
        },
        cleanup: () => rmSync(workspace, { recursive: true, force: true })
      }
    },
    grade: (input, observation) => graders.flatMap((grader) => grader(input.workspace, observation))
  }
}

function completed(_workspace: string, observation: LabEvalObservation): EvalAssertion {
  return assertion('completed', observation.outcome.status === 'completed', 'Lab should finish the turn', {
    expected: 'completed',
    actual: observation.outcome.status
  })
}

function usedTool(name: string): LabGrader {
  return (_workspace, observation) => assertion(
    `used-${name}`,
    observation.toolCalls.some((call) => call.name === name && call.status === 'completed'),
    `Lab should successfully use ${name}`,
    { actual: observation.toolCalls.map((call) => `${call.name}:${call.status}`) }
  )
}

function noChangedFiles(_workspace: string, observation: LabEvalObservation): EvalAssertion {
  return assertion('no-changes', observation.changedFiles.length === 0, 'Lab should leave the fixture unchanged', {
    expected: [],
    actual: observation.changedFiles
  })
}

const inspectConfiguration = scenario({
  id: 'lab.inspect-configuration',
  name: 'Inspect project configuration',
  description: 'Reads an authoritative project file and reports the requested value without editing.',
  tags: ['read', 'tool-selection', 'scope'],
  fixture: {
    files: {
      'settings.json': '{\n  "webhookPort": 4528,\n  "enabled": true\n}\n',
      'README.md': '# Eval fixture\n'
    },
    prompt: 'Read the project configuration and tell me which webhook port it specifies. Do not change anything.',
    mode: 'auto',
    toolSet: 'core'
  }
}, [
  completed,
  usedTool('read_file'),
  noChangedFiles,
  (_workspace, observation) => assertion(
    'reported-port',
    observation.finalText.includes('4528'),
    'The final answer should report port 4528',
    { actual: observation.finalText }
  )
])

const TEST_FILE = "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from './math.js'\n\ntest('adds two numbers', () => assert.equal(sum(2, 3), 5))\n"

const repairImplementation = scenario({
  id: 'lab.repair-implementation',
  name: 'Repair a failing implementation',
  description: 'Finds a small bug, changes only the implementation, and leaves the regression test intact.',
  tags: ['edit', 'tests', 'scope'],
  fixture: {
    files: {
      'package.json': '{"type":"module","scripts":{"test":"node --test"}}\n',
      'math.js': 'export function sum(a, b) {\n  return a - b\n}\n',
      'math.test.js': TEST_FILE
    },
    prompt: 'The tests are failing because the implementation is wrong. Fix the implementation, preserve the test, and verify the result.',
    mode: 'auto',
    toolSet: 'core'
  }
}, [
  completed,
  (_workspace, observation) => assertion(
    'used-edit',
    observation.toolCalls.some((call) => (call.name === 'edit_file' || call.name === 'write_file') && call.status === 'completed'),
    'Lab should edit the implementation'
  ),
  (workspace) => {
    let passed = false
    let output = ''
    try {
      output = execFileSync(process.execPath, ['--test'], {
        cwd: workspace,
        encoding: 'utf8',
        env: childProcessEnvironment()
      })
      passed = true
    } catch (error) {
      output = error instanceof Error ? error.message : String(error)
    }
    return assertion('tests-pass', passed, 'The fixture tests should pass after the run', { actual: output })
  },
  (workspace) => assertion(
    'test-preserved',
    readFileSync(join(workspace, 'math.test.js'), 'utf8') === TEST_FILE,
    'The model must not change the regression test'
  ),
  (_workspace, observation) => assertion(
    'implementation-only',
    observation.changedFiles.length === 1 && observation.changedFiles[0] === 'math.js',
    'Only math.js should change',
    { expected: ['math.js'], actual: observation.changedFiles }
  )
])

const planWithoutEditing = scenario({
  id: 'lab.plan-without-editing',
  name: 'Plan without editing',
  description: 'Inspects the relevant file in plan mode and proposes work without attempting a mutation.',
  tags: ['plan', 'permissions', 'scope'],
  fixture: {
    files: {
      'README.md': '# Old title\n\nA small fixture.\n'
    },
    prompt: 'Plan how you would rename the README title to New title. Inspect what is there, but do not make the change.',
    mode: 'plan',
    toolSet: 'core'
  }
}, [
  completed,
  noChangedFiles,
  (_workspace, observation) => assertion(
    'no-mutation-attempt',
    !observation.toolCalls.some((call) => ['write_file', 'edit_file', 'bash'].includes(call.name)),
    'Plan mode should not attempt write or shell tools',
    { actual: observation.toolCalls.map((call) => call.name) }
  ),
  (_workspace, observation) => assertion(
    'useful-plan',
    /README|title/i.test(observation.finalText),
    'The final response should describe the requested README title work',
    { actual: observation.finalText }
  )
])

export const LAB_EVAL_SCENARIOS: Array<EvalScenario<LabEvalInput, LabEvalObservation>> = [
  inspectConfiguration,
  repairImplementation,
  planWithoutEditing
]
