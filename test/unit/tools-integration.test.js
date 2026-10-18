/** DSH boundary regression tests; no subprocess, network, or live DSH session. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { registerTools } from '../../lib/tools.js';
import { CODES, XcError } from '../../lib/core/errors.js';

const toolsRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools'));
const { HarnessError } = await import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-llm')).href);
const { isJsonValue } = await import(pathToFileURL(toolsRequire.resolve('@deepseek-ai/dsh-util-values')).href);
const allow = async () => ({ kind: 'allow' });
const identity = () => ({
  hostId: 'local', hostFp: 'fp', socketId: 'default', gen: 'g1',
  kind: 'pane', sid: 3, wid: 5, pid: 7,
});
let sequence = 0;
function execution(name = 'tmux_xc_send', args) {
  args ??= {
    tmux_xc_list: {}, tmux_xc_references: {}, tmux_xc_forget: {},
    tmux_xc_create: { hostId: 'local', kind: 'session' },
    tmux_xc_adopt: { hostId: 'local', target: '%7' },
    tmux_xc_kill: { ref: 'ref', confirm: 'local:default:%7' },
  }[name] ?? { ref: 'ref' };
  const controller = new AbortController();
  return {
    callId: `boundary-${++sequence}`, name, arguments: args,
    agent: { session: { id: 'chat' } }, signal: controller.signal, controller,
  };
}
// These boundary tests exercise the ask/pin mechanism; the switch defaults to ON
// (enabled absent -> true), so every action asks. The legacy per-key values are
// ignored except 'allow' (covered by tools-policy.test.js).
function setup(service = {}, config = { approval: { create: 'ask', send: 'ask', detach: 'ask' } }) {
  const tools = new Map();
  const listeners = new Map();
  const ctx = {
    tools: { register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    } },
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    get() { return undefined; },
  };
  const dispose = registerTools(ctx, {
    async describeForApproval() { return { en: 'approve', zh: '批准', identity: identity() }; },
    ...service,
  }, config);
  return {
    tools, listeners, dispose,
    pre: (exec, next = allow) => listeners.get('tools/pre-execute')(exec, next),
    result: (exec, result) => listeners.get('tools/result')(exec, result),
    run: (exec) => tools.get(exec.name).execute(exec.arguments, exec),
  };
}

/** Exercise the installed runtime's real output/error boundary, without booting DSH.
 * Only registry lookup and the per-execution state normally minted by the scheduler
 * are supplied here; dispatch, JSON validation, rendering and errorInfo are real.
 */
async function runtimeDispatch(tool, exec) {
  const runtime = Object.create(ToolRuntime.prototype);
  runtime.cancellationStates = new WeakMap([[exec, { callerSignal: exec.signal, bodyInvoked: false }]]);
  runtime.canonicalResults = new WeakMap();
  runtime.concludingExecutions = new WeakSet();
  runtime.resolveExecution = () => tool;
  return runtime.dispatchToolBody(exec);
}

for (const method of ['create', 'send', 'detach', 'kill']) {
  test(`${method}: actual pre-execute snapshot is passed unchanged into execution`, async () => {
    const original = identity();
    const expected = { ...original };
    let descriptionCalls = 0;
    let received;
    const fixture = setup({
      async describeForApproval(name, args, { signal }) {
        descriptionCalls++;
        assert.equal(name, exec.name);
        assert.equal(args, exec.arguments);
        assert.equal(signal, exec.signal);
        return { en: 'exact target', zh: '精确目标', identity: original };
      },
      async [method](args) { received = args; return {}; },
    });
    const exec = execution(`tmux_xc_${method}`);
    assert.equal((await fixture.pre(exec)).kind, 'ask');
    original.pid = 99; // The service cannot rewrite an already displayed pin.
    await fixture.run(exec);
    assert.equal(descriptionCalls, 1);
    assert.deepEqual(received.approvalIdentity, expected);
    assert.equal(Object.isFrozen(received.approvalIdentity), true);
    assert.equal(received.signal, exec.signal);
    assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
    await assert.rejects(fixture.run(exec), /Missing approved target identity/);
    fixture.dispose();
  });
}

for (const method of ['create', 'send', 'detach']) {
  test(`${method}: policy allow neither describes nor supplies an identity`, async () => {
    let received;
    const fixture = setup({
      async describeForApproval() { assert.fail('allow must not describe'); },
      async [method](args) { received = args; return {}; },
    }, { approval: { [method]: 'allow' } });
    const exec = execution(`tmux_xc_${method}`);
    assert.equal((await fixture.pre(exec)).kind, 'allow');
    await fixture.run(exec);
    assert.equal(Object.hasOwn(received, 'approvalIdentity'), false);
    assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
    fixture.dispose();
  });
}

