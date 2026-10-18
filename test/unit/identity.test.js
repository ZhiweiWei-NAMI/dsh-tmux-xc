import test from 'node:test';
import assert from 'node:assert/strict';
import { assertResolved, labelFor, refFromInventory, resolve } from '../../lib/core/identity.js';

const FP = '3fa9c2e81b0d';
const GEN = '2893481-1792293185';

function pane(pid, index, extra = {}) {
  return {
    pid, index, active: index === 0, cmd: 'bash', cwd: '/home/u', dead: false, width: 200, height: 50,
    title: `pane ${pid}`, ...extra,
  };
}

function window(wid, index, name, panes) {
  return { wid, index, name, active: index === 0, panes };
}

function session(sid, name, windows, extra = {}) {
  return { sid, name, created: 1, attached: 1, windows, ...extra };
}

function inventory(overrides = {}) {
  return {
    host: { fp: FP, uid: '1000', user: 'u' },
    server: { gen: GEN, socketPath: '/tmp/tmux-1000/default' },
    sessions: [
      session(3, 'train', [window(5, 0, 'shell', [pane(8, 0), pane(7, 1)])]),
      session(4, 'logs', [window(9, 0, 'tail', [pane(12, 0)])]),
    ],
    malformed: 0,
    ...overrides,
  };
}

const paneRef = { hostId: 'namilab', hostFp: FP, socketId: 'default', gen: GEN, kind: 'pane', sid: 3, wid: 5, pid: 7 };

test('OK: pane with unchanged ancestry', () => {
  const result = resolve(paneRef, inventory());
  assert.equal(result.code, 'OK');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.target.kind, 'pane');
  assert.equal(result.target.sid, 3);
  assert.equal(result.target.wid, 5);
  assert.equal(result.target.pid, 7);
  assert.equal(result.target.session.name, 'train');
  assert.equal(result.target.window.name, 'shell');
  assert.equal(result.target.pane.cmd, 'bash');
});

test('OK: rename does not change resolution', () => {
  const inv = inventory({
    sessions: [session(3, 'renamed', [window(5, 0, 'renamed-window', [pane(7, 0), pane(8, 1)])])],
  });
  const result = resolve(paneRef, inv);
  assert.equal(result.code, 'OK');
  assert.equal(result.target.session.name, 'renamed');
  assert.equal(result.target.window.name, 'renamed-window');
});

test('HOST_IDENTITY_CHANGED wins over every other mismatch', () => {
  const result = resolve({ ...paneRef, hostFp: '000000000000' }, inventory({ server: null }));
  assert.equal(result.code, 'HOST_IDENTITY_CHANGED');
});

test('SERVER_GONE when there is no tmux server', () => {
  const result = resolve(paneRef, inventory({ server: null, sessions: [] }));
  assert.equal(result.code, 'SERVER_GONE');
});

test('SERVER_RESTARTED when the generation differs (kill + recreate same name too)', () => {
  const result = resolve(paneRef, inventory({ server: { gen: '999-1', socketPath: '/tmp/x' } }));
  assert.equal(result.code, 'SERVER_RESTARTED');
  assert.match(result.message, /restarted/);
});

test('TARGET_GONE: pane id absent while the server gen matches', () => {
  const inv = inventory({ sessions: [session(3, 'train', [window(5, 0, 'shell', [pane(8, 1)])])] });
  assert.equal(resolve(paneRef, inv).code, 'TARGET_GONE');
});

test('TARGET_GONE: kill + recreate with the same name is never a redirect', () => {
  const inv = inventory({
    sessions: [session(6, 'train', [window(10, 0, 'shell', [pane(13, 0)])])],
  });
  assert.equal(resolve(paneRef, inv).code, 'TARGET_GONE');
});

test('OK_RELOCATED: pane moved to another window in the same session', () => {
  const inv = inventory({
    sessions: [session(3, 'train', [window(11, 1, 'new', [pane(7, 0)]), window(5, 0, 'shell', [pane(8, 1)])])],
  });
  const result = resolve(paneRef, inv);
  assert.equal(result.code, 'OK_RELOCATED');
  assert.equal(result.target.wid, 11);
  assert.equal(result.target.sid, 3);
  assert.ok(result.warnings.length >= 1);
});

