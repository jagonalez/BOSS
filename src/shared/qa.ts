export type QaPolicy = 'off' | 'suggest' | 'automatic'

export type QaAgentTool =
  | 'ralf_browser_tabs'
  | 'ralf_browser_navigate'
  | 'ralf_browser_snapshot'
  | 'ralf_browser_screenshot'
  | 'ralf_browser_click'
  | 'ralf_browser_type'
  | 'ralf_computer'

export interface QaPolicyState {
  threadId: string
  policy: QaPolicy
  defaultPolicy: QaPolicy
  source: 'global' | 'thread'
  browserAvailable: boolean
  computerAvailable: boolean
  computerEnabled: boolean
}

export interface AgentToolImage {
  mimeType: string
  data: string
}

export interface AgentToolResult {
  __ralfToolResult: true
  text: string
  image?: AgentToolImage
}

export function isAgentToolResult(value: unknown): value is AgentToolResult {
  return Boolean(value && typeof value === 'object' && (value as AgentToolResult).__ralfToolResult === true)
}

export const QA_GUIDANCE = [
  'R.A.L.F. provides browser and computer QA tools.',
  'For UI bugs or visual reviews, inspect the running result before drawing conclusions.',
  'Prefer ralf_browser_* for web content and ralf_computer for native applications.',
  'After changes, repeat the affected flow and report the evidence you observed.',
  'In Suggest mode, inspection is allowed but navigation, clicking, and typing require the user to enable Automatic QA.'
].join(' ')

export const QA_TOOL_DEFINITIONS: Array<{
  name: QaAgentTool
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}> = [
  {
    name: 'ralf_browser_tabs',
    description: 'List the browser tiles currently open in the R.A.L.F. workspace. Use this before other browser tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'ralf_browser_navigate',
    description: 'Navigate an existing R.A.L.F. browser tile to an HTTP or HTTPS URL. Requires Automatic QA.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, url: { type: 'string' } },
      required: ['tabId', 'url'],
      additionalProperties: false
    },
    readOnly: false
  },
  {
    name: 'ralf_browser_snapshot',
    description: 'Read visible page text and indexed interactive elements from a R.A.L.F. browser tile. Element refs remain valid until the page changes.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'ralf_browser_screenshot',
    description: 'Capture the rendered page in a R.A.L.F. browser tile for visual QA.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'ralf_browser_click',
    description: 'Click an element ref returned by ralf_browser_snapshot. Requires Automatic QA; snapshot again afterward to verify.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, ref: { type: 'string' } },
      required: ['tabId', 'ref'],
      additionalProperties: false
    },
    readOnly: false
  },
  {
    name: 'ralf_browser_type',
    description: 'Replace the value of an editable element returned by ralf_browser_snapshot. Requires Automatic QA.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', default: false }
      },
      required: ['tabId', 'ref', 'text'],
      additionalProperties: false
    },
    readOnly: false
  },
  {
    name: 'ralf_computer',
    description: 'Inspect or operate a native app through R.A.L.F. Computer Use. Supported operations: list_apps, list_windows, get_window_state, get_desktop_state, screenshot, zoom, click, type_text, press_key, hotkey, scroll, wait. Inspect before acting and verify after every action. Input actions require Automatic QA.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'screenshot', 'zoom', 'click', 'type_text', 'press_key', 'hotkey', 'scroll', 'wait'] },
        arguments: { type: 'object', additionalProperties: true }
      },
      required: ['operation'],
      additionalProperties: false
    },
    readOnly: false
  }
]
