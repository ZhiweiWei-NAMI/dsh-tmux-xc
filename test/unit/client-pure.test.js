import test from 'node:test';
import assert from 'node:assert/strict';

// Evaluating lib/client.js as a module runs only its top-level pure builders
// (the browser path is guarded on `window`) and publishes them on globalThis.
import '../../lib/client.js';

const pure = globalThis.__dshTmuxXcPure;

test('client-pure: pure builders are exported for Node evaluation', () => {
  assert.ok(pure, 'globalThis.__dshTmuxXcPure should be defined');
  for (const name of ['posixQuote', 'powerShellQuote', 'buildRemoteAttachCommand', 'attachCommandPosix', 'attachCommandPowerShell', 'killConfirmString', 'findInventoryTarget', 'kindTextFor', 'resourceLabel', 'rowTitle', 'childTaskAliases', 'menuPosition', 'tokenAt', 'canonicalToken']) {
    assert.equal(typeof pure[name], 'function', `${name} should be a function`);
  }
});

const displayLocales = {
  zh: { kindSession: '会话', kindWindow: '窗口', kindPane: '窗格', unknownCommand: '未知命令' },
  en: { kindSession: 'Session', kindWindow: 'Window', kindPane: 'Pane', unknownCommand: 'unknown command' },
};

for (const [locale, words] of Object.entries(displayLocales)) {
  const t = (key) => {
    assert.ok(Object.hasOwn(words, key), `unexpected translation key: ${key}`);
    return words[key];
  };

  test(`kindTextFor: ${locale} kind nouns, not delete actions`, () => {
    for (const [kind, key] of [['session', 'kindSession'], ['window', 'kindWindow'], ['pane', 'kindPane']]) {
      assert.equal(pure.kindTextFor(kind, t), words[key]);
    }
    assert.equal(pure.kindTextFor('unknown', t), '');
  });

  test(`resourceLabel: ${locale} same-command panes have distinct indexed titles without stable ids`, () => {
    const panes = [0, 1].map((index) => ({ index, cmd: 'bash', pid: 77 + index, sid: 33, wid: 55, uri: 'internal-uri' }));
    const labels = panes.map((pane) => pure.resourceLabel('pane', pane, t));
    assert.deepEqual(labels, [`${words.kindPane} 0 · bash`, `${words.kindPane} 1 · bash`]);
    for (const label of labels) assert.doesNotMatch(label, /[$@%]|33|55|77|78|internal-uri/);
    assert.equal(pure.resourceLabel('pane', { index: 2, cmd: '' }, t), `${words.kindPane} 2 · ${words.unknownCommand}`);
    assert.equal(pure.resourceLabel('pane', { pid: 77, cmd: 'bash' }, t), `${words.kindPane} ? · bash`);
  });

  test(`resourceLabel: ${locale} windows use display indices and names`, () => {
    assert.equal(pure.resourceLabel('window', { index: 0, name: 'shell', wid: 55 }, t), '0: shell');
    assert.equal(pure.resourceLabel('window', { index: 1, name: 'logs', wid: 56 }, t), '1: logs');
    assert.equal(pure.resourceLabel('session', { name: 'task', sid: 33 }, t), 'task');
  });

  test(`rowTitle: ${locale} alias wins without replacing the underlying row label`, () => {
    for (const [kind, source] of [['pane', { index: 0, cmd: 'bash' }], ['window', { index: 1, name: 'shell' }]]) {
      const label = pure.resourceLabel(kind, source, t);
      const node = { kind, label, alias: '  My\u202epane\n alias  ' };
      assert.equal(pure.rowTitle(node), 'Mypane alias');
      assert.equal(node.label, label);
      assert.equal(pure.rowTitle({ ...node, alias: '' }), label);
      assert.equal(pure.rowTitle({ ...node, alias: 'x'.repeat(50) }), 'x'.repeat(40));
    }
    assert.equal(pure.resourceLabel('pane', { index: 0, cmd: 'ba\u202esh\n' }, t), `${words.kindPane} 0 · bash`);
  });
}

test('rowTitle: repeated parent alias falls back to the indexed resource title, without changing action identity', () => {
  const pane = { kind: 'pane', alias: 'tmux 插件开发', label: 'Pane 0 · claude', uri: 'exact-pane-uri' };
  const before = { ...pane };
  assert.equal(pure.rowTitle(pane, '  tmux 插件开发  '), 'Pane 0 · claude');
  assert.equal(pure.rowTitle(pane, 'Other task'), 'tmux 插件开发');
  assert.equal(pure.rowTitle(pane), 'tmux 插件开发');
  assert.deepEqual(pane, before);
});

