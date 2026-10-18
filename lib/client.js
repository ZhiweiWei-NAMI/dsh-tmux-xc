// dsh-tmux-xc browser bundle, v1.0.0 — host groups and flat task cards.
//
// A DSH web client for cross-conversation remote tmux: a right-sidebar panel that
// lists flat task cards grouped by host, opens a new native terminal, and inserts a durable tmux
// reference chip into the composer, re-renders those chips in the sent-message
// history, and opens a read-only capture preview when a chip is clicked. It talks
// to the host only through the owner-only HTTP routes declared in
// docs/review/ROUTES-v2.md / v011-CONTRACT-2.md (document-relative fetch,
// same-origin).
//
// This file is loaded by the DSH module loader as a classic script:
//   window.__ModuleLoader__.load({ id: 'dsh-tmux-xc', factory: (require) => ({ inject, apply }) })
//
// No JSX (we use react/jsx-runtime), no build step, plain browser code. Remote
// strings are always rendered as React text nodes; the token grammar from
// docs/CONTRACTS.md is re-implemented here rather than imported from host code.
//
// Pure helpers (command builders, kill confirmation and inventory lookup) are
// defined at top level (no React, no browser APIs) so they can be unit-tested:
// when this file is evaluated outside a browser it publishes them on
// globalThis.__dshTmuxXcPure (see test/unit/client-pure.test.js).

// --------------------------------------------------------------------------
// Pure helpers (no React, no browser APIs).
// --------------------------------------------------------------------------

function posixQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// Client-side label sanitation (defense in depth for remote display values).
function cleanLabel(label, max = 120) {
  let s = String(label ?? '');
  s = s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(s);
  if (points.length > max) s = points.slice(0, max).join('');
  return s;
}

function kindTextFor(kind, t) {
  if (kind === 'session') return t('kindSession');
  if (kind === 'window') return t('kindWindow');
  if (kind === 'pane') return t('kindPane');
  return '';
}

// Row titles use display indices, never durable target ids or URIs.
function resourceLabel(kind, node, t) {
  if (kind === 'window') return (node.index ?? '?') + ': ' + cleanLabel(node.name);
  if (kind === 'pane') return kindTextFor(kind, t) + ' ' + (node.index ?? '?') + ' · ' + (cleanLabel(node.cmd) || t('unknownCommand'));
  return cleanLabel(node.name);
}

function rowTitle(node, parentAlias) {
  const alias = cleanLabel(node.alias, 40);
  if (alias && alias !== cleanLabel(parentAlias, 40)) return alias;
  return cleanLabel(node.label, 120);
}

// Summarize existing task aliases without changing the tree or action targets.
function taskCardTitle(pane, window, session) {
  const onePane = (window.panes || []).length === 1;
  const oneTask = (session.windows || []).length === 1 && onePane;
  const ownAlias = cleanLabel(pane.alias, 40);
  if (ownAlias) return ownAlias;
  const project = cleanLabel(session.alias, 40) || cleanLabel(session.name);
  const work = cleanLabel(window.alias, 40) || cleanLabel(window.name) || cleanLabel(pane.cmd) || 'tmux';
  if (oneTask) return cleanLabel(window.alias, 40) || project || work;
  const windowLabel = (session.windows || []).length > 1 ? work + ' ' + ((window.index ?? 0) + 1) : work;
  const title = project && project !== work ? project + ' · ' + windowLabel : windowLabel;
  return title + (onePane ? '' : ' #' + ((pane.index ?? 0) + 1));
}

function flatTasks(inventory) {
  const hosts = Array.isArray(inventory) ? inventory : inventory?.hosts || [];
  return hosts.map(host => {
    const tasks = [];
    const seen = new Map();
    for (const socket of host.sockets || []) for (const session of socket.sessions || []) {
      for (const window of session.windows || []) for (const pane of window.panes || []) {
        const ref = decodeUri(pane.uri);
        // Linked windows can place one pane under several sessions. Keep one card,
        // retaining every exact ancestor URI for reference navigation.
        const key = ref ? [ref.hostId, ref.hostFp, ref.socketId, ref.gen, ref.pid].join('|') : pane.uri;
        if (key && seen.has(key)) {
          seen.get(key).links.push({ session, window, pane });
          continue;
        }
        const task = { socket, session, window, pane, links: [{ session, window, pane }] };
        tasks.push(task);
        if (key) seen.set(key, task);
      }
    }
    tasks.sort((a,b) => Number(!!(b.pane.adopted || b.pane.origin)) - Number(!!(a.pane.adopted || a.pane.origin))
      || taskCardTitle(a.pane,a.window,a.session).localeCompare(taskCardTitle(b.pane,b.window,b.session)));
    return { host, tasks };
  });
}

function childTaskAliases(session) {
  const aliases = new Set();
  const ownAlias = cleanLabel(session.alias, 40);
  for (const window of session.windows || []) {
    for (const node of [window, ...(window.panes || [])]) {
      const alias = cleanLabel(node.alias, 40);
      if (alias && alias !== ownAlias) aliases.add(alias);
    }
  }
  return [...aliases];
}

// Fixed, body-portaled popups: prefer below, flip above, then clamp to the viewport.
function menuPosition(anchor, size, viewport, margin = 8) {
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(size.height, Math.max(0, viewport.height - margin * 2));
  const clamp = (value, max) => Math.max(margin, Math.min(value, max - margin));
  const below = anchor.bottom + 2;
  const top = below + height <= viewport.height - margin ? below : anchor.top - height - 2;
  return {
    left: clamp(anchor.left, viewport.width - width),
    top: clamp(top, viewport.height - height),
  };
}

// PowerShell single-quoting: wrap in ' and double every embedded '.
function powerShellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// The remote-side tmux command (POSIX sh). Keeps the exact socket (-S path |
// -L name), exact $sid, and per-kind @wid / %pid targeting. Returns null for
// invalid ids so a copy can never select the default socket/transport silently.
function buildRemoteAttachCommand(node, socketMeta) {
  if (!node || !socketMeta) return null;
  const validId = (id) => Number.isSafeInteger(id) && id >= 0;
  if (!validId(node.sid)) return null;
  const parts = ['tmux'];
  if (socketMeta.path) parts.push('-S', posixQuote(socketMeta.path));
  else if (socketMeta.name) parts.push('-L', posixQuote(socketMeta.name));
  parts.push('attach', '-t', posixQuote('$' + node.sid));
  if (node.kind === 'window' || node.kind === 'pane') {
    if (!validId(node.wid)) return null;
    parts.push('\\;', 'select-window', '-t', posixQuote('@' + node.wid));
  }
  if (node.kind === 'pane') {
    if (!validId(node.pid)) return null;
    parts.push('\\;', 'select-pane', '-t', posixQuote('%' + node.pid));
  }
  return parts.join(' ');
}

// Bash / Linux / macOS / Git Bash form:
//   ssh -t -o ClearAllForwardings=yes <posixQuote(alias)> <posixQuote(remoteCommand)>
function attachCommandPosix(node, hostMeta, socketMeta) {
  if (!hostMeta || !socketMeta) return null;
  const command = buildRemoteAttachCommand(node, socketMeta);
  if (!command) return null;
  if (hostMeta.transport === 'local') return command;
  if (hostMeta.transport !== 'ssh' || typeof hostMeta.ssh !== 'string' || !hostMeta.ssh || hostMeta.ssh.startsWith('-')) return null;
  return 'ssh -t -o ClearAllForwardings=yes ' + posixQuote(hostMeta.ssh) + ' ' + posixQuote(command);
}

// Windows PowerShell form. cmd.exe is NOT supported (its % / quoting rules differ
// from POSIX and PowerShell); the remote command from buildRemoteAttachCommand
// never contains '"', and $ % @ ; are literal inside PowerShell single quotes.
function attachCommandPowerShell(node, hostMeta, socketMeta) {
  if (!hostMeta || !socketMeta) return null;
  const command = buildRemoteAttachCommand(node, socketMeta);
  if (!command) return null;
  if (hostMeta.transport !== 'ssh' || typeof hostMeta.ssh !== 'string' || !hostMeta.ssh || hostMeta.ssh.startsWith('-')) return null;
  return 'ssh -t -o ClearAllForwardings=yes ' + powerShellQuote(hostMeta.ssh) + ' ' + powerShellQuote(command);
}

// Only discovered, supported command languages may receive generated input.
function terminalShell(shells, host) {
  const name = shell => String(shell.path || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  return (host?.transport !== 'local' && shells.find(shell => /^(pwsh|powershell)(\.exe)?$/.test(name(shell))))
    || shells.find(shell => /^(bash|zsh|sh|dash)(\.exe)?$/.test(name(shell))) || null;
}

function terminalAttachCommand(node, host, socket, shell) {
  const path = String(shell?.path || '').replace(/\\/g, '/');
  const powerShell = /(?:^|\/)(?:pwsh|powershell)(?:\.exe)?$/i.test(path);
  if (!powerShell && !/(?:^|\/)(?:bash|zsh|sh|dash)(?:\.exe)?$/i.test(path)) return null;
  if (!/^\d+-\d+$/.test(node?.gen || '') || !host || !socket || node.kind !== 'pane') return null;
  if ([host.ssh, socket.path, socket.name].some(value => value != null && /[\x00-\x1f\x7f]/.test(value))) return null;
  if (!buildRemoteAttachCommand(node, socket)) return null;
  const base = 'tmux' + (socket.path ? ' -S ' + posixQuote(socket.path) : socket.name ? ' -L ' + posixQuote(socket.name) : '');
  const target = '$' + node.sid + ':@' + node.wid + '.%' + node.pid;
  const checks = ['#{==:#{pid}-#{start_time},' + node.gen + '}', '#{==:#{session_id},$' + node.sid + '}', '#{==:#{window_id},@' + node.wid + '}', '#{==:#{pane_id},%' + node.pid + '}'];
  const condition = checks.reduce((a,b) => '#{&&:' + a + ',' + b + '}', '1');
  // Single-quoted tmux parser arguments use the same literal escape grammar.
  const actions = 'select-window -t ' + posixQuote('$' + node.sid + ':@' + node.wid) + ' ; select-pane -t ' + posixQuote('%' + node.pid) + ' ; attach-session -t ' + posixQuote('$' + node.sid);
  // One native tmux queue: no second process can attach to a restarted server.
  const guarded = base + ' if-shell -F -t ' + posixQuote(target) + ' ' + posixQuote(condition) + ' ' + posixQuote(actions) + ' ' + posixQuote("display-message -p 'tmux target changed; refresh the task list.'");
  if (host.transport === 'local') return powerShell ? null : guarded;
  if (host.transport !== 'ssh' || typeof host.ssh !== 'string' || !host.ssh || host.ssh.startsWith('-')) return null;
  // Windows PowerShell legacy argv marshaling cannot preserve embedded double quotes.
  if (powerShell && (guarded.includes('"') || host.ssh.includes('"'))) return null;
  const quote = powerShell ? powerShellQuote : posixQuote;
  return 'ssh -t -o ClearAllForwardings=yes ' + quote(host.ssh) + ' ' + quote(guarded);
}

// The exact `kill` confirmation string, mirrored from lib/core/uri.js
// `targetString(ref)` so the panel can compute the value the POST /kill route
// expects without guessing: `hostId:socketId:$sid` / `@wid` / `%pid` by kind.
// Returns null when the node data cannot produce a valid target string.
function killConfirmString(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.hostId !== 'string' || !node.hostId) return null;
  if (typeof node.socketId !== 'string' || !node.socketId) return null;
  if (node.kind === 'session') {
    if (!Number.isSafeInteger(node.sid) || node.sid < 0) return null;
    return node.hostId + ':' + node.socketId + ':$' + node.sid;
  }
  if (node.kind === 'window') {
    if (!Number.isSafeInteger(node.wid) || node.wid < 0) return null;
    return node.hostId + ':' + node.socketId + ':@' + node.wid;
  }
  if (node.kind === 'pane') {
    if (!Number.isSafeInteger(node.pid) || node.pid < 0) return null;
    return node.hostId + ':' + node.socketId + ':%' + node.pid;
  }
  return null;
}

function decodeUri(uri) {
  if (typeof uri !== 'string') return null;
  const m = /^dsh-tmux:v1\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(host|server|session|window|pane)\/([^/]*)\/([^/]*)\/([^/]*)$/.exec(uri);
  if (!m) return null;
  const num = (s) => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
  return { hostId: m[1], hostFp: m[2], socketId: m[3], gen: m[4], kind: m[5], sid: num(m[6]), wid: num(m[7]), pid: num(m[8]) };
}

