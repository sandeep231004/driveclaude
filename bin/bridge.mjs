#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_MODEL,
  cancelTask,
  diff,
  inspectTask,
  listTaskRecords,
  resetSession,
  sessionInfo,
  startTask,
} from '../src/runner.mjs'
import { formatDiff, formatSession, formatStatus, formatTasks } from '../src/format.mjs'
import { runStdioServer } from '../src/mcp.mjs'

const HELP = `bridge — let Codex supervise Claude Code

  bridge mcp                     Run the MCP server over stdio (this is what Codex launches)
  bridge init-codex              Register the MCP server in ~/.codex/config.toml
  bridge send <task>             Delegate a task and follow it live
  bridge status <task_id>        Show progress or the final result
  bridge tasks                   List recent tasks
  bridge session                 Show the Claude session for this directory
  bridge diff                    Show the working-tree diff
  bridge cancel <task_id>        Stop a running task

Options
  --cwd <dir>     Directory to operate on (default: current directory)
  --model <name>  Implementer model (default: ${DEFAULT_MODEL})
  --new           Start a fresh session, discarding prior context
  --detach        For send: print the task_id and exit instead of following
  --stat          For diff: summary only
  --reset         For session: forget the session for this directory
  --full          For status: include Claude's message while still running
`

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const takesValue = ['cwd', 'model'].includes(key)
      flags[key] = takesValue ? argv[++i] : true
    } else {
      positional.push(a)
    }
  }
  return { flags, positional }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function follow(id) {
  let shown = 0
  for (;;) {
    const snap = inspectTask(id)
    const tools = snap.recentTools
    if (snap.toolCount > shown) {
      // recentTools is a tail window; only print the ones we haven't seen.
      const unseen = Math.min(snap.toolCount - shown, tools.length)
      for (const t of tools.slice(tools.length - unseen)) {
        console.log(`  ${t.name}${t.target ? ` ${t.target}` : ''}`)
      }
      shown = snap.toolCount
    }
    if (snap.status !== 'running') {
      console.log('')
      console.log(formatStatus(snap))
      process.exit(snap.status === 'done' ? 0 : 1)
    }
    await sleep(2000)
  }
}

function initCodex() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  const block = [
    '[mcp_servers.claude]',
    'command = "bridge"',
    'args = ["mcp"]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
  ].join('\n')

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''

  if (existing.includes('[mcp_servers.claude]')) {
    console.log(`Already registered in ${configPath}:\n\n${block}`)
  } else {
    const sep = existing.trim() ? '\n\n' : ''
    fs.writeFileSync(configPath, `${existing.trimEnd()}${sep}${block}\n`)
    console.log(`Registered the bridge in ${configPath}:\n\n${block}`)
  }

  console.log(`
Next: put the supervisor instructions in ~/.codex/AGENTS.md so Codex knows the
delegation loop (see the README section "Teaching Codex to supervise"), then run
\`codex\` in any repo and ask it to plan and delegate.`)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { flags, positional } = parseArgs(rest)
  const cwd = flags.cwd || process.cwd()

  switch (cmd) {
    case 'mcp':
      await runStdioServer()
      return

    case 'init-codex':
      initCodex()
      return

    case 'send': {
      const task = positional.join(' ')
      if (!task) throw new Error('usage: bridge send "<task>"')
      const t = startTask({ cwd, prompt: task, model: flags.model, newSession: !!flags.new })
      console.log(`task ${t.id} · session ${t.sessionId}${t.resumed ? ' (resumed)' : ' (new)'}`)
      if (flags.detach) return
      console.log('')
      await follow(t.id)
      return
    }

    case 'status': {
      const snap = inspectTask(positional[0])
      if (!snap) throw new Error(`unknown task_id: ${positional[0]}`)
      console.log(formatStatus(snap, { full: !!flags.full }))
      return
    }

    case 'tasks':
      console.log(formatTasks(listTaskRecords({ cwd: flags.cwd, limit: 30 })))
      return

    case 'session':
      if (flags.reset) {
        console.log(`session cleared for ${resetSession(cwd).cwd}`)
        return
      }
      console.log(formatSession(sessionInfo(cwd)))
      return

    case 'diff':
      console.log(formatDiff(diff(cwd, { stat: !!flags.stat })))
      return

    case 'cancel': {
      const t = cancelTask(positional[0])
      console.log(t.cancelled ? `cancelled ${t.id}` : `task ${t.id} was already ${t.status}`)
      return
    }

    default:
      console.log(HELP)
      process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0)
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