test('childTaskAliases: distinct child tasks remain discoverable in a collapsed session', () => {
  const session = { alias: 'Main task', windows: [
    { alias: 'tmux 插件开发', panes: [{ alias: 'tmux 插件开发' }, { alias: ' Logs\n task ' }] },
    { alias: 'Main task', panes: [{ alias: '' }, { alias: 'Logs task' }, { alias: 'A\u202eudit' }] },
  ] };
  const before = structuredClone(session);
  assert.deepEqual(pure.childTaskAliases(session), ['tmux 插件开发', 'Logs task', 'Audit']);
  assert.deepEqual(pure.childTaskAliases({ windows: [{ panes: [{}] }] }), []);
  assert.deepEqual(pure.childTaskAliases({}), []);
  assert.deepEqual(session, before);
});

test('menuPosition: flip the bottom host menu above its trigger and clamp the right edge at 1500×950', () => {
  assert.deepEqual(pure.menuPosition(
    { left: 1460, top: 905, bottom: 923 }, { width: 180, height: 60 }, { width: 1500, height: 950 },
  ), { left: 1312, top: 843 });
  assert.deepEqual(pure.menuPosition(
    { left: 100, top: 100, bottom: 118 }, { width: 240, height: 160 }, { width: 1500, height: 950 },
  ), { left: 100, top: 120 });
  assert.deepEqual(pure.menuPosition(
    { left: -20, top: 90, bottom: 108 }, { width: 600, height: 400 }, { width: 320, height: 200 },
  ), { left: 8, top: 8 });
});

// Verbatim failing stored reference from independent SOL browser-actions line 35.
// A pure regression is not a substitute for the manager's sent-chip click/reload recheck.
const storedSolToken = '@[NaMILab ssh loopback · 窗格 sol-agent-owned:0.0 %11](dsh-tmux:v1/lab/dea37f45406a/e2e/3822029-1792321037/pane/7/9/11)';

test('tmux history rule: complete spaced stored token wins the same-start tie with the generic file rule', () => {
  const rule = pure.tmuxUserTextRule;
  const text = storedSolToken + '  Navigation test only: acknowledge this reference.';
  const tmux = rule.match(text, 0);
  assert.equal(rule.id, 'tmux-xc');
  assert.ok(rule.order < 30, 'DSH file/folder rules have order 30; lower order wins equal-start ties');
  assert.deepEqual(tmux, {
    id: 'tmux-xc', start: 0, end: storedSolToken.length,
    data: { label: 'NaMILab ssh loopback · 窗格 sol-agent-owned:0.0 %11', uri: 'dsh-tmux:v1/lab/dea37f45406a/e2e/3822029-1792321037/pane/7/9/11' },
  });
  // DSH ui-reference nextPath uses this broad whitespace-delimited file grammar.
  const fileMatch = /(?<!\S)(@"[^"\n]+"|@[^\s]+)/gu.exec(text);
  assert.equal(fileMatch[0], '@[NaMILab');
  const file = { id: 'file', start: fileMatch.index, end: fileMatch.index + fileMatch[0].length };
  // DSH ui-conversation:3908 sorts ascending; :3750 only replaces an earlier start.
  const winner = [{ order: 30, node: file }, { order: rule.order, node: tmux }]
    .sort((a, b) => a.order - b.order)
    .reduce((best, item) => !best || item.node.start < best.start ? item.node : best, undefined);
  assert.equal(winner.id, 'tmux-xc');
  assert.equal(rule.match(text, storedSolToken.length), undefined);
  assert.deepEqual(rule.match(text, 0), tmux, 're-evaluating stored text needs no composer state');
});

