import type { CollaborationOverride, CollaborationPolicy } from './thread-bus'

/**
 * How a project's collaboration policy is decided.
 *
 * A project keeps an entry only when the user sets one, so a user with a
 * hundred projects manages the handful that differ rather than every project
 * they have ever opened. Everything else follows the default.
 */
export function resolvePolicy(
  policies: Record<string, CollaborationPolicy>,
  defaultPolicy: CollaborationPolicy,
  projectId: string
): CollaborationPolicy {
  return policies[projectId] ?? defaultPolicy
}

/** Whether a project's policy is its own or inherited from the default. */
export function policySource(
  policies: Record<string, CollaborationPolicy>,
  projectId: string
): 'project' | 'default' {
  return Object.prototype.hasOwnProperty.call(policies, projectId) ? 'project' : 'default'
}

/** Projects that differ from the default, named for the settings list. */
export function policyOverrides(
  policies: Record<string, CollaborationPolicy>,
  projectPaths: Record<string, string>
): CollaborationOverride[] {
  return Object.entries(policies)
    .map(([projectId, policy]) => ({ projectId, projectPath: projectPaths[projectId] ?? '', policy }))
    .sort((a, b) => a.projectPath.localeCompare(b.projectPath))
}