test('ask execution fails closed without a pin, including legacy fake services', async () => {
  const fixture = setup({ async send() { assert.fail('must not mutate'); } });
  await assert.rejects(fixture.run(execution()), (error) => {
    assert.ok(error instanceof HarnessError);
    assert.equal(error.code, CODES.APPROVAL_MISSING);
    return true;
  });
  const missing = setup({ async describeForApproval() { return { en: 'old fake', zh: '旧' }; } });
  await assert.rejects(missing.pre(execution()), /complete target identity/);
  fixture.dispose();
  missing.dispose();
});

for (const decision of [
  { kind: 'deny', reason: 'blocked elsewhere' },
  { kind: 'cancel' },
]) {
  test(`preserves upstream ${decision.kind} without obtaining a pin`, async () => {
    const fixture = setup({ async describeForApproval() { assert.fail('must preserve upstream decision'); } });
    const exec = execution();
    assert.equal(await fixture.pre(exec, async () => decision), decision);
    await assert.rejects(fixture.run(exec), /Missing approved target identity/);
    fixture.dispose();
  });
}

for (const method of ['create', 'send', 'detach', 'kill']) {
  for (const enabled of [true, false]) {
    test(`${method}: DSH ask is preserved verbatim and snapshots with switch ${enabled}`, async () => {
      const hostAsk = Object.freeze({
        kind: 'ask', reason: 'host policy', displayReason: { en: 'Host approval', zh: '宿主审批' },
      });
      const original = identity();
      const expected = { ...original };
      let descriptions = 0;
      let received;
      const fixture = setup({
        async describeForApproval(name, args, { signal }) {
          descriptions++;
          assert.equal(name, exec.name);
          assert.equal(args, exec.arguments);
          assert.equal(signal, exec.signal);
          return { en: 'plugin reason', zh: '插件原因', identity: original };
        },
        async [method](args) { received = args; return {}; },
      }, { approval: { enabled } });
      const exec = execution(`tmux_xc_${method}`);
      assert.equal(await fixture.pre(exec, async () => hostAsk), hostAsk);
      original.gen = 'changed-after-description';
      await fixture.run(exec);
      assert.equal(descriptions, 1);
      assert.deepEqual(received.approvalIdentity, expected);
      assert.equal(Object.isFrozen(received.approvalIdentity), true);
      assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
      fixture.dispose();
    });
  }

  for (const source of ['plugin', 'DSH']) {
    test(`${method}: ${source} snapshot survives panel switch ON to OFF before execution`, async () => {
      let enabled = true;
      let received;
      const fixture = setup({
        registry: { async getSettings() { return { approval: { enabled } }; } },
        async [method](args) { received = args; return {}; },
      });
      const exec = execution(`tmux_xc_${method}`);
      const next = source === 'DSH' ? async () => ({ kind: 'ask', reason: 'host approval' }) : allow;
      assert.equal((await fixture.pre(exec, next)).kind, 'ask');
      enabled = false;
      await fixture.run(exec);
      assert.deepEqual(received.approvalIdentity, identity());
      assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
      fixture.dispose();
    });
  }
}

for (const failure of ['description throws', 'identity missing']) {
  for (const initiallyEnabled of [true, false]) {
    test(`DSH ask ${failure} fails closed after switch OFF (initially ${initiallyEnabled})`, async () => {
      let enabled = initiallyEnabled;
      let mutations = 0;
      const hostAsk = Object.freeze({ kind: 'ask', reason: 'host approval' });
      const fixture = setup({
        registry: { async getSettings() { return { approval: { enabled } }; } },
        async describeForApproval() {
          if (failure === 'description throws') throw new XcError(CODES.SERVER_RESTARTED, 'snapshot failed');
          return { en: 'no identity', zh: '缺少身份' };
        },
        async send() { mutations++; return {}; },
      });
      const exec = execution();
      assert.equal(await fixture.pre(exec, async () => hostAsk), hostAsk);
      enabled = false;
      const result = await runtimeDispatch(fixture.tools.get(exec.name), exec);
      assert.equal(result.isError, true);
      assert.equal(result.error.info.code, failure === 'description throws' ? CODES.SERVER_RESTARTED : CODES.INVALID_ARGUMENT);
      assert.equal(mutations, 0);
      assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
      fixture.dispose();
    });
  }
}

