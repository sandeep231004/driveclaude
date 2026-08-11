#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_LOG, DEFAULT_MODEL, daemonPid } from '../src/state.mjs'
import { daemonRunning, request } from '../src/client.mjs'
import { startDaemon } from '../src/daemon.mjs'
import { runStdioServer } from '../src/mcp.mjs'
import { formatDiff, formatEvents, formatInfo, formatList } from '../src/format.mjs'
import { diff } from '../src/git.mjs'

const HELP = `remotehands — your agent's hands on someone else's keyboard

  remotehands mcp                Run the MCP server over stdio (this is what Codex launches)
  remotehands init-codex         Register the MCP server in ~/.codex/config.toml
  remotehands send <message>     Type a message into the live session, then watch
  remotehands watch              Follow the live session
  remotehands read               Print the session so far
  remotehands session            Status of this directory's session
  remotehands sessions           All sessions
  remotehands end                Close this directory's session
  remotehands diff               Working-tree diff
  remotehands daemon             Run the session daemon in the foreground
  remotehands stop               Stop the daemon and all sessions

Options
  --cwd <dir>     Directory the session works in (default: current directory)
  --model <name>  Model for a NEW session (default: ${DEFAULT_MODEL})
  --fresh         Abandon the existing conversation and start over
  --since <n>     Read from this cursor (default 0)
  --stat          diff: summary only
  --no-follow     send: don't watch afterwards
`

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      flags[key] = ['cwd', 'model', 'since'].includes(key) ? argv[++i] : true
    } else positional.push(a)
  }
  return { flags, positional }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function follow(cwd, since = 0) {
  let cursor = since
  for (;;) {
    const snap = await request('read', { cwd, since: cursor })
    if (snap.events.length) {
      process.stdout.write(`${formatEvents({ ...snap, filesTouched: [] }, { showHeader: false })
        .split('\ncursor:')[0]
        .trimEnd()}\n`)
      cursor = snap.cursor
    }
    if (snap.status !== 'working') return snap
    await sleep(1500)
  }
}

function initCodex() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  const block = [
    '[mcp_servers.hands]',
    'command = "remotehands"',
    'args = ["mcp"]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 60',
  ].join('\n')

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''

  if (existing.includes('[mcp_servers.hands]')) {
    console.log(`Already registered in ${configPath}:\n\n${block}`)
  } else {
    fs.writeFileSync(configPath, `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`)
    console.log(`Registered in ${configPath}:\n\n${block}`)
  }
  console.log(`
Next: add the supervisor instructions to ~/.codex/AGENTS.md — see the README
section "Teaching Codex to drive". Then run \`codex\` in any repo.`)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { flags, positional } = parseArgs(rest)
  const cwd = path.resolve(flags.cwd || process.cwd())

  switch (cmd) {
    case 'daemon':
      startDaemon()
      return

    case 'mcp':
      await runStdioServer()
      return

    case 'init-codex':
      initCodex()
      return

    case 'send': {
      const message = positional.join(' ')
      if (!message) throw new Error('usage: remotehands send "<message>"')
      const snap = await request('send', {
        cwd,
        message,
        model: flags.model,
        fresh: !!flags.fresh,
      })
      console.log(
        snap.queued
          ? `queued mid-task · session ${snap.sessionId}`
          : `sent · session ${snap.sessionId}`,
      )
      if (flags['no-follow']) return
      console.log('')
      await follow(cwd, snap.cursorBefore)
      return
    }

    case 'watch': {
      const snap = await request('read', { cwd, since: 0 })
      console.log(formatEvents(snap))
      if (snap.status === 'working') await follow(cwd, snap.cursor)
      return
    }

    case 'read':
      console.log(formatEvents(await request('read', { cwd, since: Number(flags.since || 0) })))
      return

    case 'session':
      console.log(formatInfo(await request('info', { cwd })))
      return

    case 'sessions':
      console.log(formatList(await request('list', {})))
      return

    case 'end': {
      const r = await request('end', { cwd })
      console.log(r.ended ? `session ended for ${r.cwd}` : `no live session for ${r.cwd}`)
      return
    }

    case 'diff':
      console.log(formatDiff(diff(cwd, { stat: !!flags.stat })))
      return

    case 'stop': {
      if (!(await daemonRunning())) {
        console.log('daemon is not running')
        return
      }
      await request('shutdown', {})
      console.log('daemon stopped')
      return
    }

    case 'status': {
      const pid = daemonPid()
      console.log(pid ? `daemon running (pid ${pid})` : 'daemon not running')
      console.log(`log: ${DAEMON_LOG}`)
      return
    }

    default:
      console.log(HELP)
      process.exit(cmd && !['--help', '-h'].includes(cmd) ? 1 : 0)
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`)
  process.exit(1)
})
