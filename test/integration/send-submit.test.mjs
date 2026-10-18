// C5: text and Enter are separate guarded deliveries. An Ink-like raw-mode TUI
// receives `text` and '\r' in one read as a paste (the text stays in its input
// box), so the old single-invocation send reported success without submitting.
import assert from 'node:assert/strict'
import process from 'node:process'
import { describe, it } from 'node:test'
import {
  capturePane,
  checkInfra,
  newDetachedSession,
  paneIdOf,
  suiteContext,
  uniqueName,
  waitForPaneText,
} from './helpers.mjs'

const skip = checkInfra().skip

/**
 * Minimal Ink-like raw-mode program.
 *
 * A single read chunk containing printable text AND '\r' is treated as a paste:
 * the text is buffered and NOT submitted (exactly the failure mode C5 fixes).
 * A lone '\r' chunk submits the buffered line and clears it. The input box is
 * repainted in place on the cursor row, the way Ink renders one.
 *
 * Passing `sticky` as the first argument makes the program acknowledge Enter but
 * keep the line in its buffer, so the post-Enter cursor row still shows the text
 * (`submission.state === 'pending'`).
 */
const PROGRAM = String.raw`
const sticky = process.argv[1] === 'sticky'
const stdin = process.stdin
stdin.setRawMode(true)
stdin.resume()
stdin.setEncoding('utf8')
let line = ''
const paint = () => process.stdout.write('\r> ' + line + '\x1b[K')
const report = (marker, value) => {
  process.stdout.write('\r\n' + JSON.stringify({ marker, value }) + '\r\n')
  paint()
}
stdin.on('data', (chunk) => {
  const printable = chunk.replace(/[\r\n]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  if (chunk.includes('\r') && printable.length > 0) {
    // text + Enter in one chunk: Ink inserts it and leaves it un-submitted.
    line += printable
    report('PASTE', line)
    return
  }
  if (chunk.includes('\r')) {
    report('SUBMITTED', line)
    if (!sticky) line = ''
    paint()
    return
  }
  line += printable
  report('TYPED', line)
})
process.stdout.write(JSON.stringify({ marker: 'READY' }) + '\r\n')
paint()
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 60000)
`

/** Create a detached session running the Ink-like program; returns its pane id. */
function startProgram(ctx, name, sticky = false) {
  const argv = [process.execPath, '-e', PROGRAM, ...(sticky ? ['sticky'] : [])]
  const sid = newDetachedSession(ctx.socketName, name, argv)
  return `%${paneIdOf(ctx.socketName, sid)}`
}

async function adoptPane(service, target) {
  return service.adopt({
    hostId: 'xc', socketId: 'it', target, by: { sessionId: 'chat-c5' },
  })
}

describe('C5 send / Enter submission (real tmux, isolated socket)', { skip, timeout: 240000 }, () => {
  it('text+Enter submits an Ink-like raw-mode program and reports submission cleared', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    t.after(() => service.close())
    const target = startProgram(ctx, uniqueName('ink'))
    await waitForPaneText(ctx.socketName, target, 'READY', 20000)

    const adopted = await adoptPane(service, target)
    const text = `submit ${process.pid} hello`
    const result = await service.send({ uri: adopted.uri, text, enter: true })

    assert.deepEqual(result.delivered, { text: true, keys: 0, enter: true })
    assert.equal(result.submission.checked, true)
    assert.equal(result.submission.state, 'cleared', JSON.stringify(result.submission))

    // The lone Enter chunk submitted the buffered line.
    await waitForPaneText(ctx.socketName, target, 'SUBMITTED:', 15000)
    const captured = capturePane(ctx.socketName, target)
    assert.ok(captured.includes(`"value":"${text}"`), 'the submitted line is the sent text')
    // A paste chunk (text and '\r' together) would have reported PASTE instead.
    const pastes = [...captured.matchAll(/"marker":"PASTE"/g)]
    assert.equal(pastes.length, 0, 'text and Enter were not delivered as one paste chunk')
  })

  it('a program that never clears its line reports submission pending', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    t.after(() => service.close())
    const target = startProgram(ctx, uniqueName('sticky'), true)
    await waitForPaneText(ctx.socketName, target, 'READY', 20000)

    const adopted = await adoptPane(service, target)
    const text = `sticky ${process.pid} pending`
    const result = await service.send({ uri: adopted.uri, text, enter: true })

    assert.equal(result.delivered.enter, true)
    assert.equal(result.submission.checked, true)
    assert.equal(result.submission.state, 'pending', JSON.stringify(result.submission))
    // The program did receive the lone Enter; it just keeps the line buffered.
    await waitForPaneText(ctx.socketName, target, 'SUBMITTED:', 15000)
    assert.ok(capturePane(ctx.socketName, target).includes(text))
  })

  it('text-only, enter-only and keys-only keep working', async (t) => {
    const ctx = suiteContext(t)
    if (!ctx) return
    const service = await ctx.makeService()
    t.after(() => service.close())
    const target = startProgram(ctx, uniqueName('enter'))
    await waitForPaneText(ctx.socketName, target, 'READY', 20000)
    const adopted = await adoptPane(service, target)

    const typed = await service.send({ uri: adopted.uri, text: 'typed-only' })
    assert.deepEqual(typed.delivered, { text: true, keys: 0, enter: false })
    assert.equal(typed.submission.checked, false)
    await waitForPaneText(ctx.socketName, target, 'TYPED:', 15000)

    // Enter-only: no inter-step delay is needed and the buffered line submits.
    const entered = await service.send({ uri: adopted.uri, enter: true })
    assert.equal(entered.delivered.enter, true)
    assert.equal(entered.submission.state, 'cleared')
    await waitForPaneText(ctx.socketName, target, 'SUBMITTED:', 15000)
    await waitForPaneText(ctx.socketName, target, '"value":"typed-only"', 15000)

    // Keys-only: delivered, but there is no Enter to reason about.
    const keyed = await service.send({ uri: adopted.uri, keys: ['Tab'] })
    assert.deepEqual(keyed.delivered, { text: false, keys: 1, enter: false })
    assert.equal(keyed.submission.checked, false)
  })
})