for (const mismatch of ['agent', 'tool']) {
  test(`switch OFF does not bypass pending snapshot ${mismatch} binding`, async () => {
    let enabled = true;
    const fixture = setup({
      registry: { async getSettings() { return { approval: { enabled } }; } },
      async send() { assert.fail('must not mutate with a mismatched approval'); },
      async detach() { assert.fail('must not reuse another tool approval'); },
    });
    const exec = execution();
    await fixture.pre(exec);
    enabled = false;
    const changed = mismatch === 'agent'
      ? { ...exec, agent: { session: { id: 'other-chat' } } }
      : { ...exec, name: 'tmux_xc_detach' };
    await assert.rejects(fixture.run(changed), { code: CODES.APPROVAL_MISSING });
    assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
    fixture.dispose();
  });
}

test('switch OFF to ON before execution requires a snapshot rather than mutating unapproved', async () => {
  let enabled = false;
  const fixture = setup({
    registry: { async getSettings() { return { approval: { enabled } }; } },
    async describeForApproval() { assert.fail('allow must not describe'); },
    async send() { assert.fail('must not mutate without approval'); },
  });
  const exec = execution();
  assert.equal((await fixture.pre(exec)).kind, 'allow');
  enabled = true;
  await assert.rejects(fixture.run(exec), { code: CODES.APPROVAL_MISSING });
  fixture.dispose();
});

test('DSH ask for a read-only tool is preserved without describing a mutation', async () => {
  const fixture = setup({ async describeForApproval() { assert.fail('read-only asks need no mutation snapshot'); } });
  const hostAsk = { kind: 'ask', reason: 'host approval' };
  assert.equal(await fixture.pre(execution('tmux_xc_list'), async () => hostAsk), hostAsk);
  fixture.dispose();
});

for (const outcome of ['completion', 'denial', 'cancellation', 'guard failure']) {
  test(`tools/result clears a pending pin on ${outcome}`, async () => {
    const fixture = setup();
    const exec = execution();
    await fixture.pre(exec);
    assert.equal(getEventListeners(exec.signal, 'abort').length, 1);
    fixture.result(exec, { isError: outcome !== 'completion' });
    assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
    await assert.rejects(fixture.run(exec), /Missing approved target identity/);
    fixture.dispose();
  });
}

test('abort clears the pin immediately, including before a final result', async () => {
  const fixture = setup();
  const exec = execution();
  await fixture.pre(exec);
  exec.controller.abort();
  assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
  await assert.rejects(fixture.run({ ...exec, signal: new AbortController().signal }), /Missing approved target identity/);
  fixture.dispose();
});

test('execute finally clears the pin after service failure', async () => {
  const fixture = setup({ async send() { throw new XcError(CODES.TARGET_GONE, 'gone'); } });
  const exec = execution();
  await fixture.pre(exec);
  await assert.rejects(fixture.run(exec), { code: CODES.TARGET_GONE });
  assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
  await assert.rejects(fixture.run(exec), /Missing approved target identity/);
  fixture.dispose();
});

test('pins are isolated by callId, not by tool name', async () => {
  const received = [];
  const fixture = setup({
    async describeForApproval(_name, args) {
      return { en: 'approve', zh: '批准', identity: { ...identity(), pid: Number(args.text) } };
    },
    async send(args) { received.push(args.approvalIdentity.pid); return {}; },
  });
  const first = execution('tmux_xc_send', { ref: 'ref', text: '7' });
  const second = execution('tmux_xc_send', { ref: 'ref', text: '8' });
  await fixture.pre(first);
  await fixture.pre(second);
  fixture.result(first, { isError: true });
  await fixture.run(second);
  assert.deepEqual(received, [8]);
  await assert.rejects(fixture.run(first), /Missing approved target identity/);
  fixture.dispose();
});

for (const invalidation of ['abort', 'result', 'dispose']) {
  test(`${invalidation} while describing cannot resurrect a pin`, async () => {
    let finishDescription;
    const fixture = setup({ describeForApproval: () => new Promise((resolve) => { finishDescription = resolve; }) });
    const exec = execution();
    const pre = fixture.pre(exec);
    // Wait for description entry, not a fixed number of async policy lookups.
    for (let attempt = 0; typeof finishDescription !== 'function' && attempt < 20; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(typeof finishDescription, 'function', 'approval description must start');
    if (invalidation === 'abort') exec.controller.abort();
    if (invalidation === 'result') fixture.result(exec, { isError: true });
    if (invalidation === 'dispose') fixture.dispose();
    finishDescription({ en: 'approve', zh: '批准', identity: identity() });
    await assert.rejects(pre, { code: CODES.APPROVAL_CANCELLED });
    assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
    fixture.dispose();
  });
}

test('disposal clears every approval listener and prevents retained definitions executing', async () => {
  const fixture = setup();
  const first = execution();
  const second = execution();
  const retainedTool = fixture.tools.get(first.name);
  await fixture.pre(first);
  await fixture.pre(second);
  fixture.dispose();
  fixture.dispose();
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.tools.size, 0);
  await assert.rejects(retainedTool.execute(first.arguments, first), { code: CODES.CANCELLED });
});

