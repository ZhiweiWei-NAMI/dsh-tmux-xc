/**
 * Registry: hosts (TOFU pins), adopted/created resources and conversation
 * references. Persisted through `ctx.storage.domain` (DESIGN §5) or kept in
 * memory for tests. Storage deps are loaded lazily so importing this module
 * never requires the DSH packages.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { XcError, CODES } from './core/errors.js';
import { sanitizeLabel } from './core/sanitize.js';
import { decodeRef, encodeRef, resourceKey } from './core/uri.js';
import { resolve as resolveRef } from './core/identity.js';

/**
 * Domain and table names must match DSH's UNIT_NAME_RE `/^[a-z][a-z0-9_]*$/`,
 * so the DESIGN names (`dsh-tmux-xc`, `dsh-tmux-xc.p.<profile>`) are rendered with
 * underscores. See "Open questions" in the WP2 report.
 */
export const USER_DOMAIN = 'dsh_tmux_xc';
export const PROFILE_DOMAIN_PREFIX = 'dsh_tmux_xc_p_';

const DOMAIN_NAME_RE = /^[a-z][a-z0-9_]*$/;

const KINDS = ['host', 'server', 'session', 'window', 'pane'];
const STATES = ['live', 'stale', 'unreachable'];
const ORIGINS = ['created', 'adopted'];

let deps;

/** Lazily load `@deepseek-ai/dsh-storage-domain` and `zod` (never at module load). */
function storageDeps() {
  if (deps) return deps;
  const require = createRequire(import.meta.url);
  const domain = require('@deepseek-ai/dsh-storage-domain');
  const zodModule = require('zod');
  const z = zodModule?.default?.object ? zodModule.default : zodModule;
  deps = { defineDomain: domain.defineDomain, domainTable: domain.domainTable, z };
  return deps;
}

function invalid(message, details) {
  return new XcError(CODES.INVALID_ARGUMENT, message, details);
}

function integerOrNull() {
  const { z } = storageDeps();
  return z.number().int().nonnegative().nullable();
}

function errorShape() {
  const { z } = storageDeps();
  return z.object({ code: z.string(), message: z.string() }).passthrough().optional();
}

function schemas() {
  const { z } = storageDeps();
  const hosts = z.object({
    hostId: z.string(),
    fp: z.string(),
    user: z.string(),
    uid: z.string(),
    firstSeenAt: z.number(),
    lastVerifiedAt: z.number().optional(),
    lastError: errorShape(),
  }).passthrough();

  const labels = z.object({
    session: z.string().optional(),
    window: z.string().optional(),
    pane: z.string().optional(),
  }).passthrough().default({});

  const meta = z.object({
    cwd: z.string().optional(),
    cmd: z.string().optional(),
    attached: z.number().optional(),
    dead: z.boolean().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }).passthrough().default({});

  const by = z.object({
    sessionId: z.string(),
    at: z.number(),
    workspace: z.string().optional(),
  }).passthrough();

  const resources = z.object({
    key: z.string(),
    uri: z.string(),
    kind: z.enum(KINDS),
    hostId: z.string(),
    hostFp: z.string(),
    socketId: z.string(),
    gen: z.string(),
    sid: integerOrNull(),
    wid: integerOrNull(),
    pid: integerOrNull(),
    labels,
    meta,
    origin: z.enum(ORIGINS),
    by,
    workspaces: z.array(z.string()),
    state: z.enum(STATES),
    staleReason: z.string().optional(),
    lastVerifiedAt: z.number().optional(),
    lastError: errorShape(),
  }).passthrough();

  const refs = z.object({
    uri: z.string(),
    label: z.string(),
    firstSeenAt: z.number(),
  }).passthrough();

  const conversations = z.object({
    sessionId: z.string(),
    refs: z.array(refs).default([]),
    announcedAt: z.number().optional(),
  }).passthrough();

  return { hosts, resources, conversations };
}

/**
 * Domain spec for `ctx.storage.domain.open`. Sync, but loads zod on first use.
 * DESIGN's `dsh-tmux-xc` / `dsh-tmux-xc.p.<profile>` spellings are accepted and
 * normalized to DSH's stricter unit-name charset.
 */
