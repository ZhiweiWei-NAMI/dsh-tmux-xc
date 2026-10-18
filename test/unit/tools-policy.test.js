/**
 * Unit tests for the tool registration and the `tools/pre-execute` approval
 * policy, using a fake ctx and a fake service. No DSH runtime, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../lib/tools.js';

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

function fakeService(registry) {
  return {
    describeForApproval: async () => ({
      en: 'approve this', zh: '批准此操作',
      identity: { hostId: 'local', hostFp: 'fp', socketId: 'default', gen: 'g1', kind: 'pane', sid: 1, wid: 2, pid: 7 },
    }),
    ...(registry !== undefined ? { registry } : {}),
  };
}

function preExecute(listeners) {
  const [entry] = listeners.get('tools/pre-execute') ?? [];
  assert.ok(entry, 'pre-execute listener was registered');
  return entry.listener;
}

let callSequence = 0;
function exec(name, args = {}) {
  return {
    callId: `policy-${++callSequence}`, name, arguments: args,
    agent: { session: { id: 'chat' } }, signal: new AbortController().signal,
  };
}

const allow = async () => ({ kind: 'allow' });

test('registers exactly the DESIGN §8 tool surface', () => {
  const { ctx, registered } = fakeCtx();
  const dispose = registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(registered.map((d) => d.name).sort(), [...ALL_TOOLS].sort());
});

test('create/send/detach ask when config says ask, naming the policy key', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'ask', send: 'ask', detach: 'ask' } });
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_create', 'tmux_xc_send', 'tmux_xc_detach']) {
    const decision = await listener(exec(name), allow);
    assert.equal(decision.kind, 'ask', `${name} should ask`);
    assert.ok(decision.displayReason.en.includes('approve this'), decision.displayReason.en);
    assert.ok(decision.displayReason.en.includes('审批'), decision.displayReason.en);
    assert.ok(decision.displayReason.zh.includes('批准此操作'), decision.displayReason.zh);
  }
  const send = await listener(exec('tmux_xc_send'), allow);
  assert.ok(send.displayReason.en.includes('"send"'), send.displayReason.en);
  assert.ok(send.displayReason.zh.includes('“send”'), send.displayReason.zh);
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

test('built-in defaults are allow/allow/ask when nothing is configured', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), {});
  const listener = preExecute(listeners);
  assert.equal((await listener(exec('tmux_xc_create'), allow)).kind, 'allow');
  assert.equal((await listener(exec('tmux_xc_send'), allow)).kind, 'allow');
  assert.equal((await listener(exec('tmux_xc_detach'), allow)).kind, 'ask');
});

test('panel override wins over config, and null clears back to config', async () => {
  let stored = { approval: { send: 'ask' } };
  const registry = {
    getSettings: async () => ({ approval: { ...stored.approval } }),
  };
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(registry), { approval: { send: 'allow', create: 'ask' } });
  const listener = preExecute(listeners);
  assert.equal((await listener(exec('tmux_xc_send'), allow)).kind, 'ask', 'panel ask beats config allow');

  stored = { approval: { send: null } };
  assert.equal((await listener(exec('tmux_xc_send'), allow)).kind, 'allow', 'cleared panel override falls back to config');
  stored = { approval: {} };
  assert.equal((await listener(exec('tmux_xc_create'), allow)).kind, 'ask', 'no panel override falls back to config ask');
  assert.equal((await listener(exec('tmux_xc_detach'), allow)).kind, 'ask', 'detach uses the built-in default');
});

test('kill always asks and the ask reason names the fixed policy', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'allow', send: 'allow', detach: 'allow' } });
  const listener = preExecute(listeners);
  const decision = await listener(exec('tmux_xc_kill'), allow);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.en.includes('"kill"'), decision.displayReason.en);
  assert.ok(decision.displayReason.en.includes('cannot be changed'), decision.displayReason.en);
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

test('list rendering distinguishes transport failures from remote/protocol errors and shows codes', () => {
  const { ctx, registered } = fakeCtx();
  registerTools(ctx, fakeService(), {});
  const list = registered.find((definition) => definition.name === 'tmux_xc_list');
  for (const [status, code] of [
    ['unreachable', 'SSH_AUTH'],
    ['unreachable', 'SSH_MISSING'],
    ['error', 'REMOTE_TOOL_MISSING'],
    ['error', 'REMOTE_ERROR'],
    ['error', 'PROTOCOL'],
  ]) {
    const blocks = list.output.render({}, { hosts: [{
      id: 'local', label: 'This host', reachable: false, status, sockets: [],
      error: { code, message: 'failure detail' },
    }] });
    const text = blocks.map((block) => block.text).join('\n');
    assert.ok(text.includes(`: ${status} — ${code}: failure detail`), text);
    if (status === 'error') assert.ok(!text.includes('unreachable'), text);
  }
});

test('workspace attribution obtains a late workingDirectory service per call', async () => {
  const { ctx, registered } = fakeCtx();
  const attributions = [];
  registerTools(ctx, {
    ...fakeService(),
    async adopt({ by }) { attributions.push(by); return {}; },
  }, {});
  const adopt = registered.find((definition) => definition.name === 'tmux_xc_adopt');
  const signal = new AbortController().signal;
  const agent = { session: { id: 'chat' } };
  const args = { hostId: 'local', target: '%7' };
  await adopt.execute(args, { agent, signal });
  const workingDirectory = { async ensure(owner, callerSignal) {
    assert.equal(owner, agent);
    assert.equal(callerSignal, signal);
    return '/late-workspace';
  } };
  ctx.get = (name) => name === 'workingDirectory' ? workingDirectory : undefined;
  await adopt.execute(args, { agent, signal });
  ctx.get = () => undefined;
  await adopt.execute(args, { agent, signal });
  assert.deepEqual(attributions, [
    { sessionId: 'chat', workspace: undefined },
    { sessionId: 'chat', workspace: '/late-workspace' },
    { sessionId: 'chat', workspace: undefined },
  ]);
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