test('all registered tools reject missing agents before touching the service', async () => {
  const fixture = setup();
  for (const name of fixture.tools.keys()) {
    const exec = { ...execution(name), agent: undefined };
    await assert.rejects(fixture.run(exec), /require an agent-backed session/);
    await assert.rejects(fixture.pre(exec), /require an agent-backed session/);
  }
  const upstream = { kind: 'deny', reason: 'policy denial' };
  assert.equal(await fixture.pre({ ...execution(), agent: undefined }, async () => upstream), upstream);
  fixture.dispose();
});

test('describe failure is typed and never replaced by a generic approval card', async () => {
  const fixture = setup({
    async describeForApproval() {
      throw new XcError(CODES.SERVER_RESTARTED, 'server changed', { approved: 'g1', observed: 'g2' });
    },
  });
  const exec = execution();
  await assert.rejects(fixture.pre(exec), (error) => {
    assert.ok(error instanceof HarnessError);
    assert.equal(error.code, CODES.SERVER_RESTARTED);
    assert.match(error.message, /SERVER_RESTARTED/);
    assert.deepEqual(JSON.parse(error.message.split('\ndetails: ')[1]), { approved: 'g1', observed: 'g2' });
    return true;
  });
  assert.equal(getEventListeners(exec.signal, 'abort').length, 0);
  await assert.rejects(fixture.run(exec), /Missing approved target identity/);
  fixture.dispose();
});

for (const code of [CODES.HOST_UNREACHABLE, CODES.SSH_HOSTKEY, CODES.CONFIRM_MISMATCH]) {
  test(`${code} survives the installed DSH errorInfo boundary with explicit JSON details`, async () => {
    const details = { hostId: 'local', missing: undefined, nested: { attempts: 2n } };
    details.cycle = details;
    const fixture = setup({ async inventory() { throw new XcError(code, 'operation failed', details); } });
    const exec = execution('tmux_xc_list', {});
    const result = await runtimeDispatch(fixture.tools.get(exec.name), exec);
    assert.equal(result.isError, true);
    assert.deepEqual(result.error.info, { name: 'XcError', code });
    assert.match(result.error.message, new RegExp(code));
    const decoded = JSON.parse(result.error.message.split('\ndetails: ')[1]);
    assert.deepEqual(decoded, { hostId: 'local', missing: null, nested: { attempts: '2' }, cycle: '[Circular]' });
    assert.equal(isJsonValue(decoded), true);
    fixture.dispose();
  });
}

for (const code of ['OK', 'OK_RELOCATED', CODES.TARGET_GONE, CODES.SERVER_RESTARTED, CODES.HOST_IDENTITY_CHANGED]) {
  for (const name of ['tmux_xc_inspect', 'tmux_xc_resolve']) {
    test(`${name} ${code} survives real DSH lossless JSON validation and rendering`, async () => {
      const target = { kind: 'pane', sid: 3, wid: 5, pid: 7, session: { name: 'work' }, window: { index: 0 }, pane: { index: 0, cwd: '/tmp', cmd: 'sh' } };
      const ok = code === 'OK' || code === 'OK_RELOCATED';
      const fixture = setup({
        hosts: () => [{ id: 'local', label: 'Local' }],
        async resolveRef() {
          return { ref: identity(), result: { code, ...(ok ? { target } : {}), warnings: [] } };
        },
      });
      const exec = execution(name);
      const result = await runtimeDispatch(fixture.tools.get(name), exec);
      assert.equal(result.isError, false, result.error?.message);
      assert.equal(result.value.code, code);
      assert.equal(isJsonValue(result.value), true);
      assert.equal(Object.hasOwn(result.value, 'message'), false);
      assert.equal(Object.hasOwn(result.value, 'label'), ok);
      assert.ok(result.content.some((block) => block.text?.includes(code)));
      if (!ok && name === 'tmux_xc_inspect') assert.equal(result.value.target, null);
      fixture.dispose();
    });
  }
}
