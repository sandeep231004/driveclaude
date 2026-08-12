import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DAEMON_LOG, SOCKET, ensureDirs } from './state.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'driveclaude.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function once(op, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET)
    let buf = ''
    const id = Math.random().toString(36).slice(2)

    socket.on('connect', () => socket.write(`${JSON.stringify({ id, op, args })}\n`))
    socket.on('data', (d) => {
      buf += d
      // A reply can span many chunks — a busy session's `read` is far larger
      // than one socket read. Wait for the terminating newline before parsing.
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      socket.end()
      let res
      try {
        res = JSON.parse(buf.slice(0, nl))
      } catch {
        return reject(new Error('malformed response from daemon'))
      }
      res.ok ? resolve(res.data) : reject(new Error(res.error))
    })
    socket.on('error', reject)
    socket.setTimeout(30000, () => {
      socket.destroy()
      reject(new Error('daemon did not respond'))
    })
  })
}

/** Launch the daemon detached so it outlives this process (and Codex). */
async function launchDaemon() {
  ensureDirs()
  const log = fs.openSync(DAEMON_LOG, 'a')
  const child = spawn(process.execPath, [CLI, 'daemon'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  })
  child.unref()
  fs.closeSync(log)

  for (let i = 0; i < 60; i++) {
    await sleep(100)
    try {
      return await once('ping', {})
    } catch {}
  }
  throw new Error(`daemon failed to start — see ${DAEMON_LOG}`)
}

/** Talk to the daemon, starting it on first use. */
export async function request(op, args = {}) {
  try {
    return await once(op, args)
  } catch (e) {
    const missing = ['ENOENT', 'ECONNREFUSED'].includes(e.code)
    if (!missing) throw e
    await launchDaemon()
    return once(op, args)
  }
}

export async function daemonRunning() {
  try {
    await once('ping', {})
    return true
  } catch {
    return false
  }
}
