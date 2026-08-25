import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

export const HOME = process.env.DRIVECLAUDE_HOME || path.join(os.homedir(), '.driveclaude')
export const LOGS_DIR = path.join(HOME, 'logs')

/**
 * Windows has no Unix domain sockets — Node listens on a named pipe instead.
 * Pipe names live in one machine-wide namespace rather than on disk, so the
 * home directory is hashed into the name. Without that, two users on the same
 * machine, or two DRIVECLAUDE_HOME values, would collide on a single daemon
 * instead of each getting their own.
 */
export function resolveSocketPath(home, platform = process.platform) {
  if (platform !== 'win32') return path.join(home, 'daemon.sock')
  const id = crypto.createHash('sha256').update(home).digest('hex').slice(0, 16)
  return `\\\\.\\pipe\\driveclaude-${id}`
}

export const SOCKET = resolveSocketPath(HOME)
export const PID_FILE = path.join(HOME, 'daemon.pid')
export const DAEMON_LOG = path.join(HOME, 'daemon.log')
const SESSIONS_FILE = path.join(HOME, 'sessions.json')

export const DEFAULT_MODEL = process.env.DRIVECLAUDE_MODEL || 'sonnet'
export const CLAUDE_BIN = process.env.DRIVECLAUDE_CLAUDE_BIN || 'claude'

export function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const emptyRegistry = () => ({ version: 2, sessions: {}, defaults: {} })

/**
 * Sessions are identified by Claude's session id, not by directory. Version 1
 * stored one record at each cwd; normalize that shape on read so upgrades keep
 * every existing remembered conversation without requiring a migration step.
 */
export function readSessionRegistry() {
  const raw = readJson(SESSIONS_FILE, {})
  if (raw?.version === 2 && raw.sessions && raw.defaults) return raw

  const registry = emptyRegistry()
  for (const [cwd, record] of Object.entries(raw || {})) {
    if (!record?.sessionId) continue
    registry.sessions[record.sessionId] = { ...record, cwd }
    registry.defaults[cwd] = record.sessionId
  }
  return registry
}

function writeSessionRegistry(registry) {
  ensureDirs()
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(registry, null, 2))
}

export function rememberSession(cwd, record, { makeDefault = true } = {}) {
  const registry = readSessionRegistry()
  const previousCwd = registry.sessions[record.sessionId]?.cwd
  if (previousCwd && previousCwd !== cwd && registry.defaults[previousCwd] === record.sessionId) {
    delete registry.defaults[previousCwd]
  }
  registry.sessions[record.sessionId] = {
    ...registry.sessions[record.sessionId],
    ...record,
    cwd,
    updatedAt: Date.now(),
  }
  if (makeDefault) registry.defaults[cwd] = record.sessionId
  writeSessionRegistry(registry)
}

export const eventLogFile = (sessionId) => path.join(LOGS_DIR, `${sessionId}.jsonl`)

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function daemonPid() {
  const pid = Number(readJson(PID_FILE, null) ?? NaN)
  return isAlive(pid) ? pid : null
}

export function resolveCwd(cwd) {
  const abs = path.resolve(cwd || process.cwd())
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${abs}`)
  }
  // macOS exposes /tmp through /private/tmp, and symlinked project paths are
  // common elsewhere. A session belongs to the physical directory, not the
  // spelling a caller happened to use. Canonicalizing here prevents one repo
  // from becoming two session namespaces and makes transcript cwd checks fair.
  return fs.realpathSync.native(abs)
}

const CLAUDE_CONFIG = path.join(os.homedir(), '.claude.json')

/**
 * A missing file is a clean install — start from {}. A file that exists but
 * won't parse is a config we don't understand, so we leave it alone rather
 * than risk clobbering it.
 */
function readClaudeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'))
  } catch (e) {
    return e.code === 'ENOENT' ? {} : null
  }
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')

/**
 * Every transcript records the absolute directory it ran in. That is the only
 * trustworthy way to tie a session id to a cwd, so read it rather than infer
 * it from the folder name. Transcripts grow to megabytes, so only the head is
 * read — the cwd appears within the first few entries.
 */
function recordedCwd(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(64 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/)
    return m ? JSON.parse(m[1]) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

/**
 * Locate Claude Code's own transcript for a session, so adopt() can verify it
 * before recording anything or spawning a process. driveclaude only reads here.
 *
 * Transcripts live at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. That
 * encoding is undocumented and lossy — it dashes out '/' and '.' alike, so
 * '/x/.claude/y' becomes '-x--claude-y' — so it is used only as a fast path.
 * When it misses we scan for the transcript by filename, which is safe because
 * session ids are uuids. Either way the cwd we report comes from the file's own
 * contents, never from the folder name.
 */
export function findTranscript(cwd, sessionId) {
  const encoded = path.join(CLAUDE_PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  let file = fs.existsSync(encoded) ? encoded : null

  if (!file) {
    let dirs = []
    try {
      dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR)
    } catch {
      return { found: false }
    }
    for (const d of dirs) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, d, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) {
        file = candidate
        break
      }
    }
  }

  return file ? { found: true, cwd: recordedCwd(file) } : { found: false }
}

/**
 * --dangerously-skip-permissions means a spawned session never shows the
 * interactive trust dialog, so the project never gets marked trusted. Left
 * unfixed, a human later running plain `claude` in that directory hits the
 * trust prompt before the session picker, which stalls "discover my session"
 * behind a dialog instead of an unmarked but reachable-by-uuid session.
 */
export function trustProject(cwd) {
  const config = readClaudeConfig()
  if (!config) return
  config.projects ||= {}
  config.projects[cwd] = { ...config.projects[cwd], hasTrustDialogAccepted: true }

  // Write-then-rename so a crash mid-write can never leave ~/.claude.json
  // truncated or half-written — the rename is atomic on the same filesystem.
  const tmp = `${CLAUDE_CONFIG}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(config))
    fs.renameSync(tmp, CLAUDE_CONFIG)
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {}
  }
}
