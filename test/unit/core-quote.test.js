import test from 'node:test';
import assert from 'node:assert/strict';

import { XcError, CODES } from '../../lib/core/errors.js';
import {
  shQuote,
  validateAlias,
  validateHostId,
  validateSessionName,
  validateSocketPath,
  validateSocketName,
  toHexBytes,
  tmuxTarget,
} from '../../lib/core/quote.js';

function assertInvalid(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof XcError);
    assert.equal(error.code, CODES.INVALID_ARGUMENT);
    return true;
  });
}

test('errors exposes the full code table with name-valued codes', () => {
  assert.equal(CODES.SSH_MISSING, 'SSH_MISSING');
  for (const [key, value] of Object.entries(CODES)) {
    assert.equal(key, value);
  }
  const error = new XcError(CODES.PROTOCOL, 'bad', { exitCode: 3 });
  assert.equal(error.code, 'PROTOCOL');
  assert.deepEqual(error.details, { exitCode: 3 });
  assert.equal(error.name, 'XcError');
  assert.ok(error instanceof Error);
});

test('shQuote wraps plain values in single quotes', () => {
  assert.equal(shQuote(''), "''");
  assert.equal(shQuote('abc'), "'abc'");
  assert.equal(shQuote('a b'), "'a b'");
  assert.equal(shQuote('/tmp/tmux-lab/sock'), "'/tmp/tmux-lab/sock'");
});

test('shQuote escapes embedded single quotes structurally', () => {
  assert.equal(shQuote("it's"), "'it'\\''s'");
  assert.equal(shQuote("'"), "''\\'''");
  assert.equal(shQuote("a'b'c"), "'a'\\''b'\\''c'");
  for (const value of ["it's", "'", "''", "a'b'c"]) {
    const quoted = shQuote(value);
    // Starts and ends quoted; removing the outer quotes and splitting on the
    // escape sequence leaves no bare apostrophe behind.
    assert.ok(quoted.startsWith("'"));
    assert.ok(quoted.endsWith("'"));
    // Reconstruct the shell value: strip the outer quotes, then turn every
    // `'\''` escape back into a single apostrophe.
    const reconstructed = quoted.slice(1, -1).replaceAll(`'\\''`, "'");
    assert.equal(reconstructed, value);
  }
});

test('shQuote neutralizes shell metacharacters instead of escaping them', () => {
  assert.equal(shQuote('$(id)'), "'$(id)'");
  assert.equal(shQuote('`whoami`'), "'`whoami`'");
  assert.equal(shQuote('a; rm -rf /'), "'a; rm -rf /'");
  assert.equal(shQuote('a && b || c'), "'a && b || c'");
  assert.equal(shQuote('$HOME'), "'$HOME'");
  assert.equal(shQuote('\\n'), "'\\n'");
  assert.equal(shQuote('*'), "'*'");
  assert.equal(shQuote('~'), "'~'");
});

test('shQuote keeps hostile unicode verbatim (no shell decoding)', () => {
  for (const value of [
    'naïve café',
    '日本語のセッション',
    'emoji 🚀🔥',
    'line1\nline2',
    'tab\there',
    'bidi \u202Eevil\u202C',
    'nul-free',
    '😀'.repeat(50),
  ]) {
    assert.equal(shQuote(value), `'${value}'`);
  }
});

test('shQuote rejects NUL and non-strings', () => {
  assertInvalid(() => shQuote('a\0b'));
  assertInvalid(() => shQuote(null));
  assertInvalid(() => shQuote(42));
});

test('validateAlias accepts ssh aliases and rejects options/metacharacters', () => {
  for (const alias of ['NaMILab', 'a', 'host.example.com', 'user@host', 'a_b-c.d', 'A1']) {
    assert.equal(validateAlias(alias), alias);
  }
  for (const alias of ['', '-oProxyCommand=evil', 'a b', 'a;b', 'a\nb', 'a\0b', 'é', 'a'.repeat(129), '.hidden']) {
    assertInvalid(() => validateAlias(alias));
  }
});

test('validateHostId enforces the config key grammar', () => {
  for (const id of ['namilab', 'a', 'a1', 'a_b-c', 'a'.repeat(32)]) {
    assert.equal(validateHostId(id), id);
  }
  for (const id of ['', 'NaMILab', '-a', 'a b', 'a.b', 'a'.repeat(33)]) {
    assertInvalid(() => validateHostId(id));
  }
});

test('validateSessionName enforces 1..64 safe characters', () => {
  for (const name of ['train', 'a', 'a_b-c', 'A1', 'a'.repeat(64)]) {
    assert.equal(validateSessionName(name), name);
  }
  for (const name of ['', 'a b', 'a.b', 'a/b', 'a:b', "a'b", 'a'.repeat(65), 'a\nb']) {
    assertInvalid(() => validateSessionName(name));
  }
});

test('validateSocketPath only accepts bounded absolute POSIX paths', () => {
  assert.equal(validateSocketPath('/tmp/tmux-lab/sock'), '/tmp/tmux-lab/sock');
  assert.equal(validateSocketPath('/tmp/a b'), '/tmp/a b');
  assert.equal(validateSocketPath(`/${'a'.repeat(199)}`), `/${'a'.repeat(199)}`);
  for (const path of ['', 'tmp/sock', './sock', '/tmp/a\nb', '/tmp/a\rb', '/tmp/a\0b', `/${'a'.repeat(200)}`]) {
    assertInvalid(() => validateSocketPath(path));
  }
});

test('validateSocketName enforces 1..64 safe characters', () => {
  for (const name of ['default', 'xc', 'a.b_c-d', 'a'.repeat(64)]) {
    assert.equal(validateSocketName(name), name);
  }
  for (const name of ['', 'a b', 'a/b', 'a:b', 'a'.repeat(65)]) {
    assertInvalid(() => validateSocketName(name));
  }
});

test('toHexBytes encodes UTF-8 as lowercase 2-char hex', () => {
  assert.deepEqual(toHexBytes(''), []);
  assert.deepEqual(toHexBytes('hi'), ['68', '69']);
  assert.deepEqual(toHexBytes('é'), ['c3', 'a9']);
  assert.deepEqual(toHexBytes('🚀'), ['f0', '9f', '9a', '80']);
  assert.deepEqual(toHexBytes('日'), ['e6', '97', 'a5']);
  for (const byte of toHexBytes('naïve 🚀 日本')) assert.match(byte, /^[0-9a-f]{2}$/);
  assertInvalid(() => toHexBytes(null));
});

test('toHexBytes round-trips arbitrary UTF-8 text', () => {
  for (const value of ['plain', 'naïve', '日本語', '🚀 emoji', 'a\nb\tc', '\u202E']) {
    const hex = toHexBytes(value);
    assert.equal(Buffer.from(hex.join(''), 'hex').toString('utf8'), value);
  }
});

test('tmuxTarget formats numeric ids per kind', () => {
  assert.equal(tmuxTarget('session', 3), '$3');
  assert.equal(tmuxTarget('window', 5), '@5');
  assert.equal(tmuxTarget('pane', 7), '%7');
  assert.equal(tmuxTarget('pane', 0), '%0');
  assertInvalid(() => tmuxTarget('pane', -1));
  assertInvalid(() => tmuxTarget('pane', 1.5));
  assertInvalid(() => tmuxTarget('pane', '7'));
  assertInvalid(() => tmuxTarget('client', 7));
});
