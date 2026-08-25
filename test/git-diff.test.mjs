import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diff } from '../src/git.mjs'

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  return r.stdout
}

function withTempRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-git-diff-test-'))
  try {
    git(dir, ['init', '-q'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    git(dir, ['config', 'user.name', 'Test'])
    fs.writeFileSync(path.join(dir, 'tracked-a.txt'), 'a\n')
    fs.writeFileSync(path.join(dir, 'tracked-b.txt'), 'b\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', 'initial'])

    fs.writeFileSync(path.join(dir, 'tracked-a.txt'), 'a changed\n')
    fs.writeFileSync(path.join(dir, 'tracked-b.txt'), 'b changed\n')
    fs.writeFileSync(path.join(dir, 'untracked-a.txt'), 'new a\n')
    fs.writeFileSync(path.join(dir, 'untracked-b.txt'), 'new b\n')

    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function test(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
  } catch (e) {
    console.error(`FAIL: ${name}`)
    console.error(e)
    process.exitCode = 1
  }
}

test('unfiltered diff includes all tracked changes and all untracked files', () => {
  withTempRepo((dir) => {
    const result = diff(dir, {})
    assert.match(result.text, /tracked-a\.txt/)
    assert.match(result.text, /tracked-b\.txt/)
    assert.deepEqual(result.untracked.sort(), ['untracked-a.txt', 'untracked-b.txt'])
  })
})

test('pathspec filters both the tracked diff and the untracked list', () => {
  withTempRepo((dir) => {
    const result = diff(dir, { pathspec: 'tracked-a.txt' })
    assert.match(result.text, /tracked-a\.txt/)
    assert.doesNotMatch(result.text, /tracked-b\.txt/)
    assert.deepEqual(result.untracked, [])
  })
})

test('pathspec matching an untracked file filters the untracked list to it', () => {
  withTempRepo((dir) => {
    const result = diff(dir, { pathspec: 'untracked-a.txt' })
    assert.equal(result.text, '')
    assert.deepEqual(result.untracked, ['untracked-a.txt'])
  })
})

if (process.exitCode) {
  console.error('git diff() pathspec regression tests FAILED')
} else {
  console.log('all git diff() pathspec regression tests passed')
}
