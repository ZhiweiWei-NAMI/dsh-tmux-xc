import test from 'node:test';
import assert from 'node:assert/strict';

import { XcError, CODES } from '../../lib/core/errors.js';
import {
  newNonce,
  socketArgs,
  inventoryScript,
  guardSnippet,
  createSessionScript,
  createWindowScript,
  splitPaneScript,
  sendScript,
  captureScript,
  detachScript,
  killScript,
  NAMED_KEYS,
} from '../../lib/core/scripts.js';
import { parseRecords } from '../../lib/core/transport.js';

const NONCE = '0123456789ab';
const SOCKET = { id: 'lab', name: 'xc' };
const GEN = '2893481-1792293185';
const EXPECT = { gen: GEN, sid: 3, wid: 5, pid: 7, target: '%7' };

function assertInvalid(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof XcError);
    assert.equal(error.code, CODES.INVALID_ARGUMENT);
    return true;
  });
}

function firstLine(script) {
  return script.split('\n', 1)[0];
}

function lastLine(script) {
  return script.trimEnd().split('\n').at(-1);
}

/**
 * Recover the literal (non-%s) printf records from a script: unescape the
 * octal framing bytes so parseRecords sees real control characters.
 */
function literalRecords(script) {
  return script
    .split('\n')
    .map((line) => line.slice(line.indexOf("printf 'XC1")))
    .filter((line) => line.startsWith("printf 'XC1") && !line.includes('%s'))
    .map((line) => line.slice("printf '".length, line.indexOf("'", "printf '".length)))
    .join('')
    .replaceAll('\\037', '\x1f')
    .replaceAll('\\036', '\x1e')
    .replaceAll('\\n', '\n');
}

test('newNonce returns 12 lowercase hex characters', () => {
  for (let i = 0; i < 50; i += 1) {
    const nonce = newNonce();
    assert.match(nonce, /^[0-9a-f]{12}$/);
    assert.equal(nonce.length, 12);
  }
  assert.notEqual(newNonce(), newNonce());
});

test('socketArgs selects no flag, -L name or -S path', () => {
  assert.equal(socketArgs({ id: 'default' }), '');
  assert.equal(socketArgs({ id: 'xc', name: 'xc' }), "-L 'xc'");
  assert.equal(socketArgs({ id: 'lab', path: '/tmp/tmux-lab/sock' }), "-S '/tmp/tmux-lab/sock'");
  // path wins over name when both are configured
  assert.equal(
    socketArgs({ id: 'lab', name: 'xc', path: '/tmp/sock' }),
    "-S '/tmp/sock'",
  );
  assertInvalid(() => socketArgs({ id: 'x', name: 'bad name' }));
  assertInvalid(() => socketArgs({ id: 'x', path: 'relative/sock' }));
  assertInvalid(() => socketArgs(null));
});

test('every builder returns a complete script with begin first and end last', () => {
  const scripts = [
    inventoryScript(NONCE, SOCKET),
    createSessionScript(NONCE, SOCKET, { name: 'train' }),
    createWindowScript(NONCE, SOCKET, EXPECT, { name: 'logs' }),
    splitPaneScript(NONCE, SOCKET, EXPECT, {}),
    sendScript(NONCE, SOCKET, EXPECT, { hex: ['68', '69'], keys: ['Enter'], enter: true }),
    captureScript(NONCE, SOCKET, EXPECT, { lines: 80 }),
    detachScript(NONCE, SOCKET, EXPECT),
    killScript(NONCE, SOCKET, EXPECT, 'pane'),
  ];
  for (const script of scripts) {
    assert.ok(script.startsWith(`printf 'XC1${NONCE}\\037begin`), script.split('\n')[0]);
    assert.ok(lastLine(script).includes(`XC1${NONCE}\\037end`));
    assert.ok(script.includes('command -v tmux'));
    assert.ok(script.includes('/etc/machine-id'));
  }
});

