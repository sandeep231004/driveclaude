#!/usr/bin/env node
// Stand-in for the real `claude` binary, used only by the driveclaude test
// suite. Reports whatever --session-id/--resume it was given, then for each
// user message on stdin (stream-json), responds with a small synthetic turn
// (tool_use + text + result) and stays alive until stdin closes — like a
// real held-open session.
//
// Two test hooks, both opt-in and harmless to the default (fresh-session)
// test that doesn't use them:
//   - FAKE_CLAUDE_RESPONSE_DELAY_MS: delay before the 'result' message, so a
//     second send() can land while the session is still busy.
//   - a user message with text exactly "CRASH_NOW" exits the process
//     immediately without responding, simulating a real crash mid-turn.
import readline from 'node:readline'

const args = process.argv.slice(2)
const idFlag = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'))
const sessionId = idFlag !== -1 ? args[idFlag + 1] : 'unknown'
const delay = Number(process.env.FAKE_CLAUDE_RESPONSE_DELAY_MS || 0)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'sonnet' })

let turn = 0
let chain = Promise.resolve()

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const text = msg?.message?.content?.[0]?.text
  if (text === 'CRASH_NOW') process.exit(1)

  chain = chain.then(async () => {
    turn += 1
    const n = turn
    emit({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: `/fake/turn-${n}.txt` } },
          { type: 'text', text: `ack turn ${n}: ${text}` },
        ],
      },
    })
    await sleep(delay)
    emit({ type: 'result', result: `done turn ${n}`, is_error: false, total_cost_usd: 0.001, duration_ms: 10 })
  })
})
rl.on('close', () => process.exit(0))
