import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../../lib/routes.js';
import { encodeRef, decodeRef } from '../../lib/core/uri.js';
import { XcError, CODES } from '../../lib/core/errors.js';

const uri = encodeRef({ hostId: 'lab', hostFp: 'abcdef123456', socketId: 'named', gen: '123-456', kind: 'pane', sid: 0, wid: 0, pid: 0 });
const entry = { uri, token: `@[Lab · demo:0.0 %0](${uri})`, label: 'Lab · demo:0.0 %0', key: 'key', origin: 'adopted', state: 'live' };

function registryState(overrides = {}) {
  const state = { approvalEnabled: undefined, removedHosts: [], aliases: new Map(), version: 0, ...overrides };
  const registry = {
    getSettings: async () => ({
      ...(typeof state.approvalEnabled === 'boolean' ? { approval: { enabled: state.approvalEnabled } } : {}),
      ...(state.removedHosts.length ? { removedHosts: [...state.removedHosts] } : {}),
    }),
    setSettings: async (input) => {
      if (input.approval !== undefined) {
        state.approvalEnabled = input.approval.enabled === null ? undefined : input.approval.enabled;
      }
      if (input.removedHosts !== undefined) state.removedHosts = [...input.removedHosts];
      state.version += 1;
      return registry.getSettings();
    },
    aliasList: async () => [...state.aliases].map(([key, value]) => ({ key, alias: value.alias, updatedAt: value.updatedAt })),
    setAlias: async (key, alias) => {
      if (alias === null) {
        state.aliases.delete(key);
        return { key, alias: null };
      }
      state.aliases.set(key, { alias, updatedAt: 1 });
      return { key, alias };
    },
    removedHosts: () => [...state.removedHosts],
    get version() {
      return state.version;
    },
  };
  return registry;
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
    alias: async (args) => { calls.push(args); return { key: 'key', alias: args.alias, entry: { uri, token: entry.token, label: entry.label } }; },
    capture: async (args) => { calls.push(args); return { text: 'hi', truncated: false, lines: args.lines, target: 'Lab · 窗格 demo:0.0 %0', kind: 'pane' }; },
    kill: async (args) => { calls.push(args); return { killed: true, target: 'Lab · 窗格 demo:0.0 %0' }; },
    removePlan: async (args) => { calls.push(args); return { host: { id: 'lab', label: 'Lab', reachable: true }, sessions: [], registryEntries: 0, aliases: 0 }; },
    removeHost: async (args) => { calls.push(args); return { removed: true, remote: null }; },
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
  assert.deepEqual(await request('hosts', undefined, 'GET'), { status: 200, body: { ok: true, hosts } });
});

test('inventory uses the v2 host query parameter', async () => {
  const { request, calls } = fixture();
  await request('inventory?host=lab&workspace=%2Fproject&all=1', undefined, 'GET');
  assert.equal(calls[0].hostId, 'lab');
  assert.equal(calls[0].workspace, '/project');
  assert.equal(calls[0].all, true);
});

test('inventory strips the legacy reachable flag and preserves service alias decoration', async () => {
  const node = { key: 'pane-key', uri, label: 'Lab · 窗格 demo:0.0 %0', alias: 'editor', aliasSource: 'local' };
  const { request } = fixture({
    inventory: async () => ({ hosts: [{ id: 'lab', label: 'Lab', reachable: true, sockets: [{ id: 'named', sessions: [{ windows: [{ panes: [node] }] }] }] }] }),
  });
  const response = await request('inventory', undefined, 'GET');
  assert.equal(response.status, 200);
  const host = response.body.hosts[0];
  assert.equal(Object.hasOwn(host, 'reachable'), false);
  assert.deepEqual(host.sockets[0].sessions[0].windows[0].panes[0], node);
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
  assert.deepEqual(await request(`resolve?uri=${encodeURIComponent(uri)}`, undefined, 'GET'), {
    status: 200, body: { ok: true, code: 'TARGET_GONE', warnings: [] },
  });
});

test('terminal target resolves a fresh exact pane and returns only connection selectors', async () => {
  const ref = decodeRef(uri); let options;
  const { request } = fixture({ resolveRef: async (value, opts) => {
    assert.equal(value, uri); options = opts; return { ref, result: { code: 'OK' } };
  } });
  const response = await request('terminal-target', { uri });
  assert.equal(response.status, 200); assert.equal(options.requirePane, true);
  assert.deepEqual(response.body, { ok: true, node: ref, host: { transport: 'ssh', ssh: 'LabAlias' }, socket: { name: 'lab.socket' } });
  assert.equal((await request('terminal-target', { uri, command: 'unexpected' })).status, 400);
});
for (const code of ['OK_RELOCATED', 'SERVER_RESTARTED', 'HOST_IDENTITY_CHANGED', 'TARGET_GONE']) {
  test(`terminal target fails closed for ${code}`, async () => {
    const { request } = fixture({ resolveRef: async () => ({ ref: decodeRef(uri), result: { code } }) });
    const response = await request('terminal-target', { uri });
    assert.equal(response.status, 409); assert.equal(response.body.error.code, code === 'OK_RELOCATED' ? 'TARGET_CHANGED' : code);
    assert.equal(response.body.host, undefined);
  });
}

