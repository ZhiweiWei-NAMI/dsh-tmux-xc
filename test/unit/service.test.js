/**
 * Unit tests for TmuxXcService against a fake transport (canned records) and
 * the in-memory registry. No network, no tmux, no ssh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TmuxXcService, approvalPreview } from '../../lib/service.js';
import { memoryRegistry } from '../../lib/registry.js';
import { hostFingerprint } from '../../lib/core/parse.js';
import { encodeRef, decodeRef, formatToken, resourceKey } from '../../lib/core/uri.js';
import { XcError, CODES } from '../../lib/core/errors.js';

const CFG = {
  hosts: [{ id: 'namilab', label: 'NaMILab', ssh: 'NaMILab', sockets: [{ id: 'default' }] }],
  sshPath: '',
  sshConfigFile: '',
  connectTimeoutSec: 10,
  commandTimeoutMs: 20000,
  registryScope: 'user',
  approval: { enabled: true },
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
    detach: [['ok', '$3', 'detached', '0']],
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
      // A C5 send script also contains a read-only capture-pane probe, so it
      // must be classified by its send-keys action before the capture branch.
      if (script.includes('send-keys')) return { records: state.send, stderr: '', exitCode: 0 };
      if (script.includes('capture-pane')) {
        return {
          records: [['capture', Buffer.from('hello\n\u001b[31mred\u001b[0m\nworld', 'utf8').toString('hex')]],
          stderr: '',
          exitCode: 0,
        };
      }
      if (script.includes('detach-client')) return { records: state.detach, stderr: '', exitCode: 0 };
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
    assert.deepEqual(service.hosts(), [{ id: 'namilab', label: 'namilab', transport: transportMode ?? 'ssh', ...(transportMode === 'local' ? {} : { ssh: 'NaMILab' }), sockets: [{ id: 'default' }] }]);
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
      id: 'namilab', label: 'NaMILab', reachable: false, status: 'unreachable', verifiedAt: null, sockets: [],
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
    assert.equal(hosts[0].verifiedAt, null);
    assert.deepEqual(registryCalls.markUnreachable, []);
    assert.deepEqual(registryCalls.markVerified, []);
    assert.equal((await registry.resourceGet(adopted.key)).uri, adopted.uri);
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
    assert.equal((await registry.resourceGet(entry.key)).uri, entry.uri);
    assert.equal(transport.calls.filter((call) => call.mutating).length, 1);
  });
}

test('F4: service supplies valid zero-id guard targets for sole and multi-pane parents', async () => {
  const readable = (script) => {
    let previous;
    do {
      previous = script;
      script = script.replace(/\\([\\"$])/g, '$1').replaceAll("'\\''", "'");
    } while (script !== previous);
    return script;
  };
  for (const multi of [false, true]) {
    for (const kind of ['session', 'window', 'pane']) {
      const transport = makeTransport();
      transport.state.inventory = () => [hostRecord(), paneRecord({ sid: 0, wid: 0, pid: 0 }),
        ...(multi ? [paneRecord({ sid: 0, wid: 0, pid: 1, pindex: 1 })] : [])];
      transport.state.created = [['created', GEN, '$0', '@0', '%0', 'train', 'train']];
      transport.state.detach = [['ok', '$0', 'detached', '0']];
      const { service } = makeService(transport);
      const uri = ref({ kind, sid: 0, wid: kind === 'session' ? null : 0, pid: kind === 'pane' ? 0 : null });
      const target = { session: '$0', window: '@0', pane: '%0' }[kind];
      await service.detach({ uri });
      await service.kill({ uri, confirm: `namilab:default:${target}` });
      if (kind !== 'window') await service.create({
        hostId: 'namilab', kind: kind === 'session' ? 'window' : 'pane', parentUri: uri,
      });
      for (const { script } of transport.calls.filter((call) => call.mutating)) {
        const queue = readable(script).split('\n').find((line) => line.startsWith('out=$('));
        assert.ok(queue.includes(`if-shell -F -t "${target}"`));
        assert.ok(queue.includes('#{==:#{session_id},$0}'));
        assert.equal(queue.includes('#{==:#{window_id},@0}'), kind !== 'session' || !multi);
        assert.equal(queue.includes('#{==:#{pane_id},%0}'), kind === 'pane' || !multi);
        assert.equal(/undefined|null|NaN/.test(queue), false);
      }
    }
  }
});

for (const count of [0, 1, 3]) {
  test(`F5: detach reports ${count} confirmed client detaches without retrying`, async () => {
    const transport = makeTransport();
    transport.state.detach = [['guarded'], ...Array.from({ length: count }, () => ['progress']),
      ['ok', '$3', 'detached', String(count)]];
    const { service } = makeService(transport);
    assert.deepEqual(await service.detach({ uri: ref() }), {
      detached: count, target: 'NaMILab · 窗格 train:0.0 %7',
    });
    const mutations = transport.calls.filter((call) => call.mutating);
    assert.equal(mutations.length, 1);
    assert.ok(mutations[0].script.includes('list-clients'));
    assert.ok(mutations[0].script.includes('detach-client -t'));
    assert.equal(mutations[0].script.includes('detach-client -s'), false);
  });
}

for (const records of [
  [], [['guarded'], ['progress']], [['ok', '$3']],
  [['ok', '$4', 'detached', '1']], [['ok', '$3', 'detached', '-1']],
  [['ok', '$3', 'detached', '1.5']], [['ok', '$3', 'detached', '01']],
  [['ok', '$3', 'detached', '9007199254740992']], [['ok', '$3', 'detached']],
]) {
  test(`F5: detach rejects missing or invalid count ${JSON.stringify(records)}`, async () => {
    const transport = makeTransport();
    transport.state.detach = records;
    const { service } = makeService(transport);
    await assert.rejects(service.detach({ uri: ref() }), (error) => error.code === CODES.PROTOCOL);
    assert.equal(transport.calls.filter((call) => call.mutating).length, 1);
  });
}

test('F5: detach propagates generation/identity refusals without reporting success or replaying', async () => {
  for (const code of [CODES.SERVER_RESTARTED, CODES.TARGET_CHANGED, CODES.OUTCOME_UNKNOWN]) {
    const transport = makeTransport();
    transport.state.scriptError = new XcError(code, 'detach refused or incomplete');
    const { service } = makeService(transport);
    await assert.rejects(service.detach({ uri: ref() }), (error) => error.code === code);
    assert.equal(transport.calls.filter((call) => call.mutating).length, 1);
  }
});

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


test('approval pins the exact sole pane selected from a session', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const uri = ref({ kind: 'session', wid: null, pid: null });
  const { identity, en, zh } = await service.describeForApproval('tmux_xc_send', {
    ref: uri, text: 'line\n\t\x1b', enter: true, keys: ['C-c'],
  });
  assert.equal(identity.kind, 'pane');
  assert.equal(identity.pid, 7);
  assert.match(en, /Send input/);
  assert.match(en, /enter true/);
  assert.match(zh, /追加回车 是/);
  transport.state.inventory = () => [hostRecord(), paneRecord({ pid: 8 })];
  await assert.rejects(service.send({ uri, text: 'x', approvalIdentity: identity }), { code: 'TARGET_CHANGED' });
  assert.equal(transport.calls.some((call) => call.mutating), false);
});

test('approval pins ancestry for detach and create parents', async () => {
  for (const operation of ['detach', 'create']) {
    const transport = makeTransport();
    const { service } = makeService(transport);
    const args = operation === 'detach' ? { ref: ref() } : { hostId: 'namilab', kind: 'pane', parentRef: ref(), cwd: '/tmp' };
    const { identity } = await service.describeForApproval(`tmux_xc_${operation}`, args);
    transport.state.inventory = () => [hostRecord(), paneRecord({ sid: 4, wid: 6 })];
    await assert.rejects(operation === 'detach'
      ? service.detach({ uri: ref(), approvalIdentity: identity })
      : service.create({ ...args, parentUri: args.parentRef, by: { sessionId: 'a' }, approvalIdentity: identity }),
    { code: 'TARGET_CHANGED' });
    assert.equal(transport.calls.some((call) => call.mutating), false);
  }
});

test('kill approval refuses a relocated pane before any destructive script', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const { identity } = await service.describeForApproval('tmux_xc_kill', { ref: ref(), confirm: 'namilab:default:%7' });
  transport.state.inventory = () => [hostRecord(), paneRecord({ sid: 4 })];
  await assert.rejects(service.kill({ uri: ref(), confirm: 'namilab:default:%7', approvalIdentity: identity }), { code: 'TARGET_CHANGED' });
  assert.equal(transport.calls.some((call) => call.mutating), false);
});

for (const initialServer of [true, false]) {
  test(`session create approval refuses changed server (initial server: ${initialServer})`, async () => {
    const transport = makeTransport();
    if (!initialServer) transport.state.inventory = () => [hostRecord(), ['noserver']];
    const { service } = makeService(transport);
    const { identity } = await service.describeForApproval('tmux_xc_create', { hostId: 'namilab', kind: 'session', name: 'new' });
    transport.state.inventory = () => {
      const pane = paneRecord(); pane[1] = '9999-9999';
      return [hostRecord(), pane];
    };
    await assert.rejects(service.create({ hostId: 'namilab', kind: 'session', name: 'new', approvalIdentity: identity }), { code: 'TARGET_CHANGED' });
    assert.equal(transport.calls.some((call) => call.mutating), false);
  });
}

test('unchanged approved send guards the exact pane rather than its session', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const uri = ref({ kind: 'session', wid: null, pid: null });
  const { identity } = await service.describeForApproval('tmux_xc_send', { ref: uri, enter: true });
  await service.send({ uri, enter: true, approvalIdentity: identity });
  const call = transport.calls.find((call) => call.mutating);
  assert.match(call.script, /%7/);
  assert.match(call.script, /if-shell/);
});

test('create never substitutes the generation from its metadata reread', async () => {
  const transport = makeTransport();
  transport.state.created = [['created', GEN, '$3', '@5', '%7', 'train', 'train']];
  let inventories = 0;
  transport.state.inventory = () => {
    const pane = paneRecord();
    if (++inventories > 1) pane[1] = '9999-9999';
    return [hostRecord(), pane];
  };
  const { service, registry } = makeService(transport);
  await assert.rejects(service.create({ hostId: 'namilab', kind: 'session', name: 'train', by: { sessionId: 'a' } }), { code: 'SERVER_RESTARTED' });
  assert.deepEqual(await registry.resourceList({ all: true }), []);
});

test('URI adoption rejects a restarted generation without registering its reused id', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => {
    const pane = paneRecord(); pane[1] = '9999-9999';
    return [hostRecord(), pane];
  };
  const { service, registry } = makeService(transport);
  await assert.rejects(service.adopt({ target: ref(), by: { sessionId: 'a' } }), { code: 'SERVER_RESTARTED' });
  assert.deepEqual(await registry.resourceList({ all: true }), []);
});

test('inventory and adoption use one full canonical label and token', async () => {
  const { service } = makeService(makeTransport());
  const { hosts } = await service.inventory();
  const pane = hosts[0].sockets[0].sessions[0].windows[0].panes[0];
  const entry = await service.adopt({ target: pane.uri, by: { sessionId: 'a' } });
  assert.equal(entry.uri, pane.uri);
  assert.equal(entry.label, 'NaMILab · 窗格 train:0.0 %7');
  assert.equal(entry.token, formatToken(entry.label, entry.uri));
  assert.equal(entry.token, pane.token);
  assert.equal(entry.label, pane.label);
  assert.equal(decodeRef(entry.uri).gen, GEN);
});

test('approval preview exposes every control byte and exact truncation', () => {
  assert.equal(approvalPreview('a\n\t\x1b\x00\\"'), '"a\\n\\t\\x1b\\x00\\\\\\""');
  assert.equal(approvalPreview('中ab', 'en', 3), '"中" (+2 more bytes)');
  assert.equal(approvalPreview('中ab', 'zh', 3), '"中"（另有 2 字节）');
});

test('approval displays executable suffixes beyond the short preview budget', async () => {
  const { service } = makeService(makeTransport());
  const payload = 'x'.repeat(1500) + '\ncommand\t\x1b';
  const { en, zh } = await service.describeForApproval('tmux_xc_send', { ref: ref(), text: payload });
  for (const text of [en, zh]) assert.ok(text.includes('\\ncommand\\t\\x1b'));
});

test('create approval names the parent, effective cwd, operation, and current names', async () => {
  const { service } = makeService(makeTransport());
  const result = await service.describeForApproval('tmux_xc_create', { hostId: 'namilab', kind: 'pane', parentRef: ref(), cwd: '/tmp/#(literal)' });
  for (const text of [result.en, result.zh]) {
    assert.ok(text.includes('$3 @5 %7'));
    assert.ok(text.includes('train'));
    assert.ok(text.includes('/tmp/#(literal)'));
    assert.ok(text.includes('NaMILab'));
  }
  assert.match(result.zh, /创建窗格/);
  assert.doesNotMatch(result.zh, /parent|cwd|named|horizontal|true|false/);
});

test('configured default cwd is applied and hash-escaped, explicit cwd overrides', async () => {
  const host = { ...CFG.hosts[0], transport: 'ssh', newSession: { cwd: '/tmp/#(literal)' } };
  const transport = makeTransport(host);
  transport.state.created = [['created', GEN, '$3', '@5', '%7', 'train', 'train']];
  const { service } = makeService(transport, { config: { ...CFG, hosts: [host] } });
  await service.create({ hostId: 'namilab', kind: 'session', name: 'train', by: { sessionId: 'a' } });
  assert.ok(transport.calls.find((call) => call.mutating).script.includes('/tmp/##(literal)'));
  transport.calls.length = 0;
  await service.create({ hostId: 'namilab', kind: 'session', name: 'train', cwd: '/explicit', by: { sessionId: 'a' } });
  assert.ok(transport.calls.find((call) => call.mutating).script.includes('/explicit'));
});

test('all service values used as tool outputs contain no undefined properties', async () => {
  const transport = makeTransport();
  transport.state.created = [['created', GEN, '$3', '@5', '%7', 'train', 'train']];
  const { service } = makeService(transport);
  const values = [
    service.hosts(), await service.inventory(),
    await service.adopt({ target: ref() }),
    await service.create({ hostId: 'namilab', kind: 'session', name: 'train' }),
    await service.capture({ uri: ref() }), await service.send({ uri: ref(), enter: true }),
    await service.detach({ uri: ref() }), await service.kill({ uri: ref(), confirm: 'namilab:default:%7' }),
  ];
  const check = (value) => {
    assert.notEqual(value, undefined);
    if (value && typeof value === 'object') for (const child of Object.values(value)) check(child);
  };
  values.forEach(check);
});

test('hosts preserves configured attach selectors and omits ssh for local transport', () => {
  const config = { ...CFG, hosts: [
    { id: 'remote', label: 'Remote', ssh: 'RemoteAlias', sockets: [{ id: 'named', name: 'Lab.logs' }, { id: 'path', path: '/tmp/lab socket' }] },
    { id: 'local', transport: 'local', sockets: [{ id: 'default' }] },
  ] };
  const { service } = makeService(makeTransport(), { config });
  assert.deepEqual(service.hosts(), [
    { id: 'remote', label: 'Remote', transport: 'ssh', ssh: 'RemoteAlias', sockets: config.hosts[0].sockets },
    { id: 'local', label: 'local', transport: 'local', sockets: [{ id: 'default' }] },
  ]);
});

test('capture propagates remote byte truncation even when decoded output fits', async () => {
  const base = makeTransport();
  const transport = { async runRemote(args) {
    if (args.script.includes('capture-pane')) {
      assert.match(args.script, /65536/);
      return { records: [['capture', Buffer.from('newest').toString('hex'), '1']] };
    }
    return base.runRemote(args);
  } };
  const { service } = makeService(transport);
  assert.equal((await service.capture({ uri: ref() })).truncated, true);
});

test('close waits for registry continuations after the transport has finished', async () => {
  const registry = memoryRegistry();
  const original = registry.resourceUpsert.bind(registry);
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { started = resolve; });
  registry.resourceUpsert = async (entry) => { started(); await gate; return original(entry); };
  const { service } = makeService(makeTransport(), { registry });
  const adopting = service.adopt({ target: ref() });
  await ready;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await adopting;
  await closing;
  assert.equal((await registry.resourceList({ all: true })).length, 1);
});

test('long unsafe labels remain identical in inventory, adoption, and tokens', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => [hostRecord(), paneRecord({ sname: '[unsafe](label)`' + 'x'.repeat(150) })];
  const { service } = makeService(transport);
  const pane = (await service.inventory()).hosts[0].sockets[0].sessions[0].windows[0].panes[0];
  const entry = await service.adopt({ target: pane.uri });
  assert.equal(entry.label, pane.label);
  assert.equal(entry.token, pane.token);
  assert.ok(Array.from(entry.label).length <= 80);
  assert.doesNotMatch(entry.label, /[\[\]()`]/);
});

test('close aborts and settles complete in-flight operations before returning', async () => {
  let started, finish;
  const ready = new Promise((resolve) => { started = resolve; });
  const drained = new Promise((resolve) => { finish = resolve; });
  let aborted = false;
  const transport = { async runRemote({ signal }) {
    started();
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await drained;
    throw new XcError(CODES.CANCELLED, 'aborted');
  } };
  const { service } = makeService(transport);
  const operation = service.resolveRef(ref());
  const rejected = assert.rejects(operation, { code: 'CANCELLED' });
  await ready;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(aborted, true);
  assert.equal(closed, false);
  finish();
  await closing;
  await rejected;
  await assert.rejects(service.resolveRef(ref()), { code: 'CANCELLED' });
});

/** Records a successful text+Enter send, with an optional cursor row. */
function sendRecords({ cursorLine = null, enter = true } = {}) {
  const records = [['begin'], ['ok', '%7', '5', '3']];
  if (enter) records.push(['enter', '5']);
  if (cursorLine !== null) records.push(['cursor', Buffer.from(cursorLine).toString('hex'), '4']);
  records.push(['end']);
  return records;
}

