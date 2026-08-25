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

/** Whether a tool-result image belongs in the user-facing transcript.
 *
 * Computer state calls return screenshots so the model can inspect them. They
 * are working context, not attachments the model chose to show. The explicit
 * flag is carried on the call itself, which every backend retains as the tool
 * part's input, so the image can still reach the model without becoming a wall
 * of near-identical transcript images. Other image-producing tools keep their
 * existing visible behaviour. */
export function isComputerTool(tool: string): boolean {
  return tool === 'boss_computer' || tool.endsWith('__boss_computer')
}

export function shouldSurfaceToolImage(tool: string, input: unknown): boolean {
  if (!isComputerTool(tool)) return true
  let parsed = input
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return false
    }
  }
  return Boolean(parsed && typeof parsed === 'object'
    && (parsed as { showInTranscript?: unknown }).showInTranscript === true)
}

/** Mime types the image store can put on disk, mirrored from its extension
 *  table. Kept here because both the MCP hub and the backend manager have to
 *  know what will be rejected before they hand bytes over, so that an image
 *  BOSS cannot show is described in words rather than printed as base64. */
export const DISPLAYABLE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export function isDisplayableImageMime(mime: string): boolean {
  return (DISPLAYABLE_IMAGE_MIMES as readonly string[]).includes(mime)
}

/** The image carried by one tool-result content block, if it holds one.
 *
 *  Two shapes reach BOSS and both are read here: Claude nests the bytes under
 *  source.data with the type on source.media_type, while MCP puts data and
 *  mimeType at the top level. */
export function toolResultImage(block: unknown): AgentToolImage | undefined {
  if (!block || typeof block !== 'object') return undefined
  const item = block as {
    type?: string
    data?: unknown
    mimeType?: unknown
    source?: { type?: string; media_type?: unknown; data?: unknown }
  }
  if (item.type !== 'image') return undefined
  const source = item.source
  if (source && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return { mimeType: source.media_type, data: source.data }
  }
  if (typeof item.data === 'string' && typeof item.mimeType === 'string') {
    return { mimeType: item.mimeType, data: item.data }
  }
  return undefined
}

/** Split an MCP tool result into the text the model reads and the first image
 *  worth showing.
 *
 *  An MCP image block carries data/mimeType and no text, so stringifying the
 *  content turned a screenshot into a wall of base64 in the transcript. Only
 *  one image is carried because AgentToolResult holds one, matching what the
 *  QA tools already return; any others stay named so nothing vanishes without
 *  explanation. */
export function mcpToolResultContent(content: Array<Record<string, unknown>>): { text: string; image?: AgentToolImage } {
  const text: string[] = []
  let image: AgentToolImage | undefined
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.text === 'string') {
      if (item.text) text.push(item.text)
      continue
    }
    const found = toolResultImage(item)
    if (found) {
      if (!isDisplayableImageMime(found.mimeType)) {
        // Degrades to a sentence rather than disappearing or crashing: the
        // model is told an image came back and why it is not on screen.
        text.push(`[Image omitted: ${found.mimeType} is not a format BOSS can display.]`)
      } else if (image) {
        text.push(`[Additional ${found.mimeType} image omitted: only the first is shown.]`)
      } else {
        image = found
      }
      continue
    }
    // Anything else — resource links, embedded resources, future block types —
    // keeps its old behaviour rather than being dropped on the floor.
    text.push(JSON.stringify(item))
  }
  return { text: text.filter(Boolean).join('\n'), image }
}

/** Told to the agent once, alongside the tool list.
 *
 *  Written to answer "when would I reach for these", because the tools were
 *  being ignored until the user named them. A model that has only been told
 *  what a tool does still has to guess when it applies; saying so plainly is
 *  what turns an available tool into a used one. */
export const QA_GUIDANCE = [
  'You can see and operate what you build: boss_browser_* drives web pages open in BOSS, and boss_computer drives native applications.',
  'Reach for them whenever a claim about what something looks like or does would otherwise be a guess.',
  'That includes checking your own work after a change, answering a question about a page or an app, and reproducing a bug the user reports.',
  'Looking is cheap and does not need permission: listing tabs, reading a page, and taking a screenshot are always available.',
  'Computer screenshots used for inspection stay out of the transcript by default; set showInTranscript only when the user asked to see that specific screenshot.',
  'Do not describe a page you have not read or a screen you have not seen.',
  'Acting on a page or an app — navigating, clicking, typing — needs Automatic QA turned on, and the tool says so if it is not.'
].join(' ')

/** One tool's description, by name.
 *
 *  The opencode and pi backends write their tools out as generated plugin
 *  source rather than registering them in process, so they interpolate the
 *  text instead of importing the definition. Reading it from here keeps every
 *  backend telling the agent the same thing. */
export function qaDescription(name: QaAgentTool): string {
  const tool = QA_TOOL_DEFINITIONS.find((item) => item.name === name)
  if (!tool) throw new Error(`No BOSS tool named ${name}.`)
  return tool.description
}

export const QA_TOOL_DEFINITIONS: Array<{
  name: QaAgentTool
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}> = [
  {
    name: 'boss_browser_tabs',
    description: 'Find out which web pages are open in BOSS, and get the tabId every other browser tool needs. Start here whenever you want to look at a page. An empty list means the user has no browser open, so ask them to open one rather than assuming the page is unreachable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: 'boss_browser_navigate',
    description: 'Point an open browser tab at a URL, to reach a page that is not on screen yet. Needs Automatic QA. Snapshot afterwards to see what loaded.',
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
    description: 'Read what a page actually says and what can be clicked on it. Use this to answer any question about a page, to check a change you made, or to find the element you are about to click or type into. Always available, no permission needed. Element refs stay valid until the page changes, so snapshot again after anything that reloads or navigates.',
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
    description: 'See how a page looks, rather than what it says. Use this for anything visual — layout, spacing, colour, whether something is cut off or overlapping — where the text alone would not tell you. Always available, no permission needed. For reading content or finding elements, boss_browser_snapshot is the better tool.',
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
    description: 'Click something on a page, to walk through a flow or reach a state you cannot get to by looking. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Snapshot again afterwards: the click is not done until you have seen what it did.',
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
    description: 'Put text into a field on a page, to fill a form or search for something. Replaces what is there rather than appending. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Set submit to press Enter afterwards.',
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
    description: 'See and operate native applications on this machine — anything outside a web page, including BOSS itself. Reach for it when a question is about what is on screen, when you want to check how a desktop app looks or behaves, or when a change you made shows up in an app rather than a browser. Looking is always available: list_apps and list_windows find what is running, get_window_state and get_desktop_state describe it, screenshot and zoom show it. Inspection screenshots are returned to you but hidden from the transcript by default; set showInTranscript only when the user asked to see that specific screenshot. Acting needs Automatic QA: click, type_text, press_key, hotkey, scroll, wait. Look before you act, and look again afterwards — an action you have not verified is not finished.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'screenshot', 'zoom', 'click', 'type_text', 'press_key', 'hotkey', 'scroll', 'wait'] },
        arguments: { type: 'object', additionalProperties: true },
        showInTranscript: {
          type: 'boolean',
          default: false,
          description: 'Show this call\'s screenshot to the user. Leave false for internal inspection.'
        }
      },
      required: ['operation'],
      additionalProperties: false
    },
    readOnly: false
  }
]