test('framing round-trips through parseRecords for literal records', () => {
  const script = inventoryScript(NONCE, SOCKET);
  const parsed = parseRecords(literalRecords(script), NONCE);
  assert.deepEqual(parsed.records[0], ['begin']);
  assert.deepEqual(parsed.records.at(-1), ['end']);
  assert.equal(parsed.sawBegin, true);
  assert.equal(parsed.sawEnd, true);
  assert.deepEqual(parsed.records[1], ['noserver']);
});

test('a missing tmux emits REMOTE_TOOL_MISSING and exits 0', () => {
  const script = inventoryScript(NONCE, SOCKET);
  assert.match(script, /command -v tmux >\/dev\/null 2>&1 \|\| \{ .*REMOTE_TOOL_MISSING.*; exit 0; \}/);
});

test('all tmux invocations use `tmux -u` and the socket flags', () => {
  for (const script of [
    inventoryScript(NONCE, { id: 'lab', path: '/tmp/tmux-lab/sock' }),
    createSessionScript(NONCE, { id: 'lab', path: '/tmp/tmux-lab/sock' }, { name: 'train' }),
    sendScript(NONCE, { id: 'lab', path: '/tmp/tmux-lab/sock' }, EXPECT, { hex: [] }),
  ]) {
    const lines = script.split('\n').filter((line) => /(^|[^\w])tmux /.test(line) && !line.includes('command -v'));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.match(line, /tmux -u (-S '\/tmp\/tmux-lab\/sock'|-L 'xc')?/);
    }
  }
});

test('default socket uses bare `tmux -u`', () => {
  const script = inventoryScript(NONCE, { id: 'default' });
  assert.ok(script.includes('out=$(tmux -u list-panes -a -F'));
});

test('inventory embeds the nonce framing in the format string', () => {
  const script = inventoryScript(NONCE, SOCKET);
  // The format string embeds the raw separators, so tmux frames each pane
  // record itself; the nonce keeps hostile values from forging boundaries.
  assert.ok(script.includes(`XC1${NONCE}\x1fpane`));
  assert.ok(script.includes(`\x1f${NONCE}\x1f`));
  assert.ok(script.includes(`\x1e${NONCE}\x1e`));
  for (const field of [
    '#{pid}-#{start_time}',
    '#{socket_path}',
    '#{session_id}',
    '#{session_name}',
    '#{session_created}',
    '#{session_attached}',
    '#{window_id}',
    '#{window_index}',
    '#{window_name}',
    '#{window_active}',
    '#{pane_id}',
    '#{pane_index}',
    '#{pane_active}',
    '#{pane_current_command}',
    '#{pane_current_path}',
    '#{pane_dead}',
    '#{pane_width}',
    '#{pane_height}',
    '#{pane_title}',
  ]) {
    assert.ok(script.includes(field), field);
  }
  assert.ok(script.includes('list-panes -a'));
});

