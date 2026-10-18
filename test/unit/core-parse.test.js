import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { XcError, CODES } from '../../lib/core/errors.js';
import {
  parseHostRecord,
  hostFingerprint,
  parseInventory,
  parseCreated,
} from '../../lib/core/parse.js';

const GEN = '2893481-1792293185';
const SOCKET = '/tmp/tmux-1000/default';

function paneRecord(overrides = {}) {
  const values = {
    gen: GEN,
    socketPath: SOCKET,
    sid: '$0',
    sessionName: 'train',
    created: '1792293000',
    attached: '1',
    wid: '@0',
    windowIndex: '0',
    windowName: 'shell',
    windowActive: '1',
    pid: '%0',
    paneIndex: '0',
    paneActive: '1',
    cmd: 'bash',
    cwd: '/home/user',
    dead: '0',
    width: '200',
    height: '50',
    title: 'user@host: ~',
  };
  const merged = { ...values, ...overrides };
  if (merged.raw) return merged.raw;
  return [
    'pane',
    merged.gen,
    merged.socketPath,
    merged.sid,
    merged.sessionName,
    merged.created,
    merged.attached,
    merged.wid,
    merged.windowIndex,
    merged.windowName,
    merged.windowActive,
    merged.pid,
    merged.paneIndex,
    merged.paneActive,
    merged.cmd,
    merged.cwd,
    merged.dead,
    merged.width,
    merged.height,
    merged.title,
  ];
}

function hostRecord(machine = 'machine-id', uid = '1000', user = 'alice') {
  return ['host', machine, uid, user];
}

function inventory(panes, extra = []) {
  return [['begin'], hostRecord(), ...extra, ...panes, ['end']];
}

function expectProtocolError(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof XcError);
    assert.equal(error.code, CODES.PROTOCOL);
    return true;
  });
}

test('parseHostRecord accepts a well-formed host record', () => {
  assert.deepEqual(parseHostRecord(['host', 'mid', '1000', 'alice']), {
    machine: 'mid',
    uid: '1000',
    user: 'alice',
  });
});

test('parseHostRecord rejects malformed or truncated records', () => {
  expectProtocolError(() => parseHostRecord(['host']));
  expectProtocolError(() => parseHostRecord(['host', 'mid', '1000']));
  expectProtocolError(() => parseHostRecord(['pane', 'mid', '1000', 'alice']));
  expectProtocolError(() => parseHostRecord(['host', '', '1000', 'alice']));
  expectProtocolError(() => parseHostRecord([]));
  expectProtocolError(() => parseHostRecord(null));
});

test('hostFingerprint is the first 12 hex of sha256(machine + newline + uid)', () => {
  const expected = createHash('sha256').update('machine-id\n1000').digest('hex').slice(0, 12);
  assert.equal(hostFingerprint('machine-id', '1000'), expected);
  assert.match(hostFingerprint('machine-id', '1000'), /^[0-9a-f]{12}$/);
  assert.notEqual(hostFingerprint('machine-id', '1000'), hostFingerprint('machine-id', '1001'));
  assert.notEqual(hostFingerprint('machine-id', '1000'), hostFingerprint('machine-id2', '1000'));
  // The separator is unambiguous: a newline in `machine` or `uid` still hashes
  // differently from a different split of the same bytes.
  assert.notEqual(hostFingerprint('a', 'b'), hostFingerprint('a\nb', ''));
  assert.equal(hostFingerprint('', ''), createHash('sha256').update('\n').digest('hex').slice(0, 12));
  assert.throws(() => hostFingerprint(null, '1'), { code: CODES.INVALID_ARGUMENT });
});

test('parseInventory builds session→window→pane with fresh sanitized labels', () => {
  const inv = parseInventory(inventory([paneRecord()]));
  assert.equal(inv.host.fp, hostFingerprint('machine-id', '1000'));
  assert.equal(inv.host.uid, '1000');
  assert.equal(inv.host.user, 'alice');
  assert.deepEqual(inv.server, { gen: GEN, socketPath: SOCKET });
  assert.equal(inv.malformed, 0);
  assert.equal(inv.sessions.length, 1);
  const session = inv.sessions[0];
  assert.equal(session.sid, 0);
  assert.equal(session.name, 'train');
  assert.equal(session.created, 1792293000);
  assert.equal(session.attached, 1);
  assert.equal(session.windows.length, 1);
  const win = session.windows[0];
  assert.equal(win.wid, 0);
  assert.equal(win.index, 0);
  assert.equal(win.name, 'shell');
  assert.equal(win.active, true);
  assert.equal(win.panes.length, 1);
  assert.deepEqual(win.panes[0], {
    pid: 0,
    index: 0,
    active: true,
    cmd: 'bash',
    cwd: '/home/user',
    dead: false,
    width: 200,
    height: 50,
    title: 'user@host: ~',
  });
});

