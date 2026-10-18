/**
 * Unit tests for TmuxXcService against a fake transport (canned records) and
 * the in-memory registry. No network, no tmux, no ssh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TmuxXcService } from '../../lib/service.js';
import { memoryRegistry } from '../../lib/registry.js';
import { hostFingerprint } from '../../lib/core/parse.js';
import { encodeRef } from '../../lib/core/uri.js';
import { XcError, CODES } from '../../lib/core/errors.js';

const CFG = {
  hosts: [{ id: 'namilab', label: 'NaMILab', ssh: 'NaMILab', sockets: [{ id: 'default' }] }],
  sshPath: '',
  sshConfigFile: '',
  connectTimeoutSec: 10,
  commandTimeoutMs: 20000,
  registryScope: 'user',
  approval: { create: 'ask', send: 'ask', detach: 'ask' },
  capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 },
};

const MACHINE = 'test-machine';
const UID = '1000';
const USER = 'alice';
const FP = hostFingerprint(MACHINE, UID);
const GEN = '2893481-1792293185';
const SOCKET = '/tmp/tmux-1000/default';

function hostRecord(machine = MACHINE, uid = UID, user = USER) {
  return ['host', machine, uid, user];
}

/** One pane record matching DESIGN §7 list-panes field order. */
function paneRecord({
  sid = 3,
  sname = 'train',
  created = '1699999999',
  attached = '0',
  wid = 5,
  windex = 0,
  wname = 'train',
  wactive = '1',
  pid = 7,
  pindex = 0,
  pactive = '1',
  cmd = 'bash',
  cwd = '/home/alice',
  dead = '0',
  width = '200',
  height = '50',
  title = 'alice@host',
} = {}) {
  return [
    'pane',
    GEN,
    SOCKET,
    `$${sid}`,
    sname,
    created,
    attached,
    `@${wid}`,
    String(windex),
    wname,
    wactive,
    `%${pid}`,
    String(pindex),
    pactive,
    cmd,
    cwd,
    dead,
    width,
    height,
    title,
  ];
}

/** Fake transport dispatching on the remote script text. */
function makeTransport(expectedHost = {
  ...CFG.hosts[0],
  transport: 'ssh',
  newSession: {},
}) {
  const calls = [];
  const state = {
    inventory: () => [hostRecord(), paneRecord()],
    send: [],
    created: [],
  };
  return {
    calls,
    state,
    runRemote: async ({ script, mutating, alias, host }) => {
      calls.push({ script, mutating, alias, host });
      assert.deepEqual(host, expectedHost, 'every inventory and operation must receive the normalized host');
      assert.equal(alias, expectedHost.ssh);
      if (script.includes('list-panes')) return { records: state.inventory(), stderr: '', exitCode: 0 };
      if (state.scriptError !== undefined) throw state.scriptError;
      if (script.includes('capture-pane')) {
        return {
          records: [['capture', Buffer.from('hello\n\u001b[31mred\u001b[0m\nworld', 'utf8').toString('hex')]],
          stderr: '',
          exitCode: 0,
        };
      }
      if (script.includes('send-keys')) return { records: state.send, stderr: '', exitCode: 0 };
      if (script.includes('detach-client')) return { records: [], stderr: '', exitCode: 0 };
      if (script.includes('kill-pane') || script.includes('kill-window') || script.includes('kill-session')) {
        return { records: [], stderr: '', exitCode: 0 };
      }
      if (script.includes('new-session') || script.includes('new-window') || script.includes('split-window')) {
        return { records: state.created, stderr: '', exitCode: 0 };
      }
      throw new Error(`unhandled script: ${script.slice(0, 120)}`);
    },
  };
}

function makeService(transport, { config = CFG, registry = memoryRegistry() } = {}) {
  const registryCalls = { markVerified: [], markUnreachable: [] };
  for (const method of Object.keys(registryCalls)) {
    const original = registry[method].bind(registry);
    registry[method] = async (...args) => {
      registryCalls[method].push(args);
      return original(...args);
    };
  }
  const service = new TmuxXcService({
    config,
    registry,
    transport,
    now: () => 1234567890,
    logger: { warn() {} },
  });
  return { service, registry, registryCalls };
}

