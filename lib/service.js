/**
 * TmuxXcService — host-side operations for the tmux cross-conversation plugin.
 *
 * Every operation that touches the remote resolves a reference against a
 * *fresh* inventory, verifies the host fingerprint against the registry pin
 * (TOFU), and only then runs a guarded remote script. Mutating scripts are
 * never retried or replayed.
 *
 * @module lib/service
 */
import { XcError, CODES } from './core/errors.js';
import {
  toHexBytes,
  tmuxTarget,
  validateSessionName,
  validateHostId, validateSocketId, validateAlias, validateSocketName, validateSocketPath,
} from './core/quote.js';
import { sanitizeText, tokenSafeLabel } from './core/sanitize.js';
import { runRemote } from './core/transport.js';
import {
  newNonce,
  inventoryScript,
  createSessionScript,
  createWindowScript,
  splitPaneScript,
  sendScript,
  captureScript,
  detachScript,
  killScript,
  NAMED_KEYS,
} from './core/scripts.js';
import { parseInventory, parseCreated } from './core/parse.js';
import {
  encodeRef,
  decodeRef,
  formatToken,
  targetString,
  resourceKey,
} from './core/uri.js';
import { resolve, assertResolved, refFromInventory, labelFor } from './core/identity.js';

const KEY_ZH = {
  Enter: '回车', Escape: '退出', Tab: '制表', BSpace: '退格', Up: '上', Down: '下',
  Left: '左', Right: '右', Home: '行首', End: '行尾', PageUp: '上一页', PageDown: '下一页',
  'C-c': '控制键加第三个拉丁字母', 'C-d': '控制键加第四个拉丁字母', 'C-z': '控制键加第二十六个拉丁字母', 'C-l': '控制键加第十二个拉丁字母',
};

/** Lossless visible preview of a UTF-8 prefix, with an exact omitted-byte count. */
export function approvalPreview(text, locale = 'en', maxBytes = 1024) {
  let used = 0;
  let escaped = '';
  for (const char of String(text)) {
    const bytes = Buffer.byteLength(char);
    if (used + bytes > maxBytes) break;
    used += bytes;
    const cp = char.codePointAt(0);
    if (char === '\\') escaped += '\\\\';
    else if (char === '"') escaped += '\\"';
    else if (char === '\n') escaped += '\\n';
    else if (char === '\t') escaped += '\\t';
    else if (char === '\r') escaped += '\\r';
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) escaped += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (/[\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(char)) escaped += `\\u${cp.toString(16).padStart(4, '0')}`;
    else escaped += char;
  }
  const more = Buffer.byteLength(String(text)) - used;
  return `"${escaped}"${more ? (locale === 'zh' ? `（另有 ${more} 字节）` : ` (+${more} more bytes)`) : ''}`;
}

const SEND_MAX_BYTES = 16 * 1024;
const DEFAULT_CAPTURE = { defaultLines: 80, maxLines: 2000, maxBytes: 65536 };
const TRANSPORT_ERROR_CODES = new Set([
  CODES.HOST_UNREACHABLE,
  CODES.SSH_AUTH,
  CODES.SSH_HOSTKEY,
  CODES.SSH_MISSING,
  CODES.TIMEOUT,
]);
// Detached sessions default to a tiny 80x24; keep created sessions usable.
const NEW_SESSION_WIDTH = 200;
const NEW_SESSION_HEIGHT = 50;

/** Map a `['mismatch', ...]` guard record to the most precise XcError. */
function mismatchError(record, expectedGen) {
  // WP1 emits ['mismatch', gen, sid, wid, pid, target, expectedGen].
  const observedGen = record[1];
  if (observedGen !== expectedGen) {
    return new XcError(
      CODES.SERVER_RESTARTED,
      `tmux server restarted while the operation was pending (was ${expectedGen}, now ${observedGen}); re-resolve the reference`,
      { expectedGen, observedGen },
    );
  }
  return new XcError(
    CODES.TARGET_GONE,
    'the resolved target changed before the operation ran; re-resolve the reference',
    { expectedGen },
  );
}

function isTransportError(error) {
  return error instanceof XcError && TRANSPORT_ERROR_CODES.has(error.code);
}

