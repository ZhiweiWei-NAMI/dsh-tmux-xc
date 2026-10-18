import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from '../../lib/hooks.js';
import { memoryRegistry } from '../../lib/registry.js';
import { encodeRef, formatToken } from '../../lib/core/uri.js';

const uri = encodeRef({ hostId: 'lab', hostFp: '123456abcdef', socketId: 'default', gen: '1-2', kind: 'pane', sid: 0, wid: 0, pid: 0 });
const message = (kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text: formatToken('pane', uri) }] });

function fixture(t, resolveRef = async () => ({ result: { code: 'TARGET_GONE' } })) {
  const registry = memoryRegistry();
  let listener;
  let resolutions = 0;
  const warnings = [];
  const ctx = {
    logger: () => ({ warn: (value) => warnings.push(value) }),
    on(event, callback) {
      assert.equal(event, 'agent/pre-step');
      listener = callback;
      return () => {};
    },
  };
  const dispose = registerHooks(ctx, { async resolveRef(...args) { resolutions += 1; return resolveRef(...args); } }, registry);
  t.after(async () => { await dispose(); await registry.close(); });
  const events = [];
  const agent = { session: { id: 'conversation', snapshotEvents: () => events } };
  return {
    registry, events, dispose, warnings,
    resolutions: () => resolutions,
    run: (step, messages, extra = {}) => listener({ agent, step, ...extra }, async () => ({ kind: 'enter', messages })),
    listener,
  };
}

test('step 2 steering durably captures references and duplicate batches are idempotent', async (t) => {
  const f = fixture(t);
  const user = message();
  const result = await f.run(2, [user]);
  const conversation = f.registry.conversationGet('conversation');
  assert.deepEqual(conversation.refs.map((ref) => ref.uri), [uri]);
  assert.equal(result.messages[0], user);
  assert.equal(result.messages[1].source.kind, 'tmux-xc-reference');
  assert.match(result.messages[1].content[0].text, /TARGET_GONE/);
  assert.ok(result.messages[1].content[0].text.includes(uri));
  const seen = conversation.refs[0].firstSeenAt;
  const duplicate = await f.run(3, [message()]);
  assert.equal(duplicate.messages.length, 1);
  assert.equal(f.registry.conversationGet('conversation').refs[0].firstSeenAt, seen);
  assert.equal(f.resolutions(), 1);
});

test('all direct user messages are scanned but tool/generated sources are excluded', async (t) => {
  const f = fixture(t);
  await f.run(2, [message('tool'), message('tmux-xc-reference'), message('session-reference')]);
  assert.equal(f.registry.conversationGet('conversation'), undefined);
  const textless = { source: { kind: 'user' }, content: [{ type: 'image', text: formatToken('ignored', uri) }] };
  await f.run(4, [textless, message(), { source: { kind: 'user' }, content: [{ type: 'text', text: 'later user message' }] }]);
  assert.equal(f.registry.conversationGet('conversation').refs.length, 1);
  assert.equal(f.resolutions(), 1);
});

test('compaction-only reannouncement remains first-step-only', async (t) => {
  const f = fixture(t);
  await f.registry.conversationAddRefs('conversation', [{ uri, label: 'pane' }]);
  f.events.push({ type: 'compaction/summary', time: 1 });
  assert.deepEqual((await f.run(2, [])).messages, []);
  assert.equal(f.resolutions(), 0);
  assert.equal((await f.run(1, [])).messages.length, 1);
  assert.equal(f.resolutions(), 1);
  assert.deepEqual((await f.run(1, [])).messages, []);
});

test('rejected or already-aborted batches do not capture references', async (t) => {
  const f = fixture(t);
  const rejected = { kind: 'reject', messages: [message()] };
  assert.equal(await f.listener({ step: 2 }, async () => rejected), rejected);
  await f.run(2, [message()], { signal: AbortSignal.abort() });
  assert.equal(f.registry.conversationGet('conversation'), undefined);
});

test('hook disposal waits for accepted reference work and is idempotent', async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, async () => { entered(); await gate; return { result: { code: 'TARGET_GONE' } }; });
  const processing = f.run(2, [message()]);
  await started;
  let closed = false;
  const closing = f.dispose();
  assert.equal(f.dispose(), closing);
  closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await processing;
  await closing;
  assert.ok(f.registry.conversationGet('conversation').announcedAt);
});