test('C5: send returns delivered and submission after a cleared Enter', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  transport.state.send = sendRecords({ cursorLine: '~/project $ ' });
  const result = await service.send({ uri: ref(), text: 'echo hi', enter: true });
  assert.deepEqual(result.delivered, { text: true, keys: 0, enter: true });
  assert.equal(result.submission.checked, true);
  assert.equal(result.submission.state, 'cleared');
  assert.equal(result.bytes, 7);
});

test('C5: submission is pending while the sent text still occupies the cursor line', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  transport.state.send = sendRecords({ cursorLine: '> please run the tests now' });
  const result = await service.send({ uri: ref(), text: 'please run the tests now', enter: true });
  assert.equal(result.delivered.enter, true);
  assert.deepEqual(result.submission, { checked: true, state: 'pending' });
});

test('C5: submission only looks at the last 24 visible characters', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  const text = `${'x'.repeat(60)}TAIL_24_CHARS_1234567890123456`;
  transport.state.send = sendRecords({ cursorLine: 'pane output tail' });
  const result = await service.send({ uri: ref(), text, enter: true });
  assert.equal(result.submission.state, 'cleared', 'an old prefix does not make it pending');
  transport.state.send = sendRecords({ cursorLine: 'TAIL_24_CHARS_1234567890123456' });
  assert.equal((await service.send({ uri: ref(), text, enter: true })).submission.state, 'pending');
});

