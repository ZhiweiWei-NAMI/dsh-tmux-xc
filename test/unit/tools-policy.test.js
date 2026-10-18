/**
 * Unit tests for the tool registration and the `tools/pre-execute` approval
 * policy, using a fake ctx and a fake service. No DSH runtime, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../lib/tools.js';

const ALL_TOOLS = [
  'tmux_xc_list',
  'tmux_xc_inspect',
  'tmux_xc_resolve',
  'tmux_xc_references',
  'tmux_xc_capture',
  'tmux_xc_adopt',
  'tmux_xc_create',
  'tmux_xc_send',
  'tmux_xc_detach',
  'tmux_xc_forget',
  'tmux_xc_kill',
];

function fakeCtx() {
  const registered = [];
  const listeners = new Map();
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    on(name, listener, options) {
      const list = listeners.get(name) ?? [];
      list.push({ listener, options });
      listeners.set(name, list);
      return () => {};
    },
    get() {
      return undefined;
    },
  };
  return { ctx, registered, listeners };
}

function fakeService() {
  return {
    describeForApproval: async () => ({ en: 'approve this', zh: '批准此操作' }),
  };
}

function preExecute(listeners) {
  const [entry] = listeners.get('tools/pre-execute') ?? [];
  assert.ok(entry, 'pre-execute listener was registered');
  return entry.listener;
}

function exec(name, args = {}) {
  return { name, arguments: args, signal: undefined };
}

const allow = async () => ({ kind: 'allow' });

test('registers exactly the DESIGN §8 tool surface', () => {
  const { ctx, registered } = fakeCtx();
  const dispose = registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(registered.map((d) => d.name).sort(), [...ALL_TOOLS].sort());
});

test('create/send/detach ask when config says ask', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_create', 'tmux_xc_send', 'tmux_xc_detach']) {
    const decision = await listener(exec(name), allow);
    assert.equal(decision.kind, 'ask', `${name} should ask`);
    assert.equal(decision.displayReason.en, 'approve this');
  }
});

test('kill always asks, even when config would allow others', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'allow', send: 'allow', detach: 'allow' } });
  const listener = preExecute(listeners);
  const decision = await listener(exec('tmux_xc_kill'), allow);
  assert.equal(decision.kind, 'ask');
});

test('create/send/detach allow when config says allow', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'allow', send: 'allow', detach: 'allow' } });
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_create', 'tmux_xc_send', 'tmux_xc_detach']) {
    const decision = await listener(exec(name), allow);
    assert.equal(decision.kind, 'allow', `${name} should be allowed by config`);
  }
});

test('never-ask tools are allowed', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_list', 'tmux_xc_inspect', 'tmux_xc_resolve', 'tmux_xc_references', 'tmux_xc_capture', 'tmux_xc_adopt', 'tmux_xc_forget']) {
    const decision = await listener(exec(name), allow);
    assert.equal(decision.kind, 'allow', `${name} should never ask`);
  }
});

test('a non-allow decision from next() is preserved', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  const listener = preExecute(listeners);
  const deny = await listener(exec('tmux_xc_kill'), async () => ({ kind: 'deny', reason: 'blocked earlier' }));
  assert.equal(deny.kind, 'deny');
  assert.equal(deny.reason, 'blocked earlier');
});

test('capture output is fenced as untrusted', () => {
  const { ctx, registered } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  const capture = registered.find((d) => d.name === 'tmux_xc_capture');
  const blocks = capture.output.render({}, { text: 'ESC[31m', truncated: false, lines: 5, target: 'x %1' });
  const text = blocks.map((b) => b.text).join('\n');
  assert.ok(text.includes('untrusted'), 'capture render marks output untrusted');
  assert.ok(text.includes('```'), 'capture render fences the output');
});
