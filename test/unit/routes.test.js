import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../../lib/routes.js';
import { encodeRef } from '../../lib/core/uri.js';
import { XcError } from '../../lib/core/errors.js';

const uri = encodeRef({ hostId: 'lab', hostFp: 'abcdef123456', socketId: 'named', gen: '123-456', kind: 'pane', sid: 0, wid: 0, pid: 0 });
const entry = { uri, token: `@[Lab · demo:0.0 %0](${uri})`, label: 'Lab · demo:0.0 %0', key: 'key', origin: 'adopted', state: 'live' };

function registryState() {
  const approval = {};
  const aliases = new Map();
  return {
    getSettings: async () => ({ approval: { ...approval } }),
    setSettings: async ({ approval: incoming }) => {
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null) delete approval[key];
        else approval[key] = value;
      }
      return { approval: { ...approval } };
    },
    aliasList: async () => [...aliases].map(([key, value]) => ({ key, alias: value.alias, updatedAt: value.updatedAt })),
    setAlias: async (key, alias) => {
      if (alias === null) {
        aliases.delete(key);
        return { key, alias: null };
      }
      aliases.set(key, { alias, updatedAt: 1 });
      return { key, alias };
    },
  };
}

function fixture(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const hosts = [{ id: 'lab', label: 'Lab', transport: 'ssh', ssh: 'LabAlias', sockets: [{ id: 'named', name: 'lab.socket' }, { id: 'path', path: '/tmp/lab socket' }] }];
  const registry = registryState();
  const service = {
    hosts: () => hosts,
    inventory: async (args) => { calls.push(args); return { hosts: [] }; },
    adopt: async (args) => { calls.push(args); return entry; },
    forget: async (args) => { calls.push(args); return true; },
    resolveRef: async () => ({ ref: { hostId: 'lab' }, result: { code: 'TARGET_GONE', warnings: [] } }),
    config: { approval: {} },
    registry,
    ...overrides,
  };
  registerRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } } }, service);
  async function request(path, body, method = 'POST') {
    const route = routes.get(`/api/tmux-xc/${path.split('?')[0]}`);
    const response = await route.fetch(new Request(`http://localhost/api/tmux-xc/${path}`, body === undefined ? {} : {
      method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }));
    return { status: response.status, body: await response.json() };
  }
  return { request, calls, hosts, registry, service };
}

test('hosts exposes validated transport and both socket selectors for attach', async () => {
  const { request, hosts } = fixture();
  assert.deepEqual(await request('hosts'), { status: 200, body: { ok: true, hosts } });
});

test('inventory uses the v2 host query parameter', async () => {
  const { request, calls } = fixture();
  await request('inventory?host=lab&workspace=%2Fproject&all=1');
  assert.equal(calls[0].hostId, 'lab');
  assert.equal(calls[0].workspace, '/project');
  assert.equal(calls[0].all, true);
});

test('adopt accepts only durable uri and wraps the canonical entry', async () => {
  const { request, calls } = fixture();
  assert.deepEqual(await request('adopt', { target: uri, workspace: '/project', sessionId: 'chat' }), { status: 200, body: { ok: true, entry } });
  assert.equal(calls[0].target, uri);
  assert.equal((await request('adopt', { target: '%0' })).status, 400);
  assert.equal((await request('adopt', { target: uri, hostId: 'other' })).status, 400);
  assert.equal(calls.length, 1);
});

for (const code of ['SERVER_RESTARTED', 'TARGET_GONE', 'HOST_IDENTITY_CHANGED', 'TARGET_CHANGED']) {
  test(`stale adoption returns nested ${code} at HTTP 409`, async () => {
    const { request } = fixture({ adopt: async () => { throw new XcError(code, 'identity changed'); } });
    assert.deepEqual(await request('adopt', { target: uri }), { status: 409, body: { ok: false, error: { code, message: 'identity changed' } } });
  });
}

test('resolve returns flat result without undefined or absent target fields', async () => {
  const { request } = fixture();
  assert.deepEqual(await request(`resolve?uri=${encodeURIComponent(uri)}`), {
    status: 200, body: { ok: true, code: 'TARGET_GONE', warnings: [] },
  });
});

test('forget returns removed and rejects conflicting selectors', async () => {
  const { request } = fixture();
  assert.deepEqual(await request('forget', { uri }), { status: 200, body: { ok: true, removed: true } });
  assert.equal((await request('forget', { uri, key: 'key' })).status, 400);
});

