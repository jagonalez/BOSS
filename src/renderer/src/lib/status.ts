import type { BackendDescriptor } from '@shared/backend'

export function serviceDegradations(
  serverUrl: string,
  serverHealthy: boolean,
  backends: BackendDescriptor[]
): string[] {
  const issues: string[] = []
  if (serverUrl && !serverHealthy) issues.push('Core project service unavailable')
  for (const backend of backends) {
    if (backend.id !== 'opencode' && backend.available && !backend.healthy) issues.push(`${backend.label} is not responding`)
  }
  return issues
}
