import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = path.join(ROOT, 'bin', 'driveclaude.mjs')
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function request(socketPath, op, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buf = ''
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'test', op, args })}\n`))
    socket.on('data', (chunk) => {
      buf += chunk
      const newline = buf.indexOf('\n')
      if (newline === -1) return
      socket.end()
      const response = JSON.parse(buf.slice(0, newline))
      response.ok ? resolve(response.data) : reject(new Error(response.error))
    })
    socket.on('error', reject)
    socket.setTimeout(10000, () => {
      socket.destroy()
      reject(new Error(`daemon timed out handling ${op}`))
    })
  })
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(25)
  }
  throw new Error(message)
}

async function startDaemon(home, delay = 0) {
  const socketPath = path.join(home, 'daemon.sock')
  const child = spawn(process.execPath, [CLI, 'daemon'], {
    env: {
      ...process.env,
      DRIVECLAUDE_HOME: home,
      DRIVECLAUDE_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_RESPONSE_DELAY_MS: String(delay),
    },
    stdio: 'ignore',
  })
  await waitFor(() => fs.existsSync(socketPath), 'daemon socket never appeared')
  return { child, socketPath }
}

async function stopDaemon(daemon) {
  if (!daemon || daemon.child.exitCode !== null) return
  try {
    await request(daemon.socketPath, 'shutdown')
  } catch {}
  await waitFor(() => daemon.child.exitCode !== null, 'daemon did not stop', 3000).catch(() => {
    daemon.child.kill('SIGKILL')
  })
}

async function waitForTurns(socketPath, cwd, turns) {
  return waitFor(async () => {
    const snapshot = await request(socketPath, 'read', { cwd, since: 0 })
    return snapshot.turns >= turns ? snapshot : null
  }, `session never completed ${turns} turn(s)`)
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-persistent-home-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-persistent-cwd-'))
  let daemon

  try {
    fs.chmodSync(FAKE_CLAUDE, 0o755)
    daemon = await startDaemon(home, 150)

    const first = await request(daemon.socketPath, 'send', { cwd, message: 'first' })
    const second = await request(daemon.socketPath, 'send', { cwd, message: 'second' })
    assert.equal(second.sessionId, first.sessionId, 'normal sends must reuse the live session')
    assert.equal(second.queued, true, 'a mid-turn send must be reported as queued')

    const afterOne = await waitFor(async () => {
      const snapshot = await request(daemon.socketPath, 'read', { cwd, since: 0 })
      return snapshot.turns === 1 ? snapshot : null
    }, 'first queued turn never completed')
    assert.equal(afterOne.status, 'working', 'session must stay working while a queued turn remains')
    assert.equal(afterOne.queued, 0, 'the completed turn must consume exactly one queue entry')

    const afterTwo = await waitForTurns(daemon.socketPath, cwd, 2)
    assert.equal(afterTwo.status, 'idle')
    assert.equal(afterTwo.queued, 0)
    assert(afterTwo.events.some((event) => event.kind === 'tool' && event.name === 'Read'))
    assert(afterTwo.events.some((event) => event.kind === 'text' && event.text.includes('ack turn 2')))
    assert(afterTwo.events.some((event) => event.kind === 'result' && event.costUsd === 0.001))

    const cursor = afterTwo.cursor
    await request(daemon.socketPath, 'send', { cwd, message: 'third' })
    const afterThree = await waitForTurns(daemon.socketPath, cwd, 3)
    const incremental = await request(daemon.socketPath, 'read', { cwd, since: cursor })
    assert(incremental.events.length > 0, 'cursor reads must return new events')
    assert(incremental.events.every((event) => event.seq > cursor))
    assert.equal(afterThree.sessionId, first.sessionId)

    const ended = await request(daemon.socketPath, 'end', { cwd })
    assert.equal(ended.sessionId, first.sessionId)
    const endedInfo = await request(daemon.socketPath, 'info', { cwd })
    assert.equal(endedInfo.live, null)
    assert.equal(endedInfo.remembered.sessionId, first.sessionId, 'end must retain resumability')

    const resumedAfterEnd = await request(daemon.socketPath, 'send', { cwd, message: 'after end' })
    assert.equal(resumedAfterEnd.sessionId, first.sessionId)
    assert.equal(resumedAfterEnd.resumed, true)
    await waitForTurns(daemon.socketPath, cwd, 1)

    await stopDaemon(daemon)
    daemon = await startDaemon(home)
    const resumedAfterRestart = await request(daemon.socketPath, 'send', { cwd, message: 'after restart' })
    assert.equal(resumedAfterRestart.sessionId, first.sessionId, 'daemon restart must resume remembered id')
    assert.equal(resumedAfterRestart.resumed, true)
    await waitForTurns(daemon.socketPath, cwd, 1)

    await request(daemon.socketPath, 'send', { cwd, message: 'CRASH_NOW' })
    await waitFor(async () => {
      const snapshot = await request(daemon.socketPath, 'read', { cwd, since: 0 })
      return snapshot.status === 'exited' ? snapshot : null
    }, 'fake Claude never crashed')
    const resumedAfterCrash = await request(daemon.socketPath, 'send', { cwd, message: 'after crash' })
    assert.equal(resumedAfterCrash.sessionId, first.sessionId, 'crash recovery must resume the same id')
    assert.equal(resumedAfterCrash.resumed, true)
    await waitForTurns(daemon.socketPath, cwd, 1)

    const fresh = await request(daemon.socketPath, 'send', { cwd, message: 'intentional reset', fresh: true })
    assert.notEqual(fresh.sessionId, first.sessionId, 'fresh alone must replace the conversation id')

    console.log('PASS: persistent stream-json lifecycle, queueing, restart, crash recovery, and fresh reset')
  } finally {
    await stopDaemon(daemon)
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('FAIL:', error)
  process.exitCode = 1
})
