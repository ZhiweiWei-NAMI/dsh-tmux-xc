import test from 'node:test';
import assert from 'node:assert/strict';

// Evaluating lib/client.js as a module runs only its top-level pure builders
// (the browser path is guarded on `window`) and publishes them on globalThis.
import '../../lib/client.js';

const pure = globalThis.__dshTmuxXcPure;

test('client-pure: pure builders are exported for Node evaluation', () => {
  assert.ok(pure, 'globalThis.__dshTmuxXcPure should be defined');
  for (const name of ['posixQuote', 'powerShellQuote', 'buildRemoteAttachCommand', 'attachCommandPosix', 'attachCommandPowerShell', 'killConfirmString']) {
    assert.equal(typeof pure[name], 'function', `${name} should be a function`);
  }
});

test('posixQuote single-quotes and escapes embedded quotes', () => {
  assert.equal(pure.posixQuote('abc'), "'abc'");
  assert.equal(pure.posixQuote("a'b"), "'a'\\''b'");
});

test('powerShellQuote single-quotes and doubles embedded quotes', () => {
  assert.equal(pure.powerShellQuote('NaMILab'), "'NaMILab'");
  assert.equal(pure.powerShellQuote("a'b"), "'a''b'");
});

const sshHost = { transport: 'ssh', ssh: 'NaMILab' };
const localHost = { transport: 'local' };

test('buildRemoteAttachCommand: session -> attach only (socket by name)', () => {
  const cmd = pure.buildRemoteAttachCommand({ kind: 'session', sid: 3 }, { name: 'xc' });
  assert.equal(cmd, "tmux -L 'xc' attach -t '$3'");
});

test('buildRemoteAttachCommand: window -> attach + select-window', () => {
  const cmd = pure.buildRemoteAttachCommand({ kind: 'window', sid: 3, wid: 5 }, { name: 'xc' });
  assert.equal(cmd, "tmux -L 'xc' attach -t '$3' \\; select-window -t '@5'");
});

test('buildRemoteAttachCommand: pane -> attach + select-window + select-pane (socket by path)', () => {
  const cmd = pure.buildRemoteAttachCommand({ kind: 'pane', sid: 1, wid: 2, pid: 3 }, { path: '/tmp/tmux-lab/sock' });
  assert.equal(cmd, "tmux -S '/tmp/tmux-lab/sock' attach -t '$1' \\; select-window -t '@2' \\; select-pane -t '%3'");
});

test('buildRemoteAttachCommand: default socket (no name/path) omits -L/-S', () => {
  const cmd = pure.buildRemoteAttachCommand({ kind: 'pane', sid: 1, wid: 2, pid: 3 }, { id: 'default' });
  assert.equal(cmd, "tmux attach -t '$1' \\; select-window -t '@2' \\; select-pane -t '%3'");
});

test('buildRemoteAttachCommand: rejects missing/invalid ids', () => {
  assert.equal(pure.buildRemoteAttachCommand({ kind: 'session', sid: null }, { name: 'xc' }), null);
  assert.equal(pure.buildRemoteAttachCommand({ kind: 'window', sid: 1 }, { name: 'xc' }), null); // no wid
  assert.equal(pure.buildRemoteAttachCommand({ kind: 'pane', sid: 1, wid: 2 }, { name: 'xc' }), null); // no pid
  assert.equal(pure.buildRemoteAttachCommand({ kind: 'pane', sid: 1, wid: 2, pid: 3 }, null), null);
});

test('attachCommandPosix: ssh form is ssh -t -o ClearAllForwardings=yes <alias> <posixQuote(remoteCommand)>', () => {
  const node = { kind: 'pane', sid: 1, wid: 2, pid: 3 };
  const remote = pure.buildRemoteAttachCommand(node, { name: 'xc' });
  const cmd = pure.attachCommandPosix(node, sshHost, { name: 'xc' });
  const prefix = "ssh -t -o ClearAllForwardings=yes 'NaMILab' ";
  assert.ok(cmd.startsWith(prefix), `cmd should start with ssh prefix: ${cmd}`);
  assert.equal(cmd, prefix + pure.posixQuote(remote));
});