function ref(overrides = {}) {
  return encodeRef({
    hostId: 'namilab',
    hostFp: FP,
    socketId: 'default',
    gen: GEN,
    kind: 'pane',
    sid: 3,
    wid: 5,
    pid: 7,
    ...overrides,
  });
}

test('inventory lists a reachable host with node flags', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const { hosts } = await service.inventory({});
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].reachable, true);
  assert.equal(hosts[0].status, 'ok');
  assert.equal(hosts[0].verifiedAt, 1234567890);
  assert.equal(hosts[0].error, undefined);
  assert.equal(hosts[0].id, 'namilab');
  const [socket] = hosts[0].sockets;
  assert.equal(socket.server.gen, GEN);
  const [session] = socket.sessions;
  assert.equal(session.sid, 3);
  assert.equal(session.windows[0].wid, 5);
  const [pane] = session.windows[0].panes;
  assert.equal(pane.pid, 7);
  assert.equal(typeof pane.uri, 'string');
  assert.ok(pane.uri.startsWith('dsh-tmux:v1/'));
  assert.equal(pane.adopted, false);
});

for (const transportMode of [undefined, 'ssh', 'local']) {
  test(`normalized ${transportMode ?? 'default ssh'} host reaches inventory, reads and mutations`, async () => {
    // A local host needs no ssh alias. Omit label/sockets/newSession to check
    // their defaults travel with the host, rather than passing raw config.
    const configuredHost = {
      id: 'namilab',
      ...(transportMode === 'local' ? {} : { ssh: 'NaMILab' }),
      ...(transportMode === undefined ? {} : { transport: transportMode }),
    };
    const expectedHost = {
      id: 'namilab',
      label: 'namilab',
      ssh: configuredHost.ssh,
      transport: transportMode ?? 'ssh',
      sockets: [{ id: 'default' }],
      newSession: {},
    };
    const transport = makeTransport(expectedHost);
    transport.state.created = [['created', GEN, '$3', '@5', '%7', 'train', 'train']];
    const { service } = makeService(transport, { config: { ...CFG, hosts: [configuredHost] } });

    const { hosts } = await service.inventory();
    assert.equal(hosts[0].status, 'ok');
    assert.equal(hosts[0].reachable, true);
    await service.capture({ uri: ref() });
    await service.send({ uri: ref(), text: 'hello' });
    await service.detach({ uri: ref() });
    await service.kill({ uri: ref(), confirm: 'namilab:default:%7' });
    await service.create({ hostId: 'namilab', kind: 'session', name: 'train', by: { sessionId: 'chat-a' } });

    assert.ok(transport.calls.some((call) => call.script.includes('list-panes')));
    assert.ok(transport.calls.some((call) => call.script.includes('capture-pane') && !call.mutating));
    assert.equal(transport.calls.filter((call) => call.mutating).length, 4);
    for (const call of transport.calls) assert.equal(call.host, transport.calls[0].host);
    assert.deepEqual(service.hosts(), [{ id: 'namilab', label: 'namilab', sockets: [{ id: 'default' }] }]);
    assert.equal(configuredHost.transport, transportMode, 'normalizing must not mutate config');
    assert.equal(configuredHost.sockets, undefined);
  });
}

test('local host retains configured sockets and newSession settings at both call sites', async () => {
  const configuredHost = {
    id: 'namilab', label: 'Local lab', transport: 'local', ssh: 'ignored-ssh-alias',
    sockets: [{ id: 'xc', name: 'xc' }],
    newSession: { command: ['bash', '-l'], cwd: '/configured/default' },
  };
  const transport = makeTransport(configuredHost);
  const { service } = makeService(transport, { config: { ...CFG, hosts: [configuredHost] } });
  await service.inventory();
  await service.capture({ uri: ref({ socketId: 'xc' }) });
  await service.send({ uri: ref({ socketId: 'xc' }), text: 'hello' });
  assert.equal(transport.calls.length, 5);
  for (const call of transport.calls) {
    assert.deepEqual(call.host, configuredHost);
    assert.notEqual(call.host, configuredHost, 'the service forwards its normalized host');
    assert.equal(call.host.newSession, configuredHost.newSession);
    assert.equal(call.host.sockets, configuredHost.sockets);
  }
});

