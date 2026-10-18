/** Host entry regressions; fake Cordis services only, no runtime or subprocesses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, apply, inject } from '../../lib/index.js';
import { registerRoutes } from '../../lib/routes.js';

function config(input) {
  // Cordis 0.2.1-rc.2 uses Standard Schema, not Zod's parse().
  const result = Config['~standard'].validate(input);
  assert.equal(result.issues, undefined, JSON.stringify(result.issues));
  return result.value;
}

test('Config retains local transport and every DESIGN §3 host/socket/session field', () => {
  const host = {
    id: 'local', label: 'This machine', transport: 'local', ssh: 'localhost',
    sockets: [{ id: 'default' }, { id: 'xc', name: 'xc' }, { id: 'lab', path: '/tmp/tmux-lab/sock' }],
    newSession: { command: ['bash', '-l'], cwd: '/workspace' },
  };
  assert.deepEqual(config({ hosts: [host] }).hosts, [host]);
});

test('Config defaults transport to ssh and retains host defaults', () => {
  assert.deepEqual(config({ hosts: [{ id: 'remote', ssh: 'user@alias' }] }).hosts, [{
    id: 'remote', ssh: 'user@alias', transport: 'ssh',
    sockets: [{ id: 'default' }], newSession: { command: [], cwd: '' },
  }]);
});

test('Config makes ssh optional and skips alias validation only for local hosts', () => {
  for (const ssh of [undefined, '', '-ignored local value']) {
    const host = { id: 'local', transport: 'local', ...(ssh !== undefined ? { ssh } : {}) };
    const parsed = config({ hosts: [host] }).hosts[0];
    assert.equal(parsed.transport, 'local');
    assert.equal(parsed.ssh, ssh);
  }
  for (const transport of [undefined, 'ssh']) {
    for (const ssh of [undefined, '', '-option', 'host with spaces']) {
      const host = { id: 'remote', ...(transport !== undefined ? { transport } : {}), ...(ssh !== undefined ? { ssh } : {}) };
      assert.ok(Config['~standard'].validate({ hosts: [host] }).issues, JSON.stringify(host));
    }
  }
  assert.ok(Config['~standard'].validate({ hosts: [{ id: 'local', ssh: 'localhost', transport: 'other' }] }).issues);
});

function fakeCtx() {
  const tools = new Map();
  const listeners = new Map();
  const injections = [];
  const effects = [];
  const warnings = [];
  const ctx = {
    logger: () => ({ warn: (message) => warnings.push(message) }),
    // No storage facility: the apply test explicitly opts into memory mode.
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(name) {
      assert.notEqual(name, 'connection', 'connection must be injected, not probed at apply time');
      return undefined;
    },
    effect(setup) {
      const dispose = setup();
      effects.push(dispose);
      return dispose;
    },
    on(name, listener, options) {
      const entry = { listener, options };
      listeners.set(name, entry);
      return () => listeners.delete(name);
    },
    inject(dependencies, callback) {
      injections.push({ dependencies, callback });
      return { dispose() {} };
    },
  };
  return { ctx, tools, listeners, injections, warnings, effects };
}

function connectionScope() {
  const routes = new Map();
  const removed = [];
  return {
    routes, removed,
    ctx: { connection: { fetch: { register(route) {
      assert.ok(!routes.has(route.path), 'no duplicate routes');
      routes.set(route.path, route);
      return () => { removed.push(route.path); routes.delete(route.path); };
    } } } },
  };
}

test('inventory route preserves host error codes and reports thrown internal errors as HTTP 500', async (t) => {
  const scope = connectionScope();
  const host = {
    id: 'local', label: 'local', reachable: false, status: 'error', sockets: [],
    error: { code: 'PROTOCOL', message: 'missing end marker' },
  };
  let internal;
  const dispose = registerRoutes(scope.ctx, {
    async inventory() {
      if (internal) throw internal;
      return { hosts: [host] };
    },
  });
  t.after(dispose);
  const route = scope.routes.get('/api/tmux-xc/inventory');
  const response = await route.fetch(new Request('http://localhost/api/tmux-xc/inventory'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, hosts: [host] });
  internal = new TypeError('records must be an array');
  const failure = await route.fetch(new Request('http://localhost/api/tmux-xc/inventory'));
  assert.equal(failure.status, 500);
  const body = await failure.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'INTERNAL');
  assert.ok(body.error.message.includes(internal.message));
  assert.equal(body.hosts, undefined, 'an internal exception is not a host status');
});

test('apply registers routes when connection appears later and returns scoped cleanup', async (t) => {
  const { ctx, tools, listeners, injections, warnings, effects } = fakeCtx();
  const activeScopes = new Set();
  t.after(async () => {
    for (const dispose of activeScopes) await dispose();
    for (const dispose of effects.reverse()) await dispose();
  });
  await apply(ctx, config({ registry: 'memory', hosts: [{ id: 'local', transport: 'local' }] }));
  assert.deepEqual(inject, ['tools', 'storageDomain']);
  assert.equal(tools.size, 11, 'agent tools work without connection');
  assert.ok(!warnings.some((message) => /connection|workingDirectory/.test(message)));
  assert.equal(injections.length, 1);
  const injection = injections[0];
  assert.deepEqual(injection.dependencies, ['connection']);

  // Callback runs after apply, with connection visible only in this child scope.
  for (let generation = 0; generation < 2; generation += 1) {
    const scope = connectionScope();
    const dispose = injection.callback(scope.ctx);
    assert.equal(typeof dispose, 'function');
    activeScopes.add(dispose);
    assert.equal(scope.routes.size, 5);
    const route = scope.routes.get('/api/tmux-xc/hosts');
    const response = await route.fetch(new Request('http://localhost/api/tmux-xc/hosts'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, hosts: [{ id: 'local', label: 'local', transport: 'local', sockets: [{ id: 'default' }] }],
    });
    assert.ok(scope.routes.has('/api/tmux-xc/inventory'));
    await dispose(); // Cordis disposes the callback result when connection goes away.
    activeScopes.delete(dispose);
    assert.equal(scope.routes.size, 0);
    assert.equal(scope.removed.length, 5);
    assert.equal(tools.size, 11, 'connection loss must not dispose tools');
  }

  // Official dsh-session-reference uses this same event without an agents API.
  const hook = listeners.get('agent/pre-step');
  assert.deepEqual(hook.options, { prepend: true });
  const rejected = { kind: 'reject' };
  assert.equal(await hook.listener({ step: 1 }, async () => rejected), rejected);
  const accepted = { kind: 'enter', messages: [] };
  assert.equal(await hook.listener({ agent: { session: { id: 'chat' } }, step: 1 }, async () => accepted), accepted);
});
