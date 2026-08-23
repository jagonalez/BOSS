import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import graphql from 'highlight.js/lib/languages/graphql'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('graphql', graphql)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  go: 'go',
  rs: 'rust',
  css: 'css',
  scss: 'css',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql'
}

export function langForPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext]
}

export function highlightCode(text: string, path?: string): string {
  const lang = path ? langForPath(path) : undefined
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang }).value
    } catch {
      /* fall through */
    }
  }
  try {
    return hljs.highlightAuto(text).value
  } catch {
    return escapeHtml(text)
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The language tag on a fenced block, from the `language-*` class
 *  react-markdown puts on the code element. */
export function langFromClassName(className?: string): string | undefined {
  const match = /language-([\w+#.-]+)/.exec(className ?? '')
  return match?.[1]
}

/** Resolve a fence tag to a registered hljs language.
 *
 *  Fences use short aliases — ts, js, sh, yml — that are extensions, not
 *  language ids. The extension table already maps them onto the real ids, so a
 *  tag is read as one. Unknown tags return undefined rather than guessing. */
export function langForFence(tag?: string): string | undefined {
  if (!tag) return undefined
  const candidate = EXT_TO_LANG[tag.toLowerCase()] ?? tag.toLowerCase()
  return hljs.getLanguage(candidate) ? candidate : undefined
}

/** Highlight one fenced chat code block by its tag.
 *
 *  Same fallback ladder as highlightCode(): exact language, then auto-detect,
 *  then plain escaping — a fence the tag table does not know still renders,
 *  just without colors. */
export function highlightFence(code: string, tag?: string): string {
  const lang = langForFence(tag)
  if (lang) {
    try {
      return hljs.highlight(code, { language: lang }).value
    } catch {
      /* fall through */
    }
  }
  try {
    return hljs.highlightAuto(code).value
  } catch {
    return escapeHtml(code)
  }
}

/** Flatten React children to their text.
 *
 *  A fenced block's code arrives as a string in practice, but children are
 *  typed loosely and can be arrays or numbers; anything else (an element) has
 *  no business inside a code fence, so it contributes nothing rather than
 *  rendering as [object Object]. */
export function nodeText(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(nodeText).join('')
  return ''
}
