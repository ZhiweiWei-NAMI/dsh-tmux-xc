// Shared fixtures for the dsh-tmux-xc integration suite.
//
// The suite talks to a real loopback sshd created by scripts/test-infra.sh and to an isolated
// tmux server on a per-test `xc-it-<random>` socket. Because the ssh target is the same Linux
// machine/user, tests may also drive `tmux -L <socket>` locally (out-of-band setup/observation).
// Every function here refuses to touch any other socket.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import process from 'node:process'

export const DEFAULT_SSH_CONFIG = new URL('../../test-infra/sshd/ssh_config', import.meta.url).pathname
export const sshConfigFile = process.env.XC_SSH_CONFIG || DEFAULT_SSH_CONFIG

const SOCKET_RE = /^xc-it-[A-Za-z0-9._-]{1,48}$/

/**
 * Decide whether this file can run. Returns `{ skip }` with a clear message when the
 * loopback sshd is unavailable, `{}` otherwise. XC_SSH_CONFIG is required so a random
 * developer machine never silently exercises the real ssh config.
 */
export function checkInfra() {
  if (!process.env.XC_SSH_CONFIG) {
    return {
      skip: 'integration tests skipped: XC_SSH_CONFIG is not set ' +
        '(run scripts/test-infra.sh up, then export XC_SSH_CONFIG=<repo>/test-infra/sshd/ssh_config)',
    }
  }
  const res = spawnSync('ssh', ['-F', sshConfigFile, 'xc-test', 'true'], {
    encoding: 'utf8',
    timeout: 15000,
  })
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : (res.stderr || '').trim()
    return {
      skip: `integration tests skipped: "ssh -F ${sshConfigFile} xc-test true" failed: ${detail}`,
    }
  }
  return {}
}

/** Throw unless `name` is a socket this suite is allowed to address. */
export function assertTestSocket(name) {
  assert.match(String(name), SOCKET_RE, `refusing to use non-test tmux socket ${JSON.stringify(name)}`)
  return name
}

/** Fresh isolated socket name, e.g. `xc-it-1f3a9c`. */
export function newSocketName() {
  return `xc-it-${randomBytes(6).toString('hex')}`
}

/**
 * Build a plugin config per DESIGN §3 for the four ssh hosts provisioned by test-infra.sh.
 * `hosts` (optional) overrides the default host list; sockets always use `socketName`.
 */
export function makeConfig({ socketName, hosts } = {}) {
  assertTestSocket(socketName)
  return {
    sshPath: '',
    sshConfigFile,
    connectTimeoutSec: 3,
    commandTimeoutMs: 20000,
    registryScope: 'user',
    hosts: hosts || [
      { id: 'xc', label: 'xc-test', ssh: 'xc-test', sockets: [{ id: 'it', name: socketName }] },
      { id: 'fwd', label: 'xc-test-fwd', ssh: 'xc-test-fwd', sockets: [{ id: 'it', name: socketName }] },
      { id: 'bad', label: 'xc-test-badkey', ssh: 'xc-test-badkey', sockets: [{ id: 'it', name: socketName }] },
      { id: 'down', label: 'xc-unreachable', ssh: 'xc-unreachable', sockets: [{ id: 'it', name: socketName }] },
    ],
    approval: { create: 'allow', send: 'allow', detach: 'allow' },
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 },
  }
}

/**
 * Instantiate the host service. Imported lazily so a missing implementation fails only the
 * tests (with the module error), not test collection.
 */
export async function makeService({ socketName, hosts, registry, transport, config } = {}) {
  const { TmuxXcService } = await import('../../lib/service.js')
  const { memoryRegistry } = await import('../../lib/registry.js')
  const cfg = config || makeConfig({ socketName, hosts })
  return new TmuxXcService({ config: cfg, registry: registry || memoryRegistry(), transport })
}

/**
 * Run one local `tmux -L <socket> …` invocation and return trimmed stdout. This is the
 * out-of-band path: it deliberately does not go through the service/transport.
 * `{ input, allowFailure }` — with allowFailure a non-zero exit returns
 * `{ status, stdout, stderr }` instead of throwing.
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

/** Raw stdout bytes of a local tmux invocation (for exact pane content). */
export function localTmuxRaw(socketName, ...args) {
  assertTestSocket(socketName)
  return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8', timeout: 15000 })
}

/**
 * Per-file setup: skip when infra is missing, otherwise hand back a service and a socket name
 * that `t.after` destroys. The service is created lazily by tests that need a fresh one.
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
    async makeService(options = {}) {
      return makeService({ socketName, ...options })
    },
  }
}

/** True when a tmux server currently answers on this isolated socket. */
export function hasServer(socketName) {
  assertTestSocket(socketName)
  const res = spawnSync('tmux', ['-L', socketName, 'list-sessions'], { encoding: 'utf8', timeout: 15000 })
  return res.status === 0
}

/** Kill only the isolated test server; never throws (used from t.after). */
export function killTestServer(socketName) {
  assertTestSocket(socketName)
  spawnSync('tmux', ['-L', socketName, 'kill-server'], { encoding: 'utf8', timeout: 15000 })
}

/**
 * Poll `fn` until it returns a truthy value or `timeoutMs` elapses.
 * Resolves with the last value; rejects with the last error/timeout otherwise.
 */
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

