export interface CodexToolOutputBlock {
  type?: string
  text?: string
  url?: string
  imageUrl?: string
  image_url?: string
}

export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

// Mirrors the formats ImageStore can serve. Keeping the rejection here means a
// Codex data URL that BOSS cannot display becomes a short explanation before it
// can ever reach transcript storage as base64.
const DISPLAYABLE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function imageContent(url: string | undefined): ToolResultContentBlock {
  if (!url?.startsWith('data:')) {
    return { type: 'text', text: '[Image omitted: Codex returned a non-embedded image URL.]' }
  }
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match) return { type: 'text', text: '[Image omitted: Codex returned an unreadable data URL.]' }
  const [, mimeType, data] = match
  if (!DISPLAYABLE_IMAGE_MIMES.has(mimeType)) {
    return { type: 'text', text: `[Image omitted: ${mimeType} is not a supported image format.]` }
  }
  return { type: 'image', mimeType, data }
}

/** Convert Codex app-server output without losing the order of its blocks.
 *
 * custom_tool_call_output uses snake_case input_text/input_image/image_url,
 * while dynamic tool results use the older camelCase equivalents. Both belong
 * on the manager's existing content-block image path. Text-only results retain
 * their compact string representation; mixed image results remain an ordered
 * block array so each image can be lifted into a transcript file part. */
export function codexToolOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output
  const blocks: ToolResultContentBlock[] = []
  let containsImage = false

  for (const value of output) {
    if (!value || typeof value !== 'object') continue
    const item = value as CodexToolOutputBlock
    if (item.type === 'input_image' || item.type === 'inputImage' || item.type === 'image') {
      containsImage = true
      blocks.push(imageContent(item.image_url ?? item.imageUrl ?? item.url))
      continue
    }
    if (typeof item.text === 'string' && item.text) blocks.push({ type: 'text', text: item.text })
  }

  if (!containsImage) {
    return blocks
      .filter((block): block is Extract<ToolResultContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  return blocks
}
