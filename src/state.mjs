import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = process.env.DRIVECLAUDE_HOME || path.join(os.homedir(), '.driveclaude')
export const LOGS_DIR = path.join(HOME, 'logs')
export const SOCKET = path.join(HOME, 'daemon.sock')
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

/**
 * Session ids are remembered per directory, so a daemon restart resumes the same
 * conversation instead of starting a stranger.
 */
export function readSessions() {
  return readJson(SESSIONS_FILE, {})
}

export function rememberSession(cwd, record) {
  ensureDirs()
  const all = readSessions()
  all[cwd] = { ...all[cwd], ...record, updatedAt: Date.now() }
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2))
}

export function forgetSession(cwd) {
  ensureDirs()
  const all = readSessions()
  delete all[cwd]
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2))
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
  return abs
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
 * Claude Code's own transcript path for a session, so adopt() can check a
 * session actually exists for this cwd before recording it and spawning
 * anything. driveclaude never writes here — it only reads.
 */
export function transcriptExists(cwd, sessionId) {
  const file = path.join(CLAUDE_PROJECTS_DIR, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`)
  return fs.existsSync(file)
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