const TRANSPORT_CODES = [
  CODES.HOST_UNREACHABLE,
  CODES.SSH_AUTH,
  CODES.SSH_HOSTKEY,
  CODES.SSH_MISSING,
  CODES.TIMEOUT,
];
const NON_TRANSPORT_CODES = Object.values(CODES).filter((code) => !TRANSPORT_CODES.includes(code));

for (const code of TRANSPORT_CODES) {
  test(`inventory ${code} reports unreachable and marks only that host's registry resources`, async () => {
    const transport = makeTransport();
    const { service, registry, registryCalls } = makeService(transport);
    const adopted = await service.adopt({ hostId: 'namilab', target: '%7', by: { sessionId: 'chat-a' } });
    const other = await registry.resourceUpsert({ ...adopted, key: undefined, uri: ref({ hostId: 'other' }) });
    const pinned = await registry.hostGet('namilab');
    registryCalls.markVerified.length = 0;
    const error = new XcError(code, `transport failure: ${code}`, { privateDetail: 'not serialized' });
    transport.state.inventory = () => { throw error; };

    const { hosts } = await service.inventory();
    assert.deepEqual(hosts, [{
      id: 'namilab', label: 'NaMILab', reachable: false, status: 'unreachable', sockets: [],
      error: { code, message: error.message },
    }]);
    assert.deepEqual(registryCalls.markUnreachable, [['namilab', error, 1234567890]]);
    assert.deepEqual(registryCalls.markVerified, []);
    const stored = await registry.resourceGet(adopted.key);
    assert.equal(stored.state, 'unreachable');
    assert.deepEqual(stored.lastError, { code, message: error.message });
    assert.equal(stored.uri, adopted.uri);
    assert.equal(stored.lastVerifiedAt, adopted.lastVerifiedAt);
    assert.deepEqual(await registry.resourceGet(other.key), other);
    assert.deepEqual(await registry.hostGet('namilab'), pinned);
  });

  test(`resolveRef ${code} rethrows the original transport XcError and marks registry`, async () => {
    const transport = makeTransport();
    const { service, registryCalls } = makeService(transport);
    const error = new XcError(code, 'cannot inventory');
    transport.state.inventory = () => { throw error; };
    await assert.rejects(service.resolveRef(ref()), (actual) => actual === error);
    assert.deepEqual(registryCalls.markUnreachable, [['namilab', error, 1234567890]]);
    assert.deepEqual(registryCalls.markVerified, []);
  });
}

for (const code of NON_TRANSPORT_CODES) {
  test(`inventory ${code} reports error without marking resources unreachable`, async () => {
    const transport = makeTransport();
    const { service, registry, registryCalls } = makeService(transport);
    const adopted = await service.adopt({ hostId: 'namilab', target: '%7', by: { sessionId: 'chat-a' } });
    registryCalls.markVerified.length = 0;
    const error = new XcError(code, `operation failure: ${code}`, { ignored: true });
    transport.state.inventory = () => { throw error; };

    const { hosts } = await service.inventory();
    assert.equal(hosts[0].reachable, false, 'legacy flag continues to mean inventory success');
    assert.equal(hosts[0].status, 'error');
    assert.deepEqual(hosts[0].error, { code, message: error.message });
    assert.equal(hosts[0].verifiedAt, undefined);
    assert.deepEqual(registryCalls.markUnreachable, []);
    assert.deepEqual(registryCalls.markVerified, []);
    assert.deepEqual(await registry.resourceGet(adopted.key), adopted);
  });
}