test('OK_RELOCATED: pane moved to another session within the same gen', () => {
  const inv = inventory({
    sessions: [
      session(3, 'train', [window(5, 0, 'shell', [pane(8, 1)])]),
      session(4, 'other', [window(12, 0, 'shell', [pane(7, 0)])]),
    ],
  });
  const result = resolve(paneRef, inv);
  assert.equal(result.code, 'OK_RELOCATED');
  assert.equal(result.target.sid, 4);
  assert.equal(result.target.wid, 12);
  assert.equal(result.target.pane.pid, 7);
});

test('OK_RELOCATED: pane whose window is unchanged but whose session link moved', () => {
  const inv = inventory({
    sessions: [
      session(3, 'train', [window(5, 0, 'shell', [pane(8, 1)])]),
      session(4, 'logs', [window(5, 0, 'shell', [pane(8, 0), pane(7, 1)]), window(9, 0, 'tail', [pane(12, 0)])]),
    ],
  });
  const result = resolve(paneRef, inv);
  assert.equal(result.code, 'OK_RELOCATED');
  assert.equal(result.target.sid, 4);
  assert.equal(result.target.wid, 5);
});

test('linked window: pane resolution picks the referenced ancestry and warns', () => {
  const shared = window(5, 0, 'shell', [pane(7, 0)]);
  const inv = inventory({
    sessions: [session(3, 'train', [shared]), session(4, 'mirror', [shared])],
  });
  const result = resolve(paneRef, inv);
  assert.equal(result.code, 'OK');
  assert.equal(result.target.sid, 3);
  assert.ok(result.warnings.some((w) => w.includes('linked')));
});

test('window OK, window relocated to exactly one other session, and linked ambiguity', () => {
  const windowRef = { ...paneRef, kind: 'window', pid: null };
  assert.equal(resolve(windowRef, inventory()).code, 'OK');

  const moved = inventory({
    sessions: [session(3, 'train', []), session(4, 'logs', [window(5, 0, 'shell', [pane(7, 0)])])],
  });
  const relocated = resolve(windowRef, moved);
  assert.equal(relocated.code, 'OK_RELOCATED');
  assert.equal(relocated.target.sid, 4);

  const linked = inventory({
    sessions: [
      session(3, 'train', [window(11, 0, 'shell', [pane(7, 0)])]),
      session(4, 'mirror', [window(5, 0, 'shell', [pane(7, 0)])]),
      session(6, 'third', [window(5, 0, 'shell', [pane(7, 0)])]),
    ],
  });
  assert.equal(resolve(windowRef, linked).code, 'AMBIGUOUS');
});

test('window TARGET_GONE when the window id is absent', () => {
  const windowRef = { ...paneRef, kind: 'window', pid: null };
  assert.equal(resolve(windowRef, inventory()).code, 'OK');
  const inv = inventory({ sessions: [session(3, 'train', [window(10, 0, 'shell', [pane(7, 0)])])] });
  assert.equal(resolve(windowRef, inv).code, 'TARGET_GONE');
});

test('linked window present in the referenced session is OK even when linked', () => {
  const windowRef = { ...paneRef, kind: 'window', pid: null };
  const shared = window(5, 0, 'shell', [pane(7, 0)]);
  const inv = inventory({ sessions: [session(3, 'train', [shared]), session(4, 'mirror', [shared])] });
  const result = resolve(windowRef, inv);
  assert.equal(result.code, 'OK');
  assert.equal(result.target.sid, 3);
  assert.ok(result.warnings.length >= 1);
});

test('session OK with fresh target; TARGET_GONE when missing', () => {
  const sessionRef = { ...paneRef, kind: 'session', wid: null, pid: null };
  const ok = resolve(sessionRef, inventory());
  assert.equal(ok.code, 'OK');
  assert.equal(ok.target.session.name, 'train');
  const missing = resolve(sessionRef, inventory({ sessions: [] }));
  assert.equal(missing.code, 'TARGET_GONE');
});

test('requirePane: session/window spanning several panes is AMBIGUOUS', () => {
  const sessionRef = { ...paneRef, kind: 'session', wid: null, pid: null };
  const windowRef = { ...paneRef, kind: 'window', pid: null };
  assert.equal(resolve(sessionRef, inventory(), { requirePane: true }).code, 'AMBIGUOUS');
  assert.equal(resolve(windowRef, inventory(), { requirePane: true }).code, 'AMBIGUOUS');
  // Without requirePane the same refs are fine.
  assert.equal(resolve(sessionRef, inventory()).code, 'OK');
  assert.equal(resolve(windowRef, inventory()).code, 'OK');
});