test('inventory converts tmux "no server running"/connect errors into a noserver record', () => {
  const script = inventoryScript(NONCE, SOCKET);
  assert.ok(script.includes('no server running'));
  assert.ok(script.includes('error connecting to'));
  assert.ok(script.includes('failed to connect to server'));
  assert.ok(script.includes('2>&1 1>&3'));
  // The pane records stay on stdout; the noserver record is separate.
  assert.match(script, /printf 'XC1[0-9a-f]+\\037noserver\\036/);
});

test('inventory never emits set-option/set-environment/source-file', () => {
  const script = inventoryScript(NONCE, SOCKET);
  for (const forbidden of ['set-option', 'set-environment', 'setenv', 'source-file', 'respawn-']) {
    assert.equal(script.includes(forbidden), false, forbidden);
  }
});

test('guard compares generation and the expected ids', () => {
  const fragment = guardSnippet(NONCE, SOCKET, EXPECT);
  assert.ok(fragment.includes(`'#{pid}-#{start_time} #{session_id} #{window_id} #{pane_id}'`));
  assert.ok(fragment.includes(`[ "$1" = '${GEN}' ]`));
  assert.ok(fragment.includes(`[ "$2" = '$3' ]`));
  assert.ok(fragment.includes(`[ "$3" = '@5' ]`));
  assert.ok(fragment.includes(`[ "$4" = '%7' ]`));
  // A mismatch emits the fresh values, the end record, and exits 0.
  assert.match(fragment, /mismatch/);
  assert.ok(fragment.includes(`\\036${NONCE}\\036`));
  assert.ok(fragment.includes('exit 0'));
  assert.ok(fragment.indexOf('mismatch') < fragment.indexOf('exit 0'));
});

test('mutations guard only the ids their target implies', () => {
  // A window is not pinned to one session (it may be linked into several).
  const window = createWindowScript(NONCE, SOCKET, EXPECT, {});
  assert.ok(window.includes(`[ "$2" = '$3' ]`));
  assert.equal(window.includes('[ "$3"'), false);
  assert.equal(window.includes('[ "$4"'), false);
  // Killing a session does not require an unrelated window/pane id.
  const sessionKill = killScript(NONCE, SOCKET, EXPECT, 'session');
  assert.equal(sessionKill.includes('[ "$3"'), false);
  const paneKill = killScript(NONCE, SOCKET, EXPECT, 'pane');
  assert.ok(paneKill.includes(`[ "$4" = '%7' ]`));
});

test('guard only checks the ids that were provided', () => {
  const fragment = guardSnippet(NONCE, SOCKET, { gen: GEN, target: '$3', sid: 3 });
  assert.ok(fragment.includes(`[ "$2" = '$3' ]`));
  assert.equal(fragment.includes('[ "$3"'), false);
  assert.equal(fragment.includes('[ "$4"'), false);
});

test('guard rejects malformed expectations', () => {
  assertInvalid(() => guardSnippet(NONCE, SOCKET, { target: '%7' }));
  assertInvalid(() => guardSnippet(NONCE, SOCKET, { gen: GEN, target: 'nope' }));
  assertInvalid(() => guardSnippet(NONCE, SOCKET, { gen: GEN, target: '%7', pid: -1 }));
  assertInvalid(() => guardSnippet(NONCE, SOCKET, { gen: GEN, target: '%7', sid: 1.5 }));
});

test('mutating scripts put the guard before the action', () => {
  const scripts = [
    createWindowScript(NONCE, SOCKET, EXPECT, { name: 'x' }),
    splitPaneScript(NONCE, SOCKET, EXPECT, {}),
    sendScript(NONCE, SOCKET, EXPECT, { hex: ['61'] }),
    captureScript(NONCE, SOCKET, EXPECT, { lines: 10 }),
    detachScript(NONCE, SOCKET, EXPECT),
    killScript(NONCE, SOCKET, EXPECT, 'pane'),
  ];
  for (const script of scripts) {
    const guardAt = script.indexOf('display-message -p -t');
    assert.ok(guardAt > -1);
    const actions = script
      .split('\n')
      .filter((line) => /tmux -u .*(send-keys|capture-pane|detach-client|kill-|new-window|split-window)/.test(line));
    assert.ok(actions.length > 0);
    for (const action of actions) assert.ok(script.indexOf(action) > guardAt);
  }
});

test('createSession uses -d -P -F, numeric dimensions and quoted values', () => {
  const script = createSessionScript(NONCE, SOCKET, {
    name: 'train_1',
    cwd: '/tmp/a b',
    command: ['bash', '-l'],
    width: 120,
    height: 40,
  });
  assert.ok(script.includes("new-session -d -s 'train_1' -x 120 -y 40 -c '/tmp/a b'"));
  assert.ok(script.includes(`-P -F 'XC1${NONCE}`));
  assert.ok(script.includes('-- \'bash\' \'-l\''));
  // -P -F must come before `-- argv`
  assert.ok(script.indexOf('-P -F') < script.indexOf('-- '));
  assert.ok(script.includes('#{session_name}'));
  assert.ok(script.includes('#{window_name}'));
});

test('createSession defaults to 200x50 and no -A', () => {
  const script = createSessionScript(NONCE, SOCKET, { name: 'train' });
  assert.ok(script.includes('-x 200 -y 50'));
  assert.equal(script.includes(' -A'), false);
});

test('createSession rejects unsafe names and invalid dimensions', () => {
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'a b' }));
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'a;b' }));
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'x'.repeat(65) }));
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'x', width: 0 }));
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'x', height: 1.5 }));
  // An empty argv means "tmux default shell" and is valid.
  assert.equal(createSessionScript(NONCE, SOCKET, { name: 'x', command: [] }).includes(' -- '), false);
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'x', command: ['bash', ''] }));
  assertInvalid(() => createSessionScript(NONCE, SOCKET, { name: 'x', command: ['bash', 42] }));
});

