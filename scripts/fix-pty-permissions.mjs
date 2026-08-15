/** Give node-pty's spawn-helper back its executable bit.
 *
 *  node-pty ships prebuilt binaries rather than compiling on install, and npm
 *  does not preserve the executable bit when it unpacks them. spawn-helper is
 *  what posix_spawnp actually executes on macOS and Linux, so without it every
 *  terminal fails to open with "posix_spawnp failed" — an error that names the
 *  syscall and nothing that would lead you here.
 *
 *  Runs on postinstall because npm install undoes it every time. */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const prebuilds = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds')
if (!existsSync(prebuilds)) process.exit(0)

const EXECUTABLE = 0o755
let fixed = 0

for (const platform of readdirSync(prebuilds)) {
  const helper = join(prebuilds, platform, 'spawn-helper')
  if (!existsSync(helper)) continue
  // Only what is not already executable, so a normal install stays silent.
  if ((statSync(helper).mode & 0o111) !== 0) continue
  chmodSync(helper, EXECUTABLE)
  fixed += 1
  process.stdout.write(`node-pty: made ${platform}/spawn-helper executable\n`)
}

if (fixed === 0) process.exit(0)