test('forget returns removed and rejects conflicting selectors', async () => {
  const { request } = fixture();
  assert.deepEqual(await request('forget', { uri }), { status: 200, body: { ok: true, removed: true } });
  assert.equal((await request('forget', { uri, key: 'key' })).status, 400);
});

test('settings GET reports the switch, its source and legacy allow keys', async () => {
  const { request } = fixture();
  assert.deepEqual(await request('settings', undefined, 'GET'), {
    status: 200, body: { ok: true,
      approval: { enabled: true, source: 'default', legacyAllow: [] },
      removedHosts: [] },
  });
});

test('RFA: settings source distinguishes explicit config from default and panel', async () => {
  for (const configured of [undefined, true, false]) {
    for (const panel of [undefined, true, false]) {
      const config = { approval: { send: 'allow', ...(configured === undefined ? {} : { enabled: configured }) } };
      const { request, registry } = fixture({ config });
      if (panel !== undefined) await registry.setSettings({ approval: { enabled: panel } });
      const response = await request('settings', undefined, 'GET');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.approval, {
        enabled: panel ?? configured ?? true,
        source: panel !== undefined ? 'panel' : configured !== undefined ? 'config' : 'default',
        legacyAllow: ['send'],
      });
    }
  }
});

test('settings PUT toggles enabled and clears back to config', async () => {
  const { request } = fixture({ config: { approval: { enabled: false, create: 'allow' } } });
  assert.deepEqual(await request('settings', { approval: { enabled: true } }, 'PUT'), {
    status: 200, body: { ok: true,
      approval: { enabled: true, source: 'panel', legacyAllow: ['create'] },
      removedHosts: [] },
  });
  assert.deepEqual(await request('settings', { approval: { enabled: null } }, 'PUT'), {
    status: 200, body: { ok: true,
      approval: { enabled: false, source: 'config', legacyAllow: ['create'] },
      removedHosts: [] },
  });
});

test('settings PUT restores removed hosts but rejects adding new ones', async () => {
  const { request, registry } = fixture();
  await registry.setSettings({ removedHosts: ['lab', 'other'] });
  assert.deepEqual(await request('settings', { removedHosts: ['lab'] }, 'PUT'), {
    status: 200, body: { ok: true,
      approval: { enabled: true, source: 'default', legacyAllow: [] },
      removedHosts: ['lab'] },
  });
  const rejected = await request('settings', { removedHosts: ['lab', 'added'] }, 'PUT');
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'INVALID_ARGUMENT');
});

test('settings PUT rejects unknown and malformed fields', async () => {
  const { request } = fixture();
  for (const body of [
    { approval: { kill: 'allow' } },
    { approval: { create: 'ask' } },
    { approval: { enabled: 'yes' } },
    { approval: { other: 1 } },
    { removedHosts: 'lab' },
    { removedHosts: ['', 1] },
    { ui: {} },
  ]) {
    const response = await request('settings', body, 'PUT');
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'INVALID_ARGUMENT');
  }
});

test('alias POST adopts-if-needed through the service and returns key/alias/entry', async () => {
  const { request, calls } = fixture();
  assert.deepEqual(await request('alias', { uri, alias: 'My Pane' }), {
    status: 200, body: { ok: true, key: 'key', alias: 'My Pane', entry: { uri, token: entry.token, label: entry.label } },
  });
  assert.equal(calls[0].uri, uri);
  assert.equal(calls[0].alias, 'My Pane');
  assert.equal((await request('alias', { uri, alias: null })).status, 200);
  assert.equal((await request('alias', { uri, alias: 'x', other: 1 })).status, 400);
  assert.equal((await request('alias', { uri: 'not-a-uri', alias: 'x' })).status, 400);
  assert.equal((await request('alias', { alias: 'x' })).status, 400);
});

test('version returns the registry version without touching ssh', async () => {
  const { request, registry, calls } = fixture();
  await registry.setSettings({ approval: { enabled: true } });
  assert.deepEqual(await request('version', undefined, 'GET'), { status: 200, body: { ok: true, version: 1 } });
  assert.equal(calls.length, 0, 'version must not call any service operation');
});