test('C5: a failed cursor capture reports unknown, never a false cleared', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  transport.state.send = sendRecords({ cursorLine: null });
  const result = await service.send({ uri: ref(), text: 'hello', enter: true });
  assert.equal(result.delivered.enter, true);
  assert.equal(result.submission.state, 'unknown');
});

test('C5: no Enter requested means no submission check and enter false', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  transport.state.send = [['ok', '%7', '2', '1']];
  const result = await service.send({ uri: ref(), text: 'hi' });
  assert.deepEqual(result.delivered, { text: true, keys: 0, enter: false });
  assert.equal(result.submission.checked, false);
  assert.equal(result.submission.state, 'unknown');
});

test('C5: a failed Enter guard reports delivered text and the guard code', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  transport.state.send = [['ok', '%7', '5', '3'], ['enterfail', 'TARGET_CHANGED', '']];
  let error;
  await assert.rejects(
    service.send({ uri: ref(), text: 'hello', enter: true }),
    (err) => { error = err; return err.code === CODES.TARGET_CHANGED; },
  );
  assert.deepEqual(error.details.delivered, { text: true, keys: 0, enter: false });
  assert.equal(error.details.enterFailure, 'TARGET_CHANGED');
  assert.match(error.message, /text delivered but Enter was not delivered/);
  assert.equal(transport.calls.filter((call) => call.mutating).length, 1, 'never replayed');
});

