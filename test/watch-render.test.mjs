import assert from 'node:assert/strict'
import { renderEvent, renderHeader, renderSnapshot } from '../src/watch.mjs'

const cwd = '/tmp/example-project'
const sessionId = '9bc01cf5-bc95-4a0b-8b6f-656ceedae836'
const snap = {
  cwd,
  sessionId,
  model: 'claude-sonnet-5',
  status: 'working',
  dropped: 0,
  events: [
    { kind: 'you', text: 'Check the implementation carefully.' },
    { kind: 'tool', name: 'Read', target: `${cwd}/src/main.mjs` },
    { kind: 'text', text: 'The implementation is sound.' },
    { kind: 'result', durationMs: 3200, costUsd: 0.125, isError: false },
  ],
}

const header = renderHeader(snap)
assert(header.includes(sessionId), 'the exact watch target must be visible and copyable')
assert(header.includes(cwd))
assert(header.includes('claude-sonnet-5'))

const output = renderSnapshot(snap)
assert(output.includes('supervisor'))
assert(output.includes('claude'))
assert(output.includes('Read src/main.mjs'), 'tool paths inside cwd should be relative')
assert(output.includes('turn complete'))
assert(output.includes('$0.1250'))

const queued = renderEvent({ kind: 'you', text: 'Use the shared helper.', queued: true }, cwd).join('\n')
assert(queued.includes('queued mid-task'))

console.log('PASS: watch renders an ID-first coding-agent view with compact tool activity')
