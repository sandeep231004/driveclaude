import fs from 'node:fs'
import net from 'node:net'
import {
  DEFAULT_MODEL,
  IS_WINDOWS,
  PID_FILE,
  SOCKET,
  ensureDirs,
  readSessionRegistry,
  rememberSession,
  findTranscript,
  resolveCwd,
} from './state.mjs'
import { Session } from './session.mjs'

/** session id -> Session. More than one session may work in the same directory. */
const sessions = new Map()

/** Set once the server is listening, so every exit path clears the same files. */
let removeRuntimeFiles = () => {}

function liveMatchesForCwd(cwd) {
  return [...sessions.values()].filter((s) => s.cwd === cwd && s.status !== 'exited')
}

function uniqueByPrefix(records, sessionId) {
  const exact = records.find((record) => record.sessionId === sessionId)
  if (exact) return exact
  const matches = records.filter((record) => record.sessionId.startsWith(sessionId))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`session id prefix ${sessionId} is ambiguous`)
  return null
}

function resolveLiveSession({ sessionId, cwd }, { includeExited = false } = {}) {
  if (sessionId) {
    const match = uniqueByPrefix(
      [...sessions.values()].filter((s) => includeExited || s.status !== 'exited'),
      sessionId,
    )
    if (match) return match
    throw new Error(`no live session ${sessionId}`)
  }

  if (!cwd) throw new Error('sessionId or cwd is required')
  let matches = liveMatchesForCwd(cwd)
  if (includeExited && matches.length === 0) {
    matches = [...sessions.values()].filter((s) => s.cwd === cwd && s.status === 'exited')
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    const ids = matches.map((s) => s.sessionId.slice(0, 8)).join(', ')
    throw new Error(`multiple live sessions for ${cwd} (${ids}) — specify a session id`)
  }
  throw new Error(`no live session for ${cwd} — send a message to start one`)
}

function ensureSession(cwd, { model, fresh = false, sessionId } = {}) {
  if (sessionId) {
    if (fresh) throw new Error('fresh and sessionId cannot be used together')
    const live = uniqueByPrefix(
      [...sessions.values()].filter((s) => s.status !== 'exited'),
      sessionId,
    )
    if (live) return live

    const remembered = uniqueByPrefix(Object.values(readSessionRegistry().sessions), sessionId)
    if (!remembered) throw new Error(`no remembered session ${sessionId} — adopt it first`)
    if (cwd && remembered.cwd !== cwd) {
      throw new Error(`session ${sessionId} belongs to ${remembered.cwd}, not ${cwd}`)
    }
    sessionId = remembered.sessionId
    cwd = remembered.cwd
    model ||= remembered.model
  }

  if (!fresh && !sessionId) {
    const live = liveMatchesForCwd(cwd)
    if (live.length === 1) return live[0]
    if (live.length > 1) {
      const ids = live.map((s) => s.sessionId.slice(0, 8)).join(', ')
      throw new Error(`multiple live sessions for ${cwd} (${ids}) — specify sessionId`)
    }
  }

  const registry = readSessionRegistry()
  const rememberedId = fresh ? null : sessionId || registry.defaults[cwd]
  const remembered = rememberedId ? registry.sessions[rememberedId] : null
  const session = new Session({
    cwd,
    model: model || remembered?.model || DEFAULT_MODEL,
    sessionId: rememberedId || null,
  }).start()

  sessions.set(session.sessionId, session)
  rememberSession(cwd, { sessionId: session.sessionId, model: session.model })
  return session
}

