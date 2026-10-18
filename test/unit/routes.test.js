import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../../lib/routes.js';
import { encodeRef } from '../../lib/core/uri.js';
import { XcError } from '../../lib/core/errors.js';

const uri = encodeRef({ hostId: 'lab', hostFp: 'abcdef123456', socketId: 'named', gen: '123-456', kind: 'pane', sid: 0, wid: 0, pid: 0 });
const entry = { uri, token: `@[Lab · demo:0.0 %0](${uri})`, label: 'Lab · demo:0.0 %0', key: 'key', origin: 'adopted', state: 'live' };

function fixture(overrides = {}) {
  const routes = new Map();
  const calls = [];
  const hosts = [{ id: 'lab', label: 'Lab', transport: 'ssh', ssh: 'LabAlias', sockets: [{ id: 'named', name: 'lab.socket' }, { id: 'path', path: '/tmp/lab socket' }] }];
  const service = {
    hosts: () => hosts,
    inventory: async (args) => { calls.push(args); return { hosts: [] }; },
    adopt: async (args) => { calls.push(args); return entry; },
    forget: async (args) => { calls.push(args); return true; },
    resolveRef: async () => ({ ref: { hostId: 'lab' }, result: { code: 'TARGET_GONE', warnings: [] } }),
    ...overrides,
  };
  registerRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } } }, service);
  async function request(path, body) {
    const route = routes.get(`/api/tmux-xc/${path.split('?')[0]}`);
    const response = await route.fetch(new Request(`http://localhost/api/tmux-xc/${path}`, body === undefined ? {} : {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }));
    return { status: response.status, body: await response.json() };
  }
  return { request, calls, hosts };
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
  for (const path of ['hosts', 'inventory', `resolve?uri=${encodeURIComponent(uri)}`]) {
    const response = await request(path);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'REGISTRY_UNAVAILABLE');
  }
  for (const [path, body] of [['adopt', { target: uri }], ['forget', { uri }]]) {
    assert.equal((await request(path, body)).body.error.code, 'REGISTRY_UNAVAILABLE');
  }
});
