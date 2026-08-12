import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// trustProject() resolves ~/.claude.json from os.homedir() at call time, so
// each case runs in a subprocess with its own HOME — no shared state, and the
// real ~/.claude.json is never touched.
function runTrustProject(home, cwd) {
  const runnerPath = path.join(home, 'run.mjs')
  const moduleUrl = new URL('../src/state.mjs', import.meta.url).href
  fs.writeFileSync(
    runnerPath,
    `import { trustProject } from ${JSON.stringify(moduleUrl)}\ntrustProject(${JSON.stringify(cwd)})\n`,
  )
  const res = spawnSync(process.execPath, [runnerPath], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
  fs.unlinkSync(runnerPath)
  if (res.status !== 0) {
    throw new Error(`trustProject subprocess failed:\n${res.stderr}`)
  }
}

function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'driveclaude-trust-test-'))
  try {
    fn(home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
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

test('missing ~/.claude.json is created and the project trusted', () => {
  withTempHome((home) => {
    const configPath = path.join(home, '.claude.json')
    assert.equal(fs.existsSync(configPath), false)

    runTrustProject(home, '/tmp/project-a')

    assert.equal(fs.existsSync(configPath), true)
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(config.projects['/tmp/project-a'].hasTrustDialogAccepted, true)
  })
})

test('existing config keys and unrelated project fields are preserved', () => {
  withTempHome((home) => {
    const configPath = path.join(home, '.claude.json')
    const seed = {
      numStartups: 42,
      oauthAccount: { id: 'abc' },
      projects: {
        '/tmp/project-b': {
          allowedTools: ['Bash'],
          mcpServers: { foo: {} },
          hasTrustDialogAccepted: false,
        },
        '/tmp/project-other': { allowedTools: ['Read'] },
      },
    }
    fs.writeFileSync(configPath, JSON.stringify(seed))

    runTrustProject(home, '/tmp/project-b')

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(config.numStartups, 42)
    assert.deepEqual(config.oauthAccount, { id: 'abc' })
    assert.deepEqual(config.projects['/tmp/project-b'].allowedTools, ['Bash'])
    assert.deepEqual(config.projects['/tmp/project-b'].mcpServers, { foo: {} })
    assert.equal(config.projects['/tmp/project-b'].hasTrustDialogAccepted, true)
    assert.deepEqual(config.projects['/tmp/project-other'], { allowedTools: ['Read'] })
  })
})

test('a corrupt existing config is left untouched rather than clobbered', () => {
  withTempHome((home) => {
    const configPath = path.join(home, '.claude.json')
    fs.writeFileSync(configPath, '{ not valid json')

    runTrustProject(home, '/tmp/project-c')

    assert.equal(fs.readFileSync(configPath, 'utf8'), '{ not valid json')
  })
})

test('the write is atomic — no leftover temp file', () => {
  withTempHome((home) => {
    runTrustProject(home, '/tmp/project-d')
    const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

if (process.exitCode) {
  console.error('trustProject regression tests FAILED')
} else {
  console.log('all trustProject regression tests passed')
}
