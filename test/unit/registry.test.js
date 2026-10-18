import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PROFILE_DOMAIN_PREFIX, USER_DOMAIN, conversationKey, memoryRegistry, openRegistry, registrySpec, unavailableRegistry,
} from '../../lib/registry.js';
import { encodeRef, resourceKey } from '../../lib/core/uri.js';

const HOST = 'namilab';
const FP = '3fa9c2e81b0d';
const GEN = '2893481-1792293185';
const T0 = 1_700_000_000_000;

const paneRef = { hostId: HOST, hostFp: FP, socketId: 'default', gen: GEN, kind: 'pane', sid: 3, wid: 5, pid: 7 };
const paneUri = encodeRef(paneRef);
const paneKey = resourceKey(paneRef);

function pane(pid, index, extra = {}) {
  return {
    pid, index, active: index === 0, cmd: 'bash', cwd: '/home/u', dead: false, width: 200, height: 50,
    title: `pane ${pid}`, ...extra,
  };
}

function inventory({ gen = GEN, server = true, sessions } = {}) {
  return {
    host: { fp: FP, uid: '1000', user: 'u' },
    server: server ? { gen, socketPath: '/tmp/tmux-1000/default' } : null,
    sessions: sessions ?? [
      { sid: 3, name: 'train', created: 1, attached: 1, windows: [{ wid: 5, index: 0, name: 'shell', active: true, panes: [pane(8, 0), pane(7, 1)] }] },
      { sid: 4, name: 'logs', created: 2, attached: 0, windows: [{ wid: 9, index: 0, name: 'tail', active: true, panes: [pane(12, 0)] }] },
    ],
    malformed: 0,
  };
}

function entry(overrides = {}) {
  return {
    uri: paneUri,
    labels: { session: 'train', window: 'shell', pane: 'pane 7' },
    meta: { cwd: '/home/u', cmd: 'bash', width: 200 },
    origin: 'adopted',
    by: { sessionId: 'sess-a', at: T0, workspace: 'ws1' },
    ...overrides,
  };
}

test('hostPin is TOFU and refuses a different fingerprint', async () => {
  const registry = memoryRegistry();
  assert.deepEqual(await registry.hostPin(HOST, { fp: FP, user: 'u', uid: '1000' }), { ok: true });
  const pinned = registry.hostGet(HOST);
  assert.equal(pinned.fp, FP);
  assert.equal(pinned.user, 'u');

  const again = await registry.hostPin(HOST, { fp: FP, user: 'u', uid: '1000' });
  assert.deepEqual(again, { ok: true });

  const changed = await registry.hostPin(HOST, { fp: '000000000000', user: 'u', uid: '1000' });
  assert.equal(changed.ok, false);
  assert.equal(changed.pinned.fp, FP);
  assert.equal(registry.hostGet(HOST).fp, FP);

  await registry.hostForget(HOST);
  assert.equal(registry.hostGet(HOST), undefined);
});

