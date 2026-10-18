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

test('Config defaults approval to a single enabled switch and send.enterDelayMs to 400', () => {
  const parsed = config({ hosts: [{ id: 'local', transport: 'local' }] });
  assert.deepEqual(parsed.approval, { enabled: true });
  assert.deepEqual(parsed.send, { enterDelayMs: 400 });
});

test('Config approval switch accepts explicit enabled and leaves deprecated keys unset by default', () => {
  const parsed = config({ hosts: [{ id: 'local', transport: 'local' }], approval: { enabled: false } });
  assert.deepEqual(parsed.approval, { enabled: false });
  // The deprecated per-key fields must not be injected with defaults, so
  // "unset" stays distinguishable from an explicit legacy 'allow'.
  assert.equal(Object.hasOwn(parsed.approval, 'create'), false);
  assert.equal(Object.hasOwn(parsed.approval, 'send'), false);
  assert.equal(Object.hasOwn(parsed.approval, 'detach'), false);
  const legacy = config({ approval: { create: 'allow' } }).approval;
  assert.deepEqual(legacy, { enabled: true, create: 'allow' });
  for (const bad of [{ enabled: 'yes' }, { create: 'maybe' }, { kill: 'allow' }]) {
    assert.ok(Config['~standard'].validate({ approval: bad }).issues, JSON.stringify(bad));
  }
});

test('Config accepts host alias display hints and defaults them to an empty list', () => {
  const host = {
    id: 'local', transport: 'local',
    aliases: [{ session: 'train', window: 'shell', alias: 'main' }, { session: 'logs', alias: 'logs' }],
  };
  const parsed = config({ hosts: [host] }).hosts[0];
  assert.deepEqual(parsed.aliases, host.aliases);
  assert.deepEqual(config({ hosts: [{ id: 'local', transport: 'local' }] }).hosts[0].aliases, []);
  assert.ok(Config['~standard'].validate({ hosts: [{ id: 'local', transport: 'local', aliases: [{ window: 'x', alias: 'y' }] }] }).issues, 'session is required');
});

test('send.enterDelayMs is clamped to 0..5000', () => {
  assert.equal(config({ send: { enterDelayMs: 0 } }).send.enterDelayMs, 0);
  assert.equal(config({ send: { enterDelayMs: 5000 } }).send.enterDelayMs, 5000);
  for (const enterDelayMs of [-1, 5001, 1.5]) {
    assert.ok(Config['~standard'].validate({ send: { enterDelayMs } }).issues, String(enterDelayMs));
  }
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
  const { reachable, ...routeHost } = host;
  assert.equal(reachable, false, 'legacy tool flag remains on the service result');
  assert.deepEqual(await response.json(), { ok: true, hosts: [routeHost] });
  internal = new TypeError('records must be an array');
  const failure = await route.fetch(new Request('http://localhost/api/tmux-xc/inventory'));
  assert.equal(failure.status, 500);
  const body = await failure.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'INTERNAL');
  assert.ok(body.error.message.includes(internal.message));
  assert.equal(body.hosts, undefined, 'an internal exception is not a host status');
});

test('inventory alias lookup is best-effort', async (t) => {
  for (const mode of ['missing method', 'throws', 'rejects', 'logger throws']) {
    await t.test(mode, async (t) => {
      const scope = connectionScope();
      const pane = { key: 'pane-key', label: 'Pane' };
      const host = { id: 'local', status: 'ok', reachable: true,
        sockets: [{ sessions: [{ windows: [{ panes: [pane] }] }] }] };
      const error = new Error('aliases unavailable');
      const messages = [];
      const registry = mode === 'missing method' ? {} : {
        aliasList() {
          if (mode === 'rejects') return Promise.reject(error);
          throw error;
        },
      };
      t.after(registerRoutes(scope.ctx, {
        registry,
        logger: { debug(message) {
          messages.push(message);
          if (mode === 'logger throws') throw new Error('logger unavailable');
        } },
        async inventory() { return { hosts: [host] }; },
      }));
      const response = await scope.routes.get('/api/tmux-xc/inventory')
        .fetch(new Request('http://localhost/api/tmux-xc/inventory'));
      assert.equal(response.status, 200);
      const { reachable, ...routeHost } = host;
      assert.deepEqual(await response.json(), { ok: true, hosts: [routeHost] });
      assert.equal(Object.hasOwn(pane, 'alias'), false);
      if (mode !== 'missing method') {
        assert.equal(messages.length, 1);
        assert.ok(messages[0].includes(error.message));
      }
    });
  }
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
  assert.equal(tools.size, 12, 'agent tools work without connection');
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
    assert.equal(scope.routes.size, 12);
    const route = scope.routes.get('/api/tmux-xc/hosts');
    const response = await route.fetch(new Request('http://localhost/api/tmux-xc/hosts'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true, hosts: [{ id: 'local', label: 'local', transport: 'local', sockets: [{ id: 'default' }] }],
    });
    assert.ok(scope.routes.has('/api/tmux-xc/inventory'));
    assert.ok(scope.routes.has('/api/tmux-xc/version'));
    assert.ok(scope.routes.has('/api/tmux-xc/capture'));
    assert.ok(scope.routes.has('/api/tmux-xc/kill'));
    assert.ok(scope.routes.has('/api/tmux-xc/host/remove-plan'));
    assert.ok(scope.routes.has('/api/tmux-xc/host/remove'));
    await dispose(); // Cordis disposes the callback result when connection goes away.
    activeScopes.delete(dispose);
    assert.equal(scope.routes.size, 0);
    assert.equal(scope.removed.length, 12);
    assert.equal(tools.size, 12, 'connection loss must not dispose tools');
  }

  // Official dsh-session-reference uses this same event without an agents API.
  const hook = listeners.get('agent/pre-step');
  assert.deepEqual(hook.options, { prepend: true });
  const rejected = { kind: 'reject' };
  assert.equal(await hook.listener({ step: 1 }, async () => rejected), rejected);
  const accepted = { kind: 'enter', messages: [] };
  assert.equal(await hook.listener({ agent: { session: { id: 'chat' } }, step: 1 }, async () => accepted), accepted);
});
