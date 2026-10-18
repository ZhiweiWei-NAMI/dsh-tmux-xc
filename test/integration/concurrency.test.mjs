// PRD A10: two conversations drive two panes concurrently; no cross-talk and every payload
// arrives exactly once.
import assert from 'node:assert/strict'
import process from 'node:process'
import { describe, it } from 'node:test'
import {
  capturePane,
  checkInfra,
  findPaneById,
  newCatSession,
  newDetachedSession,
  paneIdOf,
  suiteContext,
  uniqueName,
  waitForPaneText,
} from './helpers.mjs'

const ROUNDS = 20

const skip = checkInfra().skip

describe('concurrency (A10)', { skip, timeout: 240000 }, () => {
  it('20 cross-conversation rounds (2 concurrent sends each) reach only their own pane', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      // Two out-of-band panes running `cat`: they echo whatever line they receive.
      const aName = uniqueName('ca')
      const bName = uniqueName('cb')
      newCatSession(ctx.socketName, aName)
      newCatSession(ctx.socketName, bName)
      const paneA = paneIdOf(ctx.socketName, aName)
      const paneB = paneIdOf(ctx.socketName, bName)
      assert.notEqual(paneA, paneB)

      const adoptedA = await service.adopt({
        hostId: 'xc', socketId: 'it', target: `%${paneA}`, by: { sessionId: 'conv-a' },
      })
      const adoptedB = await service.adopt({
        hostId: 'xc', socketId: 'it', target: `%${paneB}`, by: { sessionId: 'conv-b' },
      })

      // Two conversations in parallel each round; both services calls run at the same time.
      for (let i = 0; i < ROUNDS; i += 1) {
        await Promise.all([
          service.send({ uri: adoptedA.uri, text: `A-${i}-${process.pid}`, enter: true }),
          service.send({ uri: adoptedB.uri, text: `B-${i}-${process.pid}`, enter: true }),
        ])
      }

      for (let i = 0; i < ROUNDS; i += 1) {
        await waitForPaneText(ctx.socketName, `%${paneA}`, `A-${i}-${process.pid}`, 15000)
        await waitForPaneText(ctx.socketName, `%${paneB}`, `B-${i}-${process.pid}`, 15000)
      }

      const textA = capturePane(ctx.socketName, `%${paneA}`)
      const textB = capturePane(ctx.socketName, `%${paneB}`)
      for (let i = 0; i < ROUNDS; i += 1) {
        assert.ok(textA.includes(`A-${i}-${process.pid}`), `pane A got its marker ${i}`)
        assert.ok(textB.includes(`B-${i}-${process.pid}`), `pane B got its marker ${i}`)
        assert.ok(!textA.includes(`B-${i}-${process.pid}`), `pane A never sees B marker ${i}`)
        assert.ok(!textB.includes(`A-${i}-${process.pid}`), `pane B never sees A marker ${i}`)
      }
      // Exactly once: `cat` echoes each line a single time.
      assert.equal(textA.split(`A-0-${process.pid}`).length - 1, 1, 'marker delivered once to A')
      assert.equal(textB.split(`B-0-${process.pid}`).length - 1, 1, 'marker delivered once to B')

      // The service inventory did not mix the two panes up.
      const inv = await service.inventory({})
      assert.ok(findPaneById(inv, 'xc', paneA), 'pane A still present')
      assert.ok(findPaneById(inv, 'xc', paneB), 'pane B still present')
      assert.equal(
        localTmux(ctx.socketName, 'display-message', '-p', '-t', `%${paneA}`, '#{pane_dead}'),
        '0',
        'pane A is alive',
      )
    } finally {
      await service.close?.()
    }
  })

  it('parallel inventories on the same host agree and do not interfere', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      newDetachedSession(ctx.socketName, uniqueName('par'), ['sh', '-c', 'exec sleep 300'])
      const [first, second, third] = await Promise.all([
        service.inventory({}),
        service.inventory({}),
        service.inventory({ hostId: 'xc' }),
      ])
      const names = (inv) =>
        inv.hosts
          .find((h) => h.id === 'xc')
          .sockets.find((s) => s.id === 'it')
          .sessions.map((s) => s.sid)
          .sort()
      assert.deepEqual(names(first), names(second))
      assert.deepEqual(names(first), names(third))
    } finally {
      await service.close?.()
    }
  })
})