const ops = {
  ping: () => ({ pid: process.pid, sessions: [...sessions.values()].filter((s) => s.status !== 'exited').length }),

  send: ({ cwd, sessionId, message, model, fresh }) => {
    const dir = cwd ? resolveCwd(cwd) : null
    if (!dir && !sessionId) throw new Error('cwd is required when starting a session')
    if (!message || !message.trim()) throw new Error('message is required')
    const session = ensureSession(dir, { model, fresh, sessionId })
    const { queued, cursor } = session.send(message)
    return { ...session.snapshot(), queued, cursorBefore: cursor }
  },

  read: ({ cwd, sessionId, since = 0 }) => {
    const dir = cwd ? resolveCwd(cwd) : null
    const session = resolveLiveSession({ sessionId, cwd: dir }, { includeExited: true })
    return { ...session.snapshot(), events: session.since(since) }
  },

  info: ({ cwd, sessionId }) => {
    const dir = cwd ? resolveCwd(cwd) : null
    const registry = readSessionRegistry()
    if (sessionId) {
      let live = null
      try {
        live = resolveLiveSession({ sessionId })
      } catch {}
      const remembered = uniqueByPrefix(Object.values(registry.sessions), live?.sessionId || sessionId)
      if (!live && !remembered) throw new Error(`no session ${sessionId}`)
      return { cwd: live?.cwd || remembered?.cwd || dir, remembered, live: live?.snapshot() || null }
    }
    const live = liveMatchesForCwd(dir)
    if (live.length > 1) {
      const ids = live.map((s) => s.sessionId.slice(0, 8)).join(', ')
      throw new Error(`multiple live sessions for ${dir} (${ids}) — specify a session id`)
    }
    const rememberedId = registry.defaults[dir]
    return {
      cwd: dir,
      remembered: rememberedId ? registry.sessions[rememberedId] || null : null,
      live: live[0]?.snapshot() || null,
    }
  },

  list: () => ({
    sessions: [...sessions.values()].filter((s) => s.status !== 'exited').map((s) => s.snapshot()),
    remembered: Object.values(readSessionRegistry().sessions),
  }),

  adopt: ({ cwd, sessionId, model }) => {
    const dir = resolveCwd(cwd)
    if (!sessionId || !sessionId.trim()) throw new Error('sessionId is required')
    if (sessions.get(sessionId)?.status !== 'exited' && sessions.has(sessionId)) {
      throw new Error(`session ${sessionId} is already controlled by driveclaude`)
    }
    const transcript = findTranscript(dir, sessionId)
    if (!transcript.found) {
      throw new Error(`no Claude transcript found for session ${sessionId}`)
    }
    // Right id, wrong directory: resuming here would carry the conversation
    // into a repo it was never working in, so say where it actually belongs.
    if (transcript.cwd && transcript.cwd !== dir) {
      throw new Error(`session ${sessionId} belongs to ${transcript.cwd}, not ${dir}`)
    }
    const session = new Session({ cwd: dir, model: model || DEFAULT_MODEL, sessionId }).start()
    sessions.set(session.sessionId, session)
    rememberSession(dir, { sessionId: session.sessionId, model: session.model })
    return session.snapshot()
  },

  end: ({ cwd, sessionId }) => {
    const dir = cwd ? resolveCwd(cwd) : null
    if (!sessionId && liveMatchesForCwd(dir).length === 0) return { cwd: dir, ended: false }
    const session = resolveLiveSession({ sessionId, cwd: dir })
    session.end()
    sessions.delete(session.sessionId)
    return { cwd: session.cwd, ended: true, sessionId: session.sessionId }
  },

  shutdown: () => {
    for (const s of sessions.values()) s.end()
    // Clear the socket and pid file too, or the next start finds a stale socket
    // and every client wastes a connect attempt on a daemon that is long gone.
    setTimeout(() => {
      removeRuntimeFiles()
      process.exit(0)
    }, 200)
    return { stopping: true }
  },
}

function handle(socket) {
  let buf = ''
  socket.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let req
      try {
        req = JSON.parse(line)
      } catch {
        continue
      }
      let res
      try {
        const op = ops[req.op]
        if (!op) throw new Error(`unknown op: ${req.op}`)
        res = { id: req.id, ok: true, data: op(req.args || {}) }
      } catch (e) {
        res = { id: req.id, ok: false, error: e.message }
      }
      socket.write(`${JSON.stringify(res)}\n`)
    }
  })
  socket.on('error', () => {})
}

/** Is something actually listening, or is this a socket a crashed daemon left behind? */
function socketAlive() {
  return new Promise((resolve) => {
    const probe = net.createConnection(SOCKET)
    probe.on('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.on('error', () => resolve(false))
  })
}

export async function startDaemon() {
  ensureDirs()

  // Never hijack a healthy daemon: taking its address would strand its live
  // sessions as unreachable orphans. Probe first, whatever the platform —
  // a Windows named pipe has no file to look for, so an existence check
  // would silently skip this and collide on listen().
  if (await socketAlive()) {
    process.stdout.write('a daemon is already running — nothing to do\n')
    return null
  }
  // A dead Unix daemon leaves its socket file behind and it must be cleared
  // before listening. Named pipes vanish with the process, so there is nothing
  // to clean up on Windows.
  if (!IS_WINDOWS && fs.existsSync(SOCKET)) {
    try {
      fs.unlinkSync(SOCKET)
    } catch {}
  }

  const server = net.createServer(handle)
  server.listen(SOCKET, () => {
    fs.writeFileSync(PID_FILE, String(process.pid))
    process.stdout.write(`driveclaude daemon listening on ${SOCKET} (pid ${process.pid})\n`)
  })

  removeRuntimeFiles = () => {
    if (!IS_WINDOWS) {
      try {
        fs.unlinkSync(SOCKET)
      } catch {}
    }
    try {
      fs.unlinkSync(PID_FILE)
    } catch {}
  }

  const shutdown = () => {
    for (const s of sessions.values()) s.end()
    try {
      server.close()
    } catch {}
    removeRuntimeFiles()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return server
}
