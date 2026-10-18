import test from 'node:test';
import assert from 'node:assert/strict';
import { XcError, CODES } from '../../lib/core/errors.js';
import {
  newNonce, socketArgs, inventoryScript, guardSnippet, createSessionScript,
  createWindowScript, splitPaneScript, sendScript, captureScript, detachScript,
  killScript, NAMED_KEYS,
} from '../../lib/core/scripts.js';
import { parseRecords } from '../../lib/core/transport.js';

const NONCE = '0123456789ab';
const SOCKET = { id: 'lab', name: 'xc' };
const GEN = '2893481-1792293185';
const EXPECT = { gen: GEN, sid: 3, wid: 5, pid: 7, target: '%7' };

function assertInvalid(fn) {
  assert.throws(fn, (error) => error instanceof XcError && error.code === CODES.INVALID_ARGUMENT);
}

// For structural assertions only: peel nested tmux quoting, without executing a
// shell or interpreting any payload. Real parser coverage lives in integration.
function readable(script) {
  let previous;
  do {
    previous = script;
    script = script.replace(/\\([\\"$])/g, '$1').replaceAll("'\\''", "'");
  } while (script !== previous);
  return script;
}

function builders() {
  return [
    inventoryScript(NONCE, SOCKET),
    createSessionScript(NONCE, SOCKET, { name: 'train' }),
    createSessionScript(NONCE, SOCKET, { name: 'train', expectedGen: GEN }),
    createSessionScript(NONCE, SOCKET, { name: 'train', expectedGen: null }),
    createWindowScript(NONCE, SOCKET, EXPECT, { name: 'logs' }),
    splitPaneScript(NONCE, SOCKET, EXPECT),
    sendScript(NONCE, SOCKET, EXPECT, { hex: ['68', '69'], keys: ['Tab'], enter: true }),
    captureScript(NONCE, SOCKET, EXPECT),
    detachScript(NONCE, SOCKET, EXPECT),
    ...['session', 'window', 'pane'].map((kind) => killScript(NONCE, SOCKET, EXPECT, kind)),
  ];
}

function literalRecords(script) {
  return script.split('\n')
    .map((line) => line.slice(line.indexOf("printf 'XC1")))
    .filter((line) => line.startsWith("printf 'XC1") && !line.includes('%s'))
    .map((line) => line.slice("printf '".length, line.indexOf("'", "printf '".length)))
    .join('').replaceAll('\\037', '\x1f').replaceAll('\\036', '\x1e').replaceAll('\\n', '\n');
}

test('nonce and socket selectors remain validated', () => {
  assert.match(newNonce(), /^[0-9a-f]{12}$/);
  assert.notEqual(newNonce(), newNonce());
  assert.equal(socketArgs({ id: 'default' }), '');
  assert.equal(socketArgs(SOCKET), "-L 'xc'");
  assert.equal(socketArgs({ name: 'xc', path: '/tmp/sock' }), "-S '/tmp/sock'");
  for (const socket of [null, { name: 'bad name' }, { path: 'relative' }, { path: '/tmp/a\nb' }]) {
    assertInvalid(() => socketArgs(socket));
  }
  for (const nonce of ['', 'xyz', 'A1B2C3D4E5F6', '0123456789ab0', '../']) {
    assertInvalid(() => inventoryScript(nonce, SOCKET));
    assertInvalid(() => createSessionScript(nonce, SOCKET, { name: 'x' }));
  }
});

test('complete scripts frame begin/end and probe tools without changing user options', () => {
  for (const script of builders()) {
    assert.ok(script.startsWith(`printf 'XC1${NONCE}\\037begin`));
    assert.ok(script.trimEnd().split('\n').at(-1).includes(`XC1${NONCE}\\037end`));
    assert.ok(script.includes('command -v tmux'));
    assert.ok(script.includes('/etc/machine-id'));
    for (const forbidden of ['set-option', 'set-environment', 'setenv', 'source-file', 'respawn-', 'run-shell']) {
      assert.equal(script.includes(forbidden), false, forbidden);
    }
    assert.equal(script.includes('StrictHostKeyChecking=no'), false);
    // Explicit successful early exits must always carry a footer. Signal traps
    // deliberately exit nonzero without claiming a complete operation.
    const end = `printf 'XC1${NONCE}\\037end\\036${NONCE}\\036\\n';`;
    for (const match of script.matchAll(/exit 0/g)) {
      assert.ok(script.slice(0, match.index).trimEnd().endsWith(end));
    }
  }
});

test('inventory framing, fields, missing-server classification and UTF-8 invocation', () => {
  const script = inventoryScript(NONCE, SOCKET);
  // Inspect the early-return path only: the normal footer after `fi` is a
  // different branch, not a second footer emitted on a missing-server run.
  const failureEnd = script.indexOf('\nfi', script.indexOf('if [ "$rc" -ne 0 ]'));
  const parsed = parseRecords(literalRecords(script.slice(0, failureEnd)), NONCE);
  assert.deepEqual(parsed.records, [['begin'], ['noserver'], ['end']]);
  assert.deepEqual(parseRecords(literalRecords(script.slice(failureEnd)), NONCE).records, [['end']]);
  for (const field of [
    'pid', 'start_time', 'socket_path', 'session_id', 'session_name', 'session_created',
    'session_attached', 'window_id', 'window_index', 'window_name', 'window_active',
    'pane_id', 'pane_index', 'pane_active', 'pane_current_command', 'pane_current_path',
    'pane_dead', 'pane_width', 'pane_height', 'pane_title',
  ]) assert.ok(script.includes(`#{${field}}`), field);
  assert.ok(script.includes("tmux -u -L 'xc' list-panes -a"));
  assert.ok(script.includes('2>&1 1>&3'));
  for (const text of ['no server running', 'error connecting to', 'failed to connect to server']) {
    assert.ok(script.includes(text));
  }
  assert.ok(inventoryScript(NONCE, {}).includes('tmux -u list-panes'));
  assert.ok(inventoryScript(NONCE, { path: '/tmp/socket' }).includes("tmux -u -S '/tmp/socket'"));
});

test('RV1-04: guard and ALL actions share one synchronous bound tmux client', () => {
  for (const raw of builders().slice(4)) {
    const script = readable(raw);
    assert.equal([...raw.matchAll(/tmux -u /g)].length, 1);
    assert.ok(script.includes('if-shell -F'));
    assert.ok(script.includes(`#{==:#{pid}-#{start_time},${GEN}}`));
    assert.ok(script.includes('#{==:#{session_id},$3}'));
    assert.ok(script.includes('#{==:#{window_id},@5}'));
    assert.ok(script.includes('#{==:#{pane_id},%7}'));
    assert.ok(script.includes('SERVER_RESTARTED'));
    assert.ok(script.includes('TARGET_CHANGED'));
    assert.ok(script.includes('TARGET_GONE'));
    assert.ok(script.includes('REMOTE_ERROR'));
    assert.ok(script.includes('rc=$?'));
    assert.ok(script.includes('if [ "$rc" -ne 0 ]'));
    assert.equal(script.includes('if-shell -b'), false);
  }
});

test('guard validates generation/ids and retains every supplied approved ancestor', () => {
  const full = readable(guardSnippet(NONCE, SOCKET, EXPECT));
  assert.ok(full.includes('#{==:#{window_id},@5}'));
  const session = readable(guardSnippet(NONCE, SOCKET, { gen: GEN, target: '$3', sid: 3 }));
  assert.ok(session.includes('#{==:#{session_id},$3}'));
  assert.equal(session.includes('#{window_id}'), false);
  for (const expect of [
    { target: '%7' }, { ...EXPECT, gen: '#(id)' }, { ...EXPECT, target: 'bad' },
    { ...EXPECT, pid: -1 }, { ...EXPECT, sid: 1.5 },
  ]) assertInvalid(() => guardSnippet(NONCE, SOCKET, expect));
});

test('RV1-02: send atomically refuses synchronization, copy mode, dead and input-off panes', () => {
  const script = readable(sendScript(NONCE, SOCKET, EXPECT, { hex: ['61'], enter: true }));
  for (const [format, code] of [
    ['synchronize-panes', 'SYNCHRONIZED_PANES'], ['pane_in_mode', 'PANE_IN_MODE'],
    ['pane_dead', 'PANE_DEAD'], ['pane_input_off', 'PANE_INPUT_DISABLED'],
  ]) {
    assert.ok(script.includes(`#{==:#{${format}},0}`));
    assert.ok(script.includes(code));
  }
  assert.ok(script.indexOf('#{synchronize-panes}') < script.indexOf('send-keys'));
  assert.equal(script.includes('set-option'), false);
});

test('RV1-08: success marker follows all queued actions and failure stops at checked status', () => {
  for (const builder of [sendScript, detachScript]) {
    const script = readable(builder(NONCE, SOCKET, EXPECT));
    assert.ok(script.includes(' ; display-message -p'));
    assert.ok(script.includes(`XC1${NONCE}\x1fguarded`));
    assert.ok(script.includes(`XC1${NONCE}\x1fok`));
    assert.ok(script.includes('OUTCOME_UNKNOWN'));
    assert.ok(script.includes('verify with capture before retrying'));
    assert.ok(script.indexOf('if [ "$rc" -ne 0 ]') < script.indexOf('printf \'%s\\n\' "$out"'));
  }
});

test('create uses dimensions, argv and format-safe cwd in all creation paths', () => {
  const direct = createSessionScript(NONCE, SOCKET, {
    name: 'train_1', cwd: '/tmp/a b', command: ['bash', '-l'], width: 120, height: 40,
  });
  assert.ok(direct.includes("new-session -d -s 'train_1' -x 120 -y 40 -c '/tmp/a b'"));
  assert.ok(direct.includes("-- 'bash' '-l'"));
  assert.ok(direct.indexOf('-P -F') < direct.indexOf('-- '));
  assert.equal(direct.includes(' -A'), false);
  assert.ok(createSessionScript(NONCE, SOCKET, { name: 'x' }).includes('-x 200 -y 50'));
  for (const make of [
    (cwd) => createSessionScript(NONCE, SOCKET, { name: 'x', cwd }),
    (cwd) => createSessionScript(NONCE, SOCKET, { name: 'x', cwd, expectedGen: GEN }),
    (cwd) => createWindowScript(NONCE, SOCKET, EXPECT, { cwd }),
    (cwd) => splitPaneScript(NONCE, SOCKET, EXPECT, { cwd }),
  ]) {
    const script = readable(make("/tmp/a#(touch marker)/#{pane_id}/hash#/'quoted'"));
    assert.ok(script.includes('/tmp/a##(touch marker)/##{pane_id}/hash##/'));
    assert.equal(script.includes('/tmp/a#(touch marker)'), false);
    assertInvalid(() => make('a\0b'));
  }
});

test('create can bind existing generation or refuse a newly appeared server', () => {
  const existing = createSessionScript(NONCE, SOCKET, { name: 'x', expectedGen: GEN });
  assert.ok(existing.includes(`#{==:#{pid}-#{start_time},${GEN}}`));
  const absent = createSessionScript(NONCE, SOCKET, { name: 'x', expectedGen: null });
  assert.ok(absent.includes('start-server \\; if-shell -F'));
  assert.ok(absent.includes('#{==:#{session_id},}'));
  const invocation = readable(absent).split('\n').find((line) => line.startsWith('out=$('));
  assert.ok(invocation.indexOf('new-session') < invocation.indexOf('display-message'),
    'tmux 3.0a cannot display a pre-create guard marker without a live pane');
  assert.equal(invocation.includes(`XC1${NONCE}\x1fguarded`), false);
  assert.ok(readable(existing).includes(`XC1${NONCE}\x1fguarded`));
  for (const script of [existing, absent]) assert.equal([...script.matchAll(/tmux -u /g)].length, 1);
});

test('create rejects invalid names, dimensions, orientation and argv', () => {
  for (const options of [
    { name: 'a b' }, { name: 'a;b' }, { name: 'x'.repeat(65) }, { name: 'x', width: 0 },
    { name: 'x', height: 1.5 }, { name: 'x', command: ['bash', ''] }, { name: 'x', command: [42] },
  ]) assertInvalid(() => createSessionScript(NONCE, SOCKET, options));
  assertInvalid(() => splitPaneScript(NONCE, SOCKET, EXPECT, { horizontal: 'yes' }));
  assert.ok(readable(splitPaneScript(NONCE, SOCKET, EXPECT)).includes('split-window -d -t "%7" -v'));
  assert.ok(readable(splitPaneScript(NONCE, SOCKET, EXPECT, { horizontal: true })).includes('-h'));
  assert.ok(readable(createWindowScript(NONCE, SOCKET, EXPECT, { name: 'logs' })).includes('new-window -d -t "$3" -n "logs"'));
});

test('hex chunks stay at most 256 bytes in a single command queue, followed by keys and Enter', () => {
  const hex = Array.from({ length: 700 }, (_, i) => (i % 256).toString(16).padStart(2, '0'));
  const script = readable(sendScript(NONCE, SOCKET, EXPECT, { hex, keys: ['C-c', 'Tab'], enter: true }));
  const chunks = [...script.matchAll(/send-keys -t "%7" -H ((?:[0-9a-f]{2} ?)+)/g)]
    .map((match) => match[1].trim().split(' '));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [256, 256, 188]);
  assert.deepEqual(chunks.flat(), hex);
  assert.ok(script.includes('send-keys -t "%7" "C-c"'));
  assert.ok(script.includes('send-keys -t "%7" "Tab"'));
  assert.ok(script.includes('send-keys -t "%7" Enter'));
});

test('send validation and payload literalness stay strict', () => {
  assert.deepEqual([...NAMED_KEYS], [
    'Enter', 'Escape', 'Tab', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
    'PageUp', 'PageDown', 'C-c', 'C-d', 'C-z', 'C-l',
  ]);
  for (const key of ['F1', 'C-x', '; rm -rf /', 'Enter Enter', '']) {
    assertInvalid(() => sendScript(NONCE, SOCKET, EXPECT, { keys: [key] }));
  }
  for (const hex of [['AB'], ['6'], ['zz'], ['61', ''], Array(16385).fill('61')]) {
    assertInvalid(() => sendScript(NONCE, SOCKET, EXPECT, { hex }));
  }
  assert.doesNotThrow(() => sendScript(NONCE, SOCKET, EXPECT, { hex: Array(16384).fill('61') }));
  const text = "hello'; rm -rf / #$(id)`whoami`";
  const hex = Array.from(Buffer.from(text), (byte) => byte.toString(16).padStart(2, '0'));
  const script = sendScript(NONCE, SOCKET, EXPECT, { hex });
  assert.equal(script.includes('rm -rf'), false);
  assert.equal(script.includes('$(id)'), false);
  assert.ok(script.includes(hex.join(' ')));
});

test('RV1-15: capture bounds newest raw bytes before hex, emits truncation, checks tmux status', () => {
  const script = readable(captureScript(NONCE, SOCKET, EXPECT, { lines: 250, maxBytes: 8192 }));
  assert.ok(script.includes('capture-pane -p -J -t "%7" -S -250'));
  assert.ok(script.includes('size=8192; truncated=1'));
  assert.ok(script.includes('tail -c "$size" "$tmp/raw"'));
  assert.ok(script.indexOf('tail -c') < script.indexOf('od -An -v -tx1 "$tmp/tail"'));
  assert.ok(script.indexOf('if [ "$rc" -ne 0 ]') < script.indexOf('tail -c'));
  assert.ok(script.includes('[89ab][0-9a-f]*) hex=${hex#??}'));
  assert.ok(script.includes('"$hex" "$truncated"'));
  assert.ok(script.includes('trap'));
  assert.equal(script.includes('capture-pane -p -J -t "%7" -S -250 |'), false);
  for (const options of [{ lines: 0 }, { lines: 2001 }, { maxBytes: 0 }, { maxBytes: 1048577 }]) {
    assertInvalid(() => captureScript(NONCE, SOCKET, EXPECT, options));
  }
});

test('detach checks original pane ancestry but acts on its approved session; kill targets exact ids', () => {
  const detach = readable(detachScript(NONCE, SOCKET, EXPECT));
  assert.ok(detach.includes('if-shell -F -t "%7"'));
  assert.ok(detach.includes('detach-client -s "$3"'));
  for (const [kind, target] of [['pane', '%7'], ['window', '@5'], ['session', '$3']]) {
    const raw = killScript(NONCE, SOCKET, EXPECT, kind);
    const script = readable(raw);
    assert.ok(script.includes(`kill-${kind} -t "${target}"`));
    const invocation = script.split('\n').find((line) => line.startsWith('out=$('));
    assert.equal(invocation.includes(`XC1${NONCE}\x1fok`), false,
      'no target-dependent native success marker after killing the final resource');
    assert.ok(raw.lastIndexOf('printf \'%s\\n\' "$out"') < raw.indexOf(`\\037ok`));
    assert.ok(raw.indexOf('if [ "$rc" -ne 0 ]') < raw.indexOf(`\\037ok`));
  }
  assertInvalid(() => killScript(NONCE, SOCKET, EXPECT, 'client'));
});

test('hostile configured command argv remains quoted, not raw shell code', () => {
  const script = createSessionScript(NONCE, SOCKET, {
    name: 'x', command: ["bash -c 'echo pwned'", '$(id)', '`whoami`'],
  });
  assert.ok(script.includes("'bash -c '\\''echo pwned'\\'''"));
  assert.ok(script.includes("'$(id)'"));
  assert.ok(script.includes("'`whoami`'"));
});
