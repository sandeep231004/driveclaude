import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatList } from '../src/format.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-registry-'))
const stateUrl = pathToFileURL(path.resolve('src/state.mjs')).href
const oldId = '11111111-1111-4111-8111-111111111111'
const newId = '22222222-2222-4222-8222-222222222222'
const oldCwd = '/tmp/old-project'
const newCwd = '/tmp/new-project'

try {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'sessions.json'),
    JSON.stringify({ [oldCwd]: { sessionId: oldId, model: 'sonnet', updatedAt: 1 } }),
  )

  const source = `
    import { readSessionRegistry, rememberSession } from ${JSON.stringify(stateUrl)}
    rememberSession(${JSON.stringify(newCwd)}, { sessionId: ${JSON.stringify(newId)}, model: 'sonnet' })
    process.stdout.write(JSON.stringify(readSessionRegistry()))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, DRIVECLAUDE_HOME: home },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const registry = JSON.parse(result.stdout)
  assert.equal(registry.version, 2)
  assert.equal(registry.sessions[oldId].cwd, oldCwd, 'v1 remembered session must survive migration')
  assert.equal(registry.sessions[newId].cwd, newCwd)
  assert.equal(registry.defaults[oldCwd], oldId)
  assert.equal(registry.defaults[newCwd], newId)

  const oldDaemonList = formatList({
    sessions: [],
    remembered: { [oldCwd]: { sessionId: oldId, model: 'sonnet' } },
  })
  assert(oldDaemonList.includes(oldCwd), 'new CLI must format the previous daemon response shape')
  console.log('PASS: v1 cwd-keyed state migrates without losing remembered sessions')
  console.log('PASS: new CLI remains readable while an old daemon is still running')
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
