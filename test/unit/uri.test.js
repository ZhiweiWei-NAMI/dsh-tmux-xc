import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEME, TOKEN_RE, decodeRef, encodeRef, findTokens, formatToken, resourceKey, targetString,
} from '../../lib/core/uri.js';

const pane = {
  hostId: 'namilab',
  hostFp: '3fa9c2e81b0d',
  socketId: 'default',
  gen: '2893481-1792293185',
  kind: 'pane',
  sid: 3,
  wid: 5,
  pid: 7,
};

const session = { ...pane, kind: 'session', wid: null, pid: null };
const window = { ...pane, kind: 'window', pid: null };
const server = { ...pane, kind: 'server', sid: null, wid: null, pid: null };
const host = { ...pane, kind: 'host', sid: null, wid: null, pid: null };

test('SCHEME is stable', () => {
  assert.equal(SCHEME, 'dsh-tmux');
});

test('encodeRef canonical form and nulls as "-"', () => {
  assert.equal(
    encodeRef(pane),
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/2893481-1792293185/pane/3/5/7',
  );
  assert.equal(
    encodeRef(session),
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/2893481-1792293185/session/3/-/-',
  );
  assert.equal(
    encodeRef(server),
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/2893481-1792293185/server/-/-/-',
  );
});

test('decode/encode round trip for every kind', () => {
  for (const ref of [pane, window, session, server, host]) {
    const uri = encodeRef(ref);
    assert.deepEqual(decodeRef(uri), { v: 1, ...ref });
  }
});

test('decodeRef accepts "0" ids', () => {
  const ref = decodeRef('dsh-tmux:v1/h/0123456789ab/s/1-2/pane/0/0/0');
  assert.equal(ref.sid, 0);
  assert.equal(ref.wid, 0);
  assert.equal(ref.pid, 0);
});

test('decodeRef rejects wrong version, arity and schemes', () => {
  for (const uri of [
    'dsh-tmux:v2/namilab/3fa9c2e81b0d/default/1-2/pane/3/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/pane/3/5',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/pane/3/5/7/8',
    'other:v1/namilab/3fa9c2e81b0d/default/1-2/pane/3/5/7',
    'dsh-tmux:v1//3fa9c2e81b0d/default/1-2/pane/3/5/7',
    '',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/pane/3/5/7\n',
  ]) {
    assert.throws(() => decodeRef(uri), { code: 'INVALID_ARGUMENT' }, uri);
  }
});

test('decodeRef rejects bad hostId, fp, socketId and gen', () => {
  const bad = [
    'dsh-tmux:v1/NaMILab/3fa9c2e81b0d/default/1-2/pane/3/5/7',
    'dsh-tmux:v1/-bad/3fa9c2e81b0d/default/1-2/pane/3/5/7',
    'dsh-tmux:v1/' + 'a'.repeat(33) + '/3fa9c2e81b0d/default/1-2/pane/3/5/7',
    'dsh-tmux:v1/namilab/3FA9C2E81B0D/default/1-2/pane/3/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1/pane/3/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2-3/pane/3/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/bad socket/1-2/pane/3/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/bogus/3/5/7',
  ];
  for (const uri of bad) assert.throws(() => decodeRef(uri), { code: 'INVALID_ARGUMENT' }, uri);
});

test('decodeRef rejects non-canonical ids and kind/id inconsistency', () => {
  const bad = [
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/pane/03/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/pane/3/-/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/pane/3/5/-',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/window/3/5/7',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/window/-/5/-',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/session/3/5/-',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/session/-/-/-',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/server/3/-/-',
    'dsh-tmux:v1/namilab/3fa9c2e81b0d/default/1-2/host/-/-/7',
  ];
  for (const uri of bad) assert.throws(() => decodeRef(uri), { code: 'INVALID_ARGUMENT' }, uri);
});

test('encodeRef validates its input', () => {
  assert.throws(() => encodeRef({ ...pane, hostFp: 'xyz' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef({ ...pane, kind: 'nope' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef({ ...pane, pid: -1 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef({ ...pane, pid: 1.5 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef({ ...pane, pid: '7' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef({ ...pane, gen: 'latest' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef(null), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeRef({ ...session, wid: 3 }), { code: 'INVALID_ARGUMENT' });
});

test('formatToken sanitizes the label and produces a matching token', () => {
  const uri = encodeRef(pane);
  const token = formatToken('NaMILab · train:0.1 `bad` []()\nnext', uri);
  assert.equal(token, `@[NaMILab · train:0.1 bad next](${uri})`);
  const [found] = findTokens(token);
  assert.equal(found.uri, uri);
});

test('TOKEN_RE has label and uri groups', () => {
  const source = encodeRef(pane);
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  const match = re.exec(`hi @[lab](${source}) there`);
  assert.equal(match[1], 'lab');
  assert.equal(match[2], source);
});

test('TOKEN_RE does not match across newlines or through brackets', () => {
  const uri = encodeRef(pane);
  assert.equal(findTokens(`@[a\nb](${uri})`).length, 0);
  assert.equal(findTokens(`@[a]b](${uri})`).length, 0);
  assert.equal(findTokens(`@[a](${uri}\n)`).length, 0);
  assert.equal(findTokens(`@[a](${uri})`).length, 1);
});

test('findTokens reports offsets, skips invalid decodes and supports many tokens', () => {
  const a = encodeRef(pane);
  const b = encodeRef(session);
  const text = `x @[one](${a}) y @[bad](dsh-tmux:v1/nope/zzz) z @[two](${b})`;
  const found = findTokens(text);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.label), ['one', 'two']);
  assert.equal(text.slice(found[0].start, found[0].end), `@[one](${a})`);
  assert.equal(found[1].ref.kind, 'session');
});

test('findTokens tolerates empty and non-string input', () => {
  assert.deepEqual(findTokens(''), []);
  assert.deepEqual(findTokens(undefined), []);
  assert.deepEqual(findTokens('no tokens here'), []);
});

test('targetString renders the tmux target per kind', () => {
  assert.equal(targetString(pane), 'namilab:default:%7');
  assert.equal(targetString(window), 'namilab:default:@5');
  assert.equal(targetString(session), 'namilab:default:$3');
  assert.equal(targetString(server), 'namilab:default:server');
  assert.equal(targetString(host), 'namilab:default:host');
});

test('resourceKey is unique, stable and path-safe', () => {
  const key = resourceKey(pane);
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.equal(key, resourceKey({ ...pane }));
  assert.notEqual(key, resourceKey({ ...pane, pid: 8 }));
  assert.notEqual(key, resourceKey({ ...pane, hostId: 'other' }));
  const awkward = resourceKey({ ...pane, hostId: 'a_b', socketId: 'c_d' });
  assert.match(awkward, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(awkward, resourceKey({ ...pane, hostId: 'a', socketId: 'bc_d' }));
});