test('C5: enter-only guard failures still report the precise code and no text', async () => {
  const transport = makeTransport();
  const { service } = makeService(transport);
  transport.state.send = [['enterfail', 'PANE_DEAD', '']];
  let error;
  await assert.rejects(
    service.send({ uri: ref(), enter: true }),
    (err) => { error = err; return err.code === CODES.PANE_DEAD; },
  );
  assert.deepEqual(error.details.delivered, { text: false, keys: 0, enter: false });
});

test('C5: send.enterDelayMs defaults to 400 and is clamped to [0, 5000]', async () => {
  for (const [value, expected] of [
    [undefined, 'sleep 0.400 2>/dev/null || sleep 1'],
    [0, null],
    [1500, 'sleep 1.500 2>/dev/null || sleep 2'],
    [-20, null],
    [99999, 'sleep 5.000 2>/dev/null || sleep 5'],
    ['bogus', null],
  ]) {
    const transport = makeTransport();
    const config = value === undefined ? CFG : { ...CFG, send: { enterDelayMs: value } };
    const { service } = makeService(transport, { config });
    transport.state.send = sendRecords({ cursorLine: '$ ' });
    await service.send({ uri: ref(), text: 'x', enter: true });
    const mutating = transport.calls.filter((call) => call.mutating);
    assert.equal(mutating.length, 1);
    const script = mutating[0].script;
    if (expected === null) {
      // Only the post-Enter settling wait remains; there is no inter-step pause.
      assert.equal(script.includes('sleep 0.400'), false, `delay ${value}`);
      assert.equal(script.includes('sleep 1.500'), false, `delay ${value}`);
      assert.equal(script.includes('sleep 5.000'), false, `delay ${value}`);
    } else {
      assert.ok(script.includes(expected), `delay ${value}: ${expected}`);
      // The delay sits between the text queue and the Enter queue.
      assert.ok(script.indexOf(expected) > script.indexOf('send-keys -t \"%7\" -H'));
      assert.ok(script.indexOf(expected) < script.indexOf('Enter ; display-message'));
    }
    // The settling wait before the cursor read is always present.
    assert.ok(script.includes('sleep 0.300 2>/dev/null || sleep 1'));
  }
});

