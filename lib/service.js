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
} from './core/quote.js';
import { sanitizeText, sanitizeLabel } from './core/sanitize.js';
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

const SEND_MAX_BYTES = 16 * 1024;
const DEFAULT_CAPTURE = { defaultLines: 80, maxLines: 2000, maxBytes: 65536 };
// Detached sessions default to a tiny 80x24; keep created sessions usable.
const NEW_SESSION_WIDTH = 200;
const NEW_SESSION_HEIGHT = 50;

/** Map a `['mismatch', ...]` guard record to the most precise XcError. */
function mismatchError(record, expectedGen) {
  const observedGen = record
    .slice(1)
    .find((field) => typeof field === 'string' && /^\d+-\d+$/.test(field));
  if (observedGen !== undefined && observedGen !== expectedGen) {
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

function codeOf(error) {
  return error instanceof XcError ? error.code : 'INTERNAL';
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Parse a tmux target string `$3` / `@5` / `%7`. */
function parseTarget(target) {
  if (typeof target !== 'string' || target.length < 2) return undefined;
  const num = Number(target.slice(1));
  if (!Number.isInteger(num) || num < 0) return undefined;
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
      sockets: host.sockets ?? [{ id: 'default' }],
      newSession: host.newSession ?? {},
    }));
  }

  /** The allow-listed host/socket surface (never ssh options or paths). */
  hosts() {
    return this.#hosts.map(({ id, label, sockets }) => ({
      id,
      label,
      sockets: sockets.map(({ id }) => ({ id })),
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
  close() {
    this.#lifetime.abort();
  }

  /** Run one remote script and surface guard `mismatch` records as errors. */
  async #runScript(host, script, nonce, { mutating, signal, expectedGen }) {
    const { records } = await this.transport.runRemote({
      cfg: this.#sshCfg(),
      alias: host.ssh,
      script,
      nonce,
      mutating,
      signal: this.#signal(signal),
      timeoutMs: this.config.commandTimeoutMs ?? 20000,
    });
    const mismatch = records.find((record) => record[0] === 'mismatch');
    if (mismatch !== undefined) throw mismatchError(mismatch, expectedGen);
    return records;
  }

  /** Fresh inventory for one host socket, updating registry reachability. */
  async #runInventory(host, socket, signal) {
    const nonce = newNonce();
    const script = inventoryScript(nonce, socket);
    try {
      const records = await this.transport.runRemote({
        cfg: this.#sshCfg(),
        alias: host.ssh,
        script,
        nonce,
        mutating: false,
        signal: this.#signal(signal),
        timeoutMs: this.config.commandTimeoutMs ?? 20000,
      });
      const inv = parseInventory(records);
      await this.registry.markVerified(host.id, socket.id, inv, this.now());
      return inv;
    } catch (error) {
      if (error instanceof XcError && error.code === CODES.HOST_UNREACHABLE) {
        try {
          await this.registry.markUnreachable(host.id, messageOf(error), this.now());
        } catch {
          /* registry update must not mask the transport error */
        }
      }
      throw error;
    }
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
    return new Set(entries.map((entry) => entry.key));
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
    return {
      adopted: adopted.has(key),
      key,
      uri,
      token: formatToken(this.#nodeLabel(kind, sid, wid, pid, inv), uri),
    };
  }

  #nodeLabel(kind, sid, wid, pid, inv) {
    const session = inv.sessions.find((s) => s.sid === sid);
    const window = session?.windows.find((w) => w.wid === wid);
    const pane = window?.panes.find((p) => p.pid === pid);
    if (kind === 'pane') {
      return `${session?.name ?? sid}:${window?.index ?? wid}.${pane?.index ?? pid}`;
    }
    if (kind === 'window') {
      return `${session?.name ?? sid}:${window?.index ?? wid}`;
    }
    return session?.name ?? String(sid);
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
      const entry = { id: host.id, label: host.label, reachable: false, sockets: [] };
      try {
        const adopted = await this.#adoptedKeySet(host.id, workspace, all);
        for (const socket of host.sockets) {
          const inv = await this.#runInventory(host, socket, signal);
          await this.#verifyHost(host, inv);
          entry.sockets.push(this.#buildSocket(host, socket, inv, adopted));
        }
        entry.reachable = true;
        entry.verifiedAt = this.now();
      } catch (error) {
        entry.error = { code: codeOf(error), message: messageOf(error) };
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
      by: { sessionId: by.sessionId, at },
      workspaces: by.workspace ? [by.workspace] : [],
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
    return this.registry.resourceUpsert(entry);
  }

  /** Create a session/window/pane on a remote host and register it. */
  async create({ hostId, socketId, kind, name, parentUri, cwd, horizontal = false, by, signal }) {
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
      if (name === undefined || name === '') {
        throw new XcError(CODES.INVALID_ARGUMENT, 'session create requires a name');
      }
      validateSessionName(name);
      const command = host.newSession?.command;
      script = createSessionScript(nonce, socket, {
        name,
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
      const parentTarget = assertResolved(parent.result);
      const expect = this.#expect(parent.ref, parentTarget);
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
    const num = kind === 'session' ? created.sid : kind === 'window' ? created.wid : created.pid;

    // Re-read so the registered entry carries fresh labels and metadata.
    const inv2 = await this.#runInventory(host, socket, signal);
    await this.#verifyHost(host, inv2);
    const ref = refFromInventory(host.id, socket.id, inv2, kind, num);
    const resolvedTarget = assertResolved(resolve(ref, inv2));
    return this.registry.resourceUpsert(this.#entryFromTarget(ref, resolvedTarget, 'created', by));
  }

  /** Capture bounded recent pane output (sanitized; untrusted). */
  async capture({ uri, lines, signal }) {
    const cap = { ...DEFAULT_CAPTURE, ...(this.config.capture ?? {}) };
    const { ref, result } = await this.resolveRef(uri, { signal, requirePane: true });
    const target = assertResolved(result);
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const lineCount = clampInteger(lines ?? cap.defaultLines, 1, cap.maxLines);
    const nonce = newNonce();
    const script = captureScript(nonce, socket, this.#expect(ref, target), { lines: lineCount });
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
      truncated: sanitized.truncated,
      lines: lineCount,
      target: labelFor(host.label, target),
    };
  }

  /** Send deliberate input to exactly one pane. */
  async send({ uri, text, keys = [], enter = false, signal }) {
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
    const { ref, result } = await this.resolveRef(uri, { signal, requirePane: true });
    const target = assertResolved(result);
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const nonce = newNonce();
    const script = sendScript(nonce, socket, this.#expect(ref, target), {
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
  async detach({ uri, signal }) {
    const { ref, result } = await this.resolveRef(uri, { signal });
    const target = assertResolved(result);
    if (target.sid == null) {
      throw new XcError(CODES.AMBIGUOUS, 'detach requires a resolvable session');
    }
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const expect = { gen: ref.gen, sid: target.sid, target: tmuxTarget('session', target.sid) };
    const nonce = newNonce();
    const script = detachScript(nonce, socket, expect);
    await this.#runScript(host, script, nonce, { mutating: true, signal, expectedGen: ref.gen });
    return { detached: true, target: labelFor(host.label, target) };
  }

  /** Kill a remote session/window/pane; confirm must match the target string. */
  async kill({ uri, confirm, signal }) {
    const { ref, result } = await this.resolveRef(uri, { signal });
    const expected = targetString(ref);
    if (confirm !== expected) {
      throw new XcError(
        CODES.CONFIRM_MISMATCH,
        `confirm must equal the target string "${expected}" (got ${JSON.stringify(confirm)})`,
        { expected, confirm },
      );
    }
    const target = assertResolved(result);
    const host = this.#hostById(ref.hostId);
    const socket = this.#socketById(host, ref.socketId);
    const nonce = newNonce();
    const script = killScript(nonce, socket, this.#expect(ref, target), target.kind);
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

  async #describeTarget(uri, signal, extraEn = '', extraZh = '') {
    const { ref, result } = await this.resolveRef(uri, { signal });
    const host = this.#hostById(ref.hostId);
    const target = result.code === 'OK' || result.code === 'OK_RELOCATED' ? result.target : undefined;
    const label = target !== undefined ? labelFor(host.label, target) : targetString(ref);
    const en = `${label} (${targetString(ref)})${extraEn}`;
    const zh = `${label}（${targetString(ref)}）${extraZh}`;
    return { en, zh };
  }

  async describeForApproval(toolName, args = {}, { signal } = {}) {
    try {
      switch (toolName) {
        case 'tmux_xc_create': {
          const host = this.#hostById(args.hostId);
          const socketId = args.socketId ?? 'default';
          const hostLabel = host.label ?? host.id;
          const kind = args.kind === 'pane' ? 'a pane' : args.kind === 'window' ? 'a window' : 'a session';
          const name = args.name ? ` named ${JSON.stringify(sanitizeLabel(args.name, 40))}` : '';
          const en = `create ${kind}${name} on ${hostLabel} (${host.id}:${socketId})`;
          const zh = `在 ${hostLabel} 上创建${args.kind === 'session' ? '会话' : args.kind === 'window' ? '窗口' : '窗格'}${name}（${host.id}:${socketId}）`;
          return { en, zh };
        }
        case 'tmux_xc_send': {
          const preview = args.text ? ` text ${JSON.stringify(sanitizeLabel(args.text, 120))}` : '';
          const keys = Array.isArray(args.keys) && args.keys.length > 0 ? ` keys ${JSON.stringify(args.keys)}` : '';
          return this.#describeTarget(args.ref, signal, `${preview}${keys}`, ` 发送输入${preview}${keys}`);
        }
        case 'tmux_xc_detach':
          return this.#describeTarget(args.ref, signal, '', ' 断开客户端');
        case 'tmux_xc_kill':
          return this.#describeTarget(args.ref, signal, ' (confirm required)', ' 销毁目标（需确认）');
        default:
          return this.#genericDescription(toolName, args);
      }
    } catch {
      return this.#genericDescription(toolName, args);
    }
  }

  #genericDescription(toolName, args) {
    const summary = Object.keys(args ?? {}).length > 0 ? ` (${JSON.stringify(args)})` : '';
    const en = `${toolName}${summary} requires approval`;
    const zh = `${toolName}${summary} 需要人工批准`;
    return { en, zh };
  }
}
