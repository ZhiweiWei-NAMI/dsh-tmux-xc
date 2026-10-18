/** RV1 host integration regressions; fake Cordis/storage only, no processes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config } from '../../lib/index.js';
import { TmuxXcService } from '../../lib/service.js';
import { encodeRef, formatToken } from '../../lib/core/uri.js';

function parse(input = {}) {
  const result = Config['~standard'].validate(input);
  assert.equal(result.issues, undefined, JSON.stringify(result.issues));
  return result.value;
}

function fixture(t, { open, registerFailure } = {}) {
  const effects = [];
  const listeners = new Map();
  const tools = new Map();
  const routes = new Map();
  const errors = [];
  const warnings = [];
  let opened = 0;
  let closed = 0;
  const ctx = {
    logger: () => ({ warn: (text) => warnings.push(text), error: (text) => errors.push(text) }),
    storageDomain: { async open(spec) {
      opened += 1;
      if (open) return open(spec);
      const tables = new Map();
      return {
        table(name) {
          if (!tables.has(name)) tables.set(name, new Map());
          const values = tables.get(name);
          return {
            get: (key) => values.get(key), entries: () => values.entries(),
            async put(key, value) { values.set(key, value); },
            async delete(key) { return values.delete(key); },
            async update(key, fn) { const value = fn(values.get(key)); values.set(key, value); return value; },
          };
        },
        async close() { closed += 1; },
      };
    } },
    get: () => undefined,
    effect(setup, label) { const dispose = setup(); effects.push({ label, dispose }); return dispose; },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
    tools: { register(tool) {
      assert.ok(effects.some((effect) => effect.label === 'tmux-xc: service and registry'), 'resources must already have a lifecycle effect');
      if (registerFailure) throw registerFailure;
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    } },
    inject(_deps, callback) {
      const dispose = callback({ connection: { fetch: { register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      } } } });
      effects.push({ label: 'connection', dispose });
    },
  };
  t.after(async () => { for (const effect of [...effects].reverse()) await effect.dispose(); });
  return { ctx, effects, listeners, tools, routes, errors, warnings, opened: () => opened, closed: () => closed };
}

test('Config defaults to persistent storage and permits only explicit memory opt-in', () => {
  assert.equal(parse().registry, 'persistent');
  assert.equal(parse({ registry: 'memory' }).registry, 'memory');
  assert.ok(Config['~standard'].validate({ registry: 'fallback' }).issues);
});

test('capture configuration stays within the bounded remote protocol limits', () => {
  assert.equal(parse({ capture: { maxBytes: 1024 * 1024, maxLines: 2000 } }).capture.maxBytes, 1024 * 1024);
  assert.equal(parse({ capture: { maxBytes: 1, maxLines: 1 } }).capture.maxLines, 1);
  for (const capture of [{ maxBytes: 1024 * 1024 + 1 }, { maxLines: 2001 }, { maxBytes: 0 }, { maxLines: 0 }]) {
    assert.ok(Config['~standard'].validate({ capture }).issues, JSON.stringify(capture));
  }
});

test('socket ids share the URI grammar while tmux socket names remain independent', () => {
  for (const id of ['default', 'a', '0', 'lab-logs_2', 'a'.repeat(32)]) {
    const host = parse({ hosts: [{ id: 'lab', transport: 'local', sockets: [{ id, name: 'Lab.logs' }] }] }).hosts[0];
    assert.equal(host.sockets[0].name, 'Lab.logs');
    assert.doesNotThrow(() => encodeRef({ hostId: host.id, socketId: id, hostFp: '123456abcdef', gen: '1-2', kind: 'server' }));
  }
  for (const id of ['Lab', 'lab.logs', '-lab', '_lab', '', 'a'.repeat(33)]) {
    assert.ok(Config['~standard'].validate({ hosts: [{ id: 'lab', transport: 'local', sockets: [{ id }] }] }).issues, id);
  }
});

test('effect disposal awaits service abort/settlement before closing the persistent domain', async (t) => {
  const f = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const original = TmuxXcService.prototype.close;
  t.mock.method(TmuxXcService.prototype, 'close', async function () {
    events.push('service-close');
    await original.call(this);
    await gate;
    events.push('service-settled');
  });
  await apply(f.ctx, parse());
  assert.equal(f.listeners.has('dispose'), false, 'ordinary dispose listeners do not run on Cordis unload');
  const dispose = f.effects.find((effect) => effect.label === 'tmux-xc: service and registry').dispose;
  const closing = dispose();
  assert.equal(dispose(), closing, 'cleanup shares the same promise');
  assert.deepEqual(events, ['service-close']);
  assert.equal(f.closed(), 0);
  release();
  await closing;
  assert.deepEqual(events, ['service-close', 'service-settled']);
  assert.equal(f.closed(), 1);
});

test('plugin disposal drains accepted hooks before closing their conversation storage', async (t) => {
  const f = fixture(t);
  await apply(f.ctx, parse());
  const uri = encodeRef({ hostId: 'lab', socketId: 'default', hostFp: '123456abcdef', gen: '1-2', kind: 'server' });
  let accept;
  const downstream = new Promise((resolve) => { accept = resolve; });
  const processing = f.listeners.get('agent/pre-step')({
    agent: { session: { id: 'chat' } }, step: 2,
  }, () => downstream);
  const closing = f.effects.find((effect) => effect.label === 'tmux-xc: service and registry').dispose();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.closed(), 0, 'service cancellation alone must not close storage under active hooks');
  accept({ kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: formatToken('server', uri) }] }] });
  const result = await processing;
  await closing;
  assert.equal(result.messages.length, 2, 'the accepted reference finishes its durable context write');
  assert.match(result.messages[1].content[0].text, /CANCELLED/);
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.warnings, []);
});

test('the acquired domain has a cleanup effect even when tool registration fails', async (t) => {
  const failure = new Error('registration failed');
  const f = fixture(t, { registerFailure: failure });
  await assert.rejects(() => apply(f.ctx, parse()), (error) => error === failure);
  assert.equal(f.opened(), 1);
  await f.effects.find((effect) => effect.label === 'tmux-xc: service and registry').dispose();
  assert.equal(f.closed(), 1);
});

test('persistent open failures log errors and keep tools/routes unavailable', async (t) => {
  const f = fixture(t, { open: async () => { throw new Error('already-open persisted registry'); } });
  await apply(f.ctx, parse());
  assert.equal(f.opened(), 1);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /already-open persisted registry/);
  assert.equal(f.warnings.length, 0, 'no silent ephemeral fallback');
  for (const route of f.routes.values()) {
    const method = route.methods.includes('GET') ? 'GET' : 'POST';
    const response = await route.fetch(new Request(`http://localhost${route.path}`, { method }));
    assert.equal(response.status, 503, route.path);
    assert.equal((await response.json()).error.code, 'REGISTRY_UNAVAILABLE', route.path);
  }
  const exec = { agent: { session: { id: 'chat' } }, signal: new AbortController().signal };
  await assert.rejects(() => f.tools.get('tmux_xc_references').execute({}, exec), { code: 'REGISTRY_UNAVAILABLE' });
});

test('missing profile identity fails closed without opening the shared user domain', async (t) => {
  const f = fixture(t);
  await apply(f.ctx, parse({ registryScope: 'profile' }));
  assert.equal(f.opened(), 0);
  assert.match(f.errors[0], /profileContext.name/);
  const response = await f.routes.get('/api/tmux-xc/hosts').fetch(new Request('http://localhost/api/tmux-xc/hosts'));
  assert.equal((await response.json()).error.code, 'REGISTRY_UNAVAILABLE');
});

test('explicit memory mode skips persistent acquisition and warns about durability', async (t) => {
  const f = fixture(t, { open: async () => { throw new Error('must not open'); } });
  await apply(f.ctx, parse({ registry: 'memory' }));
  assert.equal(f.opened(), 0);
  assert.deepEqual(f.errors, []);
  assert.match(f.warnings[0], /explicit memory.*will not persist/);
  const response = await f.routes.get('/api/tmux-xc/hosts').fetch(new Request('http://localhost/api/tmux-xc/hosts'));
  assert.equal(response.status, 200);
});
