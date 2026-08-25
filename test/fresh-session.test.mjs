import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A fresh send creates another independently addressable session. This is what
// lets multiple supervisors work in one checkout without cwd collisions.

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

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(25)
  }
  throw new Error(message)
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-fresh-home-'))
  const cwdA = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-fresh-cwd-a-')),
  )
  const cwdB = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-fresh-cwd-b-')),
  )
  const socketPath = path.join(home, 'daemon.sock')
  const env = { ...process.env, DRIVECLAUDE_HOME: home, DRIVECLAUDE_CLAUDE_BIN: FAKE_CLAUDE }

  const daemon = spawn(process.execPath, [CLI, 'daemon'], {
    env,
    stdio: 'ignore',
  })
  let watcher

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

    const info = await requestOnce(socketPath, 'info', { sessionId: a3.sessionId })
    assert.equal(info.remembered?.sessionId, a3.sessionId, 'the new session must be remembered by its own id')

    const listed = await requestOnce(socketPath, 'list', {})
    const sameCwd = listed.sessions.filter((session) => session.cwd === cwdA)
    assert.equal(sameCwd.length, 2, 'both same-directory sessions must remain live')
    await assert.rejects(
      requestOnce(socketPath, 'read', { cwd: cwdA, since: 0 }),
      /multiple live sessions/,
      'cwd-only selection must refuse to guess between sessions',
    )

    const firstByShortId = await requestOnce(socketPath, 'read', {
      sessionId: a1.sessionId.slice(0, 8),
      since: 0,
    })
    assert.equal(firstByShortId.sessionId, a1.sessionId, 'short session ids must select the exact session')

    watcher = spawn(process.execPath, [CLI, 'watch', a1.sessionId.slice(0, 8)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let watchOutput = ''
    watcher.stdout.on('data', (chunk) => {
      watchOutput += chunk
    })
    watcher.stderr.on('data', (chunk) => {
      watchOutput += chunk
    })
    await waitFor(
      () => watchOutput.includes(a1.sessionId),
      'ID-based CLI watch never rendered the selected session',
    )
    watcher.kill('SIGINT')
    await waitFor(() => watcher.exitCode !== null, 'CLI watch did not stop after SIGINT')
    assert(!watchOutput.includes(a3.sessionId), 'watch must not leak output from a sibling session')

    await send(undefined, 'continue first', { sessionId: a1.sessionId })
    await send(undefined, 'continue second', { sessionId: a3.sessionId })

    const b1 = await send(cwdB, 'hi b')
    const b2 = await send(cwdB, 'hi b again')
    assert.equal(b2.sessionId, b1.sessionId, "cwdA's fresh must not disturb an unrelated cwd's session")

    console.log('PASS: repeated normal send reuses the session id')
    console.log('PASS: fresh starts a second live session without killing the first')
    console.log('PASS: same-directory sessions require an explicit id')
    console.log('PASS: full and short session ids target sessions independently')
    console.log('PASS: CLI watch follows only the selected same-directory session')
    console.log('PASS: other cwd sessions are unaffected')
    console.log('all fresh-session regression tests passed')
  } finally {
    if (watcher?.exitCode === null) watcher.kill('SIGKILL')
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
