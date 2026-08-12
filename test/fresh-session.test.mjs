import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Regression test for: `fresh` was ignored whenever a live session already
// existed for the cwd, because ensureSession() returned the existing session
// before ever checking the fresh flag. Runs a real daemon against a fake
// `claude` binary (no network calls, no real Claude process) and drives it
// over the same socket protocol the CLI uses.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = path.join(ROOT, 'bin', 'driveclaude.mjs')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs')
fs.chmodSync(FAKE_CLAUDE, 0o755)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function requestOnce(socketPath, op, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buf = ''
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: '1', op, args })}\n`))
    socket.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      socket.end()
      let res
      try {
        res = JSON.parse(buf.slice(0, nl))
      } catch (e) {
        reject(e)
        return
      }
      res.ok ? resolve(res.data) : reject(new Error(res.error))
    })
    socket.on('error', reject)
    socket.setTimeout(10000, () => {
      socket.destroy()
      reject(new Error('daemon did not respond'))
    })
  })
}

async function waitForSocket(socketPath) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(socketPath)) return
    await sleep(50)
  }
  throw new Error('daemon socket never appeared')
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-fresh-home-'))
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-fresh-cwd-a-'))
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-fresh-cwd-b-'))
  const socketPath = path.join(home, 'daemon.sock')

  const daemon = spawn(process.execPath, [CLI, 'daemon'], {
    env: { ...process.env, DRIVECLAUDE_HOME: home, DRIVECLAUDE_CLAUDE_BIN: FAKE_CLAUDE },
    stdio: 'ignore',
  })

  try {
    await waitForSocket(socketPath)
    const send = (cwd, message, extra) => requestOnce(socketPath, 'send', { cwd, message, ...extra })

    const a1 = await send(cwdA, 'hi')
    const a2 = await send(cwdA, 'hi again')
    assert.equal(a2.sessionId, a1.sessionId, 'repeated normal send should reuse the session id')

    // The fake claude process for cwdA is still alive here — this is exactly
    // the "fresh ignored for a live session" bug scenario.
    const a3 = await send(cwdA, 'start over', { fresh: true })
    assert.notEqual(a3.sessionId, a2.sessionId, 'fresh send must start a new session id even while the old one is live')

    const info = await requestOnce(socketPath, 'info', { cwd: cwdA })
    assert.equal(info.remembered?.sessionId, a3.sessionId, 'the remembered id must be forgotten and replaced, not left pointing at the old session')

    const b1 = await send(cwdB, 'hi b')
    const b2 = await send(cwdB, 'hi b again')
    assert.equal(b2.sessionId, b1.sessionId, "cwdA's fresh must not disturb an unrelated cwd's session")

    console.log('PASS: repeated normal send reuses the session id')
    console.log('PASS: fresh send replaces a live session with a genuinely new id')
    console.log('PASS: fresh forgets the remembered id for that cwd')
    console.log('PASS: other cwd sessions are unaffected')
    console.log('all fresh-session regression tests passed')
  } finally {
    daemon.kill('SIGTERM')
    await sleep(300)
    try {
      process.kill(daemon.pid, 0)
      daemon.kill('SIGKILL')
    } catch {}
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwdA, { recursive: true, force: true })
    fs.rmSync(cwdB, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exitCode = 1
})
