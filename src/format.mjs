const MAX_TEXT = 1500
const MAX_DIFF = 24000

const clip = (s, n) => {
  const t = String(s ?? '').trim()
  return t.length <= n ? t : `${t.slice(0, n)}\n… [truncated ${t.length - n} chars]`
}

const secs = (ms) => `${Math.round(ms / 1000)}s`

function header(snap) {
  const bits = [`session ${snap.sessionId}`, snap.status]
  if (snap.queued) bits.push(`${snap.queued} message(s) queued`)
  if (snap.turns) bits.push(`${snap.turns} turns`)
  return `${bits.join(' · ')}\ncwd ${snap.cwd} · model ${snap.model}`
}

export function formatEvents(snap, { showHeader = true } = {}) {
  const lines = showHeader ? [header(snap), ''] : []

  if (snap.dropped) lines.push(`[${snap.dropped} older events dropped]`)

  for (const e of snap.events || []) {
    switch (e.kind) {
      case 'you':
        lines.push(`you › ${clip(e.text, 400)}${e.queued ? '   [queued mid-task]' : ''}`)
        break
      case 'thinking':
        lines.push(`(thinking) ${clip(e.text, 600)}`)
        break
      case 'text':
        lines.push(`claude: ${clip(e.text, MAX_TEXT)}`)
        break
      case 'tool':
        lines.push(`  · ${e.name}${e.target ? ` ${e.target}` : ''}`)
        break
      case 'tool_error':
        lines.push(`  ! failed: ${clip(e.text, 300)}`)
        break
      case 'result': {
        const cost = e.costUsd != null ? ` · $${e.costUsd.toFixed(4)}` : ''
        const dur = e.durationMs != null ? ` · ${secs(e.durationMs)}` : ''
        lines.push(`── turn ${e.isError ? 'failed' : 'complete'}${dur}${cost} ──`)
        if (e.text) lines.push(clip(e.text, MAX_TEXT))
        break
      }
      case 'error':
        lines.push(`!! ${clip(e.text, 400)}`)
        break
      default:
        lines.push(`[${e.kind}] ${clip(e.text, 200)}`)
    }
  }

  if (!snap.events?.length) lines.push('(nothing new)')

  if (snap.filesTouched?.length) {
    lines.push('', `files written this session (${snap.filesTouched.length}):`)
    for (const f of snap.filesTouched) lines.push(`  ${f}`)
  }

  lines.push('', `cursor: ${snap.cursor}`)
  if (snap.status === 'working') {
    lines.push(
      `Claude is still working. Read again with since=${snap.cursor} in ~20s, ` +
        'or send another message now — it will be queued and picked up between steps.',
    )
  } else if (snap.status === 'idle') {
    lines.push('Claude is idle and waiting for your next message.')
  } else if (snap.status === 'exited') {
    lines.push('The session has exited. The next send starts a new one, resuming this conversation.')
  }

  return lines.join('\n')
}

export function formatInfo(info) {
  if (!info.live && !info.remembered) {
    return `No session for ${info.cwd}. The next send starts one.`
  }
  const lines = []
  if (info.live) {
    lines.push(header(info.live))
    lines.push(`alive since ${new Date(info.live.startedAt).toLocaleString()}`)
    lines.push(`last activity ${new Date(info.live.lastActivity).toLocaleString()}`)
    if (info.live.filesTouched.length) {
      lines.push(`files written: ${info.live.filesTouched.join(', ')}`)
    }
  } else {
    lines.push(`cwd ${info.cwd}`)
    lines.push(`no live process — remembered session ${info.remembered.sessionId}`)
    lines.push('the next send resumes this conversation')
  }
  const id = info.live?.sessionId || info.remembered?.sessionId
  if (id) lines.push('', `attach by hand: claude --resume ${id}`)
  return lines.join('\n')
}

export function formatList({ sessions, remembered }) {
  const lines = []
  if (sessions.length) {
    lines.push('Live sessions:')
    for (const s of sessions) {
      lines.push(
        `  ${s.status.padEnd(8)} ${s.queued ? `${s.queued}q ` : '   '} ${s.cwd}  (${s.sessionId.slice(0, 8)})`,
      )
    }
  } else {
    lines.push('No live sessions.')
  }
  const sleeping = Object.keys(remembered).filter((c) => !sessions.some((s) => s.cwd === c))
  if (sleeping.length) {
    lines.push('', 'Remembered (will resume on next send):')
    for (const c of sleeping) lines.push(`  ${c}`)
  }
  return lines.join('\n')
}

export function formatDiff(d) {
  if (!d.gitRepo) return `${d.cwd} is not a git repository — no diff available.`
  const parts = [d.text.trim() ? clip(d.text, MAX_DIFF) : 'No tracked changes vs HEAD.']
  if (d.untracked?.length) {
    parts.push('', `untracked files (${d.untracked.length}):`)
    for (const f of d.untracked.slice(0, 50)) parts.push(`  ${f}`)
  }
  return parts.join('\n')
}
