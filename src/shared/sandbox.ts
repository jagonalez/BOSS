/** Preferences for the sandbox BOSS asks a backend to run its agent in. */
export interface SandboxSettings {
  /** Let an agent reach the network from inside the sandbox. Off blocks every
   *  outbound request, which stops `gh pr create`, `npm install`, and `curl`
   *  alike. It does not stop `git push`, so it buys less isolation than it
   *  costs. Plan mode stays offline whatever this says. */
  networkAccess: boolean
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  networkAccess: true
}