test('removed hosts are filtered from hosts/inventory and refuse every operation', async () => {
  const transport = makeTransport();
  const { service, registry } = makeService(transport);
  await service.adopt({ target: ref(), by: { sessionId: 'a' } });

  await service.removeHost({ host: 'namilab', mode: 'local', confirm: 'namilab' });

  assert.deepEqual(service.hosts(), []);
  assert.deepEqual((await service.inventory()).hosts, []);
  await assert.rejects(service.resolveRef(ref()), (error) =>
    error.code === CODES.HOST_NOT_ALLOWED && /removed in the tmux panel/.test(error.message));
  await assert.rejects(service.capture({ uri: ref() }), (error) => error.code === CODES.HOST_NOT_ALLOWED);
  assert.deepEqual(registry.removedHosts(), ['namilab']);
});

test('inventory decorates config alias hints and a local alias wins for its exact key', async () => {
  const host = {
    id: 'namilab', label: 'NaMILab', ssh: 'NaMILab', sockets: [{ id: 'default' }],
    aliases: [
      { session: 'train', alias: '训练会话' },
      { session: 'train', window: 'train', alias: '训练窗口' },
    ],
  };
  const transport = makeTransport({ ...host, transport: 'ssh', newSession: {} });
  const { service, registry } = makeService(transport, { config: { ...CFG, hosts: [host] } });
  const adopted = await service.adopt({ target: ref(), by: { sessionId: 'a' } });
  await registry.setAlias(adopted.key, '本地窗格');

  const { hosts } = await service.inventory();
  const session = hosts[0].sockets[0].sessions[0];
  assert.equal(session.alias, '训练会话');
  assert.equal(session.aliasSource, 'config');
  const window = session.windows[0];
  assert.equal(window.alias, '训练窗口');
  assert.equal(window.aliasSource, 'config');
  const pane = window.panes[0];
  assert.equal(pane.alias, '本地窗格');
  assert.equal(pane.aliasSource, 'local');
});

