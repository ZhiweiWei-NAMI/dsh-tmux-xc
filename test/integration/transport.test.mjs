// Transport-level integration: real ssh through the loopback sshd in scripts/test-infra.sh,
// plus the no-replay guarantee for mutating calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { CODES, XcError } from '../../lib/core/errors.js'
import { buildSshArgv, runRemote } from '../../lib/core/transport.js'
import { inventoryScript, newNonce } from '../../lib/core/scripts.js'
import {
  checkInfra,
  makeConfig,
  newCatSession,
  newSocketName,
  paneIdOf,
  rejectsWithCode,
  suiteContext,
  uniqueName,
} from './helpers.mjs'

const skip = checkInfra().skip

describe('transport (real ssh)', { skip, timeout: 120000 }, () => {
  const socketName = newSocketName()
  const cfg = makeConfig({ socketName })

  it('inventory with no tmux server yields a noserver record, not an error', async () => {
    const nonce = newNonce()
    const res = await runRemote({
      cfg,
      alias: 'xc-test',
      script: inventoryScript(nonce, { id: 'it', name: socketName }),
      nonce,
      mutating: false,
      timeoutMs: 15000,
    })
    assert.equal(res.exitCode, 0)
    const types = res.records.map((r) => r[0])
    assert.ok(types.includes('noserver'), `expected a noserver record, got ${JSON.stringify(types)}`)
  })

  it('service inventory on a host with no server reports server:null without error', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      const inv = await service.inventory({ hostId: 'xc' })
      const host = inv.hosts.find((h) => h.id === 'xc')
      assert.ok(host, 'host is listed')
      assert.equal(host.reachable, true, 'reachable ssh host')
      assert.equal(host.error, undefined)
      const socket = host.sockets.find((s) => s.id === 'it')
      assert.ok(socket, 'socket is listed')
      assert.equal(socket.server, null, 'no tmux server yet')
      assert.deepEqual(socket.sessions, [], 'no sessions')
    } finally {
      await service.close?.()
    }
  })

  it('works through an alias with a conflicting LocalForward + ExitOnForwardFailure (ClearAllForwardings)', async () => {
    const nonce = newNonce()
    const res = await runRemote({
      cfg,
      alias: 'xc-test-fwd',
      script: inventoryScript(nonce, { id: 'it', name: socketName }),
      nonce,
      mutating: false,
      timeoutMs: 15000,
    })
    assert.equal(res.exitCode, 0)
    assert.ok(res.records.some((r) => r[0] === 'noserver'), 'ssh ran despite the forwarding conflict')
  })

  it('host key mismatch surfaces as SSH_HOSTKEY', async () => {
    const nonce = newNonce()
    const err = await rejectsWithCode(
      runRemote({
        cfg,
        alias: 'xc-test-badkey',
        script: inventoryScript(nonce, { id: 'it', name: socketName }),
        nonce,
        mutating: false,
        timeoutMs: 15000,
      }),
      CODES.SSH_HOSTKEY,
      'bad host key',
    )
    assert.ok(err instanceof XcError)
  })

  it('connection refused surfaces as HOST_UNREACHABLE quickly', async () => {
    const nonce = newNonce()
    const started = Date.now()
    await rejectsWithCode(
      runRemote({
        cfg,
        alias: 'xc-unreachable',
        script: inventoryScript(nonce, { id: 'it', name: socketName }),
        nonce,
        mutating: false,
        timeoutMs: 15000,
      }),
      CODES.HOST_UNREACHABLE,
      'unreachable host',
    )
    // ConnectTimeout is 3 s; allow one read-only retry plus scheduling.
    assert.ok(Date.now() - started < 15000, 'unreachable host should fail quickly')
  })

  it('AbortSignal cancels an in-flight read', async () => {
    const nonce = newNonce()
    const controller = new AbortController()
    // A remote script that waits long enough for the abort to win.
    const script = [
      `printf 'XC1${nonce}\\037begin\\036${nonce}\\036\\n'`,
      'sleep 30',
      `printf 'XC1${nonce}\\037end\\036${nonce}\\036\\n'`,
    ].join('\n')
    const pending = runRemote({
      cfg,
      alias: 'xc-test',
      script,
      nonce,
      mutating: false,
      signal: controller.signal,
      timeoutMs: 30000,
    })
    setTimeout(() => controller.abort(), 300)
    await rejectsWithCode(pending, CODES.CANCELLED, 'aborted read')
  })

  it('argv uses BatchMode/ClearAllForwardings and never disables host key checking', () => {
    const argv = buildSshArgv({ sshPath: '', sshConfigFile: cfg.sshConfigFile, connectTimeoutSec: 7 }, 'xc-test')
    const joined = argv.join(' ')
    assert.ok(joined.includes('BatchMode=yes'), 'BatchMode=yes')
    assert.ok(joined.includes('ClearAllForwardings=yes'), 'ClearAllForwardings=yes')
    assert.ok(joined.includes('ConnectTimeout=7'), 'ConnectTimeout from config')
    assert.ok(!/StrictHostKeyChecking\s*=\s*no/i.test(joined), 'never StrictHostKeyChecking=no')
    assert.ok(!joined.includes('UserKnownHostsFile=/dev/null'), 'never discards known_hosts')
    assert.ok(!argv.includes('-A'), 'never ForwardAgent')
    assert.equal(argv.at(-2), 'xc-test')
    assert.equal(argv.at(-1), 'sh -s')
    const fwdIndex = argv.indexOf('-F')
    if (fwdIndex >= 0) {
      assert.equal(argv[fwdIndex + 1], cfg.sshConfigFile)
      assert.ok(fwdIndex < argv.indexOf('xc-test'), '-F precedes the destination')
    }
  })
})

