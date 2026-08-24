import { request } from './client.mjs'

// A live view of a session someone else is driving. Output is append-only so
// the terminal keeps its scrollback, with a single status line rewritten in
// place at the bottom — that gives motion without redrawing the screen, and
// degrades to plain lines when stdout is not a terminal.

const TTY = process.stdout.isTTY && !process.env.NO_COLOR
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const POLL_MS = 1000

const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => paint('2', s)
const bold = (s) => paint('1', s)
const cyan = (s) => paint('36', s)
const magenta = (s) => paint('35', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const secs = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`)

/** Keep a line inside the terminal so long output cannot wrap into the status line. */
function fit(s, reserve = 0) {
  const width = (process.stdout.columns || 100) - reserve
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '')
  if (plain.length <= width) return s
  // Truncating a coloured string by raw index would cut an escape sequence in
  // half, so only styled-free text is measured and clipped.
  return `${plain.slice(0, Math.max(0, width - 1))}…`
}

/** Wrap a paragraph to the terminal, indenting continuation lines under the label. */
function wrap(text, indent) {
  const width = Math.max(20, (process.stdout.columns || 100) - indent.length)
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + word.length + 1 > width) {
        out.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    out.push(line)
  }
  return out
}

/** A speaker turn: a coloured bullet, a name, then the body indented under it. */
function speaker(dot, name, text, note = '') {
  return ['', `${dot} ${bold(name)}${note}`, ...wrap(text, '  ').map((l) => `  ${l}`)]
}

/** Paths inside the session's own directory read better without the prefix. */
const relative = (target, cwd) =>
  cwd && target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target

function renderEvent(e, cwd) {
  switch (e.kind) {
    case 'you':
      return speaker(cyan('●'), cyan('supervisor'), e.text, e.queued ? dim('  queued mid-task') : '')
    case 'text':
      return speaker(magenta('●'), magenta('claude'), e.text)
    case 'thinking':
      return [dim(`  ${fit(`thinking  ${e.text.replace(/\s+/g, ' ')}`, 2)}`)]
    case 'tool': {
      // Indented under the message that requested it, the way a coding agent
      // shows its work: name first, argument dimmed behind it.
      const target = e.target ? relative(e.target, cwd) : ''
      return [`  ${dim('⎿')} ${e.name}${target ? ` ${dim(fit(target, 6 + e.name.length))}` : ''}`]
    }
    case 'tool_error':
      return [`  ${dim('⎿')} ${red(fit(e.text.replace(/\s+/g, ' '), 6))}`]
    case 'result': {
      const bits = []
      if (e.durationMs != null) bits.push(secs(e.durationMs))
      if (e.costUsd != null) bits.push(`$${e.costUsd.toFixed(4)}`)
      const mark = e.isError ? red('✗ turn failed') : green('✓ turn complete')
      return ['', `  ${mark}${bits.length ? dim(`  ${bits.join(' · ')}`) : ''}`]
    }
    case 'error':
      return ['', `${red('●')} ${red('error')}`, ...wrap(e.text, '  ').map((l) => `  ${red(l)}`)]
    case 'system':
      return [dim(`  ${fit(e.text, 2)}`)]
    default:
      return [dim(`  ${e.kind} ${fit(e.text ?? '', 4)}`)]
  }
}

/** Shown once when the view opens, so it is obvious what is being watched. */
function header(snap) {
  const id = snap.sessionId ? snap.sessionId.slice(0, 8) : '?'
  return [
    bold('driveclaude') + dim(' · watching'),
    dim(`${snap.cwd}  ${snap.model || ''}  session ${id}`),
  ].join('\n')
}

export async function watchSession(cwd, { since = 0, until = 'forever' } = {}) {
  let cursor = since
  let frame = 0
  let cost = 0
  let statusShown = false
  let attached = false
  const started = Date.now()

  const clearStatus = () => {
    if (TTY && statusShown) {
      process.stdout.write('\r\x1b[2K')
      statusShown = false
    }
  }

  const drawStatus = (snap) => {
    if (!TTY) return
    const spin = snap.status === 'working' ? `${SPINNER[frame % SPINNER.length]} ` : ''
    const bits = [
      snap.status === 'working' ? yellow(`${spin}working`) : dim(snap.status),
      `${snap.turns} turns`,
      secs(Date.now() - started),
    ]
    if (cost) bits.push(`$${cost.toFixed(4)}`)
    if (snap.queued) bits.push(yellow(`${snap.queued} queued`))
    bits.push(dim('ctrl-c to stop watching'))
    process.stdout.write(fit(bits.join(dim(' · ')), 1))
    statusShown = true
  }

  const restore = () => {
    clearStatus()
    if (TTY) process.stdout.write('\x1b[?25h')
  }
  process.on('SIGINT', () => {
    restore()
    process.stdout.write('\n')
    process.exit(0)
  })
  if (TTY) process.stdout.write('\x1b[?25l')

  try {
    for (;;) {
      let snap
      try {
        snap = await request('read', { cwd, since: cursor })
      } catch (e) {
        clearStatus()
        // Failing on the very first poll means there was nothing to watch;
        // failing later means a session we were following went away.
        process.stdout.write(`${red(attached ? `lost the session: ${e.message}` : e.message)}\n`)
        return null
      }
      if (!attached) {
        attached = true
        process.stdout.write(`${header(snap)}\n`)
      }

      if (snap.events.length) {
        clearStatus()
        const lines = []
        if (snap.dropped && cursor === 0) lines.push(dim(`[${snap.dropped} older events dropped]`))
        for (const e of snap.events) {
          if (e.kind === 'result' && e.costUsd != null) cost = e.costUsd
          lines.push(...renderEvent(e, snap.cwd))
        }
        process.stdout.write(`${lines.join('\n')}\n`)
        cursor = snap.cursor
      }

      // The session going idle is not the end of the story — whoever is driving
      // it can send again at any moment, so watching continues until interrupted.
      if (until === 'idle' && snap.status !== 'working') {
        clearStatus()
        return snap
      }
      if (snap.status === 'exited') {
        clearStatus()
        process.stdout.write(`${dim('session exited')}\n`)
        return snap
      }

      clearStatus()
      drawStatus(snap)
      frame += 1
      await sleep(POLL_MS)
    }
  } finally {
    restore()
  }
}
