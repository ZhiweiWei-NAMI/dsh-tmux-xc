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
  'tmux_xc_alias',
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

test('switch ON (default) asks all four actions and names the policy key', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), {});
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_create', 'tmux_xc_send', 'tmux_xc_kill', 'tmux_xc_detach']) {
    const decision = await listener(exec(name), allow);
    assert.equal(decision.kind, 'ask', `${name} should ask when the switch is on`);
    assert.ok(decision.displayReason.en.includes('approve this'), decision.displayReason.en);
    assert.ok(decision.displayReason.en.includes('审批'), decision.displayReason.en);
    assert.ok(decision.displayReason.zh.includes('批准此操作'), decision.displayReason.zh);
  }
  const send = await listener(exec('tmux_xc_send'), allow);
  assert.ok(send.displayReason.en.includes('"send"'), send.displayReason.en);
  assert.ok(send.displayReason.zh.includes('“send”'), send.displayReason.zh);
});

test('approval precedence matrix: panel > explicit config > legacy allow > default ask', async () => {
  for (const panel of [undefined, null, true, false, 'unavailable']) {
    for (const configured of [undefined, true, false]) {
      for (const legacy of [undefined, 'ask', 'allow']) {
        const registry = { async getSettings() {
          if (panel === 'unavailable') throw new Error('settings unavailable');
          return panel === undefined ? {} : { approval: { enabled: panel } };
        } };
        const { ctx, listeners } = fakeCtx();
        const approval = {
          ...(configured === undefined ? {} : { enabled: configured }),
          ...(legacy === undefined ? {} : { create: legacy, send: legacy, detach: legacy }),
        };
        const dispose = registerTools(ctx, fakeService(registry), { approval });
        for (const action of ['create', 'send', 'kill', 'detach']) {
          const expected = typeof panel === 'boolean' ? (panel ? 'ask' : 'allow')
            : typeof configured === 'boolean' ? (configured ? 'ask' : 'allow')
              : legacy === 'allow' && action !== 'kill' ? 'allow' : 'ask';
          assert.equal((await preExecute(listeners)(exec(`tmux_xc_${action}`), allow)).kind, expected,
            `${action}: panel=${panel}, configured=${configured}, legacy=${legacy}`);
        }
        dispose();
      }
    }
  }
});

test('legacy per-key allow is honoured only for that key when enabled is absent', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { create: 'allow', send: 'allow' } });
  const listener = preExecute(listeners);
  assert.equal((await listener(exec('tmux_xc_create'), allow)).kind, 'allow');
  assert.equal((await listener(exec('tmux_xc_send'), allow)).kind, 'allow');
  assert.equal((await listener(exec('tmux_xc_detach'), allow)).kind, 'ask', 'detach has no legacy key');
  assert.equal((await listener(exec('tmux_xc_kill'), allow)).kind, 'ask', 'kill has no legacy key');
});

test('legacy per-key ask is ignored (deprecated); the switch is authoritative', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { enabled: true, create: 'ask' } });
  const listener = preExecute(listeners);
  assert.equal((await listener(exec('tmux_xc_create'), allow)).kind, 'ask');
});

test('switch OFF allows all four actions', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), { approval: { enabled: false } });
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_create', 'tmux_xc_send', 'tmux_xc_kill', 'tmux_xc_detach']) {
    const decision = await listener(exec(name), allow);
    assert.equal(decision.kind, 'allow', `${name} should be allowed by config OFF`);
  }
});

test('ask reason says approval can be turned off in the panel 审批 switch', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), {});
  const listener = preExecute(listeners);
  const decision = await listener(exec('tmux_xc_kill'), allow);
  assert.equal(decision.kind, 'ask');
  assert.ok(decision.displayReason.en.includes('"kill"'), decision.displayReason.en);
  assert.ok(decision.displayReason.en.includes('审批 switch'), decision.displayReason.en);
  assert.ok(decision.displayReason.zh.includes('审批'), decision.displayReason.zh);
});

test('never-ask tools are allowed', async () => {
  const { ctx, listeners } = fakeCtx();
  registerTools(ctx, fakeService(), {});
  const listener = preExecute(listeners);
  for (const name of ['tmux_xc_list', 'tmux_xc_inspect', 'tmux_xc_resolve', 'tmux_xc_references', 'tmux_xc_capture', 'tmux_xc_adopt', 'tmux_xc_alias', 'tmux_xc_forget']) {
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

test('send rendering treats unknown Enter delivery as unknown and requires capture before retry', () => {
  const { ctx, registered } = fakeCtx();
  const dispose = registerTools(ctx, fakeService(), {});
  const send = registered.find((definition) => definition.name === 'tmux_xc_send');
  for (const enter of ['unknown', null, undefined]) {
    for (const state of ['unknown', 'pending']) {
      const text = send.output.render({}, {
        target: 'local:default:%7', delivered: { text: true, keys: 0, enter },
        submission: { state, checked: false },
      }).map((block) => block.text).join('\n');
      assert.match(text, /enter=unknown/);
      assert.match(text, /capture and verify before retrying/);
      assert.doesNotMatch(text, /bytes were delivered|enter=no|send Enter again/);
    }
  }
  for (const enter of [true, false]) {
    const text = send.output.render({}, {
      delivered: { text: true, keys: 0, enter }, submission: { state: 'pending', checked: true },
    }).map((block) => block.text).join('\n');
    assert.match(text, new RegExp(`enter=${enter ? 'yes' : 'no'}`));
    assert.match(text, /send Enter again/);
  }
  dispose();
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
