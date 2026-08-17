import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// adopt() takes over a Claude conversation that was started outside
// driveclaude (e.g. an interactive `claude` session run by hand). It must:
//   - refuse a sessionId with no matching Claude transcript on disk, without
//     writing anything to driveclaude's own state;
//   - on a valid transcript, resume it and behave like any driveclaude
//     session from then on (send/read work normally);
//   - refuse when a live driveclaude session already exists for that cwd;
//   - overwrite a remembered (non-live) session for that cwd.
//
// Runs a real daemon against a fake `claude` binary. `~/.claude/projects` is
// where the real Claude CLI stores transcripts (`<cwd with / -> ->/<id>.jsonl`);
// this test fakes that layout under an isolated HOME so it never touches the
// real one.

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
    const value = await predicate()
    if (value) return value
    await sleep(25)
  }
  throw new Error(message)
}

// Mirrors how the real Claude CLI stores a transcript: the folder name is the
// cwd with every non-alphanumeric character dashed out (so '.' collapses just
// like '/'), and the entries themselves record the true absolute cwd.
function seedTranscript(home, cwd, sessionId) {
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'queue-operation', sessionId })}\n` +
      `${JSON.stringify({ type: 'user', sessionId, cwd })}\n`,
  )
}

async function main() {
  // HOME fakes ~/.claude/projects (what transcriptExists reads). DRIVECLAUDE_HOME
  // fakes ~/.driveclaude (the daemon's own state) — kept separate on purpose,
  // same as every other test in this suite.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-adopt-home-'))
  const driveclaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-adopt-state-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-adopt-cwd-'))
  const socketPath = path.join(driveclaudeHome, 'daemon.sock')

  const daemon = spawn(process.execPath, [CLI, 'daemon'], {
    env: { ...process.env, HOME: home, DRIVECLAUDE_HOME: driveclaudeHome, DRIVECLAUDE_CLAUDE_BIN: FAKE_CLAUDE },
    stdio: 'ignore',
  })

  try {
    await waitForSocket(socketPath)
    const adopt = (sessionId, extra) => requestOnce(socketPath, 'adopt', { cwd, sessionId, ...extra })

    // 1. no matching transcript -> clean error, nothing persisted
    const ghostId = randomUUID()
    await assert.rejects(
      adopt(ghostId),
      /no Claude transcript found/,
      'adopting a sessionId with no transcript must fail fast',
    )
    const infoAfterMiss = await requestOnce(socketPath, 'info', { cwd })
    assert.equal(infoAfterMiss.live, null, 'a failed adopt must not create a live session')
    assert.equal(infoAfterMiss.remembered, null, 'a failed adopt must not remember anything')

    // 2. valid transcript -> adopts and behaves like a normal session after
    const idA = randomUUID()
    seedTranscript(home, cwd, idA)
    const adopted = await adopt(idA)
    assert.equal(adopted.sessionId, idA, 'adopt must resume the exact sessionId given')
    assert.equal(adopted.resumed, true, 'an adopted session is a resume, not a fresh start')

    await requestOnce(socketPath, 'send', { cwd, message: 'continue the fixes' })
    const afterSend = await waitFor(async () => {
      const snap = await requestOnce(socketPath, 'read', { cwd, since: 0 })
      return snap.turns >= 1 ? snap : null
    }, 'adopted session never completed a turn after send')
    assert.equal(afterSend.sessionId, idA)

    // 3. refuses while that cwd's adopted session is still live
    const idB = randomUUID()
    seedTranscript(home, cwd, idB)
    await assert.rejects(
      adopt(idB),
      /already live/,
      'adopt must refuse a cwd that already has a live driveclaude session',
    )

    // 4. overwrites a remembered (non-live) session for that cwd
    const ended = await requestOnce(socketPath, 'end', { cwd })
    assert.equal(ended.sessionId, idA)
    const adoptedB = await adopt(idB)
    assert.equal(adoptedB.sessionId, idB, 'adopt must succeed once the prior session is no longer live')
    const infoAfterOverwrite = await requestOnce(socketPath, 'info', { cwd })
    assert.equal(
      infoAfterOverwrite.remembered.sessionId,
      idB,
      'adopt must overwrite the remembered session for that cwd',
    )

    // 5. a cwd containing a dot still resolves. Regression: the transcript
    // lookup originally dashed out only '/', so every path with a '.' in it —
    // including any .claude/worktrees checkout — was reported as having no
    // transcript and could not be adopted at all.
    const dottedCwd = path.join(cwd, '.claude', 'worktrees', 'proj')
    fs.mkdirSync(dottedCwd, { recursive: true })
    const idDotted = randomUUID()
    seedTranscript(home, dottedCwd, idDotted)
    const adoptedDotted = await requestOnce(socketPath, 'adopt', { cwd: dottedCwd, sessionId: idDotted })
    assert.equal(adoptedDotted.sessionId, idDotted, 'a cwd containing a dot must still find its transcript')

    // 6. right session id, wrong directory -> refused, naming where it belongs.
    // Clear the live session first so this exercises the transcript check
    // rather than the already-live guard.
    await requestOnce(socketPath, 'end', { cwd })
    await assert.rejects(
      requestOnce(socketPath, 'adopt', { cwd, sessionId: idDotted }),
      new RegExp(`belongs to ${dottedCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      'adopting a session that belongs to another directory must be refused',
    )

    console.log('PASS: adopt rejects a sessionId with no matching transcript, without side effects')
    console.log('PASS: adopt resumes a valid transcript and behaves like a normal session afterwards')
    console.log('PASS: adopt refuses a cwd with an already-live driveclaude session')
    console.log('PASS: adopt overwrites a remembered (non-live) session for that cwd')
    console.log('PASS: adopt resolves a cwd containing a dot')
    console.log('PASS: adopt refuses a session that belongs to a different directory')
    console.log('all adopt regression tests passed')
  } finally {
    daemon.kill('SIGTERM')
    await sleep(300)
    try {
      process.kill(daemon.pid, 0)
      daemon.kill('SIGKILL')
    } catch {}
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(driveclaudeHome, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exitCode = 1
})
