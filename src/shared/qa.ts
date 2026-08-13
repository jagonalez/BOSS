export type QaPolicy = 'off' | 'suggest' | 'automatic'

export type QaAgentTool =
  | 'boss_browser_tabs'
  | 'boss_browser_navigate'
  | 'boss_browser_snapshot'
  | 'boss_browser_screenshot'
  | 'boss_browser_click'
  | 'boss_browser_type'
  | 'boss_computer'

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
  __bossToolResult: true
  text: string
  image?: AgentToolImage
}

export function isAgentToolResult(value: unknown): value is AgentToolResult {
  return Boolean(value && typeof value === 'object' && (value as AgentToolResult).__bossToolResult === true)
}

export const QA_GUIDANCE = [
  'BOSS provides browser and computer QA tools.',
  'For UI bugs or visual reviews, inspect the running result before drawing conclusions.',
  'Prefer boss_browser_* for web content and boss_computer for native applications.',
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
    name: 'boss_browser_tabs',
    description: 'List the browser tiles currently open in the BOSS workspace. Use this before other browser tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'boss_browser_navigate',
    description: 'Navigate an existing BOSS browser tile to an HTTP or HTTPS URL. Requires Automatic QA.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, url: { type: 'string' } },
      required: ['tabId', 'url'],
      additionalProperties: false
    },
    readOnly: false
  },
  {
    name: 'boss_browser_snapshot',
    description: 'Read visible page text and indexed interactive elements from a BOSS browser tile. Element refs remain valid until the page changes.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'boss_browser_screenshot',
    description: 'Capture the rendered page in a BOSS browser tile for visual QA.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false
    },
    readOnly: true
  },
  {
    name: 'boss_browser_click',
    description: 'Click an element ref returned by boss_browser_snapshot. Requires Automatic QA; snapshot again afterward to verify.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, ref: { type: 'string' } },
      required: ['tabId', 'ref'],
      additionalProperties: false
    },
    readOnly: false
  },
  {
    name: 'boss_browser_type',
    description: 'Replace the value of an editable element returned by boss_browser_snapshot. Requires Automatic QA.',
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
    name: 'boss_computer',
    description: 'Inspect or operate a native app through BOSS Computer Use. Supported operations: list_apps, list_windows, get_window_state, get_desktop_state, screenshot, zoom, click, type_text, press_key, hotkey, scroll, wait. Inspect before acting and verify after every action. Input actions require Automatic QA.',
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