/** Transport decorator: counts ssh spawns and aborts the caller's signal shortly after spawn. */
function abortingTransport({ abortAfterMs = 100 } = {}) {
  let spawns = 0
  let mutatingSpawns = 0
  let abortHook = () => {}
  return {
    /** All ssh spawns seen by this wrapper. */
    spawnCount: () => spawns,
    /** Spawns of scripts flagged `mutating: true` (what "no replay" is about). */
    mutatingSpawnCount: () => mutatingSpawns,
    setAbortHook(fn) {
      abortHook = fn
    },
    async runRemote(args) {
      const spawnImpl = (argv, opts = {}) => {
        spawns += 1
        if (args.mutating) mutatingSpawns += 1
        const child = spawn(argv[0], argv.slice(1), {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...opts,
        })
        if (args.mutating) setTimeout(() => abortHook(args), abortAfterMs)
        return {
          stdout: child.stdout,
          stderr: child.stderr,
          stdinWrite: (str) => child.stdin.write(str),
          kill: () => child.kill('SIGKILL'),
          done: new Promise((resolve) => {
            child.once('close', (code, signal) => resolve({ code, signal }))
            child.once('error', () => resolve({ code: null, signal: null }))
          }),
        }
      }
      return runRemote({ ...args, spawnImpl })
    },
  }
}

describe('mutation no-replay', { skip, timeout: 120000 }, () => {
  it('send aborted right after spawn → OUTCOME_UNKNOWN with exactly one spawn', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const transport = abortingTransport()
    const service = await ctx.makeService({ transport })
    try {
      const name = uniqueName('noreplay')
      newCatSession(ctx.socketName, name)
      const paneId = paneIdOf(ctx.socketName, name)
      const pane = await service.adopt({
        hostId: 'xc',
        socketId: 'it',
        target: `%${paneId}`,
        by: { sessionId: 'chat-A' },
      })

      const controller = new AbortController()
      transport.setAbortHook(() => controller.abort())
      const before = transport.mutatingSpawnCount()
      const err = await rejectsWithCode(
        service.send({ uri: pane.uri, text: 'uncertain', enter: true, signal: controller.signal }),
        CODES.OUTCOME_UNKNOWN,
        'aborted mutation',
      )
      assert.ok(err instanceof XcError)
      assert.equal(transport.mutatingSpawnCount() - before, 1, 'mutation spawned exactly once (no replay)')
    } finally {
      await service.close?.()
    }
  })
})