test('createWindow targets the expected session id', () => {
  const script = createWindowScript(NONCE, SOCKET, EXPECT, { name: 'logs', cwd: '/srv' });
  assert.ok(script.includes("new-window -d -t '$3' -n 'logs' -c '/srv'"));
  assert.ok(script.includes(`[ "$2" = '$3' ]`));
});

test('splitPane targets the expected pane and defaults to vertical', () => {
  const vertical = splitPaneScript(NONCE, SOCKET, EXPECT, {});
  assert.ok(vertical.includes("split-window -d -t '%7' -v"));
  const horizontal = splitPaneScript(NONCE, SOCKET, EXPECT, { horizontal: true });
  assert.ok(horizontal.includes("split-window -d -t '%7' -h"));
  assertInvalid(() => splitPaneScript(NONCE, SOCKET, EXPECT, { horizontal: 'yes' }));
});

test('sendScript hex chunks are at most 256 bytes per send-keys -H', () => {
  const hex = Array.from({ length: 700 }, (_, i) => (i % 256).toString(16).padStart(2, '0'));
  const script = sendScript(NONCE, SOCKET, EXPECT, { hex });
  const sends = script
    .split('\n')
    .filter((line) => line.includes('send-keys -t') && line.includes(' -H '));
  const tokens = (line) => line.trim().split(/\s+/);
  assert.deepEqual(sends.map((line) => tokens(line).length - 8), [256, 256, 188]);
  const bytes = sends.flatMap((line) => tokens(line).slice(8));
  assert.deepEqual(bytes, hex);
});

test('sendScript sends named keys from the allow-list and optional Enter', () => {
  const script = sendScript(NONCE, SOCKET, EXPECT, { keys: ['C-c', 'Tab'], enter: true });
  assert.ok(script.includes("send-keys -t '%7' 'C-c'"));
  assert.ok(script.includes("send-keys -t '%7' 'Tab'"));
  assert.ok(script.includes("send-keys -t '%7' Enter"));
  assert.ok(script.includes(`XC1${NONCE}\\037ok`));
});

test('NAMED_KEYS matches DESIGN §7 exactly', () => {
  assert.deepEqual([...NAMED_KEYS], [
    'Enter',
    'Escape',
    'Tab',
    'BSpace',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'C-c',
    'C-d',
    'C-z',
    'C-l',
  ]);
});

test('sendScript rejects keys outside the allow-list', () => {
  for (const key of ['F1', 'C-x', '; rm -rf /', 'Enter Enter', '']) {
    assertInvalid(() => sendScript(NONCE, SOCKET, EXPECT, { keys: [key] }));
  }
});

test('sendScript refuses non-lowercase or non-byte hex', () => {
  for (const hex of [['AB'], ['6'], ['zz'], ['61', '6'], ['61', '62', '']]) {
    assertInvalid(() => sendScript(NONCE, SOCKET, EXPECT, { hex }));
  }
});

test('sendScript rejects payloads above 16 KiB of text', () => {
  const hex = Array.from({ length: 16 * 1024 }, () => '61');
  assert.doesNotThrow(() => sendScript(NONCE, SOCKET, EXPECT, { hex }));
  assertInvalid(() => sendScript(NONCE, SOCKET, EXPECT, { hex: [...hex, '61'] }));
});