for (const [name, makeError] of [
  ['Error', () => new Error('internal bug')],
  ['TypeError with a transport-looking code', () => Object.assign(new TypeError('internal bug'), { code: CODES.HOST_UNREACHABLE })],
  ['plain object with a transport-looking code', () => ({ code: CODES.TIMEOUT, message: 'not an XcError' })],
  ['null', () => null],
]) {
  test(`inventory propagates non-XcError ${name} without registry side effects`, async () => {
    const transport = makeTransport();
    const { service, registryCalls } = makeService(transport);
    const error = makeError();
    transport.state.inventory = () => { throw error; };
    await assert.rejects(service.inventory(), (actual) => actual === error);
    assert.deepEqual(registryCalls.markUnreachable, []);
    assert.deepEqual(registryCalls.markVerified, []);
  });
}

for (const operation of ['capture', 'send']) {
  for (const code of [...TRANSPORT_CODES, ...NON_TRANSPORT_CODES]) {
    test(`${operation} ${code} propagates and marks unreachable only for transport codes`, async () => {
      const transport = makeTransport();
      const { service, registry, registryCalls } = makeService(transport);
      const adopted = await service.adopt({ hostId: 'namilab', target: '%7', by: { sessionId: 'chat-a' } });
      registryCalls.markVerified.length = 0;
      const error = new XcError(code, `${operation} failed`);
      transport.state.scriptError = error;

      await assert.rejects(service[operation]({ uri: ref(), text: 'hello' }), (actual) => actual === error);
      assert.equal(registryCalls.markVerified.length, 1, 'operation first resolves fresh inventory');
      assert.equal(transport.calls.filter((call) => !call.script.includes('list-panes')).length, 1, 'failed operations are never replayed');
      const stored = await registry.resourceGet(adopted.key);
      if (TRANSPORT_CODES.includes(code)) {
        assert.deepEqual(registryCalls.markUnreachable, [['namilab', error, 1234567890]]);
        assert.equal(stored.state, 'unreachable');
        assert.deepEqual(stored.lastError, { code, message: error.message });
      } else {
        assert.deepEqual(registryCalls.markUnreachable, []);
        assert.equal(stored.state, 'live');
        assert.equal(stored.lastError, undefined);
      }
    });
  }

  test(`${operation} propagates internal failures after successful inventory`, async () => {
    const transport = makeTransport();
    const { service, registryCalls } = makeService(transport);
    const error = Object.assign(new TypeError('internal operation bug'), { code: CODES.SSH_AUTH });
    transport.state.scriptError = error;
    await assert.rejects(service[operation]({ uri: ref(), text: 'hello' }), (actual) => actual === error);
    assert.equal(registryCalls.markVerified.length, 1);
    assert.deepEqual(registryCalls.markUnreachable, []);
  });
}

for (const method of ['resourceList', 'markVerified', 'hostPin', 'markUnreachable']) {
  test(`inventory propagates internal registry ${method} failures`, async () => {
    const transport = makeTransport();
    const registry = memoryRegistry();
    const error = new TypeError(`registry ${method} bug`);
    registry[method] = async () => { throw error; };
    const { service, registryCalls } = makeService(transport, { registry });
    if (method === 'markUnreachable') {
      transport.state.inventory = () => { throw new XcError(CODES.HOST_UNREACHABLE, 'offline'); };
    }
    await assert.rejects(service.inventory(), (actual) => actual === error);
    assert.equal(registryCalls.markUnreachable.length, method === 'markUnreachable' ? 1 : 0);
  });
}

for (const records of [undefined, {}]) {
  test(`inventory parser rejects ${records === undefined ? 'missing' : 'object'} records as error without unreachable side effects`, async () => {
    const transport = makeTransport();
    transport.state.inventory = () => records;
    const { service, registryCalls } = makeService(transport);
    const { hosts } = await service.inventory();
    assert.equal(hosts[0].status, 'error');
    assert.equal(hosts[0].reachable, false);
    assert.deepEqual(hosts[0].error, { code: CODES.INVALID_ARGUMENT, message: 'records must be an array' });
    assert.deepEqual(registryCalls.markVerified, []);
    assert.deepEqual(registryCalls.markUnreachable, []);
  });
}

