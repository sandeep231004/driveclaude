import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCwd } from '../src/state.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-canonical-'))
const real = path.join(home, 'real')
const alias = path.join(home, 'alias')

try {
  fs.mkdirSync(real)
  fs.symlinkSync(real, alias, 'dir')
  assert.equal(resolveCwd(alias), fs.realpathSync.native(real))
  assert.equal(resolveCwd(real), fs.realpathSync.native(real))
  console.log('PASS: cwd aliases resolve to one physical session namespace')
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
