/**
 * MCP stdio arguments, as one editable line.
 *
 * The settings form keeps args as a single string because that is how a user thinks of a command,
 * but an MCP server receives an argv array. Splitting on whitespace loses any argument that
 * contains a space — a Windows path, a JSON blob, a prompt — so the two functions here are a
 * quoting pair: `formatArgs(parseArgs(text))` preserves what the user meant, and
 * `parseArgs(formatArgs(argv))` returns the argv it started from.
 */

/**
 * Split a command line into argv, honouring single and double quotes and backslash escapes.
 *
 * Quotes group; they are not themselves part of the value, so `--flag="a b"` is one argument
 * `--flag=a b`. A backslash escapes the next character. An unterminated quote is not an error:
 * the text is still being typed, so the run so far is returned as a final argument.
 */
export function parseArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    // A backslash escapes the next character, except inside single quotes, where a shell
    // treats it literally and so does this.
    if (char === '\\' && quote !== "'" && index + 1 < text.length) {
      current += text[index + 1]
      started = true
      index += 1
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      // An empty quoted string is still an argument, so record that one has begun.
      started = true
      continue
    }

    if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }

    current += char
    started = true
  }

  if (started) args.push(current)
  return args
}

/**
 * Join argv back into one line, quoting only the arguments that would not survive a round trip.
 *
 * An argument is left bare when it holds nothing the parser treats specially, so the common case
 * reads exactly as the user typed it.
 */
export function formatArgs(args: readonly string[]): string {
  return args.map(quoteArg).join(' ')
}

function quoteArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"'\\]/.test(arg)) return arg
  // Double quotes carry every special character except a double quote or a backslash, which are
  // escaped rather than quoted away.
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`
}
