// PRD A8/A11 adjacent guarantee: a mutating call interrupted after spawn is never replayed.
// We wrap the real transport with a counting spawn implementation and abort the signal right
// after ssh is spawned; the call must report OUTCOME_UNKNOWN and invoke spawn exactly once.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { describe, it } from 'node:test'
import { CODES, XcError } from '../../lib/core/errors.js'
import { runRemote } from '../../lib/core/transport.js'
import {
  newCatSession,
  paneIdOf,
  rejectsWithCode,
  suiteContext,
  uniqueName,
} from './helpers.mjs'

/** Transport decorator: counts ssh spawns and aborts the caller's signal shortly after spawn. */
function abortingTransport({ abortAfterMs = 150 } = {}) {
  let spawns = 0
  let onAbort = () => {}
  const transport = {
    spawnCount: () => spawns,
    setAbortHook(fn) {
      onAbort = fn
    },
    async runRemote(args) {
      const spawnImpl = (argv, opts = {}) => {
        spawns += 1
        const child = spawn(argv[0], argv.slice(1), {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        if (args.mutating) {
          setTimeout(() => onAbort(args), abortAfterMs)
        }
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
      return runRemote({ ...args, spawnImpl, ...opts })
    },
  }
  return transport
}

describe('mutation is never replayed (no-replay)', { timeout: 120000 }, () => {
  it('send aborted right after spawn → OUTCOME_UNKNOWN with exactly one spawn', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService({ transport: abortingTransport() })
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
      const mutationsBefore = service.transport.spawnCount()

      const controller = new AbortController()
      service.transport.setAbortHook(() => controller.abort())
      const err = await rejectsWithCode(
        service.send({ uri: pane.uri, text: 'should-be-uncertain', enter: true, signal: controller.signal }),
        CODES.OUTCOME_UNKNOWN,
        'aborted mutation',
      )
      assert.ok(err instanceof XcError)
      assert.equal(
        service.transport.spawnCount() - mutationsBefore,
        1,
        'mutation must spawn exactly once (no retry/replay)',
      )
    } finally {
      await service.close?.()
    }
  })

  it('read-only calls may retry, but never more than once per attempt', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    // A wrapper that makes the first ssh attempt fail before `begin` with HOST_UNREACHABLE.
    let attempts = 0
    const transport = {
      spawnCount: () => attempts,
      async runRemote(args) {
        attempts += 1
        if (attempts === 1) throw new XcError(CODES.HOST_UNREACHABLE, 'synthetic pre-begin failure')
        return runRemote(args)
      },
    }
    const service = await ctx.makeService({ transport })
    try {
      const inv = await service.inventory({})
      assert.ok(inv.hosts.length >= 1, 'inventory succeeded after one retry')
      assert.equal(attempts, 2, 'read-only path retried exactly once')
    } finally {
      await service.close?.()
    }
  })
})