test('parseInventory sorts sessions by sid, windows by index, panes by index', () => {
  const inv = parseInventory(
    inventory([
      paneRecord({ sid: '$10', wid: '@12', windowIndex: '2', pid: '%30', paneIndex: '1' }),
      paneRecord({ sid: '$2', wid: '@5', windowIndex: '1', pid: '%7', paneIndex: '0' }),
      paneRecord({ sid: '$2', wid: '@1', windowIndex: '0', pid: '%3', paneIndex: '1' }),
      paneRecord({ sid: '$2', wid: '@1', windowIndex: '0', pid: '%1', paneIndex: '0' }),
      paneRecord({ sid: '$10', wid: '@12', windowIndex: '2', pid: '%20', paneIndex: '0' }),
    ]),
  );
  assert.deepEqual(inv.sessions.map((s) => s.sid), [2, 10]);
  assert.deepEqual(inv.sessions[0].windows.map((w) => w.wid), [1, 5]);
  assert.deepEqual(inv.sessions[0].windows[0].panes.map((p) => p.pid), [1, 3]);
  assert.deepEqual(inv.sessions[1].windows[0].panes.map((p) => p.pid), [20, 30]);
});

test('parseInventory groups panes of the same window under one window node', () => {
  const inv = parseInventory(
    inventory([
      paneRecord({ pid: '%0', paneIndex: '0' }),
      paneRecord({ pid: '%1', paneIndex: '1' }),
      paneRecord({ wid: '@1', pid: '%2', paneIndex: '0', windowIndex: '1', windowName: 'logs' }),
    ]),
  );
  assert.equal(inv.sessions.length, 1);
  assert.equal(inv.sessions[0].windows.length, 2);
  assert.equal(inv.sessions[0].windows[0].panes.length, 2);
  assert.equal(inv.sessions[0].windows[1].name, 'logs');
});

test('parseInventory sanitizes names, commands, cwd and titles', () => {
  const inv = parseInventory(
    inventory([
      paneRecord({
        sessionName: 'tra\u202Ein\x1b[31m',
        windowName: 'sh\u200Bell\u001b]0;x\u0007',
        cmd: 'ba\u009bsh',
        cwd: '/tmp/\u202Ea',
        title: 'ti\ntle',
      }),
    ]),
  );
  const session = inv.sessions[0];
  assert.equal(session.name, 'train');
  assert.equal(session.windows[0].name, 'shell');
  assert.equal(session.windows[0].panes[0].cmd, 'bash');
  assert.equal(session.windows[0].panes[0].cwd, '/tmp/a');
  assert.equal(session.windows[0].panes[0].title, 'ti tle');
});

test('parseInventory counts malformed records and skips them (never defaults to 0)', () => {
  const cases = [
    paneRecord({ raw: ['pane'] }),
    paneRecord({ raw: [...paneRecord(), 'extra'] }),
    paneRecord({ sid: 'not-a-number' }),
    paneRecord({ sid: '' }),
    paneRecord({ sid: '0' }), // tmux always emits $N
    paneRecord({ wid: '@x' }),
    paneRecord({ sid: '@1' }),
    paneRecord({ wid: '$1' }),
    paneRecord({ pid: '@1' }),
    paneRecord({ pid: '%' }),
    paneRecord({ gen: 'not-a-gen' }),
    paneRecord({ gen: '1-2-3' }),
    paneRecord({ created: '-1' }),
    paneRecord({ created: '1.5' }),
    paneRecord({ windowIndex: '' }),
    paneRecord({ windowIndex: 'abc' }),
    paneRecord({ width: '' }),
    paneRecord({ height: 'x' }),
    paneRecord({ socketPath: '' }),
    paneRecord({ raw: ['pane', GEN] }),
  ];
  for (const bad of cases) {
    const inv = parseInventory(inventory([bad]));
    assert.equal(inv.malformed, 1, JSON.stringify(bad));
    assert.equal(inv.sessions.length, 0);
    assert.equal(inv.server, null);
  }
});

test('parseInventory ignores unknown record types but counts them as malformed', () => {
  const inv = parseInventory(inventory([paneRecord()], [['weird', 'x']]));
  assert.equal(inv.malformed, 1);
  assert.equal(inv.sessions.length, 1);
});

test('parseInventory drops panes from another server generation and counts them', () => {
  const inv = parseInventory(
    inventory([paneRecord(), paneRecord({ gen: '999-1', pid: '%9' })]),
  );
  assert.equal(inv.malformed, 1);
  assert.equal(inv.sessions.length, 1);
  assert.equal(inv.sessions[0].windows[0].panes.length, 1);
  assert.equal(inv.server.gen, GEN);
});

test('parseInventory with no panes and noserver reports a null server', () => {
  const inv = parseInventory([['begin'], hostRecord(), ['noserver'], ['end']]);
  assert.equal(inv.server, null);
  assert.deepEqual(inv.sessions, []);
  assert.equal(inv.malformed, 0);
});