export function registrySpec(name) {
  if (typeof name === 'string') name = name.replace(/[.-]/g, '_');
  if (typeof name !== 'string' || !DOMAIN_NAME_RE.test(name)) {
    throw new Error(`registry domain name '${name}' must match ${DOMAIN_NAME_RE}`);
  }
  const { defineDomain, domainTable } = storageDeps();
  const { hosts, resources, conversations } = schemas();
  return defineDomain({
    name,
    version: 1,
    layout: 'per-record',
    tables: {
      hosts: domainTable(hosts),
      resources: domainTable(resources),
      conversations: domainTable(conversations),
    },
  });
}

function profileDomainName(name) {
  if (typeof name !== 'string' || name.length === 0 || !name.isWellFormed()) {
    throw invalid('profile registry scope requires an exact, non-empty, well-formed profileContext.name');
  }
  // Hash the exact identity: no case folding, punctuation replacement, Unicode
  // normalization or truncation that could merge distinct legal profiles.
  return `${PROFILE_DOMAIN_PREFIX}${createHash('sha256').update(name, 'utf8').digest('hex')}`;
}

/** Path-safe conversation key; a changed id keeps a short sha256 suffix for uniqueness. */
export function conversationKey(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw invalid('sessionId must be a non-empty string', { sessionId });
  }
  const mapped = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  if (mapped === sessionId) return mapped;
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 8);
  return `${mapped}-${digest}`;
}

function serializeError(error) {
  if (!error) return undefined;
  if (typeof error === 'string') return { code: 'ERROR', message: error };
  return { code: String(error.code ?? 'ERROR'), message: String(error.message ?? error) };
}

function cleanLabels(labels) {
  const out = {};
  for (const key of ['session', 'window', 'pane']) {
    const value = labels?.[key];
    if (typeof value === 'string') out[key] = sanitizeLabel(value);
  }
  return out;
}

function cleanMeta(meta) {
  const out = {};
  if (!meta) return out;
  for (const key of ['cwd', 'cmd', 'attached', 'dead', 'width', 'height']) {
    if (meta[key] === undefined || meta[key] === null) continue;
    // Paths and command names are untrusted remote text (DESIGN §12).
    out[key] = key === 'cwd' || key === 'cmd' ? sanitizeLabel(String(meta[key])) : meta[key];
  }
  return out;
}

