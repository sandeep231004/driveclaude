import fs from 'node:fs'
import net from 'node:net'
import {
  DEFAULT_MODEL,
  PID_FILE,
  SOCKET,
  ensureDirs,
  forgetSession,
  readSessions,
  rememberSession,
  resolveCwd,
} from './state.mjs'
import { Session } from './session.mjs'

/** cwd -> Session. The daemon outlives Codex, so these stay alive between runs. */
const sessions = new Map()

/** Set once the server is listening, so every exit path clears the same files. */
let removeRuntimeFiles = () => {}

function ensureSession(cwd, { model, fresh = false } = {}) {
  const existing = sessions.get(cwd)
  if (existing && existing.status !== 'exited') {
    if (!fresh) return existing
    // fresh must win even over a live session — end it and drop it so the
    // code below builds a genuinely new one instead of handing this back.
    existing.end()
    sessions.delete(cwd)
  }

  if (fresh) forgetSession(cwd)
  const remembered = fresh ? null : readSessions()[cwd]
  const session = new Session({
    cwd,
    model: model || remembered?.model || DEFAULT_MODEL,
    sessionId: remembered?.sessionId || null,
  }).start()

  sessions.set(cwd, session)
  rememberSession(cwd, { sessionId: session.sessionId, model: session.model })
  return session
}

function requireSession(cwd) {
  const s = sessions.get(cwd)
  if (!s) throw new Error(`no live session for ${cwd} — send a message to start one`)
  return s
}

const ops = {
  ping: () => ({ pid: process.pid, sessions: sessions.size }),

  send: ({ cwd, message, model, fresh }) => {
    const dir = resolveCwd(cwd)
    if (!message || !message.trim()) throw new Error('message is required')
    const session = ensureSession(dir, { model, fresh })
    const { queued, cursor } = session.send(message)
    return { ...session.snapshot(), queued, cursorBefore: cursor }
  },

  read: ({ cwd, since = 0 }) => {
    const dir = resolveCwd(cwd)
    const session = requireSession(dir)
    return { ...session.snapshot(), events: session.since(since) }
  },

  info: ({ cwd }) => {
    const dir = resolveCwd(cwd)
    const session = sessions.get(dir)
    return { cwd: dir, remembered: readSessions()[dir] || null, live: session?.snapshot() || null }
  },

  list: () => ({
    sessions: [...sessions.values()].map((s) => s.snapshot()),
    remembered: readSessions(),
  }),

  end: ({ cwd }) => {
    const dir = resolveCwd(cwd)
    const session = sessions.get(dir)
    if (!session) return { cwd: dir, ended: false }
    session.end()
    sessions.delete(dir)
    return { cwd: dir, ended: true, sessionId: session.sessionId }
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

  if (fs.existsSync(SOCKET)) {
    // Never hijack a healthy daemon: taking its address would strand its live
    // sessions as unreachable orphans. Only clear a dead socket.
    if (await socketAlive()) {
      process.stdout.write('a daemon is already running — nothing to do\n')
      return null
    }
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
    try {
      fs.unlinkSync(SOCKET)
    } catch {}
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