test('inventory propagates a real internal parser failure without unreachable side effects', async () => {
  const transport = makeTransport();
  const error = new TypeError('internal record iteration bug');
  const records = [];
  records[Symbol.iterator] = () => { throw error; };
  transport.state.inventory = () => records;
  const { service, registryCalls } = makeService(transport);
  await assert.rejects(service.inventory(), (actual) => actual === error);
  assert.deepEqual(registryCalls.markVerified, []);
  assert.deepEqual(registryCalls.markUnreachable, []);
});

test('inventory host identity mismatch is error rather than unreachable', async () => {
  const transport = makeTransport();
  const { service, registry, registryCalls } = makeService(transport);
  await service.inventory();
  const pinned = await registry.hostGet('namilab');
  transport.state.inventory = () => [hostRecord('replacement-machine'), paneRecord()];
  const { hosts } = await service.inventory();
  assert.equal(hosts[0].status, 'error');
  assert.equal(hosts[0].reachable, false);
  assert.equal(hosts[0].error.code, CODES.HOST_IDENTITY_CHANGED);
  assert.deepEqual(registryCalls.markUnreachable, []);
  assert.deepEqual(await registry.hostGet('namilab'), pinned);
});

test('inventory with no tmux server is reachable and verifies stale registry entries', async () => {
  const transport = makeTransport();
  const { service, registry, registryCalls } = makeService(transport);
  const adopted = await service.adopt({ hostId: 'namilab', target: '%7', by: { sessionId: 'chat-a' } });
  transport.state.inventory = () => [hostRecord(), ['noserver']];
  const { hosts } = await service.inventory();
  assert.equal(hosts[0].status, 'ok');
  assert.equal(hosts[0].reachable, true);
  assert.equal(hosts[0].verifiedAt, 1234567890);
  assert.equal(hosts[0].error, undefined);
  assert.deepEqual(hosts[0].sockets, [{ id: 'default', server: null, sessions: [] }]);
  assert.deepEqual(registryCalls.markUnreachable, []);
  const stored = await registry.resourceGet(adopted.key);
  assert.equal(stored.state, 'stale');
  assert.equal(stored.staleReason, CODES.SERVER_GONE);
});

test('resolveRef resolves a live pane reference', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const { result } = await service.resolveRef(ref());
  assert.equal(result.code, 'OK');
  assert.equal(result.target.kind, 'pane');
  assert.equal(result.target.pid, 7);
});

test('stale target refuses with TARGET_GONE', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => [hostRecord(), paneRecord({ pid: 8 })];
  const { service } = makeService(transport);
  const { result } = await service.resolveRef(ref());
  assert.equal(result.code, 'TARGET_GONE');
  await assert.rejects(service.send({ uri: ref(), text: 'x' }), (error) => error.code === CODES.TARGET_GONE);
});

test('ambiguous session ref refuses send with AMBIGUOUS', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => [hostRecord(), paneRecord({ pid: 7 }), paneRecord({ pid: 8 })];
  const { service } = makeService(transport);
  const uri = ref({ kind: 'session', sid: 3, wid: null, pid: null });
  await assert.rejects(service.send({ uri, text: 'x' }), (error) => error.code === CODES.AMBIGUOUS);
});

test('kill with wrong confirm refuses with CONFIRM_MISMATCH and no remote kill', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  await assert.rejects(service.kill({ uri: ref(), confirm: 'wrong' }), (error) => error.code === CODES.CONFIRM_MISMATCH);
  assert.equal(transport.calls.some((call) => call.script.includes('kill-')), false);
});

test('mutations run mutating (never retried); reads run read-only', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  await service.send({ uri: ref(), text: 'hi' });
  const sendCall = transport.calls.find((call) => call.script.includes('send-keys'));
  const inventoryCall = transport.calls.find((call) => call.script.includes('list-panes'));
  assert.equal(sendCall.mutating, true);
  assert.equal(inventoryCall.mutating, false);
  assert.equal(transport.calls.filter((call) => call.script.includes('send-keys')).length, 1);
});