test('capture route returns OK with label/kind/text and bounds lines to [1, 500]', async () => {
  const { request, calls } = fixture();
  const response = await request(`capture?uri=${encodeURIComponent(uri)}&lines=300`, undefined, 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, code: 'OK', label: 'Lab · 窗格 demo:0.0 %0', kind: 'pane', text: 'hi', truncated: false });
  assert.equal(calls[0].uri, uri);
  assert.equal(calls[0].lines, 300);

  await request(`capture?uri=${encodeURIComponent(uri)}&lines=999`, undefined, 'GET');
  assert.equal(calls[1].lines, 500);
  await request(`capture?uri=${encodeURIComponent(uri)}&lines=0`, undefined, 'GET');
  assert.equal(calls[2].lines, 1);
  assert.equal((await request(`capture?uri=${encodeURIComponent(uri)}&lines=abc`, undefined, 'GET')).status, 400);
  assert.equal((await request('capture', undefined, 'GET')).status, 400, 'uri is required');
});

test('capture route reports resolution outcomes as HTTP 200 with code', async () => {
  const { request } = fixture({ capture: async () => { throw new XcError(CODES.TARGET_GONE, 'pane gone'); } });
  const response = await request(`capture?uri=${encodeURIComponent(uri)}`, undefined, 'GET');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, code: 'TARGET_GONE', message: 'pane gone' });
});

test('kill route returns killed/label and maps confirm mismatch to 400', async () => {
  const { request, calls } = fixture();
  assert.deepEqual(await request('kill', { uri, confirm: 'lab:named:%0' }), {
    status: 200, body: { ok: true, killed: true, label: 'Lab · 窗格 demo:0.0 %0' },
  });
  assert.equal(calls[0].uri, uri);
  assert.equal(calls[0].confirm, 'lab:named:%0');
  for (const confirm of [undefined, null, '']) {
    assert.equal((await request('kill', { uri, ...(confirm === undefined ? {} : { confirm }) })).status, 400);
  }
  assert.equal(calls.length, 1, 'panel kill still requires an echoed or typed confirm');

  const mismatch = fixture({ kill: async () => { throw new XcError(CODES.CONFIRM_MISMATCH, 'bad confirm'); } });
  const response = await mismatch.request('kill', { uri, confirm: 'wrong' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'CONFIRM_MISMATCH');
});

test('host/remove-plan forwards the host id', async () => {
  const { request, calls } = fixture();
  assert.deepEqual(await request('host/remove-plan?host=lab', undefined, 'GET'), {
    status: 200, body: { ok: true, host: { id: 'lab', label: 'Lab', reachable: true }, sessions: [], registryEntries: 0, aliases: 0 },
  });
  assert.equal(calls[0].hostId, 'lab');
});

test('host/remove validates the body and forwards to the service', async () => {
  const { request, calls } = fixture();
  assert.deepEqual(await request('host/remove', { host: 'lab', mode: 'local', confirm: 'lab' }), {
    status: 200, body: { ok: true, removed: true, remote: null },
  });
  assert.equal(calls[0].host, 'lab');
  assert.equal(calls[0].mode, 'local');
  assert.equal(calls[0].confirm, 'lab');
  assert.equal(calls[0].killUris, undefined);

  assert.equal((await request('host/remove', { host: 'lab', mode: 'weird', confirm: 'lab' })).status, 400);
  assert.equal((await request('host/remove', { host: 'lab', mode: 'remote', killUris: 'x', confirm: 'lab' })).status, 400);
  assert.equal((await request('host/remove', { host: 'lab', mode: 'remote' })).status, 400, 'confirm is required');
});

test('unavailable durable registry fails every route closed', async () => {
  const { request } = fixture({ assertAvailable() { throw new XcError('REGISTRY_UNAVAILABLE', 'registry unavailable'); } });
  for (const path of ['hosts', 'inventory', 'settings', 'version', `resolve?uri=${encodeURIComponent(uri)}`, `capture?uri=${encodeURIComponent(uri)}`]) {
    const response = await request(path, undefined, 'GET');
    assert.equal(response.status, 503, path);
    assert.equal(response.body.error.code, 'REGISTRY_UNAVAILABLE', path);
  }
  for (const [path, body, method] of [
    ['adopt', { target: uri }],
    ['forget', { uri }],
    ['settings', { approval: { enabled: true } }, 'PUT'],
    ['alias', { uri, alias: 'x' }],
    ['kill', { uri, confirm: 'lab:named:%0' }],
    ['host/remove', { host: 'lab', mode: 'local', confirm: 'lab' }],
  ]) {
    assert.equal((await request(path, body, method)).body.error.code, 'REGISTRY_UNAVAILABLE', path);
  }
});
