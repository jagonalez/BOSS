export function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'Chat'
}