/** Poll `fn` until it stops throwing, returning its value. */
export async function waitUntilOk(fn, timeoutMs = 5000, intervalMs = 100) {
  return waitFor(async () => {
    try {
      return { ok: await fn() }
    } catch {
      return null
    }
  }, timeoutMs, intervalMs).then((v) => v.ok)
}

// ---------------------------------------------------------------------------
// Out-of-band pane helpers. These only create/kill panes on the test socket.

/** Create a detached session running `argv`, return `{ sid, name }` (created via -P -F). */
export function newDetachedSession(socketName, name, argv) {
  assertTestSocket(socketName)
  const fmt = '#{session_id}'
  const out = localTmux(socketName, 'new-session', '-d', '-P', '-F', fmt, '-s', name, '--', ...argv)
  return { sid: out.trim(), name }
}

/** Create a detached session whose only pane runs `cat` (line echo, no shell prompt). */
export function newCatSession(socketName, name) {
  return newDetachedSession(socketName, name, ['cat'])
}

/** Create a detached session running a long-lived marker process. */
export function newSleepSession(socketName, name) {
  return newDetachedSession(socketName, name, ['sh', '-c', 'echo ready; exec sleep 600'])
}

/** Current pane id (`%N`) of a session/window target. */
export function paneOf(socketName, target) {
  return localTmux(socketName, 'list-panes', '-t', target, '-F', '#{pane_id}').split('\n')[0].trim()
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

/** Wait until `target` pane buffer contains `text` (literal substring). */
export async function waitForPaneText(socketName, target, text, timeoutMs = 5000) {
  return waitFor(() => capturePane(socketName, target).includes(text), timeoutMs)
}

/** Pid of the process running in the pane. */
export function panePid(socketName, target) {
  return Number(localTmux(socketName, 'display-message', '-p', '-t', target, '#{pane_pid}'))
}

/** Pid of the foreground process in the pane (e.g. `sleep`, not its `sh` parent). */
export function paneProcessPid(socketName, target) {
  return Number(localTmux(socketName, 'display-message', '-p', '-t', target, '#{pane_pid}'))
}

/** Numeric id from a tmux id string ("%7" -> 7, "$3" -> 3, "@2" -> 2). */
export function idNum(id) {
  return Number(String(id).replace(/^[%$@]/, ''))
}

/** Pane id (`%N`) of a session/window target. */
export function paneIdOf(socketName, target) {
  return Number(localTmux(socketName, 'list-panes', '-t', target, '-F', '#{pane_id}').split('\n')[0].trim().replace(/^%/, ''))
}

/** `tmux -L sock show-options -g` snapshot as a Map of option -> value. */
export function globalOptionsSnapshot(socketName) {
  const out = localTmux(socketName, 'show-options', '-g')
  const map = new Map()
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s+(.*)$/.exec(line)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** `tmux -L sock show-environment -g` snapshot as a Map. */
export function globalEnvironmentSnapshot(socketName) {
  const out = localTmux(socketName, 'show-environment', '-g')
  const map = new Map()
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** Session option snapshot (`show-options -t $sid`). */
export function sessionOptionsSnapshot(socketName, target) {
  const out = localTmux(socketName, 'show-options', '-t', target)
  const map = new Map()
  for (const line of out.split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s+(.*)$/.exec(line)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** Recursively collect tokens from a service inventory result. */
export function collectTokens(node, out = []) {
  if (!node || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (key === 'token' && typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') collectTokens(value, out)
  }
  return out
}

/** Walk a service inventory result for the parsed host with id `hostId`. */
export function hostInventory(inv, hostId) {
  return (inv.hosts || []).find((h) => h.id === hostId)
}

/** First socket entry of a host in a service inventory result. */
export function socketInventory(inv, hostId, socketId = 'it') {
  const host = hostInventory(inv, hostId)
  return host && (host.sockets || []).find((s) => s.id === socketId)
}

/** All sessions of a host/socket in a service inventory result (`[]` when absent). */
export function sessionsOf(inv, hostId, socketId = 'it') {
  const socket = socketInventory(inv, hostId, socketId)
  return (socket && socket.sessions) || []
}

/** Find a session by name in a service inventory result. */
export function findSession(inv, hostId, name, socketId = 'it') {
  return sessionsOf(inv, hostId, socketId).find((s) => s.name === name)
}

/** Find a pane by pid in a service inventory result. */
export function findPaneByPid(inv, hostId, pid, socketId = 'it') {
  for (const session of sessionsOf(inv, hostId, socketId)) {
    for (const win of session.windows || []) {
      for (const pane of win.panes || []) if (Number(pane.pid) === Number(pid)) return { session, window: win, pane }
    }
  }
  return null
}

/** Pane found by tmux id number (e.g. 7 for %7) in a service inventory result. */
export function findPaneById(inv, hostId, pid, socketId = 'it') {
  return findPaneByPid(inv, hostId, pid, socketId)
}

/** Await a promise expected to reject with an XcError code; returns the error. */
export async function rejectsWithCode(promise, code, message) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, code, `${message || 'error'} — expected ${code}, got ${err.code}: ${err.message}`)
    return err
  }
  assert.fail(`${message || 'call'} — expected rejection with ${code}, but it resolved`)
}

/** Small deterministic unique suffix for names within one test file. */
let nameSeq = 0
export function uniqueName(prefix = 's') {
  nameSeq += 1
  return `${prefix}${process.pid % 10000}_${nameSeq}`
}