test('requirePane: a single-pane session/window resolves and carries that pane', () => {
  const sessionRef = { ...paneRef, kind: 'session', wid: null, pid: null };
  const windowRef = { ...paneRef, kind: 'window', pid: null };
  const inv = inventory({ sessions: [session(3, 'solo', [window(5, 0, 'only', [pane(7, 0)])])] });
  const s = resolve(sessionRef, inv, { requirePane: true });
  assert.equal(s.code, 'OK');
  assert.equal(s.target.pid, 7);
  assert.equal(s.target.wid, 5);
  const w = resolve(windowRef, inv, { requirePane: true });
  assert.equal(w.code, 'OK');
  assert.equal(w.target.pid, 7);
});

test('server and host kinds ignore ids and check gen / fp', () => {
  const serverRef = { ...paneRef, kind: 'server', sid: null, wid: null, pid: null };
  assert.equal(resolve(serverRef, inventory()).code, 'OK');
  assert.equal(resolve(serverRef, inventory({ server: { gen: '1-2', socketPath: '/x' } })).code, 'SERVER_RESTARTED');

  const hostRef = { ...paneRef, kind: 'host', sid: null, wid: null, pid: null };
  assert.equal(resolve(hostRef, inventory()).code, 'OK');
  assert.equal(resolve(hostRef, inventory()).code, 'OK');
});

test('resolve validates its arguments', () => {
  assert.throws(() => resolve(null, inventory()), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resolve(paneRef, null), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => resolve({ ...paneRef, kind: 'weird' }, inventory()), { code: 'INVALID_ARGUMENT' });
});

test('assertResolved throws XcError for failures and returns the target otherwise', () => {
  const ok = resolve(paneRef, inventory());
  assert.equal(assertResolved(ok), ok.target);
  const moved = resolve(paneRef, inventory({
    sessions: [session(3, 'train', [window(5, 0, 'shell', [pane(8, 1)])]), session(4, 'x', [window(9, 0, 'y', [pane(7, 0)])])],
  }));
  assert.equal(moved.code, 'OK_RELOCATED');
  assert.equal(assertResolved(moved).sid, 4);
  assert.throws(() => assertResolved(resolve(paneRef, inventory({ server: null }))), { code: 'SERVER_GONE' });
});

test('refFromInventory builds refs for every kind and throws NOT_FOUND', () => {
  const inv = inventory();
  assert.deepEqual(refFromInventory('namilab', 'default', inv, 'pane', 7), paneRef);
  assert.deepEqual(refFromInventory('namilab', 'default', inv, 'session', 3), {
    ...paneRef, kind: 'session', wid: null, pid: null,
  });
  assert.deepEqual(refFromInventory('namilab', 'default', inv, 'window', 9), {
    ...paneRef, kind: 'window', sid: 4, wid: 9, pid: null,
  });
  assert.equal(refFromInventory('namilab', 'default', inv, 'server', null).kind, 'server');
  assert.equal(refFromInventory('namilab', 'default', inv, 'host', null).kind, 'host');
  assert.throws(() => refFromInventory('namilab', 'default', inv, 'pane', 99), { code: 'NOT_FOUND' });
  assert.throws(() => refFromInventory('namilab', 'default', inv, 'session', 99), { code: 'NOT_FOUND' });
  assert.throws(() => refFromInventory('namilab', 'default', inv, 'window', 99), { code: 'NOT_FOUND' });
  assert.throws(() => refFromInventory('namilab', 'default', inv, 'weird', 1), { code: 'INVALID_ARGUMENT' });
});

test('labelFor renders the documented shape', () => {
  const target = resolve(paneRef, inventory()).target;
  assert.equal(labelFor('NaMILab', target), 'NaMILab · train:0.1 %7');
  assert.equal(target.window.index, 0);
  assert.equal(target.pane.index, 1);
  assert.equal(labelFor('NaMILab', { kind: 'session', sid: 3, session: { name: 'train' } }), 'NaMILab · train $3');
  assert.equal(labelFor('NaMILab', { kind: 'server', gen: GEN }), `NaMILab · server ${GEN}`);
  assert.equal(labelFor('NaMILab', { kind: 'host' }), 'NaMILab');
  assert.equal(labelFor('', { kind: 'host' }), 'host');
});
