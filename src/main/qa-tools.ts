import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isComputerUseActionOperation, type QaAgentTool, type QaPolicy, type QaPolicyState, type AgentToolResult } from '@shared/qa'
import type { BrowseManager } from './browse'
import type { ComputerUse } from './computer-use'

interface StoredQaState {
  version: 2
  defaultPolicy: QaPolicy
  policies: Record<string, QaPolicy>
}

interface LegacyQaState {
  version: 1
  policies: Record<string, QaPolicy>
}

function stateFile(): string {
  return join(app.getPath('userData'), 'qa-policies.json')
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringArg(value: unknown, key: string): string {
  const result = objectArg(value)[key]
  return typeof result === 'string' ? result.trim() : ''
}

function booleanArg(value: unknown, key: string): boolean {
  return objectArg(value)[key] === true
}

export class QaTools {
  private readonly policies: Record<string, QaPolicy> = {}
  private defaultPolicy: QaPolicy = 'suggest'

  constructor(
    private readonly getBrowser: () => BrowseManager | null,
    private readonly computer: ComputerUse
  ) {
    try {
      const stored = JSON.parse(readFileSync(stateFile(), 'utf8')) as StoredQaState | LegacyQaState
      if (stored.policies) Object.assign(this.policies, stored.policies)
      if (stored.version === 2) this.defaultPolicy = stored.defaultPolicy
    } catch {
      /* New installs start in Suggest mode. */
    }
  }

  policy(threadId: string): QaPolicy {
    return this.policies[threadId] ?? this.defaultPolicy
  }

  default(): QaPolicy {
    return this.defaultPolicy
  }

  async setDefault(policy: QaPolicy): Promise<QaPolicy> {
    this.defaultPolicy = policy
    this.save()
    if (policy === 'automatic' && !this.computer.status.enabled) await this.computer.setEnabled(true)
    return this.defaultPolicy
  }

  status(threadId: string): QaPolicyState {
    const browser = this.getBrowser()
    return {
      threadId,
      policy: this.policy(threadId),
      defaultPolicy: this.defaultPolicy,
      source: Object.prototype.hasOwnProperty.call(this.policies, threadId) ? 'thread' : 'global',
      browserAvailable: Boolean(browser && browser.agentTabs().length > 0),
      computerAvailable: this.computer.status.supported,
      computerEnabled: this.computer.status.enabled
    }
  }

  async setPolicy(threadId: string, policy: QaPolicy | null): Promise<QaPolicyState> {
    if (policy === null) delete this.policies[threadId]
    else this.policies[threadId] = policy
    this.save()
    if (this.policy(threadId) === 'automatic' && !this.computer.status.enabled) await this.computer.setEnabled(true)
    return this.status(threadId)
  }

  async call(threadId: string, tool: QaAgentTool, args: unknown): Promise<AgentToolResult> {
    const policy = this.policy(threadId)
    if (policy === 'off') throw new Error('QA tools are disabled for this thread. Ask the user to change QA to Suggest or Automatic.')
    const browser = this.getBrowser()
    switch (tool) {
      case 'boss_browser_tabs':
        return this.text(JSON.stringify(browser?.agentTabs() ?? [], null, 2))
      case 'boss_browser_snapshot':
        return this.requireBrowser(browser).agentSnapshot(stringArg(args, 'tabId'))
      case 'boss_browser_screenshot':
        return this.requireBrowser(browser).agentScreenshot(stringArg(args, 'tabId'))
      case 'boss_browser_navigate':
        this.requireAutomatic(policy, 'navigate the browser')
        return this.requireBrowser(browser).agentNavigate(stringArg(args, 'tabId'), stringArg(args, 'url'))
      case 'boss_browser_click':
        this.requireAutomatic(policy, 'click in the browser')
        return this.requireBrowser(browser).agentClick(stringArg(args, 'tabId'), stringArg(args, 'ref'))
      case 'boss_browser_type':
        this.requireAutomatic(policy, 'type in the browser')
        return this.requireBrowser(browser).agentType(stringArg(args, 'tabId'), stringArg(args, 'ref'), stringArg(args, 'text'), booleanArg(args, 'submit'))
      case 'boss_computer': {
        const operation = stringArg(args, 'operation')
        if (isComputerUseActionOperation(operation)) this.requireAutomatic(policy, `run computer action ${operation}`)
        const input = objectArg(objectArg(args).arguments)
        return this.computer.call(operation, input)
      }
    }
  }

  private requireBrowser(browser: BrowseManager | null): BrowseManager {
    if (!browser) throw new Error('The BOSS browser is not ready.')
    return browser
  }

  private requireAutomatic(policy: QaPolicy, action: string): void {
    if (policy !== 'automatic') throw new Error(`QA is in Suggest mode. Ask the user to enable Automatic QA before you ${action}.`)
  }

  private text(text: string): AgentToolResult {
    return { __bossToolResult: true, text }
  }

  private save(): void {
    try {
      writeFileSync(stateFile(), JSON.stringify({ version: 2, defaultPolicy: this.defaultPolicy, policies: this.policies } satisfies StoredQaState, null, 2))
    } catch {
      /* Policy remains enforced in memory if persistence is unavailable. */
    }
  }
}
