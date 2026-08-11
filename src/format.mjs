const MAX_DIFF = 24000
const MAX_MSG = 4000

const secs = (ms) => `${Math.round(ms / 1000)}s`

function truncate(text, max) {
  if (!text) return ''
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
}

export function formatStatus(snap, { full = false } = {}) {
  const lines = [
    `task ${snap.id} · ${snap.status} · ${secs(snap.elapsedMs)} · model ${snap.model}`,
    `cwd ${snap.cwd}`,
    `session ${snap.sessionId}${snap.resumed ? ' (resumed)' : ' (new)'}`,
    `task: ${truncate(snap.prompt, 300)}`,
    '',
  ]

  if (snap.status === 'running') {
    const cur = snap.currentTool
    lines.push(`working · ${snap.toolCount} tool calls so far`)
    if (cur) lines.push(`current: ${cur.name}${cur.target ? ` ${cur.target}` : ''}`)
    if (snap.recentTools.length) {
      lines.push('recent:')
      for (const t of snap.recentTools) lines.push(`  ${t.name}${t.target ? ` ${t.target}` : ''}`)
    }
  }

  if (snap.filesTouched.length) {
    lines.push('', `files written (${snap.filesTouched.length}):`)
    for (const f of snap.filesTouched) lines.push(`  ${f}`)
  }

  if (snap.status === 'error' && snap.error) {
    lines.push('', 'error:', truncate(snap.error, MAX_MSG))
  }

  if (snap.status === 'done' || full) {
    lines.push('', 'claude says:', truncate(snap.finalMessage || '(no output)', MAX_MSG))
    if (snap.numTurns != null) {
      const cost = snap.costUsd != null ? ` · $${snap.costUsd.toFixed(4)}` : ''
      lines.push('', `${snap.numTurns} turns${cost}`)
    }
  }

  if (snap.status === 'running') {
    lines.push('', 'Still working — call status again in ~30s.')
  }

  return lines.join('\n')
}

export function formatDiff(d, { max = MAX_DIFF } = {}) {
  if (!d.gitRepo) return `${d.cwd} is not a git repository — no diff available.`
  const parts = []
  parts.push(d.text.trim() ? truncate(d.text, max) : 'No tracked changes vs HEAD.')
  if (d.untracked?.length) {
    parts.push('', `untracked files (${d.untracked.length}):`)
    for (const f of d.untracked.slice(0, 50)) parts.push(`  ${f}`)
  }
  return parts.join('\n')
}

export function formatTasks(tasks) {
  if (!tasks.length) return 'No tasks yet.'
  return tasks
    .map((t) => {
      const when = new Date(t.startedAt).toLocaleString()
      return `${t.id}  ${t.status.padEnd(9)} ${when}  ${truncate(t.prompt, 70).replace(/\n/g, ' ')}`
    })
    .join('\n')
}

export function formatSession(info) {
  if (!info.session) {
    return `No Claude session yet for ${info.cwd}. The next implement() call starts one.`
  }
  const s = info.session
  return [
    `cwd ${info.cwd}${info.gitRepo ? '' : ' (not a git repo)'}`,
    `session ${s.sessionId}`,
    `turns ${s.turns} · last used ${new Date(s.updatedAt).toLocaleString()}`,
    '',
    'Recent tasks:',
    formatTasks(info.tasks),
    '',
    `Attach by hand: claude --resume ${s.sessionId}`,
  ].join('\n')
}