test('attachCommandPosix: local transport returns the bare remote command', () => {
  const cmd = pure.attachCommandPosix({ kind: 'pane', sid: 1, wid: 2, pid: 3 }, localHost, { name: 'xc' });
  assert.equal(cmd, "tmux -L 'xc' attach -t '$1' \\; select-window -t '@2' \\; select-pane -t '%3'");
});

test('attachCommandPosix: rejects missing or unsafe host metadata', () => {
  assert.equal(pure.attachCommandPosix({ kind: 'session', sid: 1 }, null, { name: 'xc' }), null);
  assert.equal(pure.attachCommandPosix({ kind: 'session', sid: 1 }, { transport: 'ssh', ssh: '-oBatchMode' }, { name: 'xc' }), null);
  assert.equal(pure.attachCommandPosix({ kind: 'session', sid: 1 }, { transport: 'ssh' }, { name: 'xc' }), null);
});

test('attachCommandPowerShell: matches the documented pane example shape', () => {
  const cmd = pure.attachCommandPowerShell({ kind: 'pane', sid: 1, wid: 2, pid: 3 }, sshHost, { name: 'xc' });
  // Alias and remote command each wrapped in PowerShell single quotes, embedded
  // quotes doubled; the remote command contains no double quotes.
  assert.equal(
    cmd,
    "ssh -t -o ClearAllForwardings=yes 'NaMILab' 'tmux -L ''xc'' attach -t ''$1'' \\; select-window -t ''@2'' \\; select-pane -t ''%3'''",
  );
  assert.ok(!cmd.includes('"'), 'remote command must not contain double quotes');
});

test('attachCommandPowerShell: local transport is not supported (no ssh alias)', () => {
  assert.equal(pure.attachCommandPowerShell({ kind: 'session', sid: 1 }, localHost, { name: 'xc' }), null);
});

// killConfirmString mirrors lib/core/uri.js `targetString(ref)`, which the
// POST /api/tmux-xc/kill route requires as `confirm` (hostId:socketId:$sid / @wid / %pid).
test('killConfirmString: mirrors targetString for session/window/pane', () => {
  assert.equal(pure.killConfirmString({ kind: 'session', hostId: 'lab', socketId: 'default', sid: 3 }), 'lab:default:$3');
  assert.equal(pure.killConfirmString({ kind: 'window', hostId: 'lab', socketId: 'xc', sid: 3, wid: 5 }), 'lab:xc:@5');
  assert.equal(pure.killConfirmString({ kind: 'pane', hostId: 'lab', socketId: 'xc', sid: 1, wid: 2, pid: 7 }), 'lab:xc:%7');
});

test('killConfirmString: rejects invalid ids / kinds / missing fields', () => {
  assert.equal(pure.killConfirmString(null), null);
  assert.equal(pure.killConfirmString({}), null);
  assert.equal(pure.killConfirmString({ kind: 'session', socketId: 'default', sid: 3 }), null); // no hostId
  assert.equal(pure.killConfirmString({ kind: 'session', hostId: 'lab', sid: 3 }), null); // no socketId
  assert.equal(pure.killConfirmString({ kind: 'session', hostId: 'lab', socketId: 'default', sid: null }), null);
  assert.equal(pure.killConfirmString({ kind: 'window', hostId: 'lab', socketId: 'default', sid: 3 }), null); // no wid
  assert.equal(pure.killConfirmString({ kind: 'pane', hostId: 'lab', socketId: 'default', sid: 1, wid: 2 }), null); // no pid
  assert.equal(pure.killConfirmString({ kind: 'server', hostId: 'lab', socketId: 'default' }), null);
});