test('hostPin validates input', async () => {
  const registry = memoryRegistry();
  await assert.rejects(() => registry.hostPin('', { fp: FP }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => registry.hostPin(HOST, {}), { code: 'INVALID_ARGUMENT' });
});

test('resourceUpsert stores a normalized entry and merges by key', async () => {
  const registry = memoryRegistry();
  const created = await registry.resourceUpsert(entry());
  assert.equal(created.key, paneKey);
  assert.equal(created.uri, paneUri);
  assert.equal(created.kind, 'pane');
  assert.equal(created.state, 'live');
  assert.deepEqual(created.workspaces, ['ws1']);
  assert.equal(registry.resourceGet(paneKey).labels.window, 'shell');

  const merged = await registry.resourceUpsert(entry({
    labels: { window: 'renamed' },
    meta: { cmd: 'vim' },
    by: { sessionId: 'sess-b', at: T0 + 1000 },
    origin: 'created',
  }));
  assert.equal(merged.key, paneKey);
  assert.equal(merged.labels.window, 'renamed');
  assert.equal(merged.labels.session, 'train');
  assert.equal(merged.meta.cmd, 'vim');
  assert.equal(merged.meta.cwd, '/home/u');
  assert.equal(merged.origin, 'adopted', 'keeps the first origin');
  assert.equal(merged.by.sessionId, 'sess-a', 'keeps the first by');
  assert.deepEqual(merged.workspaces, ['ws1'], 'does not drop earlier workspaces');
  assert.equal(registry.resourceList().length, 1);
});

test('resourceUpsert without a state keeps the existing stale state', async () => {
  const registry = memoryRegistry();
  await registry.resourceUpsert(entry());
  await registry.markUnreachable(HOST, { code: 'HOST_UNREACHABLE', message: 'x' }, T0);
  const merged = await registry.resourceUpsert(entry({ labels: { session: 'train2' } }));
  assert.equal(merged.state, 'unreachable');
  assert.equal(merged.labels.session, 'train2');
});

test('resourceUpsert rejects malformed entries', async () => {
  const registry = memoryRegistry();
  await assert.rejects(() => registry.resourceUpsert({}), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => registry.resourceUpsert({ uri: 'nope' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => registry.resourceUpsert(entry({ state: 'dead' })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => registry.resourceUpsert(entry({ origin: 'stolen' })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => registry.resourceUpsert(entry({ key: 'other' })), { code: 'INVALID_ARGUMENT' });
});

test('resourceList filters by host, workspace and all', async () => {
  const registry = memoryRegistry();
  const otherRef = { ...paneRef, pid: 8 };
  await registry.resourceUpsert(entry());
  await registry.resourceUpsert(entry({
    uri: encodeRef(otherRef),
    by: { sessionId: 'sess-b', at: T0, workspace: 'ws2' },
  }));
  assert.equal(registry.resourceList().length, 2);
  assert.equal(registry.resourceList({ workspace: 'ws1' }).length, 1);
  assert.equal(registry.resourceList({ workspace: 'ws1', all: true }).length, 2);
  assert.equal(registry.resourceList({ hostId: HOST }).length, 2);
  assert.equal(registry.resourceList({ hostId: 'other' }).length, 0);
});

test('resourceForget deletes only the given key', async () => {
  const registry = memoryRegistry();
  await registry.resourceUpsert(entry());
  await registry.resourceUpsert(entry({ uri: encodeRef({ ...paneRef, pid: 8 }) }));
  assert.equal(await registry.resourceForget(paneKey), true);
  assert.equal(await registry.resourceForget(paneKey), false);
  assert.equal(registry.resourceGet(paneKey), undefined);
  assert.equal(registry.resourceList().length, 1);
});

test('conversationAddRefs dedupes by uri and keeps firstSeenAt', async () => {
  const registry = memoryRegistry();
  const first = await registry.conversationAddRefs('sess-a', [{ uri: paneUri, label: 'one' }]);
  assert.equal(first.sessionId, 'sess-a');
  assert.equal(first.refs.length, 1);
  const seen = first.refs[0].firstSeenAt;

  const second = await registry.conversationAddRefs('sess-a', [
    { uri: paneUri, label: 'duplicate' },
    { uri: encodeRef({ ...paneRef, pid: 8 }), label: 'two' },
  ]);
  assert.equal(second.refs.length, 2);
  assert.equal(second.refs[0].firstSeenAt, seen);
  assert.equal(registry.conversationGet('sess-a').refs.length, 2);

  const announced = await registry.conversationSetAnnounced('sess-a', T0 + 5);
  assert.equal(announced.announcedAt, T0 + 5);
  assert.equal(registry.conversationGet('sess-a').announcedAt, T0 + 5);

  await assert.rejects(
    () => registry.conversationAddRefs('sess-a', [{ uri: 'dsh-tmux:v1/x', label: 'bad' }]),
    { code: 'INVALID_ARGUMENT' },
  );

  // A never-seen conversation is created with an empty ref list.
  const fresh = await registry.conversationSetAnnounced('sess-new', T0 + 9);
  assert.deepEqual(fresh.refs, []);
  assert.equal(await registry.conversationGet('missing'), undefined);
});

test('conversation keys are path-safe and change-collision resistant', () => {
  assert.equal(conversationKey('abc-123_X'), 'abc-123_X');
  const key = conversationKey('sess/with spaces');
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.ok(key.includes('sess_with_spaces'));
  assert.notEqual(conversationKey('a/b'), conversationKey('a_b'));
});

test('markVerified transitions live -> stale reasons and refreshes labels', async () => {
  const registry = memoryRegistry();
  await registry.resourceUpsert(entry());
  const at = T0 + 100;

  assert.equal(await registry.markVerified(HOST, 'default', inventory(), at), 1);
  let stored = registry.resourceGet(paneKey);
  assert.equal(stored.state, 'live');
  assert.equal(stored.staleReason, undefined);
  assert.equal(stored.lastVerifiedAt, at);
  assert.equal(stored.labels.window, 'shell');

  // Rename only: still live, labels refreshed.
  const renamed = inventory({
    sessions: [{ sid: 3, name: 'renamed', attached: 1, windows: [{ wid: 5, index: 0, name: 'win2', active: true, panes: [pane(7, 1, { title: 'new title' })] }] }],
  });
  assert.equal(await registry.markVerified(HOST, 'default', renamed, at + 1), 1);
  stored = registry.resourceGet(paneKey);
  assert.equal(stored.state, 'live');
  assert.equal(stored.labels.session, 'renamed');
  assert.equal(stored.labels.window, 'win2');
  assert.equal(stored.labels.pane, 'new title');

  // Server gone.
  await registry.markVerified(HOST, 'default', inventory({ server: false, sessions: [] }), at + 2);
  stored = registry.resourceGet(paneKey);
  assert.equal(stored.state, 'stale');
  assert.equal(stored.staleReason, 'SERVER_GONE');

  // Restart.
  await registry.markVerified(HOST, 'default', inventory({ gen: '1-2' }), at + 3);
  stored = registry.resourceGet(paneKey);
  assert.equal(stored.state, 'stale');
  assert.equal(stored.staleReason, 'SERVER_RESTARTED');

  // Target gone.
  await registry.markVerified(HOST, 'default', inventory({
    sessions: [{ sid: 3, name: 'train', attached: 1, windows: [{ wid: 5, index: 0, name: 'shell', active: true, panes: [pane(8, 0)] }] }],
  }), at + 4);
  stored = registry.resourceGet(paneKey);
  assert.equal(stored.state, 'stale');
  assert.equal(stored.staleReason, 'TARGET_GONE');

  // Back to live clears staleReason.
  await registry.markVerified(HOST, 'default', inventory(), at + 5);
  stored = registry.resourceGet(paneKey);
  assert.equal(stored.state, 'live');
  assert.equal(stored.staleReason, undefined);
  assert.equal(stored.lastVerifiedAt, at + 5);
});

test('markVerified handles host/server kinds, relocation and ambiguity', async () => {
  const registry = memoryRegistry();
  const serverRef = { ...paneRef, kind: 'server', sid: null, wid: null, pid: null };
  const windowRef = { ...paneRef, kind: 'window', pid: null };
  await registry.resourceUpsert(entry({ uri: encodeRef(serverRef) }));
  await registry.resourceUpsert(entry({ uri: encodeRef(windowRef) }));

  await registry.markVerified(HOST, 'default', inventory({ gen: '9-9' }), T0);
  assert.equal(registry.resourceGet(resourceKey(serverRef)).staleReason, 'SERVER_RESTARTED');
  assert.equal(registry.resourceGet(resourceKey(windowRef)).staleReason, 'SERVER_RESTARTED');

  await registry.markVerified(HOST, 'default', inventory(), T0 + 1);
  assert.equal(registry.resourceGet(resourceKey(serverRef)).state, 'live');

  // Window moved to another session: relocated => live.
  await registry.markVerified(HOST, 'default', inventory({
    sessions: [
      { sid: 3, name: 'train', attached: 1, windows: [] },
      { sid: 4, name: 'logs', attached: 0, windows: [{ wid: 5, index: 0, name: 'moved', active: true, panes: [pane(7, 0)] }] },
    ],
  }), T0 + 2);
  const moved = registry.resourceGet(resourceKey(windowRef));
  assert.equal(moved.state, 'live');
  assert.equal(moved.labels.window, 'moved');

  // Window linked into several sessions and missing from the referenced one: ambiguous.
  await registry.markVerified(HOST, 'default', inventory({
    sessions: [
      { sid: 3, name: 'train', attached: 1, windows: [{ wid: 11, index: 0, name: 'a', active: true, panes: [pane(7, 0)] }] },
      { sid: 4, name: 'mirror', attached: 0, windows: [{ wid: 5, index: 0, name: 'a', active: true, panes: [pane(7, 0)] }] },
      { sid: 6, name: 'third', attached: 0, windows: [{ wid: 5, index: 0, name: 'a', active: true, panes: [pane(7, 0)] }] },
    ],
  }), T0 + 3);
  assert.equal(registry.resourceGet(resourceKey(windowRef)).staleReason, 'AMBIGUOUS');
});

test('markVerified does not touch other hosts or sockets', async () => {
  const registry = memoryRegistry();
  await registry.resourceUpsert(entry());
  const otherSocket = { ...paneRef, socketId: 'xc', pid: 7 };
  await registry.resourceUpsert(entry({ uri: encodeRef(otherSocket) }));
  assert.equal(await registry.markVerified(HOST, 'default', inventory({ server: false, sessions: [] }), T0), 1);
  assert.equal(registry.resourceGet(resourceKey(otherSocket)).state, 'live');
});

test('markUnreachable keeps identity fields and sets state', async () => {
  const registry = memoryRegistry();
  await registry.resourceUpsert(entry());
  const before = registry.resourceGet(paneKey);
  await registry.markUnreachable(HOST, { code: 'HOST_UNREACHABLE', message: 'timeout' }, T0 + 1);
  const after = registry.resourceGet(paneKey);
  assert.equal(after.state, 'unreachable');
  assert.equal(after.staleReason, undefined);
  assert.deepEqual(after.lastError, { code: 'HOST_UNREACHABLE', message: 'timeout' });
  for (const field of ['key', 'uri', 'kind', 'hostId', 'hostFp', 'socketId', 'gen', 'sid', 'wid', 'pid']) {
    assert.deepEqual(after[field], before[field], field);
  }
});

test('compound writes are serialized', async () => {
  const registry = memoryRegistry();
  const uris = Array.from({ length: 20 }, (_, i) => encodeRef({ ...paneRef, pid: i }));
  await Promise.all(uris.map((uri, i) => registry.resourceUpsert(entry({ uri, by: { sessionId: `s${i}`, at: T0 } }))));
  assert.equal(registry.resourceList().length, 20);
  await Promise.all(uris.map((uri) => registry.conversationAddRefs('sess-a', [{ uri, label: uri }])));
  const conv = registry.conversationGet('sess-a');
  assert.equal(conv.refs.length, 20);
  assert.equal(new Set(conv.refs.map((r) => r.uri)).size, 20);
});

test('registrySpec declares the three tables and is path-safe', () => {
  assert.equal(registrySpec(USER_DOMAIN).name, USER_DOMAIN);
  const domainName = `${PROFILE_DOMAIN_PREFIX}web`;
  const spec = registrySpec(domainName);
  assert.equal(spec.name, domainName);
  assert.equal(spec.version, 1);
  assert.equal(spec.layout, 'per-record');
  assert.deepEqual(Object.keys(spec.tables), ['hosts', 'resources', 'conversations']);
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/);
  // DESIGN spellings are accepted and normalized to the DSH unit charset.
  assert.equal(registrySpec('dsh-tmux-xc').name, 'dsh_tmux_xc');
  assert.equal(registrySpec('dsh-tmux-xc.p.web').name, 'dsh_tmux_xc_p_web');
  assert.throws(() => registrySpec('Dsh Tmux'));
  assert.throws(() => registrySpec('9bad'));
  assert.throws(() => registrySpec(''));
});

test('openRegistry uses ctx.storage.domain.open and reports the domain name', async () => {
  const opened = [];
  const ctx = {
    storage: { domain: { open: async (spec) => {
      opened.push(spec);
      const tables = new Map();
      return {
        table(name) {
          if (!tables.has(name)) {
            const map = new Map();
            tables.set(name, {
              get: (key) => map.get(key), entries: () => map.entries(),
              put: async (key, value) => { map.set(key, value); },
              delete: async (key) => map.delete(key),
              update: async (key, fn) => { const next = fn(map.get(key)); map.set(key, next); return next; },
            });
          }
          return tables.get(name);
        },
        close: async () => { opened.push('closed'); },
      };
    } } },
  };
  const registry = await openRegistry(ctx, { scope: 'user' });
  assert.equal(opened[0].name, USER_DOMAIN);
  assert.equal(registry.name, USER_DOMAIN);
  assert.equal(registry.warning, undefined);
  await registry.resourceUpsert(entry());
  assert.equal(registry.resourceList().length, 1);
  await registry.close();
  assert.equal(opened[1], 'closed');
});

test('profile scope hashes exact identities without folding, truncation or user fallback', async () => {
  const profiles = [
    'lab-a', 'lab_a', 'Lab', 'lab', '实验室', '___',
    `${'x'.repeat(100)}a`, `${'x'.repeat(100)}b`, 'é', 'e\u0301', ' lab', 'lab ',
  ];
  const names = [];
  for (const profile of profiles) {
    const ctx = {
      get: (key) => (key === 'profileContext' ? { name: profile } : undefined),
      storage: { domain: { open: async (spec) => {
        names.push(spec.name);
        return { table: () => ({}), close: async () => {} };
      } } },
    };
    const registry = await openRegistry(ctx, { scope: 'profile' });
    const expected = `${PROFILE_DOMAIN_PREFIX}${createHash('sha256').update(profile, 'utf8').digest('hex')}`;
    assert.equal(registry.name, expected);
    assert.equal(names.at(-1), expected);
    assert.match(registry.name, /^[a-z][a-z0-9_]*$/);
    assert.notEqual(registry.name, USER_DOMAIN);
    await registry.close();
  }
  assert.equal(new Set(names).size, profiles.length);
});

test('profile scope rejects missing identity before opening any domain', async () => {
  let opens = 0;
  for (const name of [undefined, null, '', 123, '\ud800', '\udfff']) {
    const ctx = {
      get: () => name === undefined ? undefined : { name },
      storage: { domain: { open: async () => { opens += 1; } } },
    };
    await assert.rejects(() => openRegistry(ctx, { scope: 'profile' }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(opens, 0, 'must never silently open the shared user domain');
});

test('unavailable registry refuses every read/write and permits disposal', async () => {
  const registry = unavailableRegistry();
  assert.equal(registry.mode, 'unavailable');
  for (const [name, method] of Object.entries(registry)) {
    if (typeof method !== 'function' || name === 'close') continue;
    assert.throws(() => method(), { code: 'REGISTRY_UNAVAILABLE' }, name);
  }
  await registry.close();
  await registry.close();
});

test('persistent open errors propagate rather than substituting an empty registry', async () => {
  for (const message of ['invalid record', 'incompatible version', 'already-open']) {
    const error = new Error(message);
    const ctx = { storageDomain: { open: async () => { throw error; } } };
    await assert.rejects(() => openRegistry(ctx), (actual) => actual === error);
  }
});

test('close drains queued writes, shares settlement and refuses new work', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  let closes = 0;
  const table = { get() {}, async put() { await gate; writes += 1; } };
  const registry = await openRegistry({ storageDomain: { open: async () => ({
    table: () => table,
    async close() { assert.equal(writes, 1); closes += 1; },
  }) } });
  const writing = registry.hostPin(HOST, { fp: FP });
  const closing = registry.close();
  assert.equal(registry.close(), closing);
  assert.equal(closes, 0);
  await assert.rejects(() => registry.hostPin('other', { fp: FP }), { code: 'REGISTRY_UNAVAILABLE' });
  assert.throws(() => registry.hostGet(HOST), { code: 'REGISTRY_UNAVAILABLE' });
  release();
  await writing;
  await closing;
  assert.equal(closes, 1);
});

test('an opened domain is closed if obtaining its tables fails', async () => {
  let closed = 0;
  const failure = new Error('table unavailable');
  await assert.rejects(() => openRegistry({ storageDomain: { open: async () => ({
    table() { throw failure; },
    async close() { closed += 1; },
  }) } }), (error) => error === failure);
  assert.equal(closed, 1);
});

test('openRegistry rejects a missing facility and a bad scope', async () => {
  await assert.rejects(() => openRegistry({}, { scope: 'user' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(() => openRegistry({ storage: { domain: { open: async () => ({}) } } }, { scope: 'global' }), { code: 'INVALID_ARGUMENT' });
});