test('service.alias adopts a not-yet-registered uri before setting its alias', async () => {
  const transport = makeTransport();
  const { service, registry } = makeService(transport);
  const result = await service.alias({ uri: ref(), alias: '编辑器', signal: undefined });
  assert.equal(result.alias, '编辑器');
  assert.equal(result.entry.uri, ref());
  assert.equal(typeof result.entry.token, 'string');
  const key = resourceKey(decodeRef(ref()));
  const stored = await registry.resourceGet(key);
  assert.equal(stored.kind, 'pane');
  assert.deepEqual((await registry.aliasList()).map((item) => item.key), [key]);
});

test('host/remove remote kills every session and removes locally when all succeed', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => [hostRecord(), paneRecord({ sid: 3, pid: 7 }), paneRecord({ sid: 4, pid: 8 })];
  const { service, registry } = makeService(transport);
  const uri3 = ref({ kind: 'session', sid: 3, wid: null, pid: null });
  const uri4 = ref({ kind: 'session', sid: 4, wid: null, pid: null });

  const result = await service.removeHost({ host: 'namilab', mode: 'remote', killUris: [uri3, uri4], confirm: 'namilab' });
  assert.equal(result.removed, true);
  assert.deepEqual(result.remote.map((item) => item.ok), [true, true]);
  assert.ok(result.remote.every((item) => typeof item.label === 'string'));
  assert.deepEqual(registry.removedHosts(), ['namilab']);
  assert.equal((await registry.resourceList({ all: true })).length, 0);
});

test('host/remove remote reports an honest per-uri result and stays unremoved on one failure', async () => {
  const transport = makeTransport();
  transport.state.inventory = () => [hostRecord(), paneRecord({ sid: 3, pid: 7 }), paneRecord({ sid: 4, pid: 8 })];
  const { service, registry } = makeService(transport);
  const uri3 = ref({ kind: 'session', sid: 3, wid: null, pid: null });
  const uriGone = ref({ kind: 'session', sid: 99, wid: null, pid: null });

  const result = await service.removeHost({ host: 'namilab', mode: 'remote', killUris: [uri3, uriGone], confirm: 'namilab' });
  assert.equal(result.removed, false);
  assert.equal(result.remote.length, 2);
  assert.equal(result.remote[0].ok, true);
  assert.equal(result.remote[1].ok, false);
  assert.equal(result.remote[1].code, CODES.TARGET_GONE);
  assert.equal(Object.hasOwn(result.remote[1], 'label'), false);
  assert.deepEqual(registry.removedHosts(), []);
  assert.equal((await registry.resourceList({ all: true })).length, 0, 'no local purge on a failed remote removal');
});
