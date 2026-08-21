#!/usr/bin/env node
// The dynamic imports below need a module context.
export {}
// `lab acp` runs the Agent Client Protocol server instead of the interactive
// CLI. Handled before arg parsing because the protocol owns stdin/stdout.
if (process.argv[2] === 'acp') {
  // @ts-expect-error Application builds use bundler resolution.
  const { runAcp } = await import('../src/main/backend/lab-acp.ts')
  runAcp()
  // The stdin readline keeps the process alive; it exits when stdin closes.
} else {
  // @ts-expect-error Application builds use bundler resolution.
  const { parseArgs, runCli } = await import('../src/main/backend/lab-cli.ts')
  const args = parseArgs(process.argv.slice(2))
  const code = await runCli(args).catch((error) => {
    process.stderr.write(`lab: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  })
  process.exit(code)
}
