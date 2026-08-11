import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME = process.env.BRIDGE_HOME || path.join(os.homedir(), '.bridge')
export const TASKS_DIR = path.join(HOME, 'tasks')
const SESSIONS_FILE = path.join(HOME, 'sessions.json')

function ensure() {
  fs.mkdirSync(TASKS_DIR, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensure()
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/** Sessions are keyed by the absolute working directory they operate on. */
export function readSessions() {
  return readJson(SESSIONS_FILE, {})
}

export function getSession(cwd) {
  return readSessions()[cwd] || null
}

export function saveSession(cwd, session) {
  const all = readSessions()
  all[cwd] = session
  writeJson(SESSIONS_FILE, all)
}

export function clearSession(cwd) {
  const all = readSessions()
  delete all[cwd]
  writeJson(SESSIONS_FILE, all)
}

export const taskFile = (id) => path.join(TASKS_DIR, `${id}.json`)
export const logFile = (id) => path.join(TASKS_DIR, `${id}.log`)
export const errFile = (id) => path.join(TASKS_DIR, `${id}.err`)

export function saveTask(task) {
  writeJson(taskFile(task.id), task)
  return task
}

export function readTaskRecord(id) {
  return readJson(taskFile(id), null)
}

export function listTaskRecords({ cwd, limit = 20 } = {}) {
  ensure()
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(TASKS_DIR, f), null))
    .filter(Boolean)
    .filter((t) => (cwd ? t.cwd === cwd : true))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
}

export function newTaskId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export { ensure as ensureStateDirs }
