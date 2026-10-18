// RV1 remote safety regressions. Intentionally real tmux/SSH integration, never
// substitutes a mock for the command parser, queue, pane options or capture size.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  capturePane, checkInfra, core, killTestServer, localTmux, newCatSession,
  newDetachedSession, paneIdOf, rejectsWithCode, suiteContext, uniqueName, waitFor,
  waitForPaneText,
} from './helpers.mjs'

const skip = checkInfra().skip

function expectation(socketName, target) {
  const [gen, sid, wid, pid] = localTmux(socketName, 'display-message', '-p', '-t', target,
    '#{pid}-#{start_time} #{session_id} #{window_id} #{pane_id}').split(' ')
  return { gen, sid: Number(sid.slice(1)), wid: Number(wid.slice(1)), pid: Number(pid.slice(1)), target }
}

async function remote(ctx, builder, expect, options, { mutating = true, transform = (s) => s } = {}) {
  const scripts = await core('scripts')
  const { runRemote } = await core('transport')
  const nonce = scripts.newNonce()
  const script = transform(scripts[builder](nonce, { id: 'it', name: ctx.socketName }, expect, options))
  return runRemote({ cfg: ctx.config, alias: 'xc-test', nonce, script, mutating })
}

describe('RV1 core safety (real tmux parser and isolated socket)', { skip, timeout: 180000 }, () => {
  it('RV1-01: all create cwd paths treat hash formats/jobs as literal directories', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const parent = resolve(tmpdir())
    const directory = mkdtempSync(join(parent, 'xc-cwd-'))
    t.after(() => {
      assert.equal(dirname(resolve(directory)), parent)
      assert.ok(directory.startsWith(join(parent, 'xc-cwd-')))
      rmSync(directory, { recursive: true, force: true })
    })
    const marker = join(directory, 'SHOULD_NOT_EXIST')
    const cwd = join(directory, `#(touch ${marker})`, '#{session_id}', 'literal#hash', "quote'and space")
    mkdirSync(cwd, { recursive: true })
    const service = await ctx.makeService()
    t.after(() => service.close())
    const session = await service.create({
      hostId: 'xc', socketId: 'it', kind: 'session', name: uniqueName('literal'), cwd,
    })
    const { decodeRef } = await core('uri')
    const createdIdentity = decodeRef(session.uri)
    const observed = expectation(ctx.socketName, `$${session.sid}`)
    assert.equal(createdIdentity.gen, observed.gen)
    assert.equal(createdIdentity.sid, observed.sid)
    assert.equal(localTmux(ctx.socketName, 'display-message', '-p', '-t', `$${session.sid}`, '#{pane_current_path}'), cwd)
    const window = await service.create({
      hostId: 'xc', socketId: 'it', kind: 'window', parentUri: session.uri, name: uniqueName('window'), cwd,
    })
    assert.equal(localTmux(ctx.socketName, 'display-message', '-p', '-t', `@${window.wid}`, '#{pane_current_path}'), cwd)
    const pane = await service.adopt({ hostId: 'xc', socketId: 'it', target: `%${paneIdOf(ctx.socketName, `@${window.wid}`)}` })
    const split = await service.create({ hostId: 'xc', socketId: 'it', kind: 'pane', parentUri: pane.uri, cwd })
    assert.equal(localTmux(ctx.socketName, 'display-message', '-p', '-t', `%${split.pid}`, '#{pane_current_path}'), cwd)
    assert.equal(existsSync(marker), false, 'no tmux format shell job executed')
  })

  it('RV1-02: synchronized two-pane windows receive no bytes and retain their option', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newCatSession(ctx.socketName, uniqueName('sync'))
    const first = `%${paneIdOf(ctx.socketName, sid)}`
    const second = localTmux(ctx.socketName, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', first, 'cat')
    localTmux(ctx.socketName, 'set-window-option', '-t', sid, 'synchronize-panes', 'on')
    const before = [capturePane(ctx.socketName, first), capturePane(ctx.socketName, second)]
    await rejectsWithCode(remote(ctx, 'sendScript', expectation(ctx.socketName, first), {
      hex: ['62', '61', '64'], enter: true,
    }), 'SYNCHRONIZED_PANES')
    assert.equal(capturePane(ctx.socketName, first), before[0])
    assert.equal(capturePane(ctx.socketName, second), before[1])
    assert.equal(localTmux(ctx.socketName, 'show-window-options', '-v', '-t', sid, 'synchronize-panes'), 'on')
  })

  it('RV1-02: copy mode, input-off and dead panes have distinct refusal codes', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newCatSession(ctx.socketName, uniqueName('states'))
    const target = `%${paneIdOf(ctx.socketName, sid)}`
    const expect = expectation(ctx.socketName, target)
    localTmux(ctx.socketName, 'copy-mode', '-t', target)
    await rejectsWithCode(remote(ctx, 'sendScript', expect, { hex: ['61'] }), 'PANE_IN_MODE')
    localTmux(ctx.socketName, 'send-keys', '-t', target, '-X', 'cancel')
    localTmux(ctx.socketName, 'select-pane', '-t', target, '-d')
    await rejectsWithCode(remote(ctx, 'sendScript', expect, { hex: ['61'] }), 'PANE_INPUT_DISABLED')
    localTmux(ctx.socketName, 'select-pane', '-t', target, '-e')
    localTmux(ctx.socketName, 'set-window-option', '-t', target, 'remain-on-exit', 'on')
    localTmux(ctx.socketName, 'send-keys', '-t', target, 'C-d')
    await waitFor(() => localTmux(ctx.socketName, 'display-message', '-p', '-t', target, '#{pane_dead}') === '1')
    await rejectsWithCode(remote(ctx, 'sendScript', expect, { enter: true }), 'PANE_DEAD')
  })

  it('RV1-04: stale generation and ancestry cannot redirect queued actions', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newCatSession(ctx.socketName, uniqueName('identity'))
    const target = `%${paneIdOf(ctx.socketName, sid)}`
    const old = expectation(ctx.socketName, target)
    localTmux(ctx.socketName, 'split-window', '-d', '-t', target, 'cat')
    localTmux(ctx.socketName, 'break-pane', '-d', '-s', target)
    for (const [builder, options, mutating] of [
      ['sendScript', { hex: ['61'] }, true], ['captureScript', {}, false],
      ['detachScript', undefined, true], ['killScript', 'pane', true],
    ]) await rejectsWithCode(remote(ctx, builder, old, options, { mutating }), 'TARGET_CHANGED')
    assert.ok(localTmux(ctx.socketName, 'display-message', '-p', '-t', target, '#{pane_id}'))
    killTestServer(ctx.socketName)
    newCatSession(ctx.socketName, uniqueName('replacement'))
    await rejectsWithCode(remote(ctx, 'sendScript', old, { hex: ['61'], enter: true }), 'SERVER_RESTARTED')
    assert.equal(capturePane(ctx.socketName, '%0').includes('a'), false)
  })

  it('F4: rejected first actions are REMOTE_ERROR with visible tmux diagnostics', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newCatSession(ctx.socketName, uniqueName('reject'))
    const target = `%${paneIdOf(ctx.socketName, sid)}`
    const before = capturePane(ctx.socketName, target)
    const error = await rejectsWithCode(remote(ctx, 'sendScript', expectation(ctx.socketName, target), {
      hex: ['61'], enter: true,
    }, {
      transform: (script) => script.replace(' -H 61', ' -X no-such-copy-command'),
    }), 'REMOTE_ERROR')
    assert.ok(error.message.includes('not in a mode'))
    assert.ok(error.details.output.includes('not in a mode'))
    assert.equal(error.message.includes('verify with capture'), false)
    assert.equal(capturePane(ctx.socketName, target), before, 'neither payload nor Enter ran')

    const invalid = await rejectsWithCode(remote(ctx, 'sendScript', expectation(ctx.socketName, target), {
      hex: ['61'],
    }, {
      transform: (script) => script.replace(' -H 61', ' -Z'),
    }), 'REMOTE_ERROR')
    assert.ok(/usage:|unknown flag|invalid option/.test(invalid.message))
    assert.ok(Array.from(invalid.details.output).length <= 300)
  })

  it('RV1-08: an action failure stops later chunks/Enter and cannot report delivered', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newDetachedSession(ctx.socketName, uniqueName('failure'), ['sh', '-c',
      'stty -echo; printf "READY\\n"; IFS= read -r line; printf "SUBMITTED:%s\\n" "$line"; exec sleep 600'])
    const target = `%${paneIdOf(ctx.socketName, sid)}`
    await waitForPaneText(ctx.socketName, target, 'READY')
    const error = await rejectsWithCode(remote(ctx, 'sendScript', expectation(ctx.socketName, target), {
      hex: [...Array(256).fill('61'), '62'], enter: true,
    }, {
      // Fault injection changes only the second native action. The first chunk
      // succeeds; a tmux copy-mode command outside copy mode must fail.
      transform: (script) => {
        assert.ok(script.includes(' -H 62'))
        return script.replace(' -H 62', ' -X no-such-copy-command')
      },
    }), 'OUTCOME_UNKNOWN')
    assert.ok(error.message.includes('not in a mode'))
    assert.ok(error.message.includes('verify with capture before retrying'))
    assert.equal(error.details.output.includes('XC1'), false)
    assert.equal(capturePane(ctx.socketName, target).includes('SUBMITTED:'), false)
    // A successful separate read confirms the server/target remain available;
    // no reconnect/replay of the failed batch is performed.
    const result = await remote(ctx, 'captureScript', expectation(ctx.socketName, target), {}, { mutating: false })
    assert.ok(result.records.some((record) => record[0] === 'capture'))
  })

  it('RV1-08: capture command failure is framed, never successful empty output', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newCatSession(ctx.socketName, uniqueName('capturefail'))
    const target = `%${paneIdOf(ctx.socketName, sid)}`
    await rejectsWithCode(remote(ctx, 'captureScript', expectation(ctx.socketName, target), {}, {
      mutating: false,
      transform: (script) => script.replace('capture-pane -p -J', 'capture-pane -p -J -Z'),
    }), 'REMOTE_ERROR')
  })

  it('RV1-15: multi-megabyte capture preserves framing and newest bounded output', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const target = localTmux(ctx.socketName, 'new-session', '-d', '-P', '-F', '#{pane_id}',
      '-s', uniqueName('large'), '-x', '2000', '-y', '50', '--', 'sh', '-c',
      'awk \'BEGIN { for (i=0;i<2100;i++) { for(j=0;j<1999;j++) printf "x"; print "" } print "最新 🌏 END_MARKER" }\'; exec sleep 600')
    await waitFor(() => localTmux(ctx.socketName, 'capture-pane', '-p', '-J', '-t', target, '-S', '-20').includes('END_MARKER'), 30000)
    const result = await remote(ctx, 'captureScript', expectation(ctx.socketName, target), {
      lines: 2000, maxBytes: 65536,
    }, { mutating: false })
    const capture = result.records.find((record) => record[0] === 'capture')
    assert.ok(capture)
    assert.equal(capture[2], '1')
    assert.ok(capture[1].length <= 2 * 65536)
    const text = Buffer.from(capture[1], 'hex').toString('utf8')
    assert.ok(text.includes('最新 🌏 END_MARKER'))
    assert.equal(text.includes('\ufffd'), false)
    const service = await ctx.makeService()
    t.after(() => service.close())
    const adopted = await service.adopt({ hostId: 'xc', socketId: 'it', target })
    const publicCapture = await service.capture({ uri: adopted.uri, lines: 2000 })
    assert.equal(publicCapture.truncated, true, 'service preserves remote truncation metadata')
    assert.ok(publicCapture.text.includes('END_MARKER'))
  })

  it('RV1-15: truncating inside UTF-8 skips the partial leading codepoint', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const sid = newDetachedSession(ctx.socketName, uniqueName('utf8'), ['sh', '-c', 'printf "é🌏END"; exec sleep 600'])
    const target = `%${paneIdOf(ctx.socketName, sid)}`
    await waitForPaneText(ctx.socketName, target, 'é🌏END')
    const raw = Buffer.from(capturePane(ctx.socketName, target))
    const budget = raw.length - (raw.indexOf(Buffer.from('🌏')) + 1)
    const result = await remote(ctx, 'captureScript', expectation(ctx.socketName, target), { maxBytes: budget }, { mutating: false })
    const capture = result.records.find((record) => record[0] === 'capture')
    assert.equal(capture[2], '1')
    assert.ok(Buffer.from(capture[1], 'hex').toString('utf8').startsWith('END'))
    assert.equal(Buffer.from(capture[1], 'hex').toString('utf8').includes('\ufffd'), false)
  })
})
