# Lab evaluations

BOSS has deterministic unit and E2E tests for protocol and UI behavior. The
eval suites answer a different question: whether a real model, prompt, and tool
surface reliably produce the intended outcome.

Both suites use the same runtime-neutral runner:

- **Lab** runs coding tasks in disposable Git repositories and grades tool use,
  final diffs, tests, and scope.
- **Lab Assistant** runs orchestration tasks against a simulated BOSS world.
  Projects, work items, pull requests, agents, questions, and releases are fake;
  no eval can message a real agent or publish a release.

## Run the suites

Lab reads the same OpenAI-compatible environment as the CLI. Put credentials in
`~/.lab/.env` or export them in the shell:

```sh
LAB_BASE_URL=https://example.test/v1
LAB_API_KEY=...
LAB_MODEL=model-id
```

List scenarios without contacting a model:

```sh
npm run eval:lab -- --list
npm run eval:assistant -- --list
```

Run a suite or one scenario:

```sh
npm run eval:lab
npm run eval:assistant -- --scenario lab-assistant.route-merge-conflict
```

Repeat stochastic cases and retain the complete trace:

```sh
npm run eval:assistant -- --repeats 5 --output /tmp/lab-assistant-evals.json
```

The console report shows the failed assertions. The JSON report also carries
the transcript, tool calls, changed files, final simulated world, and duration
for each attempt. API keys are never included.

## What belongs in an eval

Prefer deterministic graders:

- a test or command passes;
- only expected files changed;
- a required tool or durable action occurred;
- a forbidden action did not occur;
- the simulated world reached the expected state.

Use a model judge only for qualities that cannot be stated as an invariant,
such as the clarity of a proposed plan. A judge must not decide whether code
works, whether a release was authorized, or whether an agent was messaged.

Real-model evals are deliberately separate from `npm test`: provider drift,
cost, and network availability should not make deterministic CI flaky. Run
them manually while developing prompts and tools, then on a scheduled job once
the model matrix and regression thresholds have been chosen.

## Adding another runtime

Implement `EvalRuntime<Input, Observation>` from `eval-runner.ts`. Lab and Lab
Assistant scenarios do not know how the runtime obtains completions, so a Pi or
replay adapter can execute the same cases without changing their graders.