test('unavailable durable registry fails every route closed', async () => {
  const { request } = fixture({ assertAvailable() { throw new XcError('REGISTRY_UNAVAILABLE', 'registry unavailable'); } });
  for (const path of ['hosts', 'inventory', 'settings', `resolve?uri=${encodeURIComponent(uri)}`]) {
    const response = await request(path);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'REGISTRY_UNAVAILABLE');
  }
  for (const [path, body, method] of [['adopt', { target: uri }], ['forget', { uri }], ['settings', { approval: { send: 'allow' } }, 'PUT'], ['alias', { key: 'key', alias: 'x' }]]) {
    assert.equal((await request(path, body, method)).body.error.code, 'REGISTRY_UNAVAILABLE');
  }
});

test('settings GET reports defaults with fixed kill source', async () => {
  const { request } = fixture();
  assert.deepEqual(await request('settings'), {
    status: 200, body: { ok: true,
      approval: { create: 'allow', send: 'allow', detach: 'ask', kill: 'ask' },
      source: { create: 'default', send: 'default', detach: 'default', kill: 'fixed' } },
  });
});

test('settings PUT merges overrides and clears back to config/default on null', async () => {
  const { request } = fixture({ config: { approval: { create: 'ask' } } });
  assert.deepEqual(await request('settings', { approval: { send: 'allow' } }, 'PUT'), {
    status: 200, body: { ok: true,
      approval: { create: 'ask', send: 'allow', detach: 'ask', kill: 'ask' },
      source: { create: 'config', send: 'panel', detach: 'default', kill: 'fixed' } },
  });
  // Clearing the panel override falls back to the configured value.
  assert.deepEqual(await request('settings', { approval: { send: null } }, 'PUT'), {
    status: 200, body: { ok: true,
      approval: { create: 'ask', send: 'allow', detach: 'ask', kill: 'ask' },
      source: { create: 'config', send: 'default', detach: 'default', kill: 'fixed' } },
  });
});

test('settings PUT rejects kill and unknown fields with 400', async () => {
  const { request } = fixture();
  for (const approval of [
    { kill: 'allow' },
    { create: 'ask', other: 'allow' },
    { create: 'sometimes' },
    { send: 1 },
  ]) {
    const response = await request('settings', { approval }, 'PUT');
    assert.equal(response.status, 400, JSON.stringify(approval));
    assert.equal(response.body.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal((await request('settings', { ui: {} }, 'PUT')).status, 400);
});

test('alias POST sets and clears an alias with route-level validation', async () => {
  const { request } = fixture();
  assert.deepEqual(await request('alias', { key: 'key', alias: 'My Pane' }), {
    status: 200, body: { ok: true, key: 'key', alias: 'My Pane' },
  });
  assert.deepEqual(await request('alias', { key: 'key', alias: null }), {
    status: 200, body: { ok: true, key: 'key', alias: null },
  });
  // An empty string also removes the alias.
  assert.deepEqual(await request('alias', { key: 'key', alias: '' }), {
    status: 200, body: { ok: true, key: 'key', alias: null },
  });
  assert.equal((await request('alias', { key: 'key' })).status, 400);
  assert.equal((await request('alias', { key: 'key', alias: 'x', other: 1 })).status, 400);
  assert.equal((await request('alias', { key: '', alias: 'x' })).status, 400);
});

test('inventory decorates session/window/pane nodes with their alias', async () => {
  const node = { key: 'pane-key', uri, label: 'Lab · 窗格 demo:0.0 %0' };
  const { request } = fixture({
    registry: {
      getSettings: async () => ({ approval: {} }),
      setSettings: async () => ({ approval: {} }),
      setAlias: async (key, alias) => ({ key, alias }),
      aliasList: async () => [{ key: 'pane-key', alias: 'editor', updatedAt: 1 }],
    },
    inventory: async () => ({ hosts: [{
      id: 'lab', label: 'Lab',
      sockets: [{ id: 'named', server: { gen: '1-2' }, sessions: [{ key: 'session-key', windows: [{ key: 'window-key', panes: [node] }] }] }],
    }] }),
  });
  const response = await request('inventory');
  assert.equal(response.status, 200);
  const sessions = response.body.hosts[0].sockets[0].sessions;
  assert.equal(sessions[0].alias, undefined, 'no alias set on the session node');
  assert.equal(sessions[0].windows[0].alias, undefined, 'no alias set on the window node');
  assert.equal(sessions[0].windows[0].panes[0].alias, 'editor', 'pane node gets its alias');
});