test('guard mismatch maps to TARGET_GONE and SERVER_RESTARTED', async () => {
  const transport = makeTransport();
  transport.state.send = [['mismatch', GEN, '$3', '@5', '%8', '%7', GEN]];
  const { service } = makeService(transport);
  await assert.rejects(service.send({ uri: ref(), text: 'x' }), (error) => error.code === CODES.TARGET_GONE);

  const transport2 = makeTransport();
  transport2.state.send = [['mismatch', '1111-2222', '$3', '@5', '%7', '%7', GEN]];
  const svc2 = makeService(transport2).service;
  await assert.rejects(svc2.send({ uri: ref(), text: 'x' }), (error) => error.code === CODES.SERVER_RESTARTED);
});

for (const kind of ['session', 'window', 'pane']) {
  test(`create ${kind} parses transport records and registers the created target`, async () => {
    const transport = makeTransport();
    transport.state.created = [['created', GEN, '$3', '@5', '%7', 'train', 'train']];
    if (kind === 'session') {
      let inventories = 0;
      transport.state.inventory = () => ++inventories === 1
        ? [hostRecord(), ['noserver']]
        : [hostRecord(), paneRecord()];
    }
    const { service, registry } = makeService(transport);
    const entry = await service.create({
      hostId: 'namilab',
      kind,
      name: kind === 'pane' ? undefined : 'train',
      parentUri: kind === 'window'
        ? ref({ kind: 'session', wid: null, pid: null })
        : kind === 'pane' ? ref() : undefined,
      by: { sessionId: 'chat-a' },
    });
    assert.equal(entry.kind, kind);
    assert.equal(entry.origin, 'created');
    assert.equal(entry.gen, GEN);
    assert.deepEqual(await registry.resourceGet(entry.key), entry);
    assert.equal(transport.calls.filter((call) => call.mutating).length, 1);
  });
}

test('linked window absent from its referenced session refuses send with AMBIGUOUS', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => [hostRecord(), paneRecord({ sid: 4 }), paneRecord({ sid: 5 })];
  const { service } = makeService(transport);
  const uri = ref({ kind: 'window', pid: null });
  const { result } = await service.resolveRef(uri);
  assert.equal(result.code, CODES.AMBIGUOUS);
  await assert.rejects(service.send({ uri, text: 'x' }), (error) => error.code === CODES.AMBIGUOUS);
  assert.equal(transport.calls.some((call) => call.mutating), false);
});

test('host and socket not allow-listed refuse', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  await assert.rejects(service.resolveRef(ref({ hostId: 'other' })), (error) => error.code === CODES.HOST_NOT_ALLOWED);
  await assert.rejects(service.resolveRef(ref({ socketId: 'xc' })), (error) => error.code === CODES.SOCKET_NOT_ALLOWED);
});

test('host fingerprint change refuses with HOST_IDENTITY_CHANGED', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  await service.inventory({});
  transport.state.inventory = () => [hostRecord('other-machine'), paneRecord()];
  await assert.rejects(service.resolveRef(ref()), (error) => error.code === CODES.HOST_IDENTITY_CHANGED);
});

test('capture sanitizes untrusted output', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const result = await service.capture({ uri: ref(), lines: 50 });
  assert.equal(result.text, 'hello\nred\nworld');
  assert.equal(result.truncated, false);
  assert.ok(!result.text.includes('\u001b'));
});

test('send validates text size, keys and requires payload', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  await assert.rejects(service.send({ uri: ref(), text: 'x'.repeat(20000) }), (error) => error.code === CODES.INVALID_ARGUMENT);
  await assert.rejects(service.send({ uri: ref(), keys: ['NotAKey'] }), (error) => error.code === CODES.INVALID_ARGUMENT);
  await assert.rejects(service.send({ uri: ref() }), (error) => error.code === CODES.INVALID_ARGUMENT);
});
