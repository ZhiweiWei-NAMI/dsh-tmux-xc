// Shared fixtures for the dsh-tmux-xc integration suite.
//
// The suite talks to a real loopback sshd created by scripts/test-infra.sh and to an isolated
// tmux server on a per-test `xc-it-<random>` socket. Because the ssh target is the same Linux
// machine/user, tests may also drive `tmux -L <socket>` locally (out-of-band setup/observation).
// Every helper here refuses to address any other tmux socket.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import process from 'node:process'

export const DEFAULT_SSH_CONFIG = new URL('../../test-infra/sshd/ssh_config', import.meta.url).pathname
export const sshConfigFile = process.env.XC_SSH_CONFIG || DEFAULT_SSH_CONFIG

const SOCKET_RE = /^xc-it-[A-Za-z0-9._-]{1,48}$/

/** Throw unless `name` is a socket this suite is allowed to address. */
export function assertTestSocket(name) {
  assert.match(String(name), SOCKET_RE, `refusing to use non-test tmux socket ${JSON.stringify(name)}`)
  return name
}

/** Fresh isolated socket name, e.g. `xc-it-1f3a9c`. */
export function newSocketName() {
  return `xc-it-${randomBytes(6).toString('hex')}`
}

let infraCache
/**
 * Decide whether this file can run. Returns `{ skip }` with a clear message when the loopback
 * sshd is unavailable, `{}` otherwise. XC_SSH_CONFIG is required so a random developer machine
 * never silently exercises the user's real ssh config.
 */
export function checkInfra() {
  if (infraCache) return infraCache
  if (!process.env.XC_SSH_CONFIG) {
    infraCache = {
      skip: 'integration tests skipped: XC_SSH_CONFIG is not set ' +
        '(run scripts/test-infra.sh up, then export XC_SSH_CONFIG=<repo>/test-infra/sshd/ssh_config)',
    }
    return infraCache
  }
  const res = spawnSync('ssh', ['-F', sshConfigFile, 'xc-test', 'true'], { encoding: 'utf8', timeout: 15000 })
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : (res.stderr || '').trim()
    infraCache = { skip: `integration tests skipped: "ssh -F ${sshConfigFile} xc-test true" failed: ${detail}` }
  } else {
    infraCache = {}
  }
  return infraCache
}

/**
 * Build a plugin config per DESIGN §3 for the four ssh hosts provisioned by test-infra.sh.
 * `hosts` (optional) overrides the default list; every socket points at `socketName`.
 */
export function makeConfig({ socketName, hosts } = {}) {
  assertTestSocket(socketName)
  const socket = () => ({ id: 'it', name: socketName })
  return {
    sshPath: '',
    sshConfigFile,
    connectTimeoutSec: 3,
    commandTimeoutMs: 20000,
    registryScope: 'user',
    hosts: hosts || [
      { id: 'xc', label: 'xc-test', ssh: 'xc-test', sockets: [socket()] },
      { id: 'fwd', label: 'xc-test-fwd', ssh: 'xc-test-fwd', sockets: [socket()] },
      { id: 'bad', label: 'xc-test-badkey', ssh: 'xc-test-badkey', sockets: [socket()] },
      { id: 'down', label: 'xc-unreachable', ssh: 'xc-unreachable', sockets: [socket()] },
    ],
    approval: { create: 'allow', send: 'allow', detach: 'allow' },
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 },
  }
}

const coreCache = new Map()

/**
 * Lazily import one `lib/core/*.js` module. Every test file uses this instead of a static
 * import so that a suite without the implementation (or without ssh infra) skips cleanly
 * rather than failing at module load.
 */
export function core(name) {
  if (!coreCache.has(name)) coreCache.set(name, import(`../../lib/core/${name}.js`))
  return coreCache.get(name)
}

/**
 * Instantiate the host service. Imported lazily so a missing implementation fails only the
 * tests that need it, with the real module error, instead of breaking test collection.
 */
export async function makeService({ socketName, hosts, registry, transport, config } = {}) {
  const { TmuxXcService } = await import('../../lib/service.js')
  const { memoryRegistry } = await import('../../lib/registry.js')
  const cfg = config || makeConfig({ socketName, hosts })
  return new TmuxXcService({ config: cfg, registry: registry || memoryRegistry(), transport })
}

/**
 * Per-test setup: skip the test when infra is missing, otherwise return a fresh socket and a
 * service factory. `t.after` kills only that socket's server.
 */
export function suiteContext(t) {
  const infra = checkInfra()
  if (infra.skip) {
    t.skip(infra.skip)
    return null
  }
  const socketName = newSocketName()
  t.after(() => killTestServer(socketName))
  return {
    socketName,
    config: makeConfig({ socketName }),
    makeService: (options = {}) => makeService({ socketName, ...options }),
  }
}

/**
 * Run one local `tmux -L <socket> …` invocation and return trimmed stdout. With an options
 * object as the last argument, `allowFailure: true` returns `{status, stdout, stderr}` instead
 * of throwing.
 */
