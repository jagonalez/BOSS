/**
 * The stored project list after the user drags a row.
 *
 * `listed` is the order the renderer drew. It is taken as given, then anything
 * already stored but absent from it is appended. Two lists differ because the
 * sidebar shows more than BOSS stores: it also lists projects it learned from a
 * backend's session history, which BOSS was never asked to open, and it hides
 * stored projects whose folder has gone. So a path the renderer placed is kept
 * even when it is new, and a stored path it never drew is not read as a
 * removal.
 */
export function orderedProjects(listed: string[], known: string[]): string[] {
  const ordered = listed.filter(
    (path, index) => typeof path === 'string' && path.length > 0 && listed.indexOf(path) === index
  )
  const seen = new Set(ordered)
  return [...ordered, ...known.filter((path) => !seen.has(path))]
}