test('parseInventory with no panes and no noserver reports an empty live server', () => {
  // An empty inventory (server running, no sessions) has no pane records, so
  // the generation is unknown; this is not an error.
  const inv = parseInventory([['begin'], hostRecord(), ['end']]);
  assert.equal(inv.server, null);
  assert.deepEqual(inv.sessions, []);
  assert.equal(inv.malformed, 0);
});

test('parseInventory tolerates banners/begin/end mixed into the record list', () => {
  const inv = parseInventory([
    ['begin'],
    ['banner', 'Welcome to the machine'],
    hostRecord(),
    paneRecord(),
    ['end'],
  ]);
  assert.equal(inv.malformed, 1);
  assert.equal(inv.sessions.length, 1);
});

test('parseInventory requires a host record', () => {
  expectProtocolError(() => parseInventory([['begin'], paneRecord(), ['end']]));
  expectProtocolError(() => parseInventory([['begin'], ['end']]));
  expectProtocolError(() => parseInventory([['host', 'only-two', '1']]));
});

test('parseInventory rejects a non-array input', () => {
  assert.throws(() => parseInventory(null), { code: CODES.INVALID_ARGUMENT });
  assert.throws(() => parseInventory({}), { code: CODES.INVALID_ARGUMENT });
});

test('parseInventory never mutates its input records', () => {
  const records = inventory([paneRecord()]);
  const snapshot = JSON.stringify(records);
  parseInventory(records);
  assert.equal(JSON.stringify(records), snapshot);
});

test('parseInventory rejects records whose tmux flags are not 0/1', () => {
  const flags = [
    { attached: 'yes' },
    { attached: '-1' },
    { windowActive: 'x' },
    { paneActive: 'true' },
    { dead: '1 ' },
  ];
  for (const override of flags) {
    const inv = parseInventory(inventory([paneRecord(override)]));
    assert.equal(inv.malformed, 1, JSON.stringify(override));
    assert.equal(inv.sessions.length, 0);
  }
});

test('parseInventory keeps session attached as a client count', () => {
  const inv = parseInventory(inventory([paneRecord({ attached: '3' })]));
  assert.equal(inv.sessions[0].attached, 3);
  const detached = parseInventory(inventory([paneRecord({ attached: '0' })]));
  assert.equal(detached.sessions[0].attached, 0);
});

test('parseInventory handles hostile values without forging records', () => {
  const hostile = 'x\u001f0\u001f/tmp\u001f$1';
  const inv = parseInventory(inventory([paneRecord({ title: hostile, windowName: hostile })]));
  assert.equal(inv.malformed, 0);
  // The sanitizer drops C0 controls (including lone \x1f) but the hostile
  // text never forges extra nodes.
  assert.equal(inv.malformed, 0);
  assert.equal(inv.sessions.length, 1);
  assert.equal(inv.sessions[0].windows.length, 1);
  assert.equal(inv.sessions[0].windows[0].panes.length, 1);
});

test('parseCreated parses the created record', () => {
  assert.deepEqual(
    parseCreated([
      ['begin'],
      ['created', GEN, '$4', '@9', '%12', 'train', 'logs'],
      ['end'],
    ]),
    {
      gen: GEN,
      sid: 4,
      wid: 9,
      pid: 12,
      sessionName: 'train',
      windowName: 'logs',
    },
  );
});

test('parseCreated sanitizes names', () => {
  const created = parseCreated([
    ['created', GEN, '$4', '@9', '%12', 'tr\u202Eain', 'lo\u200Bgs'],
  ]);
  assert.equal(created.sessionName, 'train');
  assert.equal(created.windowName, 'logs');
});

test('parseCreated rejects missing or malformed records', () => {
  expectProtocolError(() => parseCreated([['begin'], ['end']]));
  expectProtocolError(() => parseCreated([]));
  assert.throws(() => parseCreated(null), { code: CODES.INVALID_ARGUMENT });
  for (const rec of [
    ['created'],
    ['created', GEN, '$4', '@9', '%12'],
    ['created', GEN, '$4', '@9', '%12', 'name'],
    ['created', 'bad-gen', '$4', '@9', '%12', 'a', 'b'],
    ['created', GEN, '4', '@9', '%12', 'a', 'b'],
    ['created', GEN, '$4', '9', '%12', 'a', 'b'],
    ['created', GEN, '$4', '@9', '12', 'a', 'b'],
    ['created', GEN, '$4', '@9', '%12', '', 'b'],
  ]) {
    expectProtocolError(() => parseCreated([rec]));
  }
});

test('parseCreated takes the first created record', () => {
  const created = parseCreated([
    ['created', GEN, '$4', '@9', '%12', 'first', 'w1'],
    ['created', '1-2', '$5', '@10', '%13', 'second', 'w2'],
  ]);
  assert.equal(created.sessionName, 'first');
});