function unionWorkspaces(a, b) {
  const out = [];
  for (const value of [...(a ?? []), ...(b ?? [])]) {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out;
}

function labelsFromTarget(target) {
  const labels = {};
  if (target.session?.name) labels.session = target.session.name;
  if (target.window?.name) labels.window = target.window.name;
  if (target.pane?.title) labels.pane = target.pane.title;
  return cleanLabels(labels);
}

function metaFromTarget(target) {
  return cleanMeta({
    cwd: target.pane?.cwd,
    cmd: target.pane?.cmd,
    attached: target.session?.attached,
    dead: target.pane?.dead,
    width: target.pane?.width,
    height: target.pane?.height,
  });
}

function refOfEntry(entry) {
  return {
    hostId: entry.hostId,
    hostFp: entry.hostFp,
    socketId: entry.socketId,
    gen: entry.gen,
    kind: entry.kind,
    sid: entry.sid,
    wid: entry.wid,
    pid: entry.pid,
  };
}

/** Build a normalized resource entry from an upsert argument. */
function normalizeEntry(input) {
  if (!input || typeof input !== 'object') throw invalid('resourceUpsert expects an entry object');
  if (typeof input.uri !== 'string') throw invalid('entry.uri is required', { entry: input });
  const ref = decodeRef(input.uri);
  const key = resourceKey(ref);
  if (input.key !== undefined && input.key !== key) {
    throw invalid(`entry.key '${input.key}' does not match the key derived from its uri ('${key}')`, { entry: input });
  }
  const state = input.state;
  if (state !== undefined && !STATES.includes(state)) {
    throw invalid(`entry.state must be one of ${STATES.join(', ')}`, { state });
  }
  const origin = input.origin ?? 'adopted';
  if (!ORIGINS.includes(origin)) throw invalid(`entry.origin must be one of ${ORIGINS.join(', ')}`, { origin });
  const by = input.by && typeof input.by === 'object'
    ? { sessionId: String(input.by.sessionId ?? ''), at: Number.isFinite(input.by.at) ? input.by.at : 0 }
    : { sessionId: '', at: 0 };
  if (typeof input.by?.workspace === 'string' && input.by.workspace) by.workspace = input.by.workspace;
  const entry = {
    key,
    uri: encodeRef(ref),
    kind: ref.kind,
    hostId: ref.hostId,
    hostFp: ref.hostFp,
    socketId: ref.socketId,
    gen: ref.gen,
    sid: ref.sid,
    wid: ref.wid,
    pid: ref.pid,
    labels: cleanLabels(input.labels),
    meta: cleanMeta(input.meta),
    origin,
    by,
    workspaces: unionWorkspaces(input.workspaces, by.workspace ? [by.workspace] : []),
  };
  if (state !== undefined) entry.state = state;
  if (input.staleReason !== undefined) entry.staleReason = String(input.staleReason);
  if (typeof input.lastVerifiedAt === 'number') entry.lastVerifiedAt = input.lastVerifiedAt;
  else if (typeof by.at === 'number') entry.lastVerifiedAt = by.at;
  const error = serializeError(input.lastError);
  if (error) entry.lastError = error;
  return entry;
}

/** Merge a fresh upsert over an existing record, keeping the first origin/by. */
function mergeEntry(current, incoming) {
  // A label-only refresh must not resurrect a stale resource; state only changes
  // when the caller states it (or via markVerified/markUnreachable).
  const state = incoming.state ?? current.state;
  const merged = {
    ...current,
    uri: incoming.uri,
    labels: { ...current.labels, ...incoming.labels },
    meta: { ...current.meta, ...incoming.meta },
    workspaces: unionWorkspaces(current.workspaces, incoming.workspaces),
    state,
    origin: current.origin,
    by: current.by,
  };
  if (incoming.lastVerifiedAt !== undefined) merged.lastVerifiedAt = incoming.lastVerifiedAt;
  if (state === 'live') delete merged.staleReason;
  else if (incoming.staleReason !== undefined) merged.staleReason = incoming.staleReason;
  if (state !== 'live' && merged.staleReason === undefined) merged.staleReason = 'UNKNOWN';
  if (incoming.lastError) merged.lastError = incoming.lastError;
  return merged;
}

/** Outcome patch for one resource against a fresh inventory. */
function markEntry(entry, inv, at) {
  if (!inv || typeof inv !== 'object' || !inv.host) return null;
  if (entry.kind === 'host') {
    return inv.host.fp === entry.hostFp
      ? { state: 'live', staleReason: undefined, lastVerifiedAt: at }
      : { state: 'stale', staleReason: 'HOST_IDENTITY_CHANGED' };
  }
  if (!inv.server) return { state: 'stale', staleReason: 'SERVER_GONE' };
  if (entry.kind === 'server') {
    return entry.gen === inv.server.gen
      ? { state: 'live', staleReason: undefined, lastVerifiedAt: at }
      : { state: 'stale', staleReason: 'SERVER_RESTARTED' };
  }
  if (entry.gen !== inv.server.gen) return { state: 'stale', staleReason: 'SERVER_RESTARTED' };

  let result;
  try {
    result = resolveRef(refOfEntry(entry), inv);
  } catch (error) {
    return { state: 'stale', staleReason: 'TARGET_GONE', lastError: serializeError(error) };
  }
  if (result.code === 'OK' || result.code === 'OK_RELOCATED') {
    return {
      state: 'live',
      staleReason: undefined,
      labels: labelsFromTarget(result.target),
      meta: metaFromTarget(result.target),
      lastVerifiedAt: at,
    };
  }
  if (result.code === 'AMBIGUOUS') return { state: 'stale', staleReason: 'AMBIGUOUS' };
  if (result.code === 'HOST_IDENTITY_CHANGED') return { state: 'stale', staleReason: 'HOST_IDENTITY_CHANGED' };
  return { state: 'stale', staleReason: 'TARGET_GONE' };
}

class Registry {
  /** @param {{hosts: object, resources: object, conversations: object, close?: () => Promise<void>, name?: string, mode?: string}} backend */
  constructor({ hosts, resources, conversations, close, name, mode = 'persistent' }) {
    this._hosts = hosts;
    this._resources = resources;
    this._conversations = conversations;
    this._close = close ?? (async () => {});
    this._chain = Promise.resolve();
    this.name = name;
    this.mode = mode;
    this.closed = false;
  }

  assertAvailable() {
    if (this.closed) throw new XcError(CODES.REGISTRY_UNAVAILABLE, 'tmux registry is closed');
  }

  /** Serialize every compound write; individual table.update calls stay atomic on top. */
  _mutate(fn) {
    this.assertAvailable();
    const run = this._chain.then(fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  hostGet(hostId) {
    this.assertAvailable();
    return this._hosts.get(hostId);
  }

  async hostPin(hostId, { fp, user, uid } = {}) {
    if (typeof hostId !== 'string' || hostId.length === 0) throw invalid('hostId is required');
    if (typeof fp !== 'string' || fp.length === 0) throw invalid('fp is required', { hostId });
    const now = Date.now();
    return this._mutate(async () => {
      const existing = this._hosts.get(hostId);
      if (!existing) {
        await this._hosts.put(hostId, {
          hostId,
          fp,
          user: String(user ?? ''),
          uid: String(uid ?? ''),
          firstSeenAt: now,
          lastVerifiedAt: now,
        });
        return { ok: true };
      }
      if (existing.fp !== fp) return { ok: false, pinned: existing };
      await this._hosts.update(hostId, (current) => ({
        ...current,
        user: String(user ?? current.user),
        uid: String(uid ?? current.uid),
        lastVerifiedAt: now,
        lastError: undefined,
      }));
      return { ok: true };
    });
  }

  async hostForget(hostId) {
    return this._mutate(async () => this._hosts.delete(hostId));
  }

  async resourceUpsert(input) {
    const incoming = normalizeEntry(input);
    return this._mutate(async () => {
      const existing = this._resources.get(incoming.key);
      if (!existing) {
        const created = { ...incoming, state: incoming.state ?? 'live' };
        await this._resources.put(incoming.key, created);
        return created;
      }
      return this._resources.update(incoming.key, (current) => mergeEntry(current, incoming));
    });
  }

  resourceGet(key) {
    this.assertAvailable();
    return this._resources.get(key);
  }

  resourceList({ hostId, workspace, all = false } = {}) {
    this.assertAvailable();
    const out = [];
    for (const [, entry] of this._resources.entries()) {
      if (hostId !== undefined && entry.hostId !== hostId) continue;
      if (!all && typeof workspace === 'string' && workspace.length > 0) {
        if (!Array.isArray(entry.workspaces) || !entry.workspaces.includes(workspace)) continue;
      }
      out.push(entry);
    }
    return out;
  }

  async resourceForget(key) {
    return this._mutate(async () => this._resources.delete(key));
  }

  /** Refresh state/labels/meta of every resource of one host+socket. */
  async markVerified(hostId, socketId, inv, at = Date.now()) {
    return this._mutate(async () => {
      let updated = 0;
      for (const [key, entry] of [...this._resources.entries()]) {
        if (entry.hostId !== hostId || entry.socketId !== socketId) continue;
        const patch = markEntry(entry, inv, at);
        if (!patch) continue;
        await this._resources.update(key, (current) => {
          const next = { ...current, ...patch };
          if (patch.labels) next.labels = { ...current.labels, ...patch.labels };
          if (patch.meta) next.meta = { ...current.meta, ...patch.meta };
          if (next.state === 'live') delete next.staleReason;
          return next;
        });
        updated += 1;
      }
      return updated;
    });
  }

  /** Mark every resource of one host unreachable; identity fields stay untouched. */
  async markUnreachable(hostId, error, at = Date.now()) {
    const failure = serializeError(error);
    return this._mutate(async () => {
      let updated = 0;
      for (const [key, entry] of [...this._resources.entries()]) {
        if (entry.hostId !== hostId) continue;
        await this._resources.update(key, (current) => ({
          ...current,
          state: 'unreachable',
          staleReason: undefined,
          lastError: failure,
          lastAttemptAt: at,
        }));
        updated += 1;
      }
      return updated;
    });
  }

  async conversationAddRefs(sessionId, refs = []) {
    const key = conversationKey(sessionId);
    const now = Date.now();
    return this._mutate(async () => {
      const existing = this._conversations.get(key);
      if (!existing) {
        const seen = new Set();
        const list = [];
        for (const item of refs) {
          if (!item || typeof item.uri !== 'string' || seen.has(item.uri)) continue;
          decodeRef(item.uri);
          seen.add(item.uri);
          list.push({ uri: item.uri, label: sanitizeLabel(item.label ?? ''), firstSeenAt: now });
        }
        const created = { sessionId, refs: list };
        await this._conversations.put(key, created);
        return created;
      }
      // Validate before update: a transform throw inside table.update is still safe,
      // but failing early keeps the write chain untouched for bad input.
      const seen = new Set(existing.refs.map((item) => item.uri));
      for (const item of refs) {
        if (item && typeof item.uri === 'string' && !seen.has(item.uri)) decodeRef(item.uri);
      }
      return this._conversations.update(key, (current) => {
        const known = new Set(current.refs.map((item) => item.uri));
        const additions = [];
        for (const item of refs) {
          if (!item || typeof item.uri !== 'string' || known.has(item.uri)) continue;
          known.add(item.uri);
          additions.push({ uri: item.uri, label: sanitizeLabel(item.label ?? ''), firstSeenAt: now });
        }
        return { ...current, refs: [...current.refs, ...additions] };
      });
    });
  }

  conversationGet(sessionId) {
    this.assertAvailable();
    return this._conversations.get(conversationKey(sessionId));
  }

  async conversationSetAnnounced(sessionId, at = Date.now()) {
    const key = conversationKey(sessionId);
    return this._mutate(async () => {
      const existing = this._conversations.get(key);
      if (!existing) {
        const created = { sessionId, refs: [], announcedAt: at };
        await this._conversations.put(key, created);
        return created;
      }
      return this._conversations.update(key, (current) => ({ ...current, announcedAt: at }));
    });
  }

  close() {
    if (!this._closing) {
      this.closed = true;
      this._closing = this._chain.then(() => this._close());
    }
    return this._closing;
  }
}

/** In-memory backend with the identical Registry API. Never imports DSH packages. */
export function memoryRegistry() {
  const table = () => {
    const map = new Map();
    return {
      get: (key) => map.get(key),
      entries: () => map.entries(),
      keys: () => map.keys(),
      get size() {
        return map.size;
      },
      async put(key, value) {
        map.set(key, value);
      },
      async delete(key) {
        return map.delete(key);
      },
      async update(key, fn) {
        if (!map.has(key)) throw new Error(`memory table has no record '${key}' to update`);
        const next = fn(map.get(key));
        map.set(key, next);
        return next;
      },
    };
  };
  return new Registry({
    hosts: table(),
    resources: table(),
    conversations: table(),
    name: USER_DOMAIN,
    mode: 'memory',
  });
}

/** A failed persistent open is never a writable, unpinned in-memory registry. */
export function unavailableRegistry() {
  const fail = () => {
    throw new XcError(CODES.REGISTRY_UNAVAILABLE,
      'Persistent tmux registry is unavailable; repair storage and restart the plugin. Operations are disabled.');
  };
  return {
    mode: 'unavailable',
    assertAvailable: fail,
    hostGet: fail, hostPin: fail, hostForget: fail,
    resourceGet: fail, resourceList: fail, resourceUpsert: fail, resourceForget: fail,
    markVerified: fail, markUnreachable: fail,
    conversationGet: fail, conversationAddRefs: fail, conversationSetAnnounced: fail,
    async close() {},
  };
}

/**
 * Open the persistent registry. Profile scope hashes the exact profile identity;
 * missing identity is an error, never permission to broaden to user scope.
 */
export async function openRegistry(ctx, { scope = 'user' } = {}) {
  if (scope !== 'user' && scope !== 'profile') {
    throw invalid("scope must be 'user' or 'profile'", { scope });
  }
  let name = USER_DOMAIN;
  if (scope === 'profile') {
    const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : ctx?.profileContext;
    name = profileDomainName(profile?.name);
  }
  const facility = ctx?.storage?.domain ?? ctx?.storageDomain;
  if (!facility || typeof facility.open !== 'function') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'ctx.storage.domain.open is not available');
  }
  const domain = await facility.open(registrySpec(name));
  try {
    return new Registry({
      hosts: domain.table('hosts'),
      resources: domain.table('resources'),
      conversations: domain.table('conversations'),
      close: () => domain.close(),
      name,
    });
  } catch (error) {
    // Acquisition succeeded: release it even if table construction fails.
    await domain.close();
    throw error;
  }
}
