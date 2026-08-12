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