// Complete wire tokens only; spaces and · belong to the label, not file mentions.
const TMUX_TOKEN_SOURCE = /@\[([^\[\]()`\n\r]*)\]\(([^()\s]+)\)/gu;

function tokenAt(text, from = 0) {
  const re = new RegExp(TMUX_TOKEN_SOURCE.source, 'gu');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ref = decodeUri(m[2]);
    if (ref) return { start: m.index, end: m.index + m[0].length, label: m[1], uri: m[2], ref };
  }
  return undefined;
}

function tokenSafeLabel(label, max = 80) {
  return cleanLabel(label, max).replace(/[\[\]()]/g, '').replace(/`/g, '').trim();
}

// Never rebuild server tokens or derive chip labels from inventory row titles.
function canonicalToken(token, uri) {
  if (typeof token !== 'string') return null;
  const found = tokenAt(token, 0);
  if (!found || found.start !== 0 || found.end !== token.length) return null;
  if (uri !== undefined && found.uri !== uri) return null;
  return found;
}

function chipLabel(label) {
  return tokenSafeLabel(label) || 'tmux';
}

// Installed DSH client sources (all paths below end in /lib/client.js):
// dsh-client-ui-conversation:3908 sorts by "a.order - b.order"; :3748–3750
// replaces the winner only for "node.start < winner.start", so same-start ties
// keep the earlier rule. dsh-client-ui-reference:89–98 has id:"file", order:30
// and :69 matches @[^\s]+ (including the start of a spaced tmux token).
// Use 25: after the session/skill rules (10/20), before generic file/folder (30).
// Slot priority is NOT parser precedence; UserText dispatches by node.id at
// dsh-client-ui-conversation:4207–4215. This also reconstructs stored text on reload.
const tmuxUserTextRule = {
  id: 'tmux-xc',
  order: 25,
  match(text, from) {
    const found = tokenAt(text, from);
    if (!found) return undefined;
    return { id: 'tmux-xc', start: found.start, end: found.end, data: { label: chipLabel(found.label), uri: found.uri } };
  },
};

// Relocation may change ancestry, never host fingerprint, generation or target id.
// The caller still selects/actions the full URI supplied by the fresh inventory.
function findInventoryTarget(inventory, uri, relocated = false) {
  const ref = decodeUri(uri);
  if (!ref || !['session', 'window', 'pane'].includes(ref.kind)) return null;
  const id = ref.kind === 'session' ? 'sid' : ref.kind === 'window' ? 'wid' : 'pid';
  if (ref[id] == null) return null;
  if (relocated) {
    const exact = findInventoryTarget(inventory, uri);
    if (exact) return exact; // Prefer the original link when a window has several parents.
  }
  const matches = (node) => {
    if (node.uri === uri) return true;
    if (!relocated) return false;
    const fresh = decodeUri(node.uri);
    return fresh && ['hostId', 'hostFp', 'socketId', 'gen', 'kind', id].every((key) => fresh[key] === ref[key]);
  };
  const hosts = Array.isArray(inventory) ? inventory : inventory?.hosts || [];
  for (const host of hosts) for (const socket of host.sockets || []) for (const session of socket.sessions || []) {
    const path = { host, socket, session };
    if (ref.kind === 'session' && matches(session)) return { ...path, node: session };
    for (const window of session.windows || []) {
      if (ref.kind === 'window' && matches(window)) return { ...path, window, node: window };
      for (const pane of window.panes || []) {
        if (ref.kind === 'pane' && matches(pane)) return { ...path, window, pane, node: pane };
      }
    }
  }
  return null;
}

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
window.__ModuleLoader__.load({
  id: 'dsh-tmux-xc',
  factory: (require) => {
    const react = require('react');
    const { createPortal } = require('react-dom');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');

    // --------------------------------------------------------------------------
    // Constants
    // --------------------------------------------------------------------------

    const NS = 'tmux-xc';           // locale namespace
    const TAB_ID = 'tmux-xc';       // sidebar tab id and kind (same string)
    const SOURCE_NAME = 'tmux-xc';  // input-trigger source name
    const API_PREFIX = './api/tmux-xc';

    const LS_ADVANCED = 'dsh-tmux-xc:advanced';
    const LS_FONT = 'dsh-tmux-xc:fontSize';

    const FONT_MIN = 10;
    const FONT_MAX = 18;
    const FONT_DEFAULT = 13;
    const VERSION_POLL_MS = 3000;
    const TICKER_MS = 30000;

    function readStorage(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    }
    function writeStorage(key, value) {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    }

    // --------------------------------------------------------------------------
    // Pending-target handoff store (module scope). The history chip renderer and
    // the composer `openReference` hook live outside the panel; they publish the
    // uri to open here, keyed by sessionId, and the panel consumes it on mount or
    // immediately when it is already mounted. No cross-session leakage.
    // --------------------------------------------------------------------------

    const pendingTargets = new Map();   // sessionId -> uri
    const pendingListeners = new Map(); // sessionId -> Set<listener>
    const pendingScopes = new Map();    // sessionId -> binding lifetime cleanup

    function setPendingTarget(ctx, sessionId, uri) {
      if (!sessionId || typeof uri !== 'string' || !uri) return false;
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) return false;
      if (pendingScopes.get(sessionId)?.binding !== binding) {
        pendingScopes.get(sessionId)?.dispose();
        const scope = { binding };
        pendingScopes.set(sessionId, scope);
        scope.dispose = binding.ctx.effect(() => () => {
          if (pendingScopes.get(sessionId) !== scope) return;
          pendingScopes.delete(sessionId);
          pendingTargets.delete(sessionId);
          pendingListeners.delete(sessionId);
        }, 'tmux-xc: pending reference lifetime');
      }
      pendingTargets.set(sessionId, uri);
      const listeners = pendingListeners.get(sessionId);
      if (listeners?.size) {
        const target = takePendingTarget(sessionId); // Delete before invoking consumers.
        for (const listener of listeners) { try { listener(target); } catch { /* ignore */ } }
      }
      return true;
    }
    function takePendingTarget(sessionId) {
      const uri = pendingTargets.get(sessionId);
      pendingTargets.delete(sessionId);
      return uri || null;
    }
    function subscribePendingTarget(sessionId, listener) {
      let set = pendingListeners.get(sessionId);
      if (!set) { set = new Set(); pendingListeners.set(sessionId, set); }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && pendingListeners.get(sessionId) === set) {
          pendingListeners.delete(sessionId);
          pendingTargets.delete(sessionId);
        }
      };
    }

    // --------------------------------------------------------------------------
    // Locale dictionaries (zh + en). Keys are shared; t(key, params) interpolates
    // "{n}" style placeholders.
    // --------------------------------------------------------------------------

    const en = {
      title: 'Remote tasks',
      subtitle: 'Keep the work. Change the conversation.',
      searchTasks: 'Find a task…',
      noTasks: 'No terminal tasks on this host.',
      noMatches: 'No matching tasks.',
      viewOutput: 'Snapshot',
      openTerminal: 'Open terminal',
      openingTerminal: 'Opening…',
      terminalFailed: 'Could not open terminal: {message}',
      terminalUnavailable: 'Native terminal or a supported shell is unavailable.',
      referenceTask: 'Reference',
      taskDetails: 'Task details',
      backToTasks: 'Back to tasks',
      registeredTask: 'Registered',
      taskCount: '{n} tasks',
      settings: 'Settings',
      openPanel: 'Open tmux panel',
      refresh: 'Refresh',
      lastRefresh: 'Last refresh {time}',
      loading: 'Loading…',
      empty: 'No hosts configured or reachable.',
      loadFailed: 'Failed to load: {message}',
      unreachable: 'unreachable',
      reachable: 'reachable',
      hostError: 'host error',
      unknownCommand: 'unknown command',
      noServer: 'no tmux server',
      verifiedNow: 'verified now',
      verifiedMin: 'verified {n}m ago',
      verifiedHour: 'verified {n}h ago',
      verifiedDay: 'verified {n}d ago',
      attached: '{n} attached',
      dead: 'dead',
      adopted: 'adopted',
      created: 'created',
      stale: 'stale',
      insertFailed: 'The composer changed or is busy; the reference was not inserted.',
      sessionGone: 'This chat session is no longer mounted.',
      adoptFailed: 'Could not reference: {message}',
      actionFailed: 'The server did not accept this action.',
      candidatesSection: 'Adopted tmux references',
      copied: 'Copied',
      copyFailed: 'Copy failed; clipboard left unchanged.',
      containsTasks: 'Contains: {tasks}',
      advanced: 'Advanced details',
      refSession: 'Reference session',
      refWindow: 'Reference window',
      refPane: 'Reference pane',
      kindSession: 'Session',
      kindWindow: 'Window',
      kindPane: 'Pane',
      alias: 'Alias',
      aliasTooltip: 'Only shown in this plugin; never renames the remote tmux name.',
      aliasPlaceholder: 'Alias (empty clears)',
      aliasSaved: 'Alias saved',
      unregister: 'Unregister',
      unregisterTooltip: 'Removes only this registration, not registered child items; remote tmux and its processes keep running.',
      unregisterConfirm: 'Unregister "{label}"? Removes only this registration, not registered child items; remote tmux and its processes keep running.',
      unregistered: 'Unregistered',
      registeredNotice: 'Registered: {label}',
      approval: 'Approval',
      approvalOn: 'On',
      approvalOff: 'Off',
      approvalOnDesc: 'Ask each time for create / send / delete / detach',
      approvalOffDesc: 'Execute directly on configured hosts',
      approvalSourcePanel: 'panel setting',
      approvalSourceConfig: 'config file',
      approvalSourceDefault: 'default',
      approvalReset: 'Reset to default',
      approvalLegacyAllow: 'Legacy per-key config still applies: {list}',
      approvalFootnote: "This only controls this plugin's approval prompts; the DSH host's own permission/denial rules and SSH authentication failures still apply.",
      fontSizeSmaller: 'Decrease font size',
      fontSizeLarger: 'Increase font size',
      panelHint: 'Open terminal to interact. Snapshot shows read-only output.',
      copyAttach: 'Copy attach',
      copyBash: 'Copy Bash command (Linux/macOS/Git Bash)',
      copyPowerShell: 'Copy PowerShell command (Windows)',
      copyMenuTooltip: 'SSH aliases/config must exist on the connecting machine. cmd.exe is not supported (% and quoting rules differ).',
      copyLocalBash: 'Local Bash: run this command on the tmux machine, not a different connecting machine.',
      copyLocalPowerShell: 'Unavailable for local transport; run the Bash command on the tmux machine.',
      moreActions: 'More actions',
      deleteSession: 'Delete session',
      deleteWindow: 'Delete window',
      deletePane: 'Delete pane',
      killScopeLabel: 'Name',
      killScopeAlias: 'Alias',
      killScopeHost: 'Host',
      killScopeSocket: 'Socket',
      killScopeKind: 'Kind',
      killWhatDiesSession: 'All windows and panes in this session, and the processes running in them, will be terminated; no files are deleted; other sessions are unaffected.',
      killWhatDiesWindow: 'All panes in this window, and the processes running in them, will be terminated; no files are deleted; other windows are unaffected.',
      killWhatDiesPane: 'The process running in this pane will be terminated; no files are deleted; other panes are unaffected.',
      delete: 'Delete',
      killDeleted: 'Deleted: {label}',
      cancel: 'Cancel',
      removeHost: 'Remove host…',
      removeHostTitle: 'Remove host',
      removeHostLocal: 'Remove from plugin only (no remote connection)',
      removeHostLocalDesc: "Removes this host's registrations and aliases and hides it; the remote tmux keeps running.",
      removeHostRemote: 'Terminate selected remote sessions first, then remove the host',
      removeHostRemoteDesc: 'Terminates the selected sessions, then removes the host. The host is removed only if every selected session terminates successfully.',
      removeHostSessions: 'Sessions on this host',
      removeHostUnreachable: 'Host unreachable; only plugin-only removal is available.',
      removeHostTypeId: 'Type the host id to confirm: {id}',
      removeHostConfirm: 'Remove host',
      removeHostDone: 'Host removed',
      removeHostPartial: 'Some sessions failed to terminate; the host was NOT removed. You can choose plugin-only removal instead.',
      removeHostOk: 'terminated',
      removeHostFail: 'failed',
      restore: 'Restore',
      removedHostsSection: 'Removed hosts',
      removedHostsNone: '(none)',
      restoreDone: 'Restored',
      previewTitle: 'Snapshot',
      previewReadonly: 'Read-only snapshot, not an interactive terminal',
      refInvalidServerRestarted: 'Reference invalid: the tmux server restarted',
      refInvalidTargetGone: 'Reference invalid: the target no longer exists',
      refInvalidHostUnreachable: 'Reference invalid: the host is unreachable',
      refInvalidGeneric: 'Reference invalid: {message}',
    };

    const zh = {
      title: '远程任务',
      subtitle: '对话可以换，任务继续。',
      searchTasks: '查找任务…',
      noTasks: '这台主机上暂无终端任务。',
      noMatches: '没有匹配的任务。',
      viewOutput: '快照',
      openTerminal: '打开终端',
      openingTerminal: '正在打开…',
      terminalFailed: '打开终端失败：{message}',
      terminalUnavailable: '原生终端或受支持的 Shell 不可用。',
      referenceTask: '引用',
      taskDetails: '任务详情',
      backToTasks: '返回任务',
      registeredTask: '已登记',
      taskCount: '{n} 个任务',
      settings: '设置',
      openPanel: '打开 tmux 面板',
      refresh: '刷新',
      lastRefresh: '上次刷新 {time}',
      loading: '加载中…',
      empty: '没有配置或可达的主机。',
      loadFailed: '加载失败：{message}',
      unreachable: '不可达',
      reachable: '可达',
      hostError: '主机错误',
      unknownCommand: '未知命令',
      noServer: '无 tmux 服务器',
      verifiedNow: '刚刚验证',
      verifiedMin: '{n} 分钟前验证',
      verifiedHour: '{n} 小时前验证',
      verifiedDay: '{n} 天前验证',
      attached: '{n} 个连接',
      dead: '已死',
      adopted: '已采纳',
      created: '已创建',
      stale: '过期',
      insertFailed: '输入框已变化或正忙，引用未插入。',
      sessionGone: '当前会话已卸载。',
      adoptFailed: '引用失败：{message}',
      actionFailed: '服务端未接受此操作。',
      candidatesSection: '已采纳的 tmux 引用',
      copied: '已复制',
      copyFailed: '复制失败；剪贴板内容未改变。',
      containsTasks: '包含：{tasks}',
      advanced: '高级详情',
      refSession: '引用会话',
      refWindow: '引用窗口',
      refPane: '引用窗格',
      kindSession: '会话',
      kindWindow: '窗口',
      kindPane: '窗格',
      alias: '别名',
      aliasTooltip: '仅本插件显示，不修改远端 tmux 名称',
      aliasPlaceholder: '别名（留空清除）',
      aliasSaved: '已保存别名',
      unregister: '取消登记',
      unregisterTooltip: '只删除此条登记，不会取消已登记的子项；远端 tmux 及其中运行的进程继续运行。',
      unregisterConfirm: '取消登记“{label}”？只删除此条登记，不会取消已登记的子项；远端 tmux 及其中运行的进程继续运行。',
      unregistered: '已取消登记',
      registeredNotice: '已登记：{label}',
      approval: '插件审批',
      approvalOn: '开',
      approvalOff: '关',
      approvalOnDesc: '创建/发送/删除/分离 每次询问',
      approvalOffDesc: '在已配置的主机上直接执行',
      approvalSourcePanel: '面板设置',
      approvalSourceConfig: '配置文件',
      approvalSourceDefault: '默认',
      approvalReset: '恢复默认',
      approvalLegacyAllow: '旧版每键配置仍生效：{list}',
      approvalFootnote: '只控制本插件的审批提示；DSH 宿主自身的权限/拒绝规则以及 SSH 认证失败仍然生效。',
      fontSizeSmaller: '减小字号',
      fontSizeLarger: '增大字号',
      panelHint: '点击“打开终端”直接交互；“快照”仅查看只读输出。',
      copyAttach: '复制连接命令',
      copyBash: '复制 Bash 命令（Linux/macOS/Git Bash）',
      copyPowerShell: '复制 PowerShell 命令（Windows）',
      copyMenuTooltip: 'SSH 别名与配置必须存在于发起连接的机器上。cmd.exe 不支持（% 与引号规则不同）。',
      copyLocalBash: '本地 Bash：此命令须在 tmux 所在机器上运行，不能在另一台连接机器上直接使用。',
      copyLocalPowerShell: '本地传输不支持 PowerShell；请在 tmux 所在机器上运行 Bash 命令。',
      moreActions: '更多操作',
      deleteSession: '删除会话',
      deleteWindow: '删除窗口',
      deletePane: '删除窗格',
      killScopeLabel: '名称',
      killScopeAlias: '别名',
      killScopeHost: '主机',
      killScopeSocket: '套接字',
      killScopeKind: '类型',
      killWhatDiesSession: '该会话中的所有窗口和窗格及其中运行的进程都会被终止；不会删除任何文件；不影响其他会话。',
      killWhatDiesWindow: '该窗口中的所有窗格及其中运行的进程都会被终止；不会删除任何文件；不影响其他窗口。',
      killWhatDiesPane: '该窗格中运行的进程会被终止；不会删除任何文件；不影响其他窗格。',
      delete: '删除',
      killDeleted: '已删除：{label}',
      cancel: '取消',
      removeHost: '移除主机…',
      removeHostTitle: '移除主机',
      removeHostLocal: '仅从插件移除（不连接远端）',
      removeHostLocalDesc: '删除该主机的登记记录与别名并隐藏主机；远端 tmux 继续运行。',
      removeHostRemote: '先终止所选远端会话，再移除主机',
      removeHostRemoteDesc: '终止所选会话，然后移除主机。仅当所有所选会话都成功终止时才会移除主机。',
      removeHostSessions: '该主机的会话',
      removeHostUnreachable: '主机不可达，只能从插件移除（不连接远端）。',
      removeHostTypeId: '请输入主机 ID 以确认：{id}',
      removeHostConfirm: '移除主机',
      removeHostDone: '已移除主机',
      removeHostPartial: '部分会话终止失败，主机未被移除。可改选“仅从插件移除”。',
      removeHostOk: '已终止',
      removeHostFail: '失败',
      restore: '恢复',
      removedHostsSection: '已移除的主机',
      removedHostsNone: '（无）',
      restoreDone: '已恢复',
      previewTitle: '快照',
      previewReadonly: '只读快照，不是交互终端',
      refInvalidServerRestarted: '引用已失效：tmux 服务已重启',
      refInvalidTargetGone: '引用已失效：目标已不存在',
      refInvalidHostUnreachable: '引用已失效：主机不可达',
      refInvalidGeneric: '引用已失效：{message}',
    };

    // --------------------------------------------------------------------------
    // Reference token grammar (re-implemented; do not import host code).
    //   token = @[<label>](dsh-tmux:v1/<hostId>/<hostFp>/<socketId>/<gen>/<kind>/<sid>/<wid>/<pid>)
    // --------------------------------------------------------------------------

    // Extract the bare uri from either a token ("@[label](uri)") or a raw uri.
    function uriOf(ref) {
      if (typeof ref !== 'string') return null;
      const m = /@\[[^\[\]()]*\]\(([^()\s]+)\)/.exec(ref);
      return m ? m[1] : ref;
    }

    // Captured pane text is rendered as a React text node (never HTML). Still strip
    // control/bidi chars, preserving newlines/tabs for the monospace preview, and
    // bound its size so a hostile capture cannot exhaust memory.
    function cleanPreviewText(text, max = 200000) {
      let s = String(text ?? '');
      s = s
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '') // C0/C1 except \t \n \r
        .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g, '');
      if (s.length > max) s = s.slice(0, max);
      return s;
    }

    // Both route envelopes and inventory host errors use {code, message}.
    function errorText(value, fallback) {
      const detail = value && typeof value === 'object' && value.error != null ? value.error : value;
      const code = typeof detail?.code === 'string' ? cleanLabel(detail.code, 80) : '';
      const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : '';
      const text = cleanLabel(message, 240) || fallback;
      return code ? code + ': ' + text : text;
    }

    // --------------------------------------------------------------------------
    // HTTP transport (document-relative, same-origin credentials).
    // --------------------------------------------------------------------------

    function apiUrl(path) {
      return new URL(API_PREFIX + path, document.baseURI);
    }

    async function api(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(apiUrl(path), {
        method,
        credentials: 'same-origin',
        signal,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { /* non-JSON body */ }
      }
      if (!response.ok || data?.ok === false) {
        const detail = data?.error ?? data;
        const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : response.statusText || ('HTTP ' + response.status);
        const err = new Error(message);
        err.status = response.status;
        err.code = typeof detail?.code === 'string' ? detail.code : undefined;
        throw err;
      }
      return data;
    }

    // Copy text to the clipboard with a textarea fallback for non-secure contexts.
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      }
    }

    // --------------------------------------------------------------------------
    // Inventory / hosts normalization
    // --------------------------------------------------------------------------

    function normalizeHosts(payload) {
      const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.hosts) ? payload.hosts : []);
      const map = Object.create(null);
      for (const h of list) {
        if (!h || typeof h !== 'object') continue;
        map[h.id] = h;
      }
      return map;
    }

    function paneSecondaryTitle(pane, host, hostMeta) {
      const title = cleanLabel(pane.title);
      if (!title || title === cleanLabel(pane.cmd)) return null;
      const normalized = title.toLowerCase();
      const defaults = [host.id, host.label, hostMeta?.ssh];
      if (defaults.some((value) => typeof value === 'string' && cleanLabel(value).toLowerCase() === normalized)) return null;
      if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i.test(title)) return null;
      return title;
    }

    function agoText(t, ts, now) {
      if (!ts) return null;
      const s = Math.max(0, Math.floor((now - ts) / 1000));
      if (s < 60) return t('verifiedNow');
      if (s < 3600) return t('verifiedMin', { n: String(Math.floor(s / 60)) });
      if (s < 86400) return t('verifiedHour', { n: String(Math.floor(s / 3600)) });
      return t('verifiedDay', { n: String(Math.floor(s / 86400)) });
    }

    function stateBadge(t, node) {
      if (node.state === 'unreachable') return t('unreachable');
      if (node.state === 'stale') return t('stale');
      if (node.origin === 'created') return t('created');
      if (node.adopted || node.origin === 'adopted') return t('adopted');
      return null;
    }

    // --------------------------------------------------------------------------
    // Icons (small inline SVGs)
    // --------------------------------------------------------------------------

    function terminalIcon(size) {
      return jsx('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
        children: jsxs(Fragment, { children: [
          jsx('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          jsx('path', { d: 'M4.5 6l2 2-2 2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          jsx('path', { d: 'M8 10h3.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ] }),
      });
    }

    // --------------------------------------------------------------------------
    // Shared tiny presentational components
    // --------------------------------------------------------------------------

    function Badge({ text, kind }) {
      return jsx('span', { className: 'xc-badge', 'data-kind': kind || 'plain', children: text });
    }

    function MetaLine({ text }) {
      if (!text) return null;
      return jsx('span', { className: 'xc-meta', title: text, children: text });
    }

    function ActionBtn({ label, onClick, disabled, title, className }) {
      return jsx('button', {
        type: 'button', className: 'xc-action' + (className ? ' ' + className : ''), disabled: !!disabled, title: title || label,
        onClick: (event) => { event.stopPropagation(); onClick(); },
        children: label,
      });
    }

    function Caret({ expanded, onToggle, label }) {
      return jsx('button', {
        type: 'button', className: 'xc-caret', 'aria-label': label, 'aria-expanded': !!expanded,
        onClick: (event) => { event.stopPropagation(); onToggle(); },
        children: expanded ? '▾' : '▸',
      });
    }

    // Body portals escape sidebar clipping/stacking contexts, not token rendering.
    // Measure before paint, flip/clamp to the viewport, close on outside interaction.
    function Menu({ trigger, items, hint }) {
      const [open, setOpen] = react.useState(false);
      const [position, setPosition] = react.useState(null);
      const rootRef = react.useRef(null);
      const popRef = react.useRef(null);
      react.useLayoutEffect(() => {
        if (!open || !rootRef.current || !popRef.current) return undefined;
        const root = rootRef.current;
        const pop = popRef.current;
        // Preserve the panel's user-selected font after moving outside .xc-root.
        pop.style.fontSize = window.getComputedStyle(root).fontSize;
        setPosition(menuPosition(root.getBoundingClientRect(), pop.getBoundingClientRect(), {
          width: document.documentElement.clientWidth,
          height: window.innerHeight,
        }));
        const onDoc = (event) => {
          if (!root.contains(event.target) && !pop.contains(event.target)) setOpen(false);
        };
        const onScroll = (event) => { if (!pop.contains(event.target)) setOpen(false); };
        const onResize = () => setOpen(false);
        const onKey = (event) => {
          if (event.key === 'Escape') { setOpen(false); root.querySelector('button')?.focus(); }
        };
        document.addEventListener('pointerdown', onDoc);
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onResize);
        return () => {
          document.removeEventListener('pointerdown', onDoc);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
        };
      }, [open]);
      return jsxs('span', { className: 'xc-menu', ref: rootRef, children: [
        jsx('button', {
          type: 'button', className: 'xc-action xc-menuTrigger', title: trigger.title || trigger.label,
          'aria-haspopup': 'menu', 'aria-expanded': !!open,
          onClick: (event) => { event.stopPropagation(); setPosition(null); setOpen((v) => !v); },
          children: trigger.label,
        }),
        open ? createPortal(jsxs('span', {
          className: 'xc-menuPop', role: 'menu', ref: popRef,
          style: { left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' },
          children: [
            ...items.map((item, i) => jsx('button', {
              type: 'button', role: 'menuitem', className: 'xc-menuItem', title: item.title, disabled: !!item.disabled,
              onClick: (event) => { event.stopPropagation(); if (item.disabled) return; setOpen(false); item.onClick(); },
              children: item.label,
            }, 'i' + i)),
            ...(hint ? [jsx('span', { className: 'xc-menuHint', children: hint }, 'hint')] : []),
          ],
        }), document.body) : null,
      ] });
    }

    // Inline alias editor (max 40 chars; Enter/blur saves, Escape cancels).
    function AliasEditor({ node, t, onSave, onCancel }) {
      const [value, setValue] = react.useState(node.alias || '');
      const inputRef = react.useRef(null);
      const committed = react.useRef(false);
      react.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
      const commit = () => {
        if (committed.current) return;
        committed.current = true;
        onSave(node, value);
      };
      return jsx('input', {
        ref: inputRef,
        type: 'text',
        className: 'xc-aliasInput',
        maxLength: 40,
        value,
        placeholder: t('aliasPlaceholder'),
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        },
        onBlur: commit,
        onClick: (event) => event.stopPropagation(),
      });
    }

    // A minimal accessible toggle switch.
    function Switch({ checked, disabled, onToggle, label }) {
      return jsx('button', {
        type: 'button', role: 'switch', 'aria-checked': !!checked, 'aria-label': label,
        className: 'xc-switch' + (checked ? ' xc-switchOn' : ''), disabled: !!disabled,
        onClick: (event) => { event.stopPropagation(); onToggle(!checked); },
        children: jsx('span', { className: 'xc-switchKnob' }),
      });
    }

    // A small centered modal with a backdrop (closes on backdrop click).
    function Modal({ title, onClose, children, fontSize }) {
      return createPortal(jsx('div', {
        className: 'xc-modalBackdrop', style: { fontSize: fontSize + 'px' },
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
        children: jsx('div', { className: 'xc-modal', role: 'dialog', 'aria-modal': true, children: [
          jsxs('div', { className: 'xc-modalHead', children: [
            jsx('span', { className: 'xc-modalTitle', children: title }),
            jsx('button', { type: 'button', className: 'xc-modalClose', onClick: onClose, 'aria-label': 'close', children: '×' }),
          ] }),
          jsx('div', { className: 'xc-modalBody', children }),
        ] }),
      }), document.body);
    }

    // One label/value line inside a destructive-action dialog's exact-scope list.
    function ScopeRow({ label, value }) {
      return jsxs('div', { className: 'xc-scopeRow', children: [
        jsx('span', { className: 'xc-scopeLabel', children: label }),
        jsx('span', { className: 'xc-scopeValue', children: value }),
      ] });
    }

    // --------------------------------------------------------------------------
    // Destructive-action dialogs
    // --------------------------------------------------------------------------

    // Delete one exact URI. The explicit click echoes the server's typo guard.
    function KillDialog({ node, label, t, onClose, onDone, fontSize }) {
      const confirmString = killConfirmString(node);
      const actionLabel = node.kind === 'session' ? t('deleteSession') : node.kind === 'window' ? t('deleteWindow') : t('deletePane');
      const kindLabel = kindTextFor(node.kind, t);
      const whatDies = node.kind === 'session' ? t('killWhatDiesSession') : node.kind === 'window' ? t('killWhatDiesWindow') : t('killWhatDiesPane');
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const canConfirm = !!confirmString && !!node.uri && !busy;

      const submit = async () => {
        if (!canConfirm) return;
        setBusy(true);
        setError(null);
        try {
          const result = await api('/kill', { method: 'POST', body: { uri: node.uri, confirm: confirmString } });
          onDone({ ok: true, label: result?.label || label });
        } catch (err) {
          setError(err);
          setBusy(false);
        }
      };

      return jsx(Modal, { title: actionLabel, onClose, fontSize, children: jsxs(Fragment, { children: [
        jsxs('div', { className: 'xc-scope', children: [
          jsx(ScopeRow, { label: t('killScopeLabel'), value: label }),
          node.alias ? jsx(ScopeRow, { label: t('killScopeAlias'), value: cleanLabel(node.alias, 40) }) : null,
          jsx(ScopeRow, { label: t('killScopeHost'), value: node.hostLabel + ' (' + node.hostId + ')' }),
          jsx(ScopeRow, { label: t('killScopeSocket'), value: node.socketId }),
          jsx(ScopeRow, { label: t('killScopeKind'), value: kindLabel }),
        ] }),
        jsx('div', { className: 'xc-dialogNote', children: whatDies }),
        error ? jsx('div', { className: 'xc-err', children: errorText(error, t('actionFailed')) }) : null,
        jsxs('div', { className: 'xc-dialogActions', children: [
          jsx('button', { type: 'button', className: 'xc-action', onClick: onClose, children: t('cancel') }),
          jsx('button', { type: 'button', className: 'xc-action xc-danger', disabled: !canConfirm, onClick: submit, children: t('delete') }),
        ] }),
      ] }) });
    }

    // Remove a host: two clearly separated choices fetched from GET /host/remove-plan.
    // Local mode never touches the remote; remote mode kills the selected sessions
    // first and only removes the host when every kill succeeded.
    function HostRemoveDialog({ host, t, onClose, onDone, fontSize }) {
      const [plan, setPlan] = react.useState(null);
      const [planLoading, setPlanLoading] = react.useState(true);
      const [planError, setPlanError] = react.useState(null);
      const [mode, setMode] = react.useState('local');
      const [selected, setSelected] = react.useState(() => new Set());
      const [confirm, setConfirm] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [result, setResult] = react.useState(null);

      react.useEffect(() => {
        let alive = true;
        setPlanLoading(true);
        setPlanError(null);
        api('/host/remove-plan?host=' + encodeURIComponent(host.id))
          .then((r) => {
            if (!alive) return;
            setPlan(r);
            // Loading a plan is not destructive intent, even for plugin-created tasks.
            setMode('local');
            setSelected(new Set());
          })
          .catch((err) => { if (alive) setPlanError(err); })
          .finally(() => { if (alive) setPlanLoading(false); });
        return () => { alive = false; };
      }, [host.id]);

      const toggleSession = (uri, checked) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (checked) next.add(uri); else next.delete(uri);
          return next;
        });
      };

      const reachable = !!(plan?.host?.reachable);
      const canConfirm = confirm === host.id && !busy && (mode === 'local' || (mode === 'remote' && reachable && selected.size > 0));

      const submit = async () => {
        if (!canConfirm) return;
        setBusy(true);
        setError(null);
        setResult(null);
        const body = { host: host.id, mode, confirm };
        if (mode === 'remote') body.killUris = [...selected];
        try {
          const r = await api('/host/remove', { method: 'POST', body });
          setResult(r);
          setBusy(false);
          if (r?.removed) onDone({ ok: true });
        } catch (err) {
          setError(err);
          setBusy(false);
        }
      };

      const sessionScope = (s) => {
        const ref = decodeUri(s.uri);
        const socketId = cleanLabel(s.socketId || ref?.socketId);
        const socketLabel = cleanLabel(s.socketLabel) || socketId;
        const sid = Number.isSafeInteger(s.sid) && s.sid >= 0 ? s.sid : ref?.sid;
        return socketLabel + (socketLabel !== socketId ? ' (' + socketId + ')' : '')
          + (sid != null ? ' · $' + sid : '');
      };
      const resultLabel = (r) => cleanLabel(r.label)
        || cleanLabel((plan?.sessions || []).find((s) => s.uri === r.uri)?.label)
        || cleanLabel(r.uri, 512) || t('kindSession');

      const remoteResults = result?.remote && Array.isArray(result.remote) ? result.remote : [];
      const removed = !!result?.removed;
      const showPartial = !removed && remoteResults.length > 0;

      return jsx(Modal, { title: t('removeHostTitle'), onClose, fontSize, children: jsxs(Fragment, { children: [
        jsxs('div', { className: 'xc-scope', children: [
          jsx(ScopeRow, { label: t('killScopeHost'), value: cleanLabel(host.label || host.id) }),
          jsx(ScopeRow, { label: t('killScopeLabel'), value: host.id }),
          jsx(ScopeRow, { label: t('killScopeKind'), value: plan ? (reachable ? t('reachable') : t('unreachable')) : '…' }),
        ] }),
        planLoading ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
        planError ? jsx('div', { className: 'xc-err', children: errorText(planError, t('actionFailed')) }) : null,

        plan ? jsxs(Fragment, { children: [
          // Choice A — plugin-only removal (available even when unreachable).
          jsxs('button', {
            type: 'button',
            className: 'xc-choice' + (mode === 'local' ? ' xc-choiceOn' : ''),
            disabled: busy, onClick: () => { setMode('local'); setSelected(new Set()); },
            children: [
              jsx('span', { className: 'xc-choiceTitle', children: t('removeHostLocal') }),
              jsx('span', { className: 'xc-choiceDesc', children: t('removeHostLocalDesc') }),
            ],
          }),
          // Choice B — kill selected sessions, then remove (only when reachable).
          reachable ? jsxs('div', {
            className: 'xc-choice' + (mode === 'remote' ? ' xc-choiceOn' : ''),
            children: [
              jsx('button', { type: 'button', className: 'xc-action', disabled: busy, 'aria-pressed': mode === 'remote', onClick: () => setMode('remote'), children: t('removeHostRemote') }),
              jsx('span', { className: 'xc-choiceDesc', children: t('removeHostRemoteDesc') }),
              jsx('span', { className: 'xc-choiceSection', children: t('removeHostSessions') }),
              (plan.sessions || []).length === 0
                ? jsx('span', { className: 'xc-empty', children: t('removedHostsNone') })
                : (plan.sessions || []).map((s) => jsxs('label', {
                    className: 'xc-dialogRow',
                    children: [
                      jsx('input', {
                        type: 'checkbox', checked: selected.has(s.uri), disabled: busy || mode !== 'remote',
                        onChange: (event) => toggleSession(s.uri, event.target.checked),
                      }),
                      jsxs('span', { className: 'xc-dialogRowLabel', children: [
                        jsx('span', { children: cleanLabel(s.name) || cleanLabel(s.label) || cleanLabel(s.uri, 512) }),
                        s.alias ? jsx('small', { children: t('alias') + ': ' + cleanLabel(s.alias, 40) }) : null,
                        jsx('small', { children: sessionScope(s) }),
                      ] }),
                      s.origin ? jsx(Badge, { text: s.origin === 'created' ? t('created') : t('adopted'), kind: 'plain' }) : null,
                    ],
                  }, 'sess:' + s.uri)),
            ],
          }) : jsxs('div', { className: 'xc-choice xc-choiceDisabled', children: [
            jsx('span', { className: 'xc-choiceTitle', children: t('removeHostRemote') }),
            jsx('span', { className: 'xc-choiceDesc', children: t('removeHostUnreachable') }),
          ] }),
        ] }) : null,

        jsx('div', { className: 'xc-confirmHint', children: t('removeHostTypeId', { id: host.id }) }),
        jsx('input', {
          type: 'text', className: 'xc-confirmInput', value: confirm,
          autoFocus: true, spellCheck: false,
          placeholder: host.id,
          onChange: (event) => setConfirm(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
        }),

        showPartial ? jsx('div', { className: 'xc-dialogNote xc-dialogWarn', children: t('removeHostPartial') }) : null,
        remoteResults.length > 0 ? jsxs('div', { className: 'xc-results', children: [
          ...remoteResults.map((r) => jsxs('div', { className: 'xc-resultRow', children: [
            jsxs('span', { className: 'xc-resultLabel', children: [
              jsx('span', { children: resultLabel(r) }),
              jsx('small', { children: sessionScope((plan?.sessions || []).find((s) => s.uri === r.uri) || r) }),
            ] }),
            jsx('span', { className: 'xc-resultState' + (r.ok ? ' xc-resultOk' : ' xc-resultFail'), children: r.ok ? t('removeHostOk') : t('removeHostFail') }),
            !r.ok && r.message ? jsx('span', { className: 'xc-meta', children: cleanLabel(r.message, 120) }) : null,
          ] }, 'res:' + (r.uri || ''))),
        ] }) : null,

        error ? jsx('div', { className: 'xc-err', children: errorText(error, t('actionFailed')) }) : null,
        jsxs('div', { className: 'xc-dialogActions', children: [
          jsx('button', { type: 'button', className: 'xc-action', onClick: onClose, children: t('cancel') }),
          jsx('button', { type: 'button', className: 'xc-action xc-danger', disabled: !canConfirm, onClick: submit, children: t('removeHostConfirm') }),
        ] }),
      ] }) });
    }

    // --------------------------------------------------------------------------
    // Sent-message chip (slot "conversation.user.text.node", key "tmux-xc")
    //
    // DSH API used: the `conversation.user.text.node` keyed inline slot registered
    // via `ctx.slots.inject('conversation.user.text.node', ...)`. Its owner props
    // are `{ raw, interactive }`; `dsh-client-ui-chat` renders durable user-message
    // text with `interactive: true`, so the renderer owns the click and opens the
    // sidebar tmux tab. There is no first-class "click hook" on history chips.
    // --------------------------------------------------------------------------

    function TmuxXcChip(props) {
      const { node, raw, interactive, openTarget } = props;
      const data = node && node.data ? node.data : { label: '', uri: '' };
      const label = chipLabel(data.label);
      const uri = typeof data.uri === 'string' ? data.uri : '';
      const ref = decodeUri(uri);
      const clickable = interactive && typeof openTarget === 'function' && !!ref;
      const chipProps = {
        className: 'xc-refchip',
        title: [cleanLabel(raw, 512), killConfirmString(ref)].filter(Boolean).join('\n'),
        children: jsxs(Fragment, { children: [
          terminalIcon(12),
          jsx('span', { className: 'xc-refchipLabel', children: label }),
        ] }),
      };
      if (clickable) {
        chipProps.role = 'button';
        chipProps.tabIndex = 0;
        chipProps.onClick = () => openTarget(uri);
        chipProps.onKeyDown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTarget(uri); }
        };
      }
      return jsx('span', chipProps);
    }

    // --------------------------------------------------------------------------
    // Sidebar tab title (slot "sidebar.right.pane.tab.title")
    // --------------------------------------------------------------------------

    function TmuxXcTitle(props) {
      return jsx('span', { className: 'xc-title', children: props.t('title') });
    }

    // --------------------------------------------------------------------------
    // Sidebar panel (slot "sidebar.right.pane.tab")
    // --------------------------------------------------------------------------

    function TmuxXcPanel(props) {
      const { sessionId, t } = props;

      const [advanced, setAdvanced] = react.useState(() => readStorage(LS_ADVANCED) === '1');
      const [fontSize, setFontSize] = react.useState(() => {
        const n = Number(readStorage(LS_FONT));
        return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? Math.round(n) : FONT_DEFAULT;
      });
      const [data, setData] = react.useState(null);
      const [hostsMeta, setHostsMeta] = react.useState(Object.create(null));
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [expanded, setExpanded] = react.useState(null); // null => defaults
      const [notice, setNotice] = react.useState(null);
      const [highlightUri, setHighlightUri] = react.useState(null);
      const [selectedUri, setSelectedUri] = react.useState(null);
      const [revealedUri, setRevealedUri] = react.useState(null);
      const [query, setQuery] = react.useState('');
      const [aliasTarget, setAliasTarget] = react.useState(null);
      const [lastRefreshedAt, setLastRefreshedAt] = react.useState(null);
      const [now, setNow] = react.useState(() => Date.now());
      const [approvalOpen, setApprovalOpen] = react.useState(false);
      const [settings, setSettings] = react.useState(null);
      const [settingsError, setSettingsError] = react.useState(null);
      const [settingsSaving, setSettingsSaving] = react.useState(null);
      const [dialog, setDialog] = react.useState(null); // { kind:'kill', node, label } | { kind:'hostRemove', host }
      const [terminalOpening, setTerminalOpening] = react.useState(false);
      const terminalFlight = react.useRef(false);
      const [preview, setPreview] = react.useState(null); // { uri, loading, data, error }
      const panelContext = react.useRef(null);
      const navigation = react.useRef({ id: 0, controller: null });

      react.useEffect(() => writeStorage(LS_ADVANCED, advanced ? '1' : '0'), [advanced]);
      react.useEffect(() => writeStorage(LS_FONT, String(fontSize)), [fontSize]);

      // Every asynchronous read belongs to one mounted panel/session lifetime.
      react.useLayoutEffect(() => {
        const context = { sessionId, inputActions: props.inputActions, binding: props.sessions.binding(sessionId), controller: new AbortController(), dirty: true, active: null, version: null, inventory: null };
        panelContext.current = context;
        setSelectedUri(null);
        setRevealedUri(null);
        setPreview(null);
        setHighlightUri(null);
        setDialog(null);
        setAliasTarget(null);
        const dispose = () => {
          context.controller.abort();
          if (panelContext.current !== context) return;
          navigation.current.controller?.abort();
          navigation.current.id++;
          panelContext.current = null;
        };
        const release = context.binding?.ctx.effect(() => dispose, 'tmux-xc: panel reads');
        return () => { release?.(); dispose(); };
      }, [sessionId, props.inputActions]);

      // Polling, manual refresh and actions share a single flight. A forced refresh
      // during a flight queues another snapshot; failures remain dirty for retry.
      const refresh = react.useCallback((force = true) => {
        const context = panelContext.current;
        if (!context) return Promise.resolve(null);
        if (force) context.dirty = true;
        if (context.active) return context.active;
        const current = () => panelContext.current === context;
        const options = { signal: context.controller.signal };
        context.active = Promise.resolve().then(async () => {
          try {
            do {
              // Read the baseline BEFORE inventory, including on the first load.
              // A mutation during this snapshot remains detectable at the next poll.
              const { version } = await api('/version', options);
              if (!current()) return null;
              if (!context.dirty && context.version === version) return context.inventory;
              context.dirty = false;
              setLoading(true);
              const inventory = await api('/inventory?all=1', options);
              const hosts = await api('/hosts', options);
              const settings = await api('/settings', options);
              if (!current()) return null;
              context.inventory = inventory;
              context.version = version; // Acknowledge only a complete successful snapshot.
              setData(inventory);
              setHostsMeta(normalizeHosts(hosts));
              setSettings(settings);
              setError(null);
              setSettingsError(null);
              setLastRefreshedAt(Date.now());
            } while (context.dirty && current());
            return context.inventory;
          } catch (err) {
            context.dirty = true;
            if (current()) setError(err);
            return null;
          } finally {
            context.active = null;
            if (current()) setLoading(false);
          }
        });
        return context.active;
      }, []);

      react.useEffect(() => {
        refresh();
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') refresh(false);
        }, VERSION_POLL_MS);
        return () => clearInterval(timer);
      }, [refresh, sessionId, props.inputActions]);

      // Keep "verified Xs ago" labels fresh.
      react.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), TICKER_MS);
        return () => clearInterval(timer);
      }, []);

      // Transient action notice.
      react.useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 6000);
        return () => clearTimeout(timer);
      }, [notice]);

      // Brief row highlight after a successful reference / navigation.
      react.useEffect(() => {
        if (!highlightUri) return undefined;
        const timer = setTimeout(() => setHighlightUri(null), 2000);
        return () => clearTimeout(timer);
      }, [highlightUri]);

      const flash = (text) => setNotice(text);

      const hostsOf = (d) => (d && (Array.isArray(d) ? d : d.hosts)) || [];

      function isRegistered(node) {
        return !!(node && (node.adopted || node.origin));
      }

      function sessionContainsRegistered(session) {
        if (isRegistered(session)) return true;
        for (const w of (session.windows || [])) {
          if (isRegistered(w)) return true;
          for (const p of (w.panes || [])) if (isRegistered(p)) return true;
        }
        return false;
      }

      function defaultExpandedKeys() {
        return new Set([...tree.byKey.values()].filter((node) => node.autoExpand).map((node) => node.key));
      }

      function toggleExpanded(node, value) {
        setExpanded((prev) => {
          const next = prev === null ? defaultExpandedKeys() : new Set(prev);
          if (value) next.add(node.key); else next.delete(node.key);
          return next;
        });
      }

      function expandKeys(keys) {
        setExpanded((prev) => {
          const next = prev === null ? defaultExpandedKeys() : new Set(prev);
          for (const k of keys) next.add(k);
          return next;
        });
      }

      function isExpanded(node) {
        if (!node.expandable) return false;
        if (expanded === null) return !!node.autoExpand;
        return expanded.has(node.key);
      }

      // --- Reference / Copy / Delete / Alias / Unregister actions ---

      function parentKeyOf(node, model = tree) {
        return model.byKey.get(node.key)?.parentKey || null;
      }

      function ancestorKeys(node, model = tree) {
        const keys = [];
        for (let current = node; current; current = model.byKey.get(parentKeyOf(current, model))) keys.push(current.key);
        return keys;
      }

      // Reference label = the server kind-explicit label, with the host prefix
      // replaced by the node's alias when one is set (<alias> · 窗格 …).
      function referenceLabel(node) {
        const serverLabel = cleanLabel(node.serverLabel, 120);
        if (!node.alias) return serverLabel;
        const alias = cleanLabel(node.alias, 40);
        const prefix = cleanLabel(node.hostLabel, 80) + ' · ';
        const body = serverLabel.startsWith(prefix) ? serverLabel.slice(prefix.length) : serverLabel;
        return tokenSafeLabel(alias + ' · ' + body, 80) || serverLabel;
      }

      async function onReference(node) {
        const context = panelContext.current;
        const navigationId = navigation.current.id;
        let binding;
        let input;
        try {
          binding = props.sessions.binding(sessionId);
          if (!binding || !context || context.sessionId !== sessionId) throw new Error(t('sessionGone'));
          input = props.conversation.input.for(binding.ctx);
          if (typeof context.inputActions?.captureInsertion !== 'function') throw new Error(t('insertFailed'));
          // Capture detect coordinates BEFORE the asynchronous call. Clipboard
          // draft.length expands existing chips and is never a valid substitute.
          const span = context.inputActions.captureInsertion();
          const before = input.state.getSnapshot();
          if (!span || span.draftRev !== before.draftRev || !['plain', 'claimed'].includes(before.phase)) throw new Error(t('insertFailed'));
          if (!decodeUri(node.uri)) throw new Error(t('actionFailed'));
          const response = await api('/adopt', {
            method: 'POST',
            body: { target: node.uri, sessionId },
          });
          const entry = response?.entry;
          const parsed = canonicalToken(entry?.token, node.uri);
          if (!parsed || entry.uri !== node.uri) throw new Error(t('actionFailed'));

          // Do not reacquire another input after the await, even for a remounted
          // session with the same id. The original span remains revision-CAS'd.
          if (panelContext.current !== context || props.sessions.binding(sessionId)?.ctx !== binding.ctx) throw new Error(t('sessionGone'));
          const after = input.state.getSnapshot();
          if (after.draftRev !== span.draftRev || !['plain', 'claimed'].includes(after.phase)) throw new Error(t('insertFailed'));
          const ok = input.insertReference({
            source: SOURCE_NAME,
            ref: entry.token,
            label: chipLabel(referenceLabel(node)),
            clipboardText: entry.token,
          }, span);
          if (!ok) throw new Error(t('insertFailed'));
          input.focus();
          flash(t('registeredNotice', { label: referenceLabel(node) }));
          const inventory = await refresh();
          if (panelContext.current === context && navigation.current.id === navigationId && inventory) revealRef(node.uri, inventory, false);
        } catch (err) {
          const message = t('adoptFailed', { message: errorText(err, t('actionFailed')) });
          if (panelContext.current === context) flash(message);
          if (input && props.sessions.binding(sessionId)?.ctx === binding?.ctx) input.notify('error', message);
          if (err?.status === 409) await refresh();
        }
      }

      async function onTerminal(node) {
        const context = panelContext.current;
        if (!context || terminalFlight.current) return;
        terminalFlight.current = true;
        setTerminalOpening(true);
        try {
          if (!props.openTerminal) throw new Error(t('terminalUnavailable'));
          await props.openTerminal(node.uri, context.controller.signal);
        } catch (err) {
          if (panelContext.current === context && !context.controller.signal.aborted) flash(t('terminalFailed', { message: errorText(err, t('terminalUnavailable')) }));
        } finally {
          terminalFlight.current = false;
          if (panelContext.current === context) setTerminalOpening(false);
        }
      }

      async function onCopy(node, form) {
        const hostMeta = hostsMeta[node.hostId];
        const socketMeta = hostMeta && (hostMeta.sockets || []).find((s) => s && s.id === node.socketId);
        const cmd = form === 'powershell'
          ? attachCommandPowerShell(node, hostMeta, socketMeta)
          : attachCommandPosix(node, hostMeta, socketMeta);
        if (!cmd) { flash(t('copyFailed')); return; }
        const ok = await copyText(cmd);
        flash(ok ? t('copied') : t('copyFailed'));
      }

      async function onUnregister(node) {
        const context = panelContext.current;
        const label = rowTitle(node);
        if (!window.confirm(t('unregisterConfirm', { label }))) return;
        try {
          await api('/forget', {
            method: 'POST',
            body: node.registryKey ? { key: node.registryKey } : { uri: node.uri },
          });
          if (panelContext.current !== context) return;
          flash(t('unregistered'));
          refresh();
        } catch (err) {
          if (panelContext.current === context) flash(t('actionFailed') + ': ' + errorText(err, t('actionFailed')));
        }
      }

      async function saveAlias(node, value) {
        const context = panelContext.current;
        const navigationId = navigation.current.id;
        setAliasTarget(null);
        const alias = String(value ?? '').trim();
        try {
          // The server adopts the target if needed, then sets/clears the alias.
          await api('/alias', {
            method: 'POST',
            body: { uri: node.uri, alias: alias || null },
          });
          if (panelContext.current !== context) return;
          flash(t('aliasSaved'));
          const inventory = await refresh();
          if (panelContext.current === context && navigation.current.id === navigationId && inventory) revealRef(node.uri, inventory, false);
        } catch (err) {
          if (panelContext.current === context) flash(t('actionFailed') + ': ' + errorText(err, t('actionFailed')));
        }
      }

      async function putSettings(patch, savingKey) {
        const context = panelContext.current;
        setSettingsSaving(savingKey);
        setSettingsError(null);
        try {
          const result = await api('/settings', { method: 'PUT', body: patch });
          if (panelContext.current !== context) return null;
          setSettings(result);
          refresh(); // Queue behind any older settings snapshot already in flight.
          return result;
        } catch (err) {
          if (panelContext.current === context) setSettingsError(err);
          return null;
        } finally {
          if (panelContext.current === context) setSettingsSaving(null);
        }
      }

      const approvalEnabled = settings?.approval?.enabled;
      const approvalSource = settings?.approval?.source;
      const legacyAllow = Array.isArray(settings?.approval?.legacyAllow) ? settings.approval.legacyAllow : [];
      const removedHosts = Array.isArray(settings?.removedHosts) ? settings.removedHosts : [];

      function approvalSourceText(src) {
        if (src === 'panel') return t('approvalSourcePanel');
        if (src === 'config') return t('approvalSourceConfig');
        if (src === 'default') return t('approvalSourceDefault');
        return '';
      }

      async function toggleApproval(next) {
        await putSettings({ approval: { enabled: next } }, 'approval');
      }

      async function resetApproval() {
        await putSettings({ approval: { enabled: null } }, 'approval');
      }

      async function restoreHost(hostId) {
        const next = removedHosts.filter((h) => h !== hostId);
        const result = await putSettings({ removedHosts: next }, 'removed:' + hostId);
        if (result) flash(t('restoreDone'));
      }

      // --- Node rendering helpers ---

      function badgesFor(node, verifiedAt) {
        const items = [];
        const state = stateBadge(t, isRegistered(node) ? node : node.refTarget || node);
        if (state) items.push(jsx(Badge, { text: state, kind: node.state || 'plain' }, node.key + ':state'));
        const ago = agoText(t, verifiedAt, now);
        if (ago) items.push(jsx(MetaLine, { text: ago }, node.key + ':ago'));
        return items;
      }

      function resourceNode(kind, host, socket, session, window, pane) {
        const hostLabel = cleanLabel(host.label || host.id);
        const sid = session.sid;
        const wid = window.wid;
        const pid = pane.pid;
        const own = kind === 'session' ? session : kind === 'window' ? window : pane;
        const base = {
          hostId: host.id,
          socketId: socket.id,
          hostLabel,
          sid, wid, pid,
          uri: own.uri,
          registryKey: own.key,
          serverLabel: own.label,
          alias: own.alias || null,
          adopted: own.adopted,
          origin: own.origin,
          state: own.state,
          lastVerifiedAt: own.lastVerifiedAt || host.verifiedAt,
        };
        if (kind === 'session') {
          return {
            key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid,
            kind, ...base,
            label: resourceLabel(kind, session, t),
            childAliases: childTaskAliases(session),
            idText: '$' + sid,
            meta: [session.attached ? t('attached', { n: String(session.attached) }) : null].filter(Boolean),
          };
        }
        if (kind === 'window') {
          return {
            key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid + ':W:' + wid,
            kind, ...base,
            label: resourceLabel(kind, window, t),
            idText: '@' + wid,
            meta: [],
          };
        }
        // pane
        return {
          key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid + ':W:' + wid + ':P:' + pid,
          kind, ...base,
          label: resourceLabel(kind, pane, t),
          idText: '%' + pid,
          meta: [
            paneSecondaryTitle(pane, host, hostsMeta[host.id]),
            pane.cwd ? cleanLabel(pane.cwd) : null,
            pane.dead ? t('dead') : null,
          ].filter(Boolean),
          expandable: false,
        };
      }

      // Stable two-level presentation: host -> pane task. Navigation never adds rows.
      function visibleTree(inventory) {
        const model = { roots: [], byKey: new Map(), byUri: new Map() };
        for (const { host, tasks } of flatTasks(inventory)) {
          const hostNode = { key: 'h:' + host.id, kind: 'host', source: host, expandable: true, autoExpand: true, children: [] };
          model.roots.push(hostNode);
          model.byKey.set(hostNode.key, hostNode);
          for (const { socket, session, window, pane, links } of tasks) {
            const node = resourceNode('pane', host, socket, session, window, pane);
            node.label = taskCardTitle(pane, window, session);
            node.command = cleanLabel(pane.cmd) || t('unknownCommand');
            node.cwd = cleanLabel(pane.cwd);
            node.description = paneSecondaryTitle(pane, host, hostsMeta[host.id]);
            node.sessionNode = resourceNode('session', host, socket, session, {}, {});
            node.windowNode = resourceNode('window', host, socket, session, window, {});
            const parents = new Map();
            for (const link of links) {
              for (const parent of [resourceNode('session', host, socket, link.session, {}, {}), resourceNode('window', host, socket, link.session, link.window, {})]) parents.set(parent.uri, parent);
            }
            node.parentNodes = [...parents.values()];
            node.contextLabel = [cleanLabel(session.name), cleanLabel(window.name), String(pane.index ?? '?')].join(' / ');
            node.parentKey = hostNode.key;
            node.children = [];
            node.searchText = [node.label,node.command,node.cwd,node.description,node.contextLabel,host.label,host.id,...node.parentNodes.flatMap(parent => [parent.label, parent.alias])].join(' ').toLowerCase();
            hostNode.children.push(node);
            model.byKey.set(node.key, node);
            model.byUri.set(node.uri, node);
            for (const link of links) {
              model.byUri.set(link.pane.uri, node);
              if (!model.byUri.has(link.window.uri)) model.byUri.set(link.window.uri, node);
              if (!model.byUri.has(link.session.uri)) model.byUri.set(link.session.uri, node);
            }
          }
        }
        return model;
      }

      const tree = visibleTree(data);
      react.useEffect(() => {
        if (selectedUri && !findInventoryTarget(data, selectedUri)) setSelectedUri(null);
        if (revealedUri && !findInventoryTarget(data, revealedUri)) setRevealedUri(null);
      }, [data, selectedUri, revealedUri]);
      react.useEffect(() => {
        const node = tree.byUri.get(selectedUri);
        if (node) expandKeys(ancestorKeys(node));
      }, [selectedUri, revealedUri]);

      function remoteNameMeta(node, title) {
        if (!node.alias) return null;
        const remote = cleanLabel(node.label, 120);
        return remote && remote !== title ? remote : null;
      }

      function shortCwd(cwd) {
        const s = cleanLabel(cwd, 240);
        if (!s) return null;
        const parts = s.split('/');
        if (parts.length <= 2) return s;
        return '…/' + parts.slice(-2).join('/');
      }

      function refLabelFor(node) {
        if (node.refTarget?.kind === 'pane') return t('refPane');
        if (node.kind === 'session') return t('refSession');
        if (node.kind === 'window') return t('refWindow');
        return t('refPane');
      }

      function deleteLabelFor(node) {
        if (node.kind === 'session') return t('deleteSession');
        if (node.kind === 'window') return t('deleteWindow');
        return t('deletePane');
      }

      function actionItems(node) {
        const items = [];
        for (const parent of node.parentNodes || []) {
          items.push({ label: (parent.kind === 'session' ? t('refSession') : t('refWindow')) + ' · ' + rowTitle(parent), onClick: () => onReference(parent) });
        }
        items.push({ label: t('alias'), title: t('aliasTooltip'), onClick: () => setAliasTarget(node) });
        for (const parent of node.parentNodes || []) {
          const scope = kindTextFor(parent.kind, t) + ' · ' + rowTitle(parent);
          items.push({ label: t('alias') + ' · ' + scope, onClick: () => setAliasTarget({ ...parent, cardUri: node.uri }) });
          if (isRegistered(parent)) items.push({ label: t('unregister') + ' · ' + scope, onClick: () => onUnregister(parent) });
        }
        const registered = isRegistered(node) ? node : node.refTarget;
        if (isRegistered(registered)) {
          items.push({ label: t('unregister'), title: t('unregisterTooltip'), onClick: () => onUnregister(registered) });
        }
        return items;
      }

      function renderActions(node) {
        if (node.kind !== 'session' && node.kind !== 'window' && node.kind !== 'pane') return null;
        const refNode = node.refTarget || node;
        const local = hostsMeta[node.hostId]?.transport === 'local';
        const copyItems = [
          { label: t('copyBash'), title: local ? t('copyLocalBash') : t('copyMenuTooltip'), onClick: () => onCopy(node, 'posix') },
          { label: t('copyPowerShell'), disabled: local, title: local ? t('copyLocalPowerShell') : t('copyMenuTooltip'), onClick: () => onCopy(node, 'powershell') },
        ];
        const more = [...copyItems, ...actionItems(node)];
        more.push({ label: deleteLabelFor(node), onClick: () => setDialog({ kind: 'kill', node, label: cleanLabel(node.serverLabel) || cleanLabel(node.uri, 512), context: panelContext.current, navigationId: navigation.current.id }) });
        for (const parent of node.parentNodes || []) more.push({ label: deleteLabelFor(parent) + ' · ' + rowTitle(parent), onClick: () => setDialog({ kind: 'kill', node: parent, label: cleanLabel(parent.serverLabel) || cleanLabel(parent.uri, 512), context: panelContext.current, navigationId: navigation.current.id }) });
        const overflow = more.length
          ? jsx(Menu, { trigger: { label: '⋯', title: t('moreActions') }, items: more }, node.key + ':more')
          : null;
        return jsxs('span', { className: 'xc-actions', children: [jsx(ActionBtn, { label: t(terminalOpening ? 'openingTerminal' : 'openTerminal'), disabled: terminalOpening, className: 'xc-primary', onClick: () => onTerminal(node) }), jsx(ActionBtn, { label: t('viewOutput'), onClick: () => openTarget(node.uri) }), jsx(ActionBtn, { label: t('referenceTask'), onClick: () => onReference(refNode) }), overflow] });
      }

      function renderTask(node) {
        const label = rowTitle(node);
        const selected = tree.byUri.get(selectedUri)?.uri === node.uri;
        const highlighted = tree.byUri.get(highlightUri)?.uri === node.uri;
        return jsxs('article', { className: 'xc-task' + (selected ? ' xc-selected' : '') + (highlighted ? ' xc-highlight' : ''), 'data-kind': 'task', 'data-uri': node.uri, children: [
          jsxs('button', { type: 'button', className: 'xc-taskOpen', title: t('openTerminal'), disabled: terminalOpening, onClick: () => onTerminal(node), children: [
            jsx('span', { className: 'xc-taskIcon', children: terminalIcon(18) }),
            jsxs('span', { className: 'xc-taskIdentity', children: [
              jsx('span', { className: 'xc-taskTitle', children: label }),
              jsxs('span', { className: 'xc-taskSub', children: [jsx('span', { className: 'xc-command', children: node.command }), jsx('span', { className: 'xc-taskContext', title: node.cwd, children: node.state === 'stale' ? t('stale') : '' })] }),
            ] }),
            jsx('span', { className: 'xc-taskArrow', 'aria-hidden': true, children: '›' }),
          ] }),
          node.description && node.description !== label ? jsx('div', { className: 'xc-taskDescription', children: node.description }) : null,
          node.cwd ? jsx('div', { className: 'xc-taskPath', title: node.cwd, children: shortCwd(node.cwd) }) : null,
          node.state === 'stale' || node.state === 'unreachable' || node.meta.includes(t('dead')) ? jsx('div', { className: 'xc-err', children: node.meta.includes(t('dead')) ? t('dead') : stateBadge(t,node) }) : null,
          jsxs('div', { className: 'xc-taskBottom', children: [
            aliasTarget && (aliasTarget.cardUri || aliasTarget.uri) === node.uri ? jsx(AliasEditor, { node: aliasTarget, t, onSave: saveAlias, onCancel: () => setAliasTarget(null) }) : renderActions(node),
            [node, ...node.parentNodes].some(isRegistered) ? jsx('span', { className: 'xc-registered', title: t('registeredTask') + ': ' + [node, ...node.parentNodes].filter(isRegistered).map(item => kindTextFor(item.kind, t) + ' · ' + rowTitle(item)).join('; '), children: '✓' }) : null,
          ] }),
          jsx('details', { className: 'xc-taskDetails', children: [
            jsx('summary', { children: t('taskDetails') }, 'summary'),
            jsx('div', { className: 'xc-detailBody', children: [
              ...node.parentNodes.map(parent => jsx(ScopeRow, { label: kindTextFor(parent.kind, t), value: rowTitle(parent) + ' · ' + parent.idText }, parent.uri)),
              jsx(ScopeRow, { label: t('kindPane'), value: node.idText }, 'pane'),
              jsx(ScopeRow, { label: t('killScopeSocket'), value: node.socketId }, 'socket'),
              jsx('div', { className: 'xc-detailPath', children: node.cwd }, 'cwd'),
            ] }, 'body'),
          ] }),
        ] }, node.uri);
      }

      function renderHost(node) {
        const { key, source: host } = node;
        const unreachable = host.status === 'unreachable' || host.reachable === false;
        const failed = host.status === 'error';
        const open = isExpanded(node);
        const tasks = node.children.filter(task => !query.trim() || task.searchText.includes(query.trim().toLowerCase()));
        if (query.trim() && !tasks.length) return null;
        return jsxs('section', { className: 'xc-host', 'data-kind': 'host', children: [
          jsxs('div', { className: 'xc-hostHead', children: [
            jsxs('button', { type: 'button', className: 'xc-hostToggle', 'aria-expanded': open, onClick: () => toggleExpanded(node, !open), children: [
              jsx('span', { className: 'xc-hostDot' + (unreachable || failed ? ' xc-offline' : ''), 'aria-hidden': true }),
              jsx('span', { className: 'xc-hostName', children: cleanLabel(host.label || host.id) }),
              jsx('span', { className: 'xc-hostCount', children: String(node.children.length) }),
              jsx('span', { className: 'xc-hostChevron', 'aria-hidden': true, children: open ? '⌄' : '›' }),
            ] }),
            jsx(Menu, { trigger: { label: '⋯', title: t('moreActions') }, items: [{ label: t('removeHost'), title: t('removeHostTitle'), onClick: () => setDialog({ kind: 'hostRemove', host, context: panelContext.current }) }] }),
          ] }),
          open ? jsxs('div', { className: 'xc-taskList', children: [
            unreachable || failed ? jsx('div', { className: 'xc-hostWarning', children: host.error ? errorText(host.error, t('actionFailed')) : t(unreachable ? 'unreachable' : 'hostError') }) : null,
            ...tasks.map(renderTask),
            !tasks.length && !unreachable && !failed ? jsx('div', { className: 'xc-empty', children: t('noTasks') }) : null,
          ] }) : null,
        ] }, key);
      }

      // --- Capture preview (item 9) ---

      function refErrorMessage(code, message) {
        if (code === 'SERVER_RESTARTED') return t('refInvalidServerRestarted');
        if (code === 'TARGET_GONE') return t('refInvalidTargetGone');
        if (code === 'HOST_UNREACHABLE') return t('refInvalidHostUnreachable');
        return t('refInvalidGeneric', { message: message || t('actionFailed') });
      }

      function revealRef(uri, inventory, materialize = true) {
        const found = findInventoryTarget(inventory, uri, materialize);
        if (!found) { setSelectedUri(null); setRevealedUri(null); return; }
        const freshUri = found.node.uri;
        const model = visibleTree(inventory);
        const row = model.byUri.get(freshUri);
        setRevealedUri(freshUri);
        setQuery('');
        setSelectedUri(freshUri);
        setHighlightUri(freshUri);
        if (row) expandKeys(ancestorKeys(row, model));
      }

      // Only the latest capture in this panel lifetime may publish navigation.
      async function openTarget(uri) {
        navigation.current.controller?.abort();
        const id = ++navigation.current.id;
        const controller = new AbortController();
        navigation.current.controller = controller;
        const context = panelContext.current;
        const current = () => context && panelContext.current === context && navigation.current.id === id && !controller.signal.aborted;
        if (!current()) return;
        setSelectedUri(null);
        setRevealedUri(null);
        setHighlightUri(null);
        setPreview({ uri, loading: true, data: null, error: null });
        try {
          if (!decodeUri(uri)) throw new Error(t('actionFailed'));
          const capture = await api('/capture?uri=' + encodeURIComponent(uri), { signal: controller.signal });
          if (!current()) return;
          if (!['OK', 'OK_RELOCATED'].includes(capture?.code)) {
            setPreview({ uri, loading: false, data: null, error: { code: capture?.code, message: cleanLabel(capture?.message) } });
            return;
          }
          // Fetch after resolution, so relocation uses current inventory ancestry.
          const inventory = await refresh();
          if (!current()) return;
          setPreview({ uri, loading: false, data: capture, error: null });
          if (inventory) revealRef(uri, inventory);
        } catch (err) {
          if (current()) setPreview({ uri, loading: false, data: null, error: { code: err?.code, message: errorText(err, t('actionFailed')) } });
        } finally {
          if (navigation.current.id === id) navigation.current.controller = null;
        }
      }

      // The pending-target handoff: consume any target published before this panel
      // mounted, then keep consuming targets published while it is already open.
      const openTargetRef = react.useRef(openTarget);
      openTargetRef.current = openTarget;
      react.useEffect(() => {
        const initial = takePendingTarget(sessionId);
        if (initial) openTargetRef.current(initial);
        return subscribePendingTarget(sessionId, (uri) => openTargetRef.current(uri));
      }, [sessionId]);

      // --- Destructive-action completion handlers ---

      async function handleKillDone(result) {
        if (!dialog || panelContext.current !== dialog.context) return;
        const ancestors = ancestorKeys(dialog.node).slice(1).map((key) => tree.byKey.get(key)?.uri).filter(Boolean);
        setDialog(null);
        flash(t('killDeleted', { label: cleanLabel(result?.label) }));
        const inventory = await refresh();
        if (!inventory || panelContext.current !== dialog.context || navigation.current.id !== dialog.navigationId) return;
        // Killing a last pane may also remove its window/session. Reveal only a
        // surviving ancestor from the fresh inventory, never a reused numeric path.
        const parentUri = ancestors.find((uri) => findInventoryTarget(inventory, uri));
        if (parentUri) revealRef(parentUri, inventory);
        else { setSelectedUri(null); setRevealedUri(null); setHighlightUri(null); }
      }

      function handleHostRemoveDone() {
        if (!dialog || panelContext.current !== dialog.context) return;
        setDialog(null);
        refresh();
        flash(t('removeHostDone'));
      }

      // --- Panel body ---

      const hosts = hostsOf(data);
      const approvalState = settings
        ? (approvalEnabled ? t('approvalOn') : t('approvalOff'))
        : '';
      const previewData = preview?.data;
      const previewError = preview?.error;

      return jsxs('div', { className: 'xc-root', style: { '--xc-font-size': fontSize + 'px' }, children: [
        jsxs('div', { className: 'xc-header', children: [
          jsxs('div', { className: 'xc-heading', children: [jsx('span', { className: 'xc-headerTitle', children: t('title') }), jsx('span', { className: 'xc-subtitle', children: t('subtitle') })] }),
          jsx('button', { type: 'button', className: 'xc-action', 'aria-pressed': advanced, title: t('settings'), onClick: () => setAdvanced((v) => !v), children: '⚙' }),
          jsx('button', {
            type: 'button', className: 'xc-action', 'aria-pressed': approvalOpen, title: t('approval'),
            onClick: () => setApprovalOpen((v) => !v),
            children: approvalState ? t('approval') + '：' + approvalState : t('approval'),
          }),
          advanced ? jsxs('span', { className: 'xc-fontGroup', children: [
            jsx('button', { type: 'button', className: 'xc-action xc-fontBtn', title: t('fontSizeSmaller'), 'aria-label': t('fontSizeSmaller'), disabled: fontSize <= FONT_MIN, onClick: () => setFontSize((f) => Math.max(FONT_MIN, f - 1)), children: 'A−' }),
            jsx('button', { type: 'button', className: 'xc-action xc-fontBtn', title: t('fontSizeLarger'), 'aria-label': t('fontSizeLarger'), disabled: fontSize >= FONT_MAX, onClick: () => setFontSize((f) => Math.min(FONT_MAX, f + 1)), children: 'A+' }),
          ] }) : null,
          jsx('button', { type: 'button', className: 'xc-action', onClick: () => refresh(), children: t('refresh') }),
          lastRefreshedAt ? jsx('span', { className: 'xc-lastRefresh', children: t('lastRefresh', { time: formatTime(lastRefreshedAt) }) }) : null,
        ] }),

        approvalOpen ? jsx('div', { className: 'xc-settings', children: jsxs(Fragment, { children: [
          loading && !settings ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
          settingsError ? jsx('div', { className: 'xc-err', children: errorText(settingsError, t('actionFailed')) }) : null,
          settings ? jsxs('div', { className: 'xc-settingRow', children: [
            jsx('span', { className: 'xc-settingLabel', children: t('approval') }),
            jsx(Switch, {
              checked: !!approvalEnabled, disabled: settingsSaving === 'approval',
              onToggle: toggleApproval, label: t('approval'),
            }),
            jsx('span', { className: 'xc-settingValue', children: approvalEnabled ? t('approvalOn') : t('approvalOff') }),
            jsx('span', { className: 'xc-settingDesc', children: approvalEnabled ? t('approvalOnDesc') : t('approvalOffDesc') }),
            jsx('span', { className: 'xc-settingSource', children: approvalSourceText(approvalSource) }),
            approvalSource === 'panel'
              ? jsx('button', { type: 'button', className: 'xc-action', disabled: settingsSaving === 'approval', onClick: resetApproval, children: t('approvalReset') })
              : null,
          ] }) : null,
          legacyAllow.length > 0 ? jsx('div', { className: 'xc-settingsNote', children: t('approvalLegacyAllow', { list: legacyAllow.map((x) => cleanLabel(x)).join(', ') }) }) : null,
          jsx('div', { className: 'xc-settingsFootnote', children: t('approvalFootnote') }),
        ] }) }) : null,

        notice ? jsx('div', { className: 'xc-notice', children: notice }) : null,
        loading ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
        error ? jsx('div', { className: 'xc-err', children: t('loadFailed', { message: errorText(error, t('actionFailed')) }) }) : null,
        !loading && !error && hosts.length === 0 ? jsx('div', { className: 'xc-empty', children: t('empty') }) : null,
        !preview ? jsx('input', { className: 'xc-search', type: 'search', value: query, placeholder: t('searchTasks'), 'aria-label': t('searchTasks'), onChange: (event) => setQuery(event.target.value) }) : null,
        !preview ? jsx('div', { className: 'xc-tasks', children: tree.roots.map(renderHost) }) : null,
        !preview && query.trim() && !tree.roots.some(host => host.children.some(task => task.searchText.includes(query.trim().toLowerCase()))) ? jsx('div', { className: 'xc-empty', children: t('noMatches') }) : null,

        // Read-only capture preview below the tree (monospace, panel font size).
        preview ? jsxs('div', { className: 'xc-preview', children: [
          jsx('button', { type: 'button', className: 'xc-back', onClick: () => { navigation.current.controller?.abort(); navigation.current.id++; setPreview(null); }, children: '← ' + t('backToTasks') }),
          jsxs('div', { className: 'xc-previewHead', children: [
            jsx('span', { className: 'xc-previewTitle', children: tree.byUri.get(preview.uri)?.label || t('previewTitle') }),
            previewData?.label ? jsx('span', { className: 'xc-previewMeta', children: cleanLabel(previewData.label, 160) }) : null,
            previewData?.kind ? jsx('span', { className: 'xc-previewMeta', children: kindTextFor(previewData.kind, t) }) : null,
            jsx('span', { className: 'xc-previewReadonly', children: t('previewReadonly') }),
            preview?.uri ? jsx('button', { type: 'button', className: 'xc-action', disabled: preview.loading, onClick: () => openTarget(preview.uri), children: t('refresh') }) : null,
          ] }),
          preview.loading ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
          previewError ? jsx('div', { className: 'xc-err', children: refErrorMessage(previewError.code, previewError.message) }) : null,
          previewData?.text != null ? jsx('pre', { className: 'xc-previewText', children: cleanPreviewText(previewData.text) }) : null,
        ] }) : null,

        // Advanced section: removed hosts with a restore action.
        advanced ? jsxs('div', { className: 'xc-removedHosts', children: [
          jsx('div', { className: 'xc-removedHostsTitle', children: t('removedHostsSection') }),
          loading && !settings ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
          removedHosts.length === 0
            ? jsx('div', { className: 'xc-empty', children: t('removedHostsNone') })
            : removedHosts.map((hid) => jsxs('div', { className: 'xc-removedHostRow', children: [
                jsx('span', { className: 'xc-removedHostLabel', children: cleanLabel(hid, 120) }),
                jsx('button', { type: 'button', className: 'xc-action', disabled: settingsSaving === 'removed:' + hid, onClick: () => restoreHost(hid), children: t('restore') }),
              ] }, 'removed:' + hid)),
        ] }) : null,

        jsx('div', { className: 'xc-footer', children: t('panelHint') }),

        // Modals for destructive actions.
        dialog?.kind === 'kill' ? jsx(KillDialog, {
          node: dialog.node, label: dialog.label, t, fontSize,
          onClose: () => setDialog(null),
          onDone: handleKillDone,
        }) : null,
        dialog?.kind === 'hostRemove' ? jsx(HostRemoveDialog, {
          host: dialog.host, t, fontSize,
          onClose: () => setDialog(null),
          onDone: handleHostRemoveDone,
        }) : null,
      ] });
    }

    function formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    // --------------------------------------------------------------------------
    // Input-trigger source ("@tmux-xc") and codec
    // --------------------------------------------------------------------------

    function buildSource(ctx, t) {
      return {
        trigger: '@',
        name: SOURCE_NAME,
        order: 60,
        showGroupTitle: false,
        async candidates(session, req) {
          // Optional: adopted panes as @-mentions. Degrades to [] on any failure.
          try {
            if (req.signal.aborted) return [];
            const inventory = await api('/inventory?all=1', { signal: req.signal });
            const hosts = (inventory && (Array.isArray(inventory) ? inventory : inventory.hosts)) || [];
            const out = [];
            const pushNode = (node, hostLabel) => {
              if (!node?.uri || !(node.adopted || node.origin)) return;
              const parsed = canonicalToken(node.token, node.uri);
              if (!parsed) return;
              const label = chipLabel(parsed.label);
              out.push({
                name: label,
                label,
                description: cleanLabel(hostLabel, 120),
                section: t('candidatesSection'),
                value: JSON.stringify({ token: node.token }),
              });
            };
            for (const host of hosts) {
              for (const socket of (host.sockets || [])) {
                for (const session of (socket.sessions || [])) {
                  pushNode(session, host.label);
                  for (const window of (session.windows || [])) {
                    pushNode(window, host.label);
                    for (const pane of (window.panes || [])) {
                      pushNode(pane, host.label);
                    }
                  }
                }
              }
            }
            return out;
          } catch {
            return [];
          }
        },
        onPick(pick) {
          let parsed = null;
          try { parsed = JSON.parse(pick.candidate.value); } catch { /* fall through */ }
          const token = canonicalToken(parsed?.token);
          if (!token) return undefined;
          return {
            insert: {
              source: SOURCE_NAME,
              ref: parsed.token,
              label: chipLabel(token.label),
              clipboardText: parsed.token,
            },
          };
        },
        // Composer reference preview: open the sidebar tmux tab and hand the uri
        // to the panel via the pending-target store (never edits the draft).
        openReference(session, reference) {
          const uri = reference && uriOf(reference.ref);
          const decoded = uri && decodeUri(uri);
          if (!decoded) return false;
          try {
            if (!setPendingTarget(ctx, session.sessionId, uri)) return false;
            ctx.sidebarRight.openTabIn(session.sessionId, TAB_ID);
            return true;
          } catch {
            return false;
          }
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      };
    }

    // --------------------------------------------------------------------------
    // apply(ctx) — Cordis entry point
    // --------------------------------------------------------------------------

    const inject = [
      'locale',
      'slots',
      'sessions',
      'conversation',
      'uiConversation',
      'inputTriggers',
      'sidebarRight',
      'sidebarRightTabs',
      'webTerminals',
    ];

    const CSS = `
.xc-root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;overflow:auto;padding:20px 16px 16px;gap:16px;color:var(--dsw-alias-label-primary);font-size:var(--xc-font-size,13px);line-height:1.5;background:var(--dsw-alias-bg-layer-2)}
.xc-root *, .xc-root *:before,.xc-root *:after{box-sizing:border-box}
.xc-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.xc-heading{display:flex;flex-direction:column;gap:3px;width:100%;margin-bottom:6px}
.xc-headerTitle{font-size:1.46em;font-weight:650;letter-spacing:-.035em}
.xc-subtitle{color:var(--dsw-alias-label-tertiary);font-size:.923em}
.xc-action{font:inherit;font-size:.923em;line-height:1.4;padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,border-color .15s}
.xc-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.xc-action[aria-pressed=true]{color:var(--dsw-alias-state-business-primary)}
.xc-action:disabled{opacity:.45;cursor:default}
.xc-action.xc-danger{color:var(--dsw-alias-state-danger-primary,#c62828)}
.xc-root button:focus-visible,.xc-root summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
.xc-fontGroup{display:inline-flex;gap:2px;align-items:center}
.xc-fontBtn{min-width:30px;text-align:center}
.xc-lastRefresh{color:var(--dsw-alias-label-tertiary);font-size:.77em;font-variant-numeric:tabular-nums;margin-left:auto}
.xc-notice{padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-business-primary);font-size:.923em;overflow-wrap:anywhere}
.xc-err,.xc-hostWarning{color:var(--dsw-alias-state-danger-primary,#b74343);font-size:.923em;overflow-wrap:anywhere}
.xc-empty{color:var(--dsw-alias-label-tertiary);font-size:.923em;padding:14px 4px}
.xc-search{width:100%;min-height:38px;font:inherit;padding:9px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}
.xc-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.xc-search:focus{border-color:var(--dsw-alias-state-business-primary)}
.xc-tasks{display:flex;flex-direction:column;gap:24px}
.xc-hostHead{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.xc-hostToggle{font:inherit;color:inherit;display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:0;background:none;padding:3px 0;cursor:pointer;text-align:left}
.xc-hostDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#23856b);flex:none}
.xc-hostDot.xc-offline{background:var(--dsw-alias-state-warn-primary,#b87c26)}
.xc-hostName{font-weight:600;font-size:.923em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xc-hostCount{color:var(--dsw-alias-label-tertiary);font-size:.846em;font-variant-numeric:tabular-nums}
.xc-hostChevron{margin-left:auto;color:var(--dsw-alias-label-tertiary)}
.xc-hostHead>.xc-menu>.xc-action{background:none;border:0;font-size:1.2em;padding:0 6px}
.xc-taskList{display:flex;flex-direction:column;gap:10px}
.xc-task{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;min-width:0;box-shadow:0 2px 5px rgba(0,0,0,.025);transition:border-color .15s,box-shadow .15s}
.xc-task:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 3px 12px rgba(0,0,0,.045)}
.xc-task.xc-selected{border-color:var(--dsw-alias-state-business-primary)}
.xc-highlight{animation:xc-flash 1.8s ease-out}
@keyframes xc-flash{0%{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}100%{box-shadow:none}}
.xc-taskOpen{display:flex;align-items:center;gap:11px;width:100%;min-width:0;padding:0;text-align:left;font:inherit;color:inherit;border:0;background:none;cursor:pointer}
.xc-taskIcon{width:34px;height:34px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;flex:none}
.xc-taskIdentity{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.xc-taskTitle{font-weight:600;font-size:1.077em;letter-spacing:-.015em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xc-taskSub{display:flex;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:.846em}
.xc-command{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xc-taskContext{margin-left:auto}
.xc-taskArrow{color:var(--dsw-alias-label-tertiary);font-size:1.15em}
.xc-taskDescription{margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:.923em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.xc-taskPath{margin-top:4px;font-size:.8em;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xc-taskBottom{display:flex;align-items:center;gap:8px;margin-top:14px}
.xc-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0}
.xc-actions .xc-action{font-size:.846em;padding:5px 9px}
.xc-actions .xc-primary{background:var(--dsw-alias-bg-layer-2);border-color:transparent;color:var(--dsw-alias-label-primary);font-weight:600}
.xc-registered{color:var(--dsw-alias-state-success-primary,#23856b);font-size:.85em;margin-left:auto}
.xc-taskDetails{margin-top:11px;font-size:.8em;color:var(--dsw-alias-label-tertiary)}
.xc-taskDetails>summary{cursor:pointer;list-style:none;display:inline-block}
.xc-taskDetails>summary:before{content:'+';margin-right:5px}
.xc-taskDetails[open]>summary:before{content:'−'}
.xc-taskDetails>summary::-webkit-details-marker{display:none}
.xc-detailBody{display:flex;flex-direction:column;gap:4px;padding-top:10px}
.xc-detailPath{overflow-wrap:anywhere}
.xc-back{align-self:flex-start;font:inherit;font-size:.923em;background:none;border:0;color:var(--dsw-alias-label-secondary);padding:0 0 8px;cursor:pointer}
.xc-menu{position:relative;display:inline-flex}
.xc-menuTrigger{padding:0 6px}
.xc-menuPop{position:fixed;z-index:2147483647;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;width:max-content;min-width:min(180px,calc(100vw - 16px));max-width:min(340px,calc(100vw - 16px));max-height:calc(100dvh - 16px);overflow:auto;padding:3px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);line-height:1.35;border:.5px solid var(--dsw-alias-border-l3);box-shadow:0 4px 12px rgba(0,0,0,.18)}
.xc-menuItem{font:inherit;font-size:.9167em;line-height:1.35;text-align:left;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm,4px);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:normal;overflow-wrap:anywhere}
.xc-menuItem:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}
.xc-menuItem:disabled{opacity:.5;cursor:default}
.xc-menuHint{font-size:.8333em;line-height:1.35;color:var(--dsw-alias-label-tertiary);padding:3px 8px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:2px;white-space:pre-line;overflow-wrap:anywhere}
.xc-aliasInput{box-sizing:border-box;font:inherit;font-size:.9167em;line-height:1.35;width:100%;max-width:260px;margin:2px 0;padding:2px 6px;border-radius:var(--dsw-radius-sm,4px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.xc-settings{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.xc-settingRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.xc-settingLabel{flex:none;min-width:44px;font-size:.9167em;font-weight:500}
.xc-settingValue{flex:none;font-size:.9167em;font-weight:600}
.xc-settingDesc{color:var(--dsw-alias-label-secondary);font-size:.8333em}
.xc-settingSource{color:var(--dsw-alias-label-tertiary);font-size:.8333em}
.xc-settingsNote{color:var(--dsw-alias-state-warn-primary);font-size:.8333em}
.xc-settingsFootnote{color:var(--dsw-alias-label-tertiary);font-size:.8333em}
.xc-switch{flex:none;position:relative;width:34px;height:18px;border-radius:999px;border:0;background:var(--dsw-alias-bg-layer-3);cursor:pointer;padding:0;transition:background-color .12s}
.xc-switchOn{background:var(--dsw-alias-state-business-primary)}
.xc-switch:disabled{opacity:.5;cursor:default}
.xc-switchKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:left .12s}
.xc-switchOn .xc-switchKnob{left:18px}
.xc-footer{margin-top:auto;color:var(--dsw-alias-label-tertiary);font-size:.8333em;padding-top:4px;border-top:.5px solid var(--dsw-alias-border-l2)}
.xc-opener{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-md,6px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.xc-opener:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.xc-title{font-size:1em}
.xc-refchip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;height:20px;margin:0 1px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);vertical-align:baseline;cursor:default;max-width:100%}
.xc-refchip[role=button]{cursor:pointer}
.xc-refchip[role=button]:hover{background:var(--dsw-alias-bg-layer-3)}
.xc-refchipLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9167em}
.xc-modalBackdrop{position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:center;padding:min(48px,5dvh) 16px;overflow:auto;line-height:1.35;background:rgba(0,0,0,.35)}
.xc-modal{box-sizing:border-box;width:100%;max-width:460px;max-height:90dvh;display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg,10px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary)}
.xc-modalHead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.xc-modalTitle{flex:1;font-size:1em;font-weight:600}
.xc-modalClose{flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,4px);background:none;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:1;cursor:pointer}
.xc-modalClose:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.xc-modalBody{display:flex;flex-direction:column;gap:10px;padding:12px;min-height:0;overflow-y:auto}
.xc-scope{display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-2)}
.xc-scopeRow{display:flex;gap:8px;min-width:0}
.xc-scopeLabel{flex:none;color:var(--dsw-alias-label-tertiary);font-size:.8333em;min-width:52px}
.xc-scopeValue{min-width:0;overflow-wrap:anywhere;font-size:.9167em}
.xc-dialogNote{color:var(--dsw-alias-label-secondary);font-size:.9167em;overflow-wrap:anywhere}
.xc-dialogWarn{color:var(--dsw-alias-state-warn-primary)}
.xc-confirmHint{color:var(--dsw-alias-label-secondary);font-size:.8333em}
.xc-confirmInput{font:inherit;font-size:.9167em;line-height:1.35;width:100%;box-sizing:border-box;padding:4px 8px;border-radius:var(--dsw-radius-sm,4px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.xc-dialogActions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.xc-choice{display:flex;flex-direction:column;gap:4px;text-align:left;padding:8px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.xc-choiceOn{border-color:var(--dsw-alias-state-business-primary)}
.xc-choiceDisabled{cursor:default;opacity:.65}
.xc-choiceTitle{font-weight:600;font-size:.9167em}
.xc-choiceDesc{color:var(--dsw-alias-label-secondary);font-size:.8333em;overflow-wrap:anywhere}
.xc-choiceSection{color:var(--dsw-alias-label-tertiary);font-size:.8333em;font-weight:600;margin-top:2px}
.xc-dialogRow{display:flex;align-items:center;gap:6px;padding:2px 0;min-width:0}
.xc-dialogRowLabel{display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere}
.xc-dialogRowLabel small{color:var(--dsw-alias-label-secondary)}
.xc-results{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-2)}
.xc-resultRow{display:flex;align-items:center;gap:8px;min-width:0}
.xc-resultLabel{display:flex;flex-direction:column;min-width:0;overflow-wrap:anywhere;flex:1 1 auto}
.xc-resultState{flex:none;font-size:.8333em}
.xc-resultOk{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}
.xc-resultFail{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-warn-primary))}
.xc-removedHosts{display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.xc-removedHostsTitle{font-size:.9167em;font-weight:600}
.xc-removedHostRow{display:flex;align-items:center;gap:8px;min-width:0}
.xc-removedHostLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.xc-preview{display:flex;flex-direction:column;gap:14px;padding:16px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.xc-previewHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.xc-previewTitle{font-weight:600;font-size:1.15em;width:100%}
.xc-previewMeta{color:var(--dsw-alias-label-secondary);font-size:.8333em}
.xc-previewReadonly{color:var(--dsw-alias-label-tertiary);font-size:.8333em}
.xc-previewText{margin:0;padding:8px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:monospace;font-size:var(--xc-font-size,12px);line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:60dvh}
`;

    // Uses the shipped 0.2.1 native terminal provider: the new tab owns the
    // model's mount/render lifecycle. Never attach or acknowledge on its behalf.
    async function openNativeTerminal(ctx, sessionId, uri, signal, t) {
      const binding = ctx.sessions.binding(sessionId);
      if (!binding || !ctx.webTerminals?.launchShells || signal.aborted) throw new Error(t('terminalUnavailable'));
      const panelSignal = signal;
      const lifetime = new AbortController();
      const cancel = () => lifetime.abort();
      panelSignal.addEventListener('abort', cancel, { once: true });
      const releaseSession = binding.ctx.effect(() => cancel, 'tmux-xc: terminal launch');
      const releasePlugin = ctx.effect(() => cancel, 'tmux-xc: terminal launch');
      signal = lifetime.signal;
      const current = () => !signal.aborted && ctx.sessions.binding(sessionId)?.ctx === binding.ctx;
      try {
      const choices = await ctx.webTerminals.launchShells(sessionId, signal);
      // Owner-only host preparation resolves the durable reference afresh.
      const prepared = await api('/terminal-target', { method: 'POST', body: { uri }, signal });
      const shell = terminalShell(choices.shells || [], prepared.host);
      if (!shell) throw new Error(t('terminalUnavailable'));
      const command = terminalAttachCommand(prepared.node, prepared.host, prepared.socket, shell);
      if (!command || !current()) throw new Error(t('terminalUnavailable'));
      const before = new Set(ctx.sidebarRight.tabsIn(sessionId).map(tab => tab.id));
      // Native tab activation can unmount the cards. From here the originating
      // Session, plugin and new tab own cancellation, not the old panel DOM.
      panelSignal.removeEventListener('abort', cancel);
      // Scoped 0.2.1 runtime bridge, already used by reference navigation.
      ctx.sidebarRight.openTabIn(sessionId, 'terminal', { params: { shellPath: shell.path } });
      const added = ctx.sidebarRight.tabsIn(sessionId).filter(tab => !before.has(tab.id) && tab.kind === 'terminal');
      if (added.length !== 1) throw new Error(t('terminalUnavailable'));
      const tab = added[0];
      const model = ctx.webTerminals.view(sessionId, tab.id, tab.contentId, undefined, shell.path);
      await new Promise((resolve, reject) => {
        let finished = false, sent = false, unsubscribe = () => {}, unwatch = () => {};
        const done = error => {
          if (finished) return;
          finished = true; clearTimeout(timer); unsubscribe(); unwatch(); signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const aborted = () => done(new Error('Terminal launch cancelled.'));
        const check = () => {
          if (!current() || !ctx.sidebarRight.tabsIn(sessionId).some(item => item.id === tab.id && item.contentId === tab.contentId)) return aborted();
          const state = model.state.getSnapshot();
          if (['failed', 'closed', 'disconnected'].includes(state.phase) || ['failed', 'exited'].includes(state.info?.state)) return done(new Error(state.error?.message || 'Terminal is not connected.'));
          if (!state.writable) return;
          // One shot only: consume before write, never replay on reconnect.
          if (finished || sent) return;
          sent = true;
          // Consumed before write; even a synchronous observable update cannot replay it.
          try { model.write(command + '\r'); done(); } catch (error) { done(error); }
        };
        const timer = setTimeout(() => done(new Error('Terminal did not become ready within 30 seconds.')), 30000);
        signal.addEventListener('abort', aborted, { once: true });
        unsubscribe = model.state.subscribe(check);
        unwatch = ctx.sidebarRight.openTabs.subscribe(check);
        check();
      });
      } finally {
        panelSignal.removeEventListener('abort', cancel);
        releaseSession?.();
        releasePlugin?.();
        lifetime.abort();
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tmux-xc: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.effect(() => () => {
        for (const scope of pendingScopes.values()) scope.dispose();
        pendingScopes.clear();
        pendingTargets.clear();
        pendingListeners.clear();
      }, 'dsh-tmux-xc: pending references');

      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-tmux-xc: styles');

      // Right-sidebar tab type.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        keepMounted: true,
        priority: 'extension',
        title: () => t('title'),
      }), 'dsh-tmux-xc: tab');

      // Tab body, keyed by the tab id. The injected sessionId is this mounted
      // panel's session; selection/expansion state lives in that component.
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        inject: (sessionId) => ({
          sessionId,
          sessions: ctx.sessions,
          conversation: ctx.conversation,
          openTerminal: (uri, signal) => openNativeTerminal(ctx, sessionId, uri, signal, t),
        }),
      }, TmuxXcPanel)), 'dsh-tmux-xc: panel');

      // Tab title.
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        locale: NS,
        inject: () => ({}),
      }, TmuxXcTitle)), 'dsh-tmux-xc: panel title');

      // Composer opener button.
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'dsh-tmux-xc-opener',
        order: 40,
        locale: NS,
      }, function TmuxXcOpener(props) {
        if (!props.sessionId) return null;
        return jsx('button', {
          type: 'button',
          className: 'xc-opener',
          title: props.t('openPanel'),
          'aria-label': props.t('openPanel'),
          onClick: () => { ctx.sidebarRight.openTabIn(props.sessionId, TAB_ID); },
          children: terminalIcon(14),
        });
      })), 'dsh-tmux-xc: opener');

      // Input-trigger source.
      ctx.effect(() => ctx.inputTriggers.registerSource(buildSource(ctx, t)), 'dsh-tmux-xc: @ source');

      // Sent-message token rule + keyed chip renderer.
      ctx.effect(() => ctx.uiConversation.userText.register(tmuxUserTextRule), 'dsh-tmux-xc: user-text rule');

      ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
        name: 'conversation.user.text.node',
        key: 'tmux-xc',
        priority: 100,
        locale: NS,
        inject: (sessionId) => ({
          openTarget: (uri) => {
            if (setPendingTarget(ctx, sessionId, uri)) ctx.sidebarRight.openTabIn(sessionId, TAB_ID);
          },
        }),
      }, TmuxXcChip)), 'dsh-tmux-xc: chip renderer');
    }

    return { name: 'dsh-tmux-xc', inject, apply };
  },
});
}

// Test-only exports for test/unit/client-pure.test.js. In the browser (classic
// script) this is a no-op; Node evaluates this file as an ES module for its side
// effects and reads the pure builders off globalThis.
if (typeof window === 'undefined' && typeof globalThis !== 'undefined') {
  globalThis.__dshTmuxXcPure = {
    posixQuote,
    powerShellQuote,
    buildRemoteAttachCommand,
    attachCommandPosix,
    attachCommandPowerShell,
    terminalShell,
    terminalAttachCommand,
    killConfirmString,
    findInventoryTarget,
    kindTextFor,
    resourceLabel,
    rowTitle,
    childTaskAliases,
    taskCardTitle,
    flatTasks,
    menuPosition,
    tokenAt,
    canonicalToken,
    tmuxUserTextRule,
  };
}