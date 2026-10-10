import { spawn } from 'node:child_process'
import { prepareRuntime } from './prepare-runtime.mjs'

await prepareRuntime()

// Run the two local services without a shell or an additional dependency.
const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else child.kill('SIGTERM')
  }
}
for (const [entry, args] of [
  [
    'wrangler/bin/wrangler.js',
    ['dev', '--config', 'wrangler.dev.jsonc', '--local', '--ip', '127.0.0.1'],
  ],
  ['vite/bin/vite.js', ['--host', '127.0.0.1']],
]) {
  const child = spawn(process.execPath, [`node_modules/${entry}`, ...args], {
    stdio: 'inherit',
    windowsHide: true,
  })
  children.push(child)
  child.on('error', (error) => {
    console.error('Local service failed to start:', error.message)
    stop(1)
  })
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1)
  })
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
console.log('Frontend: http://127.0.0.1:5173 — Worker: http://127.0.0.1:8787')
console.log('Wait for both services to be ready. Press Ctrl+C to stop both.')
