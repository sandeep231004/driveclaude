import assert from 'node:assert/strict'
import path from 'node:path'
import { SOCKET, resolveSocketPath } from '../src/state.mjs'

// Windows has no Unix domain sockets, so the daemon listens on a named pipe
// there instead. resolveSocketPath takes the platform as an argument precisely
// so both branches can be checked from any machine — these assertions run the
// Windows branch on macOS and Linux too.

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

test('unix platforms keep the socket file inside the home directory', () => {
  assert.equal(resolveSocketPath('/home/me/.driveclaude', 'linux'), '/home/me/.driveclaude/daemon.sock')
  assert.equal(resolveSocketPath('/Users/me/.driveclaude', 'darwin'), '/Users/me/.driveclaude/daemon.sock')
})

test('windows uses a named pipe rather than a path on disk', () => {
  const pipe = resolveSocketPath('C:\\Users\\me\\.driveclaude', 'win32')
  assert.ok(pipe.startsWith('\\\\.\\pipe\\'), `expected a pipe name, got ${pipe}`)
  assert.ok(!pipe.includes('/'), 'a pipe name must not look like a filesystem path')
  assert.ok(!pipe.includes('daemon.sock'), 'a pipe name must not carry the unix socket filename')
})

test('each home gets its own pipe, so users and test homes cannot collide', () => {
  // Pipe names are machine-global, unlike socket paths, so this separation has
  // to be built into the name or two DRIVECLAUDE_HOME values share one daemon.
  const a = resolveSocketPath('C:\\Users\\alice\\.driveclaude', 'win32')
  const b = resolveSocketPath('C:\\Users\\bob\\.driveclaude', 'win32')
  assert.notEqual(a, b, 'different homes must map to different pipes')
})

test('the same home always resolves to the same pipe', () => {
  const home = 'C:\\Users\\me\\.driveclaude'
  assert.equal(
    resolveSocketPath(home, 'win32'),
    resolveSocketPath(home, 'win32'),
    'a client and daemon started separately must agree on the pipe name',
  )
})

test('the exported SOCKET matches this platform', () => {
  if (process.platform === 'win32') {
    assert.ok(SOCKET.startsWith('\\\\.\\pipe\\'))
  } else {
    assert.equal(path.basename(SOCKET), 'daemon.sock')
  }
})

if (process.exitCode) {
  console.error('windows path regression tests FAILED')
} else {
  console.log('all windows path tests passed')
}