/** Parse a tmux target string `$3` / `@5` / `%7`. */
function parseTarget(target) {
  if (typeof target !== 'string' || !/^[$@%](0|[1-9]\d*)$/.test(target)) return undefined;
  const num = Number(target.slice(1));
  if (!Number.isSafeInteger(num) || num < 0) return undefined;
  const prefix = target[0];
  if (prefix === '$') return { kind: 'session', num };
  if (prefix === '@') return { kind: 'window', num };
  if (prefix === '%') return { kind: 'pane', num };
  return undefined;
}

function clampInteger(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Decode a remote hex string (from `od`) to UTF-8 text. */
function decodeHexUtf8(hex) {
  if (typeof hex !== 'string') {
    throw new XcError(CODES.PROTOCOL, 'capture returned a non-text payload');
  }
  return Buffer.from(hex, 'hex').toString('utf8');
}

function targetNum(target) {
  return target.kind === 'session' ? target.sid : target.kind === 'window' ? target.wid : target.pid;
}

export class TmuxXcService {
  #lifetime;
  #hosts;
  #pending = new Set();
  constructor({ config, registry, transport = { runRemote }, now = Date.now, logger }) {
    this.config = config ?? {};
    this.registry = registry;
    this.transport = transport;
    this.now = now;
    this.logger = logger ?? console;
    this.#lifetime = new AbortController();
    this.#hosts = (this.config.hosts ?? []).map((host) => ({
      id: host.id,
      label: host.label ?? host.id,
      ssh: host.ssh,
      transport: host.transport ?? 'ssh',
      sockets: host.sockets ?? [{ id: 'default' }],
      newSession: host.newSession ?? {},
    }));
    for (const host of this.#hosts) {
      validateHostId(host.id);
      if (!['ssh', 'local'].includes(host.transport)) throw new XcError(CODES.INVALID_ARGUMENT, 'invalid transport');
      if (host.transport === 'ssh') validateAlias(host.ssh);
      for (const socket of host.sockets) {
        validateSocketId(socket.id);
        if (socket.name != null) validateSocketName(socket.name);
        if (socket.path != null) validateSocketPath(socket.path);
        if (socket.name != null && socket.path != null) throw new XcError(CODES.INVALID_ARGUMENT, 'socket cannot have both name and path');
      }
    }
    // Track complete operations, not merely their subprocesses: disposal must
    // also wait for continuations and queued registry writes before domain.close.
    for (const name of ['inventory', 'resolveRef', 'adopt', 'create', 'capture', 'send', 'detach', 'kill', 'forget', 'references', 'describeForApproval']) {
      const operation = this[name].bind(this);
      this[name] = (...args) => {
        const pending = Promise.resolve().then(() => {
          this.assertAvailable();
          return operation(...args);
        });
        this.#pending.add(pending);
        pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
        return pending;
      };
    }
  }

  assertAvailable() {
    if (this.#lifetime.signal.aborted) throw new XcError(CODES.CANCELLED, 'tmux service is closed');
    this.registry.assertAvailable?.();
  }

  /** Owner-visible validated attach metadata; never arbitrary ssh options. */
  hosts() {
    this.assertAvailable();
    return this.#hosts.map(({ id, label, transport, ssh, sockets }) => ({
      id, label, transport,
      ...(transport === 'ssh' ? { ssh } : {}),
      sockets: sockets.map(({ id, name, path }) => ({
        id, ...(name != null ? { name } : {}), ...(path != null ? { path } : {}),
      })),
    }));
  }

  #hostById(hostId) {
    const host = this.#hosts.find((h) => h.id === hostId);
    if (host === undefined) {
      throw new XcError(CODES.HOST_NOT_ALLOWED, `host "${hostId}" is not allow-listed`, { hostId });
    }
    return host;
  }

  #socketById(host, socketId) {
    const id = socketId ?? 'default';
    const socket = host.sockets.find((s) => s.id === id);
    if (socket === undefined) {
      throw new XcError(
        CODES.SOCKET_NOT_ALLOWED,
        `socket "${id}" is not allow-listed for host "${host.id}"`,
        { hostId: host.id, socketId: id },
      );
    }
    return socket;
  }

  #sshCfg() {
    return {
      sshPath: this.config.sshPath ?? '',
      sshConfigFile: this.config.sshConfigFile ?? '',
      connectTimeoutSec: this.config.connectTimeoutSec ?? 10,
    };
  }

  /** Merge a caller signal with the service lifetime so unload aborts in-flight ssh. */
  #signal(callerSignal) {
    if (callerSignal === undefined || callerSignal === null) return this.#lifetime.signal;
    return AbortSignal.any([this.#lifetime.signal, callerSignal]);
  }

  /** Abort every in-flight remote operation (called on plugin unload). */
  async close() {
    this.#lifetime.abort();
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  /** Run one remote script and surface guard `mismatch` records as errors. */
  async #runScript(host, script, nonce, { mutating, signal, expectedGen }) {
    let records;
    try {
      ({ records } = await this.transport.runRemote({
        cfg: this.#sshCfg(),
        alias: host.ssh,
        host,
        script,
        nonce,
        mutating,
        signal: this.#signal(signal),
        timeoutMs: this.config.commandTimeoutMs ?? 20000,
      }));
    } catch (error) {
      if (isTransportError(error)) {
        await this.registry.markUnreachable(host.id, error, this.now());
      }
      throw error;
    }
    const mismatch = records.find((record) => record[0] === 'mismatch');
    if (mismatch !== undefined) throw mismatchError(mismatch, expectedGen);
    return records;
  }

  /** Fresh inventory for one host socket, updating registry reachability. */
  async #runInventory(host, socket, signal) {
    const nonce = newNonce();
    const script = inventoryScript(nonce, socket);
    let records;
    try {
      ({ records } = await this.transport.runRemote({
        cfg: this.#sshCfg(),
        alias: host.ssh,
        host,
        script,
        nonce,
        mutating: false,
        signal: this.#signal(signal),
        timeoutMs: this.config.commandTimeoutMs ?? 20000,
      }));
    } catch (error) {
      if (isTransportError(error)) {
        await this.registry.markUnreachable(host.id, error, this.now());
      }
      throw error;
    }
    const inv = parseInventory(records);
    await this.registry.markVerified(host.id, socket.id, inv, this.now());
    return inv;
  }

  /** TOFU-pin or verify the host fingerprint. */
  async #verifyHost(host, inv) {
    const pin = await this.registry.hostPin(host.id, {
      fp: inv.host.fp,
      user: inv.host.user,
      uid: inv.host.uid,
    });
    if (!pin.ok) {
      throw new XcError(
        CODES.HOST_IDENTITY_CHANGED,
        `host "${host.id}" fingerprint changed from ${pin.pinned?.fp ?? 'unknown'} to ${inv.host.fp}; ` +
          'forget the host record if this change is expected',
        { hostId: host.id, pinnedFp: pin.pinned?.fp, currentFp: inv.host.fp },
      );
    }
  }

  /** Resolve a reference token against fresh remote state. */
  async resolveRef(uri, { signal, requirePane = false } = {}) {
    const ref = decodeRef(uri);
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const inv = await this.#runInventory(host, socket, signal);
    await this.#verifyHost(host, inv);
    const result = resolve(ref, inv, { requirePane });
    return { ref, result, inv };
  }

  #expect(ref, target) {
    const num = targetNum(target);
    return {
      gen: ref.gen,
      ...(target.sid != null ? { sid: target.sid } : {}),
      ...(target.wid != null ? { wid: target.wid } : {}),
      ...(target.pid != null ? { pid: target.pid } : {}),
      target: tmuxTarget(target.kind, num),
    };
  }

  async #adoptedKeySet(hostId, workspace, all) {
    const options = all ? { hostId, all: true } : workspace ? { hostId, workspace } : { hostId };
    const entries = await this.registry.resourceList(options);
    return new Map(entries.map((entry) => [entry.key, entry]));
  }

  #nodeFlags(host, socket, inv, kind, sid, wid, pid, adopted) {
    const ref = {
      hostId: host.id,
      hostFp: inv.host.fp,
      socketId: socket.id,
      gen: inv.server.gen,
      kind,
      sid: sid ?? null,
      wid: wid ?? null,
      pid: pid ?? null,
    };
    const uri = encodeRef(ref);
    const key = resourceKey(ref);
    const target = assertResolved(resolve(ref, inv));
    const label = tokenSafeLabel(labelFor(host.label, target));
    const stored = adopted.get(key);
    return {
      adopted: Boolean(stored), key, uri, label,
      token: formatToken(label, uri),
      ...(stored ? { origin: stored.origin, state: stored.state, lastVerifiedAt: stored.lastVerifiedAt } : {}),
    };
  }

  #buildPane(host, socket, inv, session, window, pane, adopted) {
    return {
      ...pane,
      ...this.#nodeFlags(host, socket, inv, 'pane', session.sid, window.wid, pane.pid, adopted),
    };
  }

  #buildWindow(host, socket, inv, session, window, adopted) {
    return {
      ...window,
      panes: window.panes.map((pane) => this.#buildPane(host, socket, inv, session, window, pane, adopted)),
      ...this.#nodeFlags(host, socket, inv, 'window', session.sid, window.wid, null, adopted),
    };
  }

  #buildSession(host, socket, inv, session, adopted) {
    return {
      ...session,
      windows: session.windows.map((window) => this.#buildWindow(host, socket, inv, session, window, adopted)),
      ...this.#nodeFlags(host, socket, inv, 'session', session.sid, null, null, adopted),
    };
  }

  #buildSocket(host, socket, inv, adopted) {
    if (inv.server == null) {
      return { id: socket.id, server: null, sessions: [] };
    }
    return {
      id: socket.id,
      server: { gen: inv.server.gen, socketPath: inv.server.socketPath },
      sessions: inv.sessions.map((session) => this.#buildSession(host, socket, inv, session, adopted)),
    };
  }

  /**
   * Inventory of allow-listed hosts (or one host) with registry flags per node.
   */
  async inventory({ hostId, workspace, all, signal } = {}) {
    let hosts;
    if (hostId !== undefined) {
      const host = this.#hostById(hostId);
      hosts = [host];
    } else {
      hosts = this.#hosts;
    }
    const out = [];
    for (const host of hosts) {
      // Keep reachable as the legacy complete-inventory success flag; status
      // distinguishes transport failures from other inventory errors.
      const entry = { id: host.id, label: host.label, reachable: false, status: 'ok', verifiedAt: null, sockets: [] };
      try {
        for (const socket of host.sockets) {
          const inv = await this.#runInventory(host, socket, signal);
          await this.#verifyHost(host, inv);
          const adopted = await this.#adoptedKeySet(host.id, workspace, all);
          entry.sockets.push(this.#buildSocket(host, socket, inv, adopted));
        }
        entry.reachable = true;
        entry.verifiedAt = this.now();
      } catch (error) {
        if (!(error instanceof XcError)) throw error;
        entry.status = isTransportError(error) ? 'unreachable' : 'error';
        entry.error = { code: error.code, message: error.message };
      }
      out.push(entry);
    }
    return { hosts: out };
  }

  #entryFromTarget(ref, target, origin, by) {
    const at = this.now();
    const meta = {};
    if (target.session != null && target.session.attached != null) meta.attached = target.session.attached;
    if (target.pane != null) {
      if (target.pane.cwd != null) meta.cwd = target.pane.cwd;
      if (target.pane.cmd != null) meta.cmd = target.pane.cmd;
      if (target.pane.dead != null) meta.dead = target.pane.dead;
      if (target.pane.width != null) meta.width = target.pane.width;
      if (target.pane.height != null) meta.height = target.pane.height;
    }
    return {
      key: resourceKey(ref),
      uri: encodeRef(ref),
      kind: ref.kind,
      hostId: ref.hostId,
      hostFp: ref.hostFp,
      socketId: ref.socketId,
      gen: ref.gen,
      sid: ref.sid,
      wid: ref.wid,
      pid: ref.pid,
      labels: {
        ...(target.session?.name != null ? { session: target.session.name } : {}),
        ...(target.window?.name != null ? { window: target.window.name } : {}),
        ...(target.pane?.index != null ? { pane: target.pane.index } : {}),
      },
      meta,
      origin,
      by: { sessionId: by?.sessionId ?? 'owner', at },
      workspaces: by?.workspace ? [by.workspace] : [],
      state: 'live',
      lastVerifiedAt: at,
    };
  }

  /** Adopt an existing remote object into the registry (remote read-only). */
  async adopt({ hostId, socketId, target, by, signal }) {
    let ref;
    let inv;
    let result;
    if (typeof target === 'string' && target.startsWith('dsh-tmux:')) {
      const resolved = await this.resolveRef(target, { signal });
      ref = resolved.ref;
      inv = resolved.inv;
      result = resolved.result;
    } else {
      const parsed = parseTarget(target);
      if (parsed === undefined) {
        throw new XcError(CODES.INVALID_ARGUMENT, 'adopt target must be $N, @N, %N or a reference uri', { target });
      }
      const host = this.#hostById(hostId);
      const socket = this.#socketById(host, socketId);
      inv = await this.#runInventory(host, socket, signal);
      await this.#verifyHost(host, inv);
      ref = refFromInventory(host.id, socket.id, inv, parsed.kind, parsed.num);
      result = resolve(ref, inv);
    }
    const resolvedTarget = assertResolved(result);
    const entry = this.#entryFromTarget(ref, resolvedTarget, 'adopted', by);
    const stored = await this.registry.resourceUpsert(entry);
    return this.#presentEntry(stored, resolvedTarget);
  }

  #presentEntry(entry, target) {
    const label = tokenSafeLabel(labelFor(this.#hostById(entry.hostId).label, target));
    return { ...entry, label, token: formatToken(label, entry.uri) };
  }

  /** Create a session/window/pane on a remote host and register it. */
  async create({ hostId, socketId, kind, name, parentUri, cwd, horizontal = false, by, signal, approvalIdentity }) {
    if (!['session', 'window', 'pane'].includes(kind)) {
      throw new XcError(CODES.INVALID_ARGUMENT, 'kind must be session, window or pane', { kind });
    }
    const host = this.#hostById(hostId);
    const socket = this.#socketById(host, socketId);
    const inv = await this.#runInventory(host, socket, signal);
    await this.#verifyHost(host, inv);

    const nonce = newNonce();
    let script;
    let expectedGen = inv.server?.gen;
    if (kind === 'session') {
      this.#checkApproval(approvalIdentity, this.#serverIdentity(host, socket, inv));
      cwd = cwd ?? host.newSession.cwd;
      if (name === undefined || name === '') {
        throw new XcError(CODES.INVALID_ARGUMENT, 'session create requires a name');
      }
      validateSessionName(name);
      const command = host.newSession?.command;
      script = createSessionScript(nonce, socket, {
        name,
        expectedGen: inv.server?.gen ?? null,
        ...(cwd ? { cwd } : {}),
        ...(Array.isArray(command) && command.length > 0 ? { command } : {}),
        width: NEW_SESSION_WIDTH,
        height: NEW_SESSION_HEIGHT,
      });
    } else {
      if (parentUri === undefined) {
        throw new XcError(CODES.INVALID_ARGUMENT, `${kind} create requires parentRef`);
      }
      const parent = await this.resolveRef(parentUri, { signal });
      if (parent.ref.hostId !== host.id || parent.ref.socketId !== socket.id) {
        throw new XcError(CODES.INVALID_ARGUMENT, 'parent must belong to the selected host and socket');
      }
      const parentTarget = this.#approvedTarget(parent, approvalIdentity);
      const expect = this.#expect(approvalIdentity ?? parent.ref, parentTarget);
      expectedGen = parent.ref.gen;
      if (kind === 'window') {
        if (parentTarget.kind !== 'session') {
          throw new XcError(CODES.INVALID_ARGUMENT, 'window create requires a session parentRef');
        }
        if (name !== undefined) validateSessionName(name);
        script = createWindowScript(nonce, socket, expect, {
          ...(name !== undefined ? { name } : {}),
          ...(cwd ? { cwd } : {}),
        });
      } else {
        if (parentTarget.kind !== 'pane') {
          throw new XcError(CODES.INVALID_ARGUMENT, 'pane create requires a pane parentRef');
        }
        script = splitPaneScript(nonce, socket, expect, {
          horizontal: Boolean(horizontal),
          ...(cwd ? { cwd } : {}),
        });
      }
    }

    const records = await this.#runScript(host, script, nonce, {
      mutating: true,
      signal,
      expectedGen,
    });
    const created = parseCreated(records);
    // The creation response, never a subsequent inventory, owns identity.
    const ref = {
      hostId: host.id, hostFp: inv.host.fp, socketId: socket.id,
      gen: created.gen, kind, sid: created.sid,
      wid: kind === 'session' ? null : created.wid,
      pid: kind === 'pane' ? created.pid : null,
    };

    // Re-read only for labels/metadata, rejecting a replaced generation.
    const inv2 = await this.#runInventory(host, socket, signal);
    await this.#verifyHost(host, inv2);
    const resolvedTarget = assertResolved(resolve(ref, inv2));
    const entry = await this.registry.resourceUpsert(this.#entryFromTarget(ref, resolvedTarget, 'created', by));
    return this.#presentEntry(entry, resolvedTarget);
  }

  /** Capture bounded recent pane output (sanitized; untrusted). */
  async capture({ uri, lines, signal }) {
    const cap = { ...DEFAULT_CAPTURE, ...(this.config.capture ?? {}) };
    const { ref, result } = await this.resolveRef(uri, { signal, requirePane: true });
    const target = this.#paneTarget(assertResolved(result));
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const lineCount = clampInteger(lines ?? cap.defaultLines, 1, cap.maxLines);
    const nonce = newNonce();
    const script = captureScript(nonce, socket, this.#expect(ref, target), { lines: lineCount, maxBytes: cap.maxBytes });
    const records = await this.#runScript(host, script, nonce, {
      mutating: false,
      signal,
      expectedGen: ref.gen,
    });
    const captureRecord = records.find((record) => record[0] === 'capture');
    if (captureRecord === undefined) {
      throw new XcError(CODES.PROTOCOL, 'capture produced no output record');
    }
    const sanitized = sanitizeText(decodeHexUtf8(captureRecord[1]), { maxBytes: cap.maxBytes });
    return {
      text: sanitized.text,
      truncated: sanitized.truncated || captureRecord[2] === '1',
      lines: lineCount,
      target: labelFor(host.label, target),
    };
  }

  /** Send deliberate input to exactly one pane. */
  async send({ uri, text, keys = [], enter = false, signal, approvalIdentity }) {
    if (text !== undefined && text !== null) {
      if (Buffer.byteLength(text, 'utf8') > SEND_MAX_BYTES) {
        throw new XcError(CODES.INVALID_ARGUMENT, `send text exceeds ${SEND_MAX_BYTES} bytes`);
      }
    }
    const keyList = Array.isArray(keys) ? keys : [];
    for (const key of keyList) {
      if (!NAMED_KEYS.includes(key)) {
        throw new XcError(CODES.INVALID_ARGUMENT, `key "${key}" is not in the allow-list`, { key });
      }
    }
    if (!text && keyList.length === 0 && !enter) {
      throw new XcError(CODES.INVALID_ARGUMENT, 'send requires text, keys, or enter');
    }
    const resolved = await this.resolveRef(uri, { signal, requirePane: true });
    const { ref } = resolved;
    const target = this.#approvedTarget(resolved, approvalIdentity, true);
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const nonce = newNonce();
    const script = sendScript(nonce, socket, this.#expect(approvalIdentity ?? ref, target), {
      hex: text ? toHexBytes(text) : [],
      keys: keyList,
      enter: Boolean(enter),
    });
    await this.#runScript(host, script, nonce, { mutating: true, signal, expectedGen: ref.gen });
    return {
      delivered: true,
      target: labelFor(host.label, target),
      bytes: text ? Buffer.byteLength(text, 'utf8') : 0,
    };
  }

  /** Detach tmux clients from the session that contains the referenced target. */
  async detach({ uri, signal, approvalIdentity }) {
    const resolved = await this.resolveRef(uri, { signal });
    const { ref } = resolved;
    const target = this.#approvedTarget(resolved, approvalIdentity);
    if (target.sid == null) {
      throw new XcError(CODES.AMBIGUOUS, 'detach requires a resolvable session');
    }
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const expect = this.#expect(approvalIdentity ?? ref, target);
    const nonce = newNonce();
    const script = detachScript(nonce, socket, expect);
    await this.#runScript(host, script, nonce, { mutating: true, signal, expectedGen: ref.gen });
    return { detached: true, target: labelFor(host.label, target) };
  }

  /** Kill a remote session/window/pane; confirm must match the target string. */
  async kill({ uri, confirm, signal, approvalIdentity }) {
    const resolved = await this.resolveRef(uri, { signal });
    const { ref } = resolved;
    const expected = targetString(ref);
    if (confirm !== expected) {
      throw new XcError(
        CODES.CONFIRM_MISMATCH,
        `confirm must equal the target string "${expected}" (got ${JSON.stringify(confirm)})`,
        { expected, confirm },
      );
    }
    const target = this.#approvedTarget(resolved, approvalIdentity);
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const nonce = newNonce();
    const script = killScript(nonce, socket, this.#expect(approvalIdentity ?? ref, target), target.kind);
    await this.#runScript(host, script, nonce, { mutating: true, signal, expectedGen: ref.gen });
    return { killed: true, target: labelFor(host.label, target) };
  }

  /** Forget a local registry entry (never touches the remote). */
  async forget({ uri, key } = {}) {
    const resolvedKey = key ?? (uri !== undefined ? resourceKey(decodeRef(uri)) : undefined);
    if (resolvedKey === undefined) {
      throw new XcError(CODES.INVALID_ARGUMENT, 'forget requires a reference uri or a resource key');
    }
    return this.registry.resourceForget(resolvedKey);
  }

  /** References submitted by one conversation (read-only local). */
  async references(sessionId) {
    return this.registry.conversationGet(sessionId);
  }

  #paneTarget(target) {
    if (target.pid == null) throw new XcError(CODES.AMBIGUOUS, 'operation requires exactly one pane');
    return { ...target, kind: 'pane' };
  }

  #identity(ref, target) {
    return {
      hostId: ref.hostId, hostFp: ref.hostFp, socketId: ref.socketId, gen: ref.gen,
      kind: target.kind, sid: target.sid ?? null, wid: target.wid ?? null, pid: target.pid ?? null,
    };
  }

  #serverIdentity(host, socket, inv) {
    return { hostId: host.id, hostFp: inv.host.fp, socketId: socket.id,
      gen: inv.server?.gen ?? null, kind: 'server', sid: null, wid: null, pid: null };
  }

  #checkApproval(pinned, fresh) {
    if (pinned && Object.keys(fresh).some((key) => pinned[key] !== fresh[key])) {
      throw new XcError(CODES.TARGET_CHANGED, 'approved target changed; request a new approval', { approved: pinned, current: fresh });
    }
  }

  #approvedTarget(resolved, pinned, requirePane = false) {
    if (pinned && !['OK', 'OK_RELOCATED'].includes(resolved.result.code)) {
      throw new XcError(CODES.TARGET_CHANGED, 'approved target no longer resolves; request a new approval', { resolution: resolved.result.code });
    }
    const target = requirePane ? this.#paneTarget(assertResolved(resolved.result)) : assertResolved(resolved.result);
    this.#checkApproval(pinned, this.#identity(resolved.ref, target));
    return target;
  }

  async describeForApproval(toolName, args = {}, { signal } = {}) {
    const create = toolName === 'tmux_xc_create';
    const send = toolName === 'tmux_xc_send';
    let host, socket, target, identity;
    if (create && args.kind === 'session') {
      host = this.#hostById(args.hostId);
      socket = this.#socketById(host, args.socketId);
      const inv = await this.#runInventory(host, socket, signal);
      await this.#verifyHost(host, inv);
      identity = this.#serverIdentity(host, socket, inv);
    } else {
      const resolved = await this.resolveRef(create ? args.parentRef : args.ref, { signal, requirePane: send });
      target = send ? this.#paneTarget(assertResolved(resolved.result)) : assertResolved(resolved.result);
      host = this.#hostById(resolved.ref.hostId);
      socket = this.#socketById(host, resolved.ref.socketId);
      if (create && (host.id !== args.hostId || socket.id !== (args.socketId ?? 'default'))) {
        throw new XcError(CODES.INVALID_ARGUMENT, 'parent must belong to the selected host and socket');
      }
      identity = this.#identity(resolved.ref, target);
    }
    const q = (value, locale = 'en') => approvalPreview(String(value ?? ''), locale);
    const ids = `$${identity.sid ?? '-'} @${identity.wid ?? '-'} %${identity.pid ?? '-'}`;
    const enTarget = `host ${q(host.label)} (${q(host.id)}), socket ${q(socket.id)}${socket.name ? ` name ${q(socket.name)}` : ''}${socket.path ? ` path ${q(socket.path)}` : ''}, generation ${identity.gen ?? 'none'}, ids ${ids}, session ${q(target?.session?.name)}, window ${q(target?.window?.name)}, pane ${q(target?.pane?.title)}`;
    const zhTarget = `主机 ${q(host.label, 'zh')}（${q(host.id, 'zh')}），套接字 ${q(socket.id, 'zh')}${socket.name ? ` 名称 ${q(socket.name, 'zh')}` : ''}${socket.path ? ` 路径 ${q(socket.path, 'zh')}` : ''}，代际 ${identity.gen ?? '无'}，编号 ${ids}，会话 ${q(target?.session?.name, 'zh')}，窗口 ${q(target?.window?.name, 'zh')}，窗格 ${q(target?.pane?.title, 'zh')}`;
    const cwd = create ? (args.cwd ?? (args.kind === 'session' ? host.newSession.cwd : '')) : target?.pane?.cwd;
    const locationEn = `; cwd ${q(cwd)}`;
    const locationZh = `；工作目录 ${q(cwd, 'zh')}`;
    if (create) {
      const kindZh = { session: '会话', window: '窗口', pane: '窗格' }[args.kind];
      if (!kindZh) throw new XcError(CODES.INVALID_ARGUMENT, 'invalid create kind');
      return {
        identity,
        en: `Create ${args.kind} named ${q(args.name)}; ${enTarget}${locationEn}; parent ${target ? ids : 'none'}; horizontal ${Boolean(args.horizontal)}; command ${q(JSON.stringify(args.kind === 'session' ? (host.newSession.command ?? []) : []))}`,
        zh: `创建${kindZh}，名称 ${q(args.name, 'zh')}；${zhTarget}${locationZh}；父级 ${target ? ids : '无'}；横向分割 ${args.horizontal ? '是' : '否'}；启动命令 ${q(JSON.stringify(args.kind === 'session' ? (host.newSession.command ?? []) : []), 'zh')}`,
      };
    }
    if (send) {
      const keys = args.keys ?? [];
      return {
        identity,
        en: `Send input; ${enTarget}${locationEn}; enter ${Boolean(args.enter)}; keys ${JSON.stringify(keys)}; payload ${approvalPreview(String(args.text ?? ''), 'en', SEND_MAX_BYTES)}`,
        zh: `发送输入；${zhTarget}${locationZh}；追加回车 ${args.enter ? '是' : '否'}；按键 ${keys.length ? keys.map((key) => KEY_ZH[key] ?? q(key, 'zh')).join('、') : '无'}；输入内容 ${approvalPreview(String(args.text ?? ''), 'zh', SEND_MAX_BYTES)}`,
      };
    }
    if (toolName === 'tmux_xc_detach') return { identity, en: `Detach clients from session $${identity.sid}; ${enTarget}${locationEn}`, zh: `断开会话 $${identity.sid} 的客户端；${zhTarget}${locationZh}` };
    if (toolName === 'tmux_xc_kill') return { identity, en: `Kill ${identity.kind}; ${enTarget}${locationEn}; confirm ${q(args.confirm)}`, zh: `销毁${{ session: '会话', window: '窗口', pane: '窗格' }[identity.kind] ?? '目标'}；${zhTarget}${locationZh}；确认值 ${q(args.confirm, 'zh')}` };
    throw new XcError(CODES.INVALID_ARGUMENT, 'unknown approval operation');
  }
}
