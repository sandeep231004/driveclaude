import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CLAUDE_BIN, DEFAULT_MODEL, ensureDirs, eventLogFile, trustProject } from './state.mjs'

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_EVENTS = 5000

function toolTarget(input = {}) {
  const v =
    input.file_path || input.path || input.command || input.pattern || input.url || input.description
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 100 ? `${s.slice(0, 100)}…` : s
}

function preview(content) {
  const s = Array.isArray(content)
    ? content.map((c) => c.text || '').join(' ')
    : String(content ?? '')
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 200 ? `${t.slice(0, 200)}…` : t
}

/**
 * One live Claude Code process, held open.
 *
 * Claude runs in streaming mode with stdin kept open, so a message can be
 * written at any moment — including while it is mid-task. Claude finishes its
 * current step, picks the message up, and carries on. It is never restarted and
 * never loses context.
 */
export class Session {
  constructor({ cwd, model = DEFAULT_MODEL, sessionId = null }) {
    this.cwd = cwd
    this.model = model
    this.sessionId = sessionId || randomUUID()
    this.resumed = Boolean(sessionId)
    this.events = []
    this.seq = 0
    this.dropped = 0
    this.status = 'starting'
    this.busy = false
    this.queued = 0
    this.turns = 0
    this.filesTouched = new Set()
    this.startedAt = Date.now()
    this.lastActivity = Date.now()
    this.child = null
    this.exitInfo = null
  }

  start() {
    ensureDirs()
    trustProject(this.cwd)
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model',
      this.model,
      this.resumed ? '--resume' : '--session-id',
      this.sessionId,
    ]
    this.child = spawn(CLAUDE_BIN, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let buf = ''
    this.child.stdout.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) if (line.trim()) this._onMessage(line)
    })
    this.child.stderr.on('data', (d) => this._push('error', { text: preview(String(d)) }))
    // A Claude process that dies mid-write makes stdin emit EPIPE. Unhandled, that
    // is fatal to the whole daemon — every other live session would die with it.
    this.child.stdin.on('error', (e) => {
      this.busy = false
      this.status = 'exited'
      this._push('error', { text: `lost the session while writing: ${e.code || e.message}` })
    })
    this.child.on('exit', (code, signal) => {
      this.status = 'exited'
      this.busy = false
      this.exitInfo = { code, signal, at: Date.now() }
      this._push('system', { text: `session exited (code ${code}${signal ? `, ${signal}` : ''})` })
    })
    this.child.on('error', (e) => {
      this.status = 'exited'
      this.exitInfo = { error: e.message, at: Date.now() }
      this._push('error', { text: `failed to start claude: ${e.message}` })
    })
    return this
  }

  _push(kind, data) {
    const ev = { seq: ++this.seq, at: Date.now(), kind, ...data }
    this.events.push(ev)
    if (this.events.length > MAX_EVENTS) {
      this.dropped += this.events.length - MAX_EVENTS
      this.events = this.events.slice(-MAX_EVENTS)
    }
    this.lastActivity = ev.at
    fs.appendFile(eventLogFile(this.sessionId), `${JSON.stringify(ev)}\n`, () => {})
    return ev
  }

  _onMessage(line) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }

    if (m.type === 'system' && m.subtype === 'init') {
      if (m.session_id) this.sessionId = m.session_id
      if (this.status === 'starting') this.status = 'idle'
      this._push('system', { text: `ready · model ${m.model || this.model}` })
      return
    }

    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) this._push('text', { text: b.text.trim() })
        else if (b.type === 'thinking' && b.thinking?.trim())
          this._push('thinking', { text: b.thinking.trim() })
        else if (b.type === 'tool_use') {
          this._push('tool', { name: b.name, target: toolTarget(b.input) })
          if (WRITE_TOOLS.has(b.name) && b.input?.file_path) {
            this.filesTouched.add(path.relative(this.cwd, b.input.file_path) || b.input.file_path)
          }
        }
      }
      return
    }

    if (m.type === 'user') {
      for (const b of m.message?.content || []) {
        if (b.type === 'tool_result' && b.is_error) {
          this._push('tool_error', { text: preview(b.content) })
        }
      }
      return
    }

    if (m.type === 'result') {
      this.turns += 1
      this.busy = false
      this.queued = 0
      this.status = 'idle'
      this._push('result', {
        text: m.result || '',
        isError: Boolean(m.is_error),
        costUsd: m.total_cost_usd ?? null,
        durationMs: m.duration_ms ?? null,
      })
    }
  }

  /**
   * Queue a message. Always accepted — if Claude is mid-task it finishes the
   * current step, then picks this up. Never interrupts, never restarts.
   */
  send(text) {
    if (this.status === 'exited' || !this.child || this.child.exitCode !== null) {
      throw new Error('session is not running')
    }
    const wasBusy = this.busy
    if (wasBusy) this.queued += 1
    this._push('you', { text, queued: wasBusy })
    this.child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      })}\n`,
    )
    this.busy = true
    this.status = 'working'
    return { queued: wasBusy, cursor: this.seq }
  }

  since(cursor = 0) {
    return this.events.filter((e) => e.seq > cursor)
  }

  snapshot() {
    return {
      cwd: this.cwd,
      sessionId: this.sessionId,
      model: this.model,
      status: this.status,
      resumed: this.resumed,
      queued: this.queued,
      turns: this.turns,
      cursor: this.seq,
      dropped: this.dropped,
      filesTouched: [...this.filesTouched],
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      exitInfo: this.exitInfo,
    }
  }

  /** Close stdin so Claude finishes pending work and exits cleanly. */
  end() {
    if (!this.child || this.child.exitCode !== null) return
    try {
      this.child.stdin.end()
    } catch {}
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGTERM')
        } catch {}
      }
    }, 5000).unref?.()
  }
}
