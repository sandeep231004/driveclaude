import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  ensureStateDirs,
  errFile,
  getSession,
  logFile,
  newTaskId,
  readTaskRecord,
  saveSession,
  saveTask,
  listTaskRecords,
  clearSession,
} from './state.mjs'

export const DEFAULT_MODEL = process.env.BRIDGE_MODEL || 'sonnet'
const CLAUDE_BIN = process.env.BRIDGE_CLAUDE_BIN || 'claude'

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function resolveCwd(cwd) {
  const abs = path.resolve(cwd || process.cwd())
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${abs}`)
  }
  return abs
}

export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

export function isGitRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true'
}

/**
 * Start a delegated Claude Code turn in the background.
 *
 * The first turn for a directory mints a UUID via --session-id; every later turn
 * --resume's that same id, so Claude keeps full context across delegations (and
 * you can attach to it by hand with `claude --resume <id>`).
 */
export function startTask({ cwd, prompt, model, newSession = false, agent } = {}) {
  if (!prompt || !prompt.trim()) throw new Error('prompt is required')
  const dir = resolveCwd(cwd)
  ensureStateDirs()

  const running = listTaskRecords({ cwd: dir, limit: 10 }).find(
    (t) => t.status === 'running' && isAlive(t.pid),
  )
  if (running) {
    throw new Error(
      `a task is already running in ${dir} (task_id ${running.id}). ` +
        'Wait for it, or cancel it first — one session cannot take two turns at once.',
    )
  }

  let session = newSession ? null : getSession(dir)
  const resuming = Boolean(session?.sessionId)
  const sessionId = session?.sessionId || randomUUID()

  const id = newTaskId()
  const args = [
    '-p',
    prompt,
    '--model',
    model || DEFAULT_MODEL,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    resuming ? '--resume' : '--session-id',
    sessionId,
  ]
  if (agent) args.push('--agent', agent)

  const out = fs.openSync(logFile(id), 'w')
  const err = fs.openSync(errFile(id), 'w')
  const child = spawn(CLAUDE_BIN, args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  })
  child.unref()
  fs.closeSync(out)
  fs.closeSync(err)

  const task = saveTask({
    id,
    cwd: dir,
    prompt,
    model: model || DEFAULT_MODEL,
    sessionId,
    resumed: resuming,
    pid: child.pid,
    status: 'running',
    startedAt: Date.now(),
  })

  saveSession(dir, {
    sessionId,
    createdAt: session?.createdAt || Date.now(),
    updatedAt: Date.now(),
    turns: (session?.turns || 0) + 1,
    lastTaskId: id,
  })

  return task
}

function readLog(id) {
  let raw = ''
  try {
    raw = fs.readFileSync(logFile(id), 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      events.push(JSON.parse(s))
    } catch {
      // trailing partial line while the process is still writing
    }
  }
  return events
}

function toolTarget(name, input = {}) {
  const v =
    input.file_path ||
    input.path ||
    input.command ||
    input.pattern ||
    input.url ||
    input.description ||
    ''
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s.length > 90 ? `${s.slice(0, 90)}…` : s
}

/** Parse a task's stream-json log into a progress/result snapshot. */
export function inspectTask(id) {
  const rec = readTaskRecord(id)
  if (!rec) return null

  const events = readLog(id)
  const texts = []
  const tools = []
  const files = new Set()
  let result = null

  for (const e of events) {
    if (e.type === 'assistant') {
      for (const block of e.message?.content || []) {
        if (block.type === 'text' && block.text?.trim()) texts.push(block.text.trim())
        if (block.type === 'tool_use') {
          tools.push({ name: block.name, target: toolTarget(block.name, block.input) })
          if (WRITE_TOOLS.has(block.name) && block.input?.file_path) {
            files.add(path.relative(rec.cwd, block.input.file_path) || block.input.file_path)
          }
        }
      }
    } else if (e.type === 'result') {
      result = e
    }
  }

  const alive = isAlive(rec.pid)
  let status = rec.status
  let error = null

  if (result) {
    status = result.is_error ? 'error' : 'done'
    if (result.is_error) error = result.result || result.subtype || 'claude reported an error'
  } else if (!alive) {
    status = 'error'
    let stderr = ''
    try {
      stderr = fs.readFileSync(errFile(id), 'utf8').trim().split('\n').slice(-8).join('\n')
    } catch {}
    error = stderr || 'claude exited without producing a result'
  } else {
    status = 'running'
  }

  if (status !== rec.status) {
    saveTask({ ...rec, status, endedAt: status === 'running' ? undefined : Date.now() })
  }

  return {
    ...rec,
    status,
    error,
    elapsedMs: (rec.endedAt || Date.now()) - rec.startedAt,
    toolCount: tools.length,
    recentTools: tools.slice(-6),
    currentTool: status === 'running' ? tools[tools.length - 1] || null : null,
    filesTouched: [...files],
    messages: texts,
    finalMessage: result?.result || texts[texts.length - 1] || null,
    numTurns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
  }
}

export function cancelTask(id) {
  const rec = readTaskRecord(id)
  if (!rec) throw new Error(`unknown task_id: ${id}`)
  if (!isAlive(rec.pid)) return { ...rec, status: rec.status, cancelled: false }
  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch {}
  return saveTask({ ...rec, status: 'cancelled', endedAt: Date.now(), cancelled: true })
}

export function sessionInfo(cwd) {
  const dir = resolveCwd(cwd)
  const session = getSession(dir)
  const tasks = listTaskRecords({ cwd: dir, limit: 10 })
  return { cwd: dir, session, tasks, gitRepo: isGitRepo(dir) }
}

export function resetSession(cwd) {
  const dir = resolveCwd(cwd)
  clearSession(dir)
  return { cwd: dir }
}

export function diff(cwd, { stat = false, pathspec } = {}) {
  const dir = resolveCwd(cwd)
  if (!isGitRepo(dir)) return { cwd: dir, gitRepo: false, text: '' }
  const args = ['--no-pager', 'diff', 'HEAD']
  if (stat) args.push('--stat')
  if (pathspec) args.push('--', pathspec)
  const text = git(dir, args) ?? ''
  const untracked = (git(dir, ['ls-files', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .filter(Boolean)
  return { cwd: dir, gitRepo: true, text, untracked }
}

export { listTaskRecords }