test('tokenAt/canonicalToken: preserve full wire identity, labels and ranges; reject partial/non-tmux tokens', () => {
  const parsed = pure.canonicalToken(storedSolToken);
  assert.equal(parsed.uri, 'dsh-tmux:v1/lab/dea37f45406a/e2e/3822029-1792321037/pane/7/9/11');
  assert.equal(parsed.ref.pid, 11);
  const text = '@notes.txt before ' + storedSolToken + ' after ' + storedSolToken;
  const first = pure.tokenAt(text, 0);
  assert.equal(text.slice(first.start, first.end), storedSolToken);
  const second = pure.tokenAt(text, first.end);
  assert.ok(second.start > first.end);
  assert.equal(text.slice(second.start, second.end), storedSolToken);
  assert.equal(pure.canonicalToken(storedSolToken, parsed.uri).uri, parsed.uri);
  for (const token of [undefined, '', storedSolToken.slice(0, -1), 'prefix ' + storedSolToken, storedSolToken + ' suffix', '@[File label](file:///tmp/a)']) {
    assert.equal(pure.canonicalToken(token), null);
  }
  assert.equal(pure.canonicalToken(storedSolToken, parsed.uri.replace('/11', '/12')), null);
  assert.equal(pure.tokenAt(storedSolToken.replace('ssh loopback', 'ssh\nloopback')), undefined);
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

const targetKinds = [
  ['session', 'sid', '$'],
  ['window', 'wid', '@'],
  ['pane', 'pid', '%'],
];

test('killConfirmString: zero is a valid stable id for every target kind', () => {
  for (const [kind, , prefix] of targetKinds) {
    assert.equal(
      pure.killConfirmString({ kind, hostId: 'lab', socketId: 'xc', sid: 0, wid: 0, pid: 0 }),
      `lab:xc:${prefix}0`,
    );
  }
});

test('killConfirmString: rejects nonnumeric, negative, fractional and unsafe stable ids', () => {
  const invalidIds = [undefined, null, '', '0', '7', false, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const [kind, id] of targetKinds) {
    for (const value of invalidIds) {
      const node = { kind, hostId: 'lab', socketId: 'xc', sid: 1, wid: 2, pid: 7, [id]: value };
      assert.equal(pure.killConfirmString(node), null, `${kind} must reject ${String(value)}`);
    }
  }
});

test('killConfirmString: aliases and names never replace host/socket identity', () => {
  for (const [kind, , prefix] of targetKinds) {
    const node = {
      kind, hostId: 'lab', socketId: 'xc', sid: 7, wid: 7, pid: 7,
      alias: 'renamed-host', name: 'renamed-target', ssh: 'other-host',
      hostName: 'display-host', socketName: 'display-socket',
    };
    assert.equal(pure.killConfirmString(node), `lab:xc:${prefix}7`);
    for (const field of ['hostId', 'socketId']) {
      for (const value of [undefined, null, '', 0]) {
        assert.equal(pure.killConfirmString({ ...node, [field]: value }), null);
      }
    }
  }
  for (const kind of [undefined, '', 'host', 'server', 'unknown']) {
    assert.equal(pure.killConfirmString({ kind, hostId: 'lab', socketId: 'xc', sid: 0, wid: 0, pid: 0 }), null);
  }
});

function inventoryUri(kind, sid, wid = '-', pid = '-', identity = {}) {
  const { hostId = 'lab', hostFp = '012345abcdef', socketId = 'xc', gen = '123-456' } = identity;
  return `dsh-tmux:v1/${hostId}/${hostFp}/${socketId}/${gen}/${kind}/${sid}/${wid}/${pid}`;
}

function inventoryFixture({ sid = 1, wid = 2, pid = 7, ...identity } = {}) {
  const pane = { kind: 'pane', sid, wid, pid, uri: inventoryUri('pane', sid, wid, pid, identity), name: 'fresh pane' };
  const window = { kind: 'window', sid, wid, uri: inventoryUri('window', sid, wid, '-', identity), panes: [pane] };
  const session = { kind: 'session', sid, uri: inventoryUri('session', sid, '-', '-', identity), windows: [window] };
  const socket = { id: identity.socketId || 'xc', gen: identity.gen || '123-456', sessions: [session] };
  const host = { id: identity.hostId || 'lab', fp: identity.hostFp || '012345abcdef', sockets: [socket] };
  return { inventory: { hosts: [host] }, host, socket, session, window, pane };
}

function assertInventoryTarget(actual, fixture, kind) {
  const keys = ['host', 'socket', 'session'];
  if (kind !== 'session') keys.push('window');
  if (kind === 'pane') keys.push('pane');
  assert.ok(actual, `${kind} target should be found`);
  assert.deepEqual(Object.keys(actual).sort(), [...keys, 'node'].sort());
  for (const key of keys) assert.equal(actual[key], fixture[key], `${key} must be the current inventory object`);
  assert.equal(actual.node, fixture[kind], 'node must be the fresh inventory object, not a decoded or cached ref');
}

test('findInventoryTarget: selects exact full URIs for session/window/pane, not same-id decoys', () => {
  const fresh = inventoryFixture();
  const decoy = inventoryFixture({ sid: 9, wid: 8 });
  fresh.inventory.hosts.unshift(decoy.host);
  for (const [kind] of targetKinds) {
    assertInventoryTarget(pure.findInventoryTarget(fresh.inventory, fresh[kind].uri), fresh, kind);
  }
  assertInventoryTarget(pure.findInventoryTarget(fresh.inventory.hosts, fresh.pane.uri), fresh, 'pane');
  assertInventoryTarget(pure.findInventoryTarget(fresh.inventory, fresh.pane.uri, true), fresh, 'pane');
});

test('findInventoryTarget: ancestry changes require explicit relocation', () => {
  const fresh = inventoryFixture({ sid: 11, wid: 12 });
  assert.equal(pure.findInventoryTarget(fresh.inventory, inventoryUri('pane', 1, 2, 7)), null);
  assert.equal(pure.findInventoryTarget(fresh.inventory, inventoryUri('pane', 1, 2, 7), false), null);
  assert.equal(pure.findInventoryTarget(fresh.inventory, inventoryUri('window', 1, 12)), null);
});

test('findInventoryTarget: relocated pane returns its fresh URI and current session/window ancestry', () => {
  const oldUri = inventoryUri('pane', 1, 2, 7);
  const fresh = inventoryFixture({ sid: 11, wid: 12 });
  const result = pure.findInventoryTarget(fresh.inventory, oldUri, true);
  assertInventoryTarget(result, fresh, 'pane');
  assert.equal(result.node.uri, inventoryUri('pane', 11, 12, 7));
  assert.notEqual(result.node.uri, oldUri);
});

test('findInventoryTarget: relocated window returns its fresh URI and current session ancestry', () => {
  const oldUri = inventoryUri('window', 1, 2);
  const fresh = inventoryFixture({ sid: 11 });
  const result = pure.findInventoryTarget(fresh.inventory, oldUri, true);
  assertInventoryTarget(result, fresh, 'window');
  assert.equal(result.node.uri, inventoryUri('window', 11, 2));
  assert.notEqual(result.node.uri, oldUri);
});

test('findInventoryTarget: missing stable targets never fall back to neighboring nodes', () => {
  const fresh = inventoryFixture();
  for (const uri of [inventoryUri('session', 99), inventoryUri('window', 1, 99), inventoryUri('pane', 1, 2, 99)]) {
    for (const relocated of [false, true]) {
      assert.equal(pure.findInventoryTarget(fresh.inventory, uri, relocated), null);
    }
  }
});

test('findInventoryTarget: replacement generation/fingerprint or different host/socket never relocates', () => {
  const original = inventoryFixture();
  for (const identity of [
    { gen: '123-999' },
    { hostFp: 'fedcba543210' },
    { hostId: 'other-lab' },
    { socketId: 'other-socket' },
  ]) {
    const replacement = inventoryFixture(identity);
    for (const [kind] of targetKinds) {
      for (const relocated of [false, true]) {
        assert.equal(pure.findInventoryTarget(replacement.inventory, original[kind].uri, relocated), null);
      }
    }
  }
});

test('findInventoryTarget: matching numeric ids from a different kind never match', () => {
  const fresh = inventoryFixture({ sid: 1, wid: 2, pid: 7 });
  for (const uri of [inventoryUri('session', 7), inventoryUri('window', 1, 7), inventoryUri('pane', 1, 2, 2)]) {
    assert.equal(pure.findInventoryTarget(fresh.inventory, uri, true), null);
  }
});

test('findInventoryTarget: malformed references and absent inventories safely return null', () => {
  const fresh = inventoryFixture();
  const malformed = [
    undefined, null, {}, 7, '', 'not-a-uri', 'dsh-tmux:v1/lab',
    'dsh-tmux:v2/lab/012345abcdef/xc/123-456/pane/1/2/7',
    'dsh-tmux:v1/lab/012345abcdef/xc//pane/1/2/7',
    inventoryUri('pane', 1, 2, '-'),
    inventoryUri('pane', 1, 2, -1),
    inventoryUri('pane', 1, 2, 0.5),
    inventoryUri('pane', 1, 2, Number.MAX_SAFE_INTEGER + 1),
    inventoryUri('unknown', 1, 2, 7),
    inventoryUri('server', '-', '-', '-'),
    `${fresh.pane.uri}/extra`,
  ];
  for (const uri of malformed) {
    for (const relocated of [false, true]) {
      assert.equal(pure.findInventoryTarget(fresh.inventory, uri, relocated), null, `must reject ${String(uri)}`);
    }
  }
  for (const inventory of [undefined, null, [], {}, { hosts: [] }]) {
    assert.equal(pure.findInventoryTarget(inventory, fresh.pane.uri, true), null);
  }
});
