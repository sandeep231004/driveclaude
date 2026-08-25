#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_LOG, DEFAULT_MODEL, daemonPid } from '../src/state.mjs'
import { daemonRunning, request } from '../src/client.mjs'
import { startDaemon } from '../src/daemon.mjs'
import { runStdioServer } from '../src/mcp.mjs'
import { formatDiff, formatEvents, formatInfo, formatList } from '../src/format.mjs'
import { watchSession } from '../src/watch.mjs'
import { diff } from '../src/git.mjs'

const HELP = `driveclaude — drive a live Claude Code session from your supervisor agent

  driveclaude mcp                Run the MCP server over stdio (this is what Codex launches)
  driveclaude init-codex         Register the MCP server in ~/.codex/config.toml
  driveclaude send <message>     Type into a session; use --session when several share a project
  driveclaude adopt <session-id> Resume an existing conversation under driveclaude
  driveclaude watch [session-id] Follow one live session (ctrl-c to stop)
  driveclaude read [session-id]  Print one session so far
  driveclaude session [id]       Status of one session
  driveclaude sessions           All sessions
  driveclaude end [session-id]   Close one session
  driveclaude diff               Working-tree diff
  driveclaude daemon             Run the session daemon in the foreground
  driveclaude stop               Stop the daemon and all sessions

Options
  --cwd <dir>     Directory the session works in (default: current directory)
  --session <id>  Target a specific session (required when a project has several)
  --model <name>  Model for a NEW session (default: ${DEFAULT_MODEL})
  --fresh         Start a new conversation alongside existing sessions
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
      flags[key] = ['cwd', 'model', 'since', 'session'].includes(key) ? argv[++i] : true
    } else positional.push(a)
  }
  return { flags, positional }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function initCodex() {
  const configPath = path.join(os.homedir(), '.codex', 'config.toml')
  const block = [
    '[mcp_servers.claude]',
    'command = "driveclaude"',
    'args = ["mcp"]',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 60',
  ].join('\n')

  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''

  if (existing.includes('[mcp_servers.claude]')) {
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
      await startDaemon()
      return

    case 'mcp':
      await runStdioServer()
      return

    case 'init-codex':
      initCodex()
      return

    case 'send': {
      const message = positional.join(' ')
      if (!message) throw new Error('usage: driveclaude send "<message>"')
      const snap = await request('send', {
        cwd: flags.session && !flags.cwd ? undefined : cwd,
        sessionId: flags.session,
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
      await watchSession({ sessionId: snap.sessionId }, { since: snap.cursorBefore, until: 'idle' })
      return
    }

    case 'adopt': {
      const sessionId = positional[0]
      if (!sessionId) throw new Error('usage: driveclaude adopt <session-id>')
      const snap = await request('adopt', { cwd, sessionId, model: flags.model })
      console.log(`adopted · session ${snap.sessionId}`)
      if (flags['no-follow']) return
      await watchSession({ sessionId: snap.sessionId }, { since: 0, until: 'idle' })
      return
    }

    case 'watch': {
      // Replays the conversation so far, then keeps following. Going idle is not
      // the end: whoever is driving can send again, and this keeps showing it.
      const sessionId = positional[0] || flags.session
      const target = sessionId ? { sessionId } : { cwd }
      await watchSession(target, { since: Number(flags.since || 0), until: 'forever' })
      return
    }

    case 'read': {
      const sessionId = positional[0] || flags.session
      console.log(
        formatEvents(
          await request('read', {
            ...(sessionId ? { sessionId } : { cwd }),
            since: Number(flags.since || 0),
          }),
        ),
      )
      return
    }

    case 'session': {
      const sessionId = positional[0] || flags.session
      console.log(formatInfo(await request('info', sessionId ? { sessionId } : { cwd })))
      return
    }

    case 'sessions':
      console.log(formatList(await request('list', {})))
      return

    case 'end': {
      const sessionId = positional[0] || flags.session
      const r = await request('end', sessionId ? { sessionId } : { cwd })
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
      // The daemon acknowledges before it exits, so wait for it to actually go —
      // otherwise the very next command races a dying daemon and gets stale answers.
      for (let i = 0; i < 40; i++) {
        await sleep(100)
        if (!(await daemonRunning())) break
      }
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
