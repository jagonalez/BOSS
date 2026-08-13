export type McpTransport = 'stdio' | 'http'

export interface McpConnectionInput {
  name: string
  transport: McpTransport
  /** stdio: executable and arguments. */
  command?: string
  args?: string[]
  /** stdio: environment variables; values are stored encrypted. */
  env?: Record<string, string>
  /** http: server URL. */
  url?: string
  /** http: credential sent in the Authorization header; stored encrypted. */
  authToken?: string
  /** http: Authorization scheme prefix ("Bearer", "Basic", "token", …). Empty sends the bare token. */
  authScheme?: string
  /** http: extra request headers; values are stored encrypted. */
  headers?: Record<string, string>
}

export interface McpConnection extends McpConnectionInput {
  id: string
  /** Namespace used in tool names: mcp_<slug>_<tool>. */
  slug: string
  enabled: boolean
  createdAt: number
}

export type McpConnectionStatus = 'disabled' | 'starting' | 'connected' | 'error'

export interface McpToolInfo {
  name: string
  description?: string
}

/** Connection plus live state, with secret values masked for the renderer. */
export interface McpConnectionView {
  connection: McpConnection
  status: McpConnectionStatus
  error?: string
  tools: McpToolInfo[]
}

export interface McpImportCandidate {
  source: string
  input: McpConnectionInput
  /** Set when the same command/url is already configured in BOSS */
  alreadyConfigured: boolean
}

export const MCP_TOOL_PREFIX = 'mcp_'
export const SECRET_MASK = '••••••'
