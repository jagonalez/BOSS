/** Map an Electron ASAR virtual path to the literal unpacked filesystem path. */
export function unpackedAsarPath(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}
