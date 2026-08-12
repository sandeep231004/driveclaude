#!/usr/bin/env node
// Stand-in for the real `claude` binary, used only by the driveclaude test
// suite. Reports whatever --session-id/--resume it was given, then stays
// alive (like a real held-open session) until stdin closes.
const args = process.argv.slice(2)
const idFlag = Math.max(args.indexOf('--session-id'), args.indexOf('--resume'))
const sessionId = idFlag !== -1 ? args[idFlag + 1] : 'unknown'

process.stdout.write(
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'sonnet' })}\n`,
)

process.stdin.resume()
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