export function localTmux(socketName, ...args) {
  assertTestSocket(socketName)
  const opts = { encoding: 'utf8', timeout: 15000 }
  if (args.at(-1) && typeof args.at(-1) === 'object') Object.assign(opts, args.pop())
  const res = spawnSync('tmux', ['-L', socketName, ...args], opts)
  if (opts.allowFailure) {
    return { status: res.status, stdout: (res.stdout || '').trimEnd(), stderr: (res.stderr || '').trimEnd() }
  }
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`tmux -L ${socketName} ${args.join(' ')} failed (${res.status}): ${(res.stderr || '').trim()}`)
  }
  return (res.stdout || '').trimEnd()
}

/** True when a tmux server currently answers on this isolated socket. */
export function hasServer(socketName) {
  assertTestSocket(socketName)
  return spawnSync('tmux', ['-L', socketName, 'list-sessions'], { encoding: 'utf8', timeout: 15000 }).status === 0
}

/** Kill only the isolated test server; never throws (safe from t.after). */
export function killTestServer(socketName) {
  assertTestSocket(socketName)
  spawnSync('tmux', ['-L', socketName, 'kill-server'], { encoding: 'utf8', timeout: 15000 })
}

/** Poll `fn` until it returns a truthy value or `timeoutMs` elapses. */
export async function waitFor(fn, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? `; last error: ${lastError.message}` : ''
      throw new Error(`waitFor timed out after ${timeoutMs} ms${suffix}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Poll `fn` until it stops throwing, then return its value. */
export async function waitUntilOk(fn, timeoutMs = 5000, intervalMs = 100) {
  const wrapped = await waitFor(async () => {
    try {
      return { value: await fn() }
    } catch {
      return null
    }
  }, timeoutMs, intervalMs)
  return wrapped.value
}

// ---------------------------------------------------------------------------
// Out-of-band tmux helpers. They only create/observe panes on the test socket.

/** Create a detached session running `argv`; returns its `$N` id. */
export function newDetachedSession(socketName, name, argv) {
  assertTestSocket(socketName)
  return localTmux(socketName, 'new-session', '-d', '-P', '-F', '#{session_id}', '-s', name, '--', ...argv).trim()
}

/** Create a detached session whose only pane runs `cat` (line echo, no prompt). */
export function newCatSession(socketName, name) {
  return newDetachedSession(socketName, name, ['cat'])
}

/** Create a detached session running `sh -c 'echo ready; exec sleep 600'`. */
export function newSleepSession(socketName, name) {
  return newDetachedSession(socketName, name, ['sh', '-c', 'echo ready; exec sleep 600'])
}

/** Pane id (`%N`) of a session/window target as a number. */
export function paneIdOf(socketName, target) {
  const id = localTmux(socketName, 'list-panes', '-t', target, '-F', '#{pane_id}').split('\n')[0].trim()
  return Number(id.replace(/^%/, ''))
}

/** Pane pid (`#{pane_pid}`) of a session/window/pane target. */
export function paneProcessPid(socketName, target) {
  return Number(localTmux(socketName, 'display-message', '-p', '-t', target, '#{pane_pid}'))
}

/** capture-pane of `target` (pane id or session name) including history. */
export function capturePane(socketName, target, lines = 2000) {
  assertTestSocket(socketName)
  const res = spawnSync(
    'tmux',
    ['-L', socketName, 'capture-pane', '-p', '-J', '-t', target, '-S', `-${lines}`],
    { encoding: 'utf8', timeout: 15000 },
  )
  if (res.status !== 0) throw new Error(`capture-pane ${target} failed: ${(res.stderr || '').trim()}`)
  return res.stdout
}

/** Wait until `target` pane buffer contains `text` as a literal substring. */
export function waitForPaneText(socketName, target, text, timeoutMs = 5000) {
  return waitFor(() => capturePane(socketName, target).includes(text), timeoutMs)
}

// ---------------------------------------------------------------------------
// Service-inventory traversal.

export function sessionsOf(inv, hostId, socketId = 'it') {
  const host = (inv.hosts || []).find((h) => h.id === hostId)
  const socket = host && (host.sockets || []).find((s) => s.id === socketId)
  return (socket && socket.sessions) || []
}

/** Find a session by current (sanitized) name. */
export function findSession(inv, hostId, name, socketId = 'it') {
  return sessionsOf(inv, hostId, socketId).find((s) => s.name === name)
}

/** Find a pane by its numeric tmux pane id (7 for %7). */
export function findPaneById(inv, hostId, pid, socketId = 'it') {
  for (const session of sessionsOf(inv, hostId, socketId)) {
    for (const win of session.windows || []) {
      for (const pane of win.panes || []) if (Number(pane.pid) === Number(pid)) return { session, window: win, pane }
    }
  }
  return null
}

/** Last-resort unique name within one test file (`names must match ^[A-Za-z0-9_-]{1,64}$`). */
let nameSeq = 0
export function uniqueName(prefix = 's') {
  nameSeq += 1
  return `${prefix}${process.pid % 10000}_${nameSeq}`
}

/** Await a promise expected to reject with an XcError code; returns the error. */
export async function rejectsWithCode(promise, code, message) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, code, `${message || 'call'} — expected ${code}, got ${err.code}: ${err.message}`)
    return err
  }
  assert.fail(`${message || 'call'} — expected rejection with ${code}, but it resolved`)
}