test('sendScript never embeds user text as shell words', () => {
  const text = "hello'; rm -rf / #$(id)`whoami`";
  const hex = Array.from(Buffer.from(text, 'utf8'), (b) => b.toString(16).padStart(2, '0'));
  const script = sendScript(NONCE, SOCKET, EXPECT, { hex });
  assert.equal(script.includes('rm -rf'), false);
  assert.equal(script.includes('$(id)'), false);
  assert.ok(script.includes(hex.join(' ')));
});

test('capture pipes through od and emits one capture record', () => {
  const script = captureScript(NONCE, SOCKET, EXPECT, { lines: 250 });
  assert.ok(script.includes("capture-pane -p -J -t '%7' -S -250"));
  assert.ok(script.includes("| od -An -v -tx1 | tr -d ' \\n'"));
  assert.ok(script.includes(`XC1${NONCE}\\037capture`));
  assert.equal(script.includes(' -e'), false);
  assertInvalid(() => captureScript(NONCE, SOCKET, EXPECT, { lines: 0 }));
  assertInvalid(() => captureScript(NONCE, SOCKET, EXPECT, { lines: 2001 }));
});

test('detach and kill target session/window/pane ids', () => {
  const detach = detachScript(NONCE, SOCKET, EXPECT);
  assert.ok(detach.includes("detach-client -s '$3'"));
  const pane = killScript(NONCE, SOCKET, EXPECT, 'pane');
  assert.ok(pane.includes("kill-pane -t '%7'"));
  const win = killScript(NONCE, SOCKET, { ...EXPECT, target: '@5' }, 'window');
  assert.ok(win.includes("kill-window -t '@5'"));
  const session = killScript(NONCE, SOCKET, { ...EXPECT, target: '$3' }, 'session');
  assert.ok(session.includes("kill-session -t '$3'"));
  assertInvalid(() => killScript(NONCE, SOCKET, EXPECT, 'client'));
});

test('creators and mutations reject non-string socket values instead of interpolating', () => {
  assertInvalid(() => createSessionScript(NONCE, { id: 'x', name: "a'; rm -rf /" }, { name: 'x' }));
  assertInvalid(() => inventoryScript(NONCE, { id: 'x', path: '/tmp/a\nb' }));
});

test('nonce is validated everywhere', () => {
  for (const bad of ['', 'xyz', 'A1B2C3D4E5F6', '0123456789ab0', '../']) {
    assertInvalid(() => inventoryScript(bad, SOCKET));
    assertInvalid(() => createSessionScript(bad, SOCKET, { name: 'x' }));
  }
});

test('no generated script ever contains set-option/set-environment/source-file', () => {
  const scripts = [
    inventoryScript(NONCE, SOCKET),
    createSessionScript(NONCE, SOCKET, { name: 'x', command: ['bash', '-l'] }),
    createWindowScript(NONCE, SOCKET, EXPECT, {}),
    splitPaneScript(NONCE, SOCKET, EXPECT, {}),
    sendScript(NONCE, SOCKET, EXPECT, { hex: ['61'], keys: ['Enter'], enter: true }),
    captureScript(NONCE, SOCKET, EXPECT, {}),
    detachScript(NONCE, SOCKET, EXPECT),
    killScript(NONCE, SOCKET, EXPECT, 'pane'),
  ];
  for (const script of scripts) {
    for (const forbidden of ['set-option', 'set-environment', 'setenv', 'source-file', 'respawn-']) {
      assert.equal(script.includes(forbidden), false, `${forbidden} in generated script`);
    }
    assert.equal(script.includes('StrictHostKeyChecking=no'), false);
  }
});

test('hostile command argv is quoted, never raw', () => {
  const script = createSessionScript(NONCE, SOCKET, {
    name: 'x',
    command: ["bash -c 'echo pwned'", '$(id)', '`whoami`'],
  });
  assert.ok(script.includes("'bash -c '\\''echo pwned'\\'''"));
  assert.ok(script.includes("'$(id)'"));
  assert.ok(script.includes("'`whoami`'"));
  assert.equal(script.includes('echo pwned\n'), false);
});
