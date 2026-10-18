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
import { CODES } from '../../lib/core/errors.js';

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
function makeTransport() {
  const calls = [];
  const state = {
    inventory: () => [hostRecord(), paneRecord()],
    send: [],
    created: [],
  };
  return {
    calls,
    state,
    runRemote: async ({ script, mutating, alias }) => {
      calls.push({ script, mutating, alias });
      if (script.includes('list-panes')) return { records: state.inventory(), stderr: '', exitCode: 0 };
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

function makeService(transport) {
  const registry = memoryRegistry();
  const service = new TmuxXcService({
    config: CFG,
    registry,
    transport,
    now: () => 1234567890,
    logger: { warn() {} },
  });
  return { service, registry };
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
