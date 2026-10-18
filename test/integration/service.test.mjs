// Service-level integration for PRD acceptance tests A1/A5/A6/A7, A11, A12 and A13.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CODES } from '../../lib/core/errors.js'
import { decodeRef } from '../../lib/core/uri.js'
import {
  capturePane,
  findSession,
  hasServer,
  killTestServer,
  localTmux,
  newCatSession,
  newDetachedSession,
  newSleepSession,
  paneIdOf,
  paneProcessPid,
  rejectsWithCode,
  suiteContext,
  uniqueName,
  waitFor,
  waitForPaneText,
  waitUntilOk,
} from './helpers.mjs'

describe('service (real ssh, isolated tmux)', { timeout: 180000 }, () => {
  it('A1/A5: create is visible in inventory; rename keeps the old ref resolvable', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      const name = uniqueName('create')
      const created = await service.create({
        hostId: 'xc',
        socketId: 'it',
        kind: 'session',
        name,
        by: { sessionId: 'chat-A', workspace: '/ws/a' },
      })
      assert.ok(created && created.uri, 'create returns a registry entry with uri')
      assert.equal(created.origin, 'created')
      assert.equal(created.kind, 'session')
      assert.equal(created.labels?.session ?? created.meta?.sessionName ?? name, name)

      const inv = await service.inventory({})
      const session = findSession(inv, 'xc', name)
      assert.ok(session, 'created session appears in inventory')
      assert.equal(session.sid, created.sid)
      assert.ok(session.windows.length >= 1)
      const win = session.windows[0]
      const pane = win.panes[0]
      assert.ok(pane, 'session has a pane')

      const before = await service.resolveRef(created.uri, {})
      assert.equal(before.result.code, 'OK')
      assert.equal(before.result.target.session, name)
      assert.equal(before.result.target.window, win.name)

      const newSessionName = uniqueName('renamed')
      const newWindowName = uniqueName('win')
      localTmux(ctx.socketName, 'rename-session', '-t', `$${created.sid}`, newSessionName)
      localTmux(ctx.socketName, 'rename-window', '-t', `@${win.wid}`, newWindowName)

      const after = await service.resolveRef(created.uri, {})
      assert.equal(after.result.code, 'OK')
      assert.equal(after.result.target.session, newSessionName)
      assert.equal(after.result.target.window, newWindowName)
      // Same ids, same generation: the durable reference did not move.
      assert.equal(Number(after.result.target.pid), Number(pane.pid))
    } finally {
      await service.close?.()
    }
  })

  it('A6: kill + recreate the same name leaves the old ref TARGET_GONE', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      const name = uniqueName('gone')
      const created = await service.create({
        hostId: 'xc',
        socketId: 'it',
        kind: 'session',
        name,
        by: { sessionId: 'chat-A' },
      })
      const oldSid = created.sid

      localTmux(ctx.socketName, 'kill-session', '-t', `$${oldSid}`)
      await waitFor(
        () => localTmux(ctx.socketName, 'has-session', '-t', `$${oldSid}`, { allowFailure: true }).status !== 0,
        5000,
      )
      // Recreate the exact same name — a naive name-based implementation would follow it.
      newDetachedSession(ctx.socketName, name, ['cat'])

      await rejectsWithCode(
        service.resolveRef(created.uri, {}),
        CODES.TARGET_GONE,
        'old ref after name reuse',
      )

      const inv = await service.inventory({})
      const fresh = findSession(inv, 'xc', name)
      assert.ok(fresh, 'new same-named session exists')
      assert.notEqual(fresh.sid, oldSid, 'recreated session has a new id')
    } finally {
      await service.close?.()
    }
  })

  it('A7: restarting the tmux server on the same socket yields SERVER_RESTARTED', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      const name = uniqueName('restart')
      const created = await service.create({
        hostId: 'xc',
        socketId: 'it',
        kind: 'session',
        name,
        by: { sessionId: 'chat-A' },
      })
      const genBefore = decodeRef(created.uri).gen

      killTestServer(ctx.socketName)
      await waitFor(() => !hasServer(ctx.socketName), 5000)
      // New server lifetime, same socket and same session name.
      newDetachedSession(ctx.socketName, name, ['cat'])
      await waitUntilOk(() => localTmux(ctx.socketName, 'has-session', '-t', name), 5000)

      const err = await rejectsWithCode(
        service.resolveRef(created.uri, {}),
        CODES.SERVER_RESTARTED,
        'ref across server restart',
      )
      assert.equal(err.code, CODES.SERVER_RESTARTED)

      const inv = await service.inventory({})
      const socket = (inv.hosts.find((h) => h.id === 'xc') || {}).sockets?.[0]
      assert.ok(socket && socket.server, 'inventory sees the new server')
      assert.notEqual(String(socket.server.gen), String(genBefore))
    } finally {
      await service.close?.()
    }
  })

  it('A13: adopt is non-invasive (options, environment, pane content, process unchanged)', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      const name = uniqueName('adopt')
      const sid = newSleepSession(ctx.socketName, name)
      await waitForPaneText(ctx.socketName, `$${sid}`, 'ready')
      const osPid = paneProcessPid(ctx.socketName, `$${sid}`)
      const paneId = paneIdOf(ctx.socketName, sid)

      const showOptionsBefore = localTmux(ctx.socketName, 'show-options', '-g')
      const showEnvBefore = localTmux(ctx.socketName, 'show-environment', '-g')
      const sessionOptionsBefore = localTmux(ctx.socketName, 'show-options', '-t', `$${sid}`)
      const contentBefore = capturePane(ctx.socketName, `$${sid}`)

      const entry = await service.adopt({
        hostId: 'xc',
        socketId: 'it',
        target: `$${sid}`,
        by: { sessionId: 'chat-A', workspace: '/ws/a' },
      })
      assert.ok(entry && entry.uri, 'adopt returns a registry entry')
      assert.equal(entry.origin, 'adopted')

      assert.equal(localTmux(ctx.socketName, 'show-options', '-g'), showOptionsBefore, 'global options unchanged')
      assert.equal(
        localTmux(ctx.socketName, 'show-environment', '-g'),
        showEnvBefore,
        'global environment unchanged',
      )
      assert.equal(
        localTmux(ctx.socketName, 'show-options', '-t', `$${sid}`),
        sessionOptionsBefore,
        'session options unchanged',
      )
      assert.equal(capturePane(ctx.socketName, `$${sid}`), contentBefore, 'pane content unchanged')
      // The marker process was not respawned or killed.
      assert.equal(paneProcessPid(ctx.socketName, `$${sid}`), osPid)

      const resolved = await service.resolveRef(entry.uri, {})
      assert.equal(resolved.result.code, 'OK')
      assert.equal(resolved.result.target.session, name, 'adopted session still resolves to itself')
    } finally {
      await service.close?.()
    }
  })

  it('A3: send delivers text literally (no shell expansion); named keys allowed, free-form keys rejected', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    try {
      const name = uniqueName('send')
      newCatSession(ctx.socketName, name)
      const paneId = paneIdOf(ctx.socketName, name)
      const pane = await service.adopt({
        hostId: 'xc',
        socketId: 'it',
        target: `%${paneId}`,
        by: { sessionId: 'chat-A' },
      })

      const text = "hello 你好 🌏 $(id) `x` 'q'"
      const sent = await service.send({ uri: pane.uri, text, enter: false })
      assert.equal(sent.delivered, true)
      await waitForPaneText(ctx.socketName, `%${paneId}`, text, 5000)
      const captured = capturePane(ctx.socketName, `%${paneId}`)
      // Literal delivery: no command substitution or backtick expansion happened.
      assert.ok(captured.includes("$(id) `x` 'q'"), 'payload preserved literally')
      assert.ok(!/uid=\d+/.test(captured), 'no shell expansion of $(id)')

      const withEnter = await service.send({ uri: pane.uri, text: 'line-two', enter: true })
      assert.equal(withEnter.delivered, true)
      await waitForPaneText(ctx.socketName, `%${paneId}`, 'line-two', 5000)

      await rejectsWithCode(
        service.send({ uri: pane.uri, keys: ['rm -rf'] }),
        CODES.INVALID_ARGUMENT,
        'free-form key name',
      )

      const keyed = await service.send({ uri: pane.uri, keys: ['C-c'] })
      assert.equal(keyed.delivered, true)
    } finally {
      await service.close?.()
    }
  })

  it('A11: kill requires the exact confirm; detach keeps processes; forget only drops the entry', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const { memoryRegistry } = await import('../../lib/registry.js')
    const registry = memoryRegistry()
    const service = await ctx.makeService({ registry })
    try {
      const name = uniqueName('kill')
      const sid = newSleepSession(ctx.socketName, name)
      await waitForPaneText(ctx.socketName, `$${sid}`, 'ready')
      const paneId = paneIdOf(ctx.socketName, sid)
      const pane = await service.adopt({
        hostId: 'xc',
        socketId: 'it',
        target: `%${paneId}`,
        by: { sessionId: 'chat-A' },
      })
      const confirm = `xc:it:%${paneId}`

      await rejectsWithCode(
        service.kill({ uri: pane.uri, confirm: 'wrong-target' }),
        CODES.CONFIRM_MISMATCH,
        'wrong kill confirm',
      )
      assert.equal(
        localTmux(ctx.socketName, 'has-session', '-t', `$${sid}`, { allowFailure: true }).status,
        0,
        'pane still alive after a rejected kill',
      )

      await service.kill({ uri: pane.uri, confirm })
      await waitFor(
        () => localTmux(ctx.socketName, 'has-session', '-t', `$${sid}`, { allowFailure: true }).status !== 0,
        5000,
      )

      // detach does not kill the pane process.
      const keep = uniqueName('detach')
      const keepSid = newSleepSession(ctx.socketName, keep)
      await waitForPaneText(ctx.socketName, `$${keepSid}`, 'ready')
      const keepPid = paneProcessPid(ctx.socketName, `$${keepSid}`)
      const adopted = await service.adopt({
        hostId: 'xc',
        socketId: 'it',
        target: `$${keepSid}`,
        by: { sessionId: 'chat-A' },
      })
      await service.detach({ uri: adopted.uri })
      assert.equal(paneProcessPid(ctx.socketName, `$${keepSid}`), keepPid, 'detach keeps the process')
      assert.equal(localTmux(ctx.socketName, 'has-session', '-t', `$${keepSid}`, { allowFailure: true }).status, 0)

      // forget removes only the registry row.
      assert.ok(await service.forget({ uri: adopted.uri }), 'forget reports success')
      assert.ok(!registry.resourceGet(adopted.key), 'registry entry removed')
      assert.equal(
        localTmux(ctx.socketName, 'has-session', '-t', `$${keepSid}`, { allowFailure: true }).status,
        0,
        'tmux object still exists after forget',
      )
      const inv = await service.inventory({})
      assert.ok(findSession(inv, 'xc', keep), 'inventory still lists the forgotten tmux session')
    } finally {
      await service.close?.()
    }
  })

  it('A12: a new service over the same registry resolves the old ref; the process survives', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const { memoryRegistry } = await import('../../lib/registry.js')
    const registry = memoryRegistry()
    const first = await ctx.makeService({ registry })
    let second
    try {
      const name = uniqueName('persist')
      const sid = newSleepSession(ctx.socketName, name)
      await waitForPaneText(ctx.socketName, `$${sid}`, 'ready')
      const osPid = paneProcessPid(ctx.socketName, `$${sid}`)
      const entry = await first.adopt({
        hostId: 'xc',
        socketId: 'it',
        target: `$${sid}`,
        by: { sessionId: 'chat-A', workspace: '/ws/a' },
      })

      // Simulate a DSH restart: same storage, brand-new service object.
      second = await ctx.makeService({ registry })
      const resolved = await second.resolveRef(entry.uri, {})
      assert.equal(resolved.result.code, 'OK')
      assert.equal(resolved.result.target.session, name)
      assert.equal(paneProcessPid(ctx.socketName, `$${sid}`), osPid, 'remote process survived the restart')
    } finally {
      await second?.close?.()
      await first.close?.()
    }
  })
})
