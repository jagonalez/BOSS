import type { Backend } from './backend'

export class BackendManager {
  private backend: Backend
  private engine: 'opencode' | 'pi'

  constructor(
    private readonly createOpenCode: () => Backend,
    private readonly createPi: (cwd?: string) => Backend,
    initial: 'opencode' | 'pi' = 'opencode'
  ) {
    this.engine = initial
    this.backend = initial === 'opencode' ? this.createOpenCode() : this.createPi()
  }

  get current(): Backend {
    return this.backend
  }

  get engineName(): 'opencode' | 'pi' {
    return this.engine
  }

  async setEngine(engine: 'opencode' | 'pi', cwd?: string): Promise<void> {
    if (engine === this.engine) return
    await this.backend.stop().catch(() => {})
    this.engine = engine
    this.backend = engine === 'opencode' ? this.createOpenCode() : this.createPi(cwd)
    await this.backend.start()
  }
}
