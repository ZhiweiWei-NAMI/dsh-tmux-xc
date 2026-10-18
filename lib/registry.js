/**
 * Registry: hosts (TOFU pins), adopted/created resources and conversation
 * references. Persisted through `ctx.storage.domain` (DESIGN §5) or kept in
 * memory for tests. Storage deps are loaded lazily so importing this module
 * never requires the DSH packages.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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

const ALIAS_MAX = 40;
const ALIAS_UNSAFE_RE = /[[\]()]/g;

/**
 * Sanitize an alias label the same way untrusted labels are cleaned: single
 * line (control/bidi/zero-width removed, whitespace collapsed, trimmed), plus
 * no `[ ] ( )`. The caller validates the resulting 1..40 length.
 */
function cleanAlias(value) {
  let text = sanitizeLabel(String(value), 1 << 20);
  text = text.replace(ALIAS_UNSAFE_RE, '').replace(/\s+/g, ' ').trim();
  return text;
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

  // Stored settings: the approval switch plus removed hosts. Legacy 0.1.0
  // per-key approval overrides are tolerated (passthrough) but ignored on read.
  const settings = z.object({
    id: z.string(),
    approval: z.object({
      enabled: z.boolean().optional(),
    }).passthrough().default({}),
    removedHosts: z.array(z.string()).optional(),
  }).passthrough();

  const aliases = z.object({
    key: z.string(),
    alias: z.string(),
    updatedAt: z.number(),
  }).passthrough();

  return { hosts, resources, conversations, settings, aliases };
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
  const { hosts, resources, conversations, settings, aliases } = schemas();
  return defineDomain({
    name,
    version: 1,
    layout: 'per-record',
    tables: {
      hosts: domainTable(hosts),
      resources: domainTable(resources),
      conversations: domainTable(conversations),
      settings: domainTable(settings),
      aliases: domainTable(aliases),
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

/**
 * Best-effort hostId extracted from a resource key. Resource keys are built as
 * `h<len>_<hostId>_s<len>_<socketId>_g<gen>_<suffix>` (lib/core/uri.js), so the
 * hostId is the length-prefixed segment right after `h`. Used to attribute an
 * alias (keyed by resource key) to a host for purgeHost / hostCounts.
 */
export function resourceKeyHostId(key) {
  if (typeof key !== 'string') return undefined;
  const match = /^h(\d+)_/.exec(key);
  if (!match) return undefined;
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length <= 0) return undefined;
  const start = match[0].length;
  return key.slice(start, start + length);
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

/** Verification timestamps alone do not invalidate the inventory projection. */
function inventoryChanged(current, next) {
  return ['state', 'staleReason', 'labels', 'meta', 'lastError']
    .some((field) => !isDeepStrictEqual(current[field], next[field]));
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
  /** @param {{hosts: object, resources: object, conversations: object, settings?: object, aliases?: object, close?: () => Promise<void>, name?: string, mode?: string}} backend */
  constructor({ hosts, resources, conversations, settings, aliases, close, name, mode = 'persistent' }) {
    this._hosts = hosts;
    this._resources = resources;
    this._conversations = conversations;
    this._settings = settings;
    this._aliases = aliases;
    this._close = close ?? (async () => {});
    this._chain = Promise.resolve();
    this.name = name;
    this.mode = mode;
    this.closed = false;
    // In-memory monotonic counter (never persisted): bumped on every mutation
    // that changes what inventory exposes (resource/alias/settings/purge), so
    // the panel can poll /version and refetch inventory only when it changes.
    this.version = 0;
  }

  assertAvailable() {
    if (this.closed) throw new XcError(CODES.REGISTRY_UNAVAILABLE, 'tmux registry is closed');
  }

  _bump() {
    this.version += 1;
  }

  /** Serialize every compound write; individual table.update calls stay atomic on top. */
  _mutate(fn) {
    this.assertAvailable();
    const run = this._chain.then(fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  /** Invalidate inventory after a successful external mutation (e.g. a guarded kill). */
  async invalidateInventory() {
    return this._mutate(() => {
      this._bump();
      return this.version;
    });
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
      let result;
      if (!existing) {
        result = { ...incoming, state: incoming.state ?? 'live' };
        await this._resources.put(incoming.key, result);
      } else {
        result = await this._resources.update(incoming.key, (current) => mergeEntry(current, incoming));
      }
      this._bump();
      return result;
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
    return this._mutate(async () => {
      const removed = await this._resources.delete(key);
      if (removed) this._bump();
      return removed;
    });
  }

  /** Refresh state/labels/meta of every resource of one host+socket. */
  async markVerified(hostId, socketId, inv, at = Date.now()) {
    return this._mutate(async () => {
      let updated = 0;
      let changed = false;
      for (const [key, entry] of [...this._resources.entries()]) {
        if (entry.hostId !== hostId || entry.socketId !== socketId) continue;
        const patch = markEntry(entry, inv, at);
        if (!patch) continue;
        await this._resources.update(key, (current) => {
          const next = { ...current, ...patch };
          if (patch.labels) next.labels = { ...current.labels, ...patch.labels };
          if (patch.meta) next.meta = { ...current.meta, ...patch.meta };
          if (next.state === 'live') delete next.staleReason;
          if (inventoryChanged(current, next)) changed = true;
          return next;
        });
        updated += 1;
      }
      if (changed) this._bump();
      return updated;
    });
  }

  /** Mark every resource of one host unreachable; identity fields stay untouched. */
  async markUnreachable(hostId, error, at = Date.now()) {
    const failure = serializeError(error);
    return this._mutate(async () => {
      let updated = 0;
      let changed = false;
      for (const [key, entry] of [...this._resources.entries()]) {
        if (entry.hostId !== hostId) continue;
        await this._resources.update(key, (current) => {
          const next = {
            ...current,
            state: 'unreachable',
            staleReason: undefined,
            lastError: failure,
            lastAttemptAt: at,
          };
          if (inventoryChanged(current, next)) changed = true;
          return next;
        });
        updated += 1;
      }
      if (changed) this._bump();
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

  /** Stored settings only (never defaults): `{ approval?, removedHosts? }`. */
  async getSettings() {
    this.assertAvailable();
    const record = this._settings?.get('global');
    const enabled = record?.approval?.enabled;
    const removedHosts = record?.removedHosts;
    return {
      ...(typeof enabled === 'boolean' ? { approval: { enabled } } : {}),
      ...(Array.isArray(removedHosts) && removedHosts.length > 0 ? { removedHosts: [...removedHosts] } : {}),
    };
  }

  /**
   * Merge stored settings. `approval.enabled` boolean (or null to clear) and
   * `removedHosts` (a full replacement list of host ids). Unknown fields and
   * legacy per-key approval keys are rejected; the panel restores hosts by
   * sending a shorter `removedHosts` list through the settings route.
   */
  async setSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalid('setSettings expects an object with approval/removedHosts');
    }
    for (const key of Object.keys(input)) {
      if (key !== 'approval' && key !== 'removedHosts') throw invalid(`unknown settings field '${key}'`);
    }
    const approval = input.approval;
    if (approval !== undefined) {
      if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) {
        throw invalid('approval must be an object');
      }
      for (const key of Object.keys(approval)) {
        if (key !== 'enabled') throw invalid(`unknown approval key '${key}'`);
        if (approval.enabled !== null && typeof approval.enabled !== 'boolean') {
          throw invalid('approval.enabled must be a boolean or null', { value: approval.enabled });
        }
      }
    }
    const removedHosts = input.removedHosts;
    if (removedHosts !== undefined) {
      if (!Array.isArray(removedHosts) || removedHosts.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw invalid('removedHosts must be an array of non-empty host ids');
      }
    }
    return this._mutate(async () => {
      const current = this._settings?.get('global') ?? { id: 'global', approval: {}, removedHosts: [] };
      const nextApproval = { ...(current.approval ?? {}) };
      if (approval !== undefined) {
        if (approval.enabled === null) delete nextApproval.enabled;
        else if (typeof approval.enabled === 'boolean') nextApproval.enabled = approval.enabled;
      }
      const nextRemoved = removedHosts === undefined ? (current.removedHosts ?? []) : [...removedHosts];
      const record = { id: 'global', approval: nextApproval };
      if (nextRemoved.length > 0) record.removedHosts = nextRemoved;
      await this._settings.put('global', record);
      this._bump();
      return {
        ...(Object.keys(nextApproval).length > 0 ? { approval: { ...nextApproval } } : {}),
        ...(nextRemoved.length > 0 ? { removedHosts: [...nextRemoved] } : {}),
      };
    });
  }

  /** Sync view of the stored removed-host ids (empty when none are stored). */
  removedHosts() {
    this.assertAvailable();
    const record = this._settings?.get('global');
    return Array.isArray(record?.removedHosts) ? [...record.removedHosts] : [];
  }

  /** Count registry resources and aliases belonging to one host (read-only). */
  hostCounts(hostId) {
    if (typeof hostId !== 'string' || hostId.length === 0) throw invalid('hostId is required');
    this.assertAvailable();
    let resources = 0;
    const resourceKeys = new Set();
    for (const [, entry] of this._resources.entries()) {
      if (entry.hostId !== hostId) continue;
      resources += 1;
      resourceKeys.add(entry.key);
    }
    let aliases = 0;
    for (const [key] of this._aliases?.entries?.() ?? []) {
      if (resourceKeys.has(key) || resourceKeyHostId(key) === hostId) aliases += 1;
    }
    return { resources, aliases };
  }

  /**
   * Remove every resource and alias belonging to one host. Returns counts.
   * This is local-only: it never contacts the host and never touches the
   * profile config file.
   */
  async purgeHost(hostId) {
    if (typeof hostId !== 'string' || hostId.length === 0) throw invalid('hostId is required');
    return this._mutate(async () => {
      const counts = await this._purgeHost(hostId);
      this._bump();
      return counts;
    });
  }

  /** Internal purge; callers must hold the _mutate queue for the entire operation. */
  async _purgeHost(hostId) {
    const resourceKeys = new Set();
    for (const [key, entry] of [...this._resources.entries()]) {
      if (entry.hostId !== hostId) continue;
      resourceKeys.add(key);
      await this._resources.delete(key);
    }
    let aliases = 0;
    for (const [key] of [...(this._aliases?.entries?.() ?? [])]) {
      if (resourceKeys.has(key) || resourceKeyHostId(key) === hostId) {
        await this._aliases.delete(key);
        aliases += 1;
      }
    }
    return { resources: resourceKeys.size, aliases };
  }

  /** Purge and hide a host in one serialized local mutation, retaining its TOFU pin. */
  async removeHostLocal(hostId) {
    if (typeof hostId !== 'string' || hostId.length === 0) throw invalid('hostId is required');
    return this._mutate(async () => {
      const counts = await this._purgeHost(hostId);
      const current = this._settings.get('global') ?? { id: 'global', approval: {} };
      const removedHosts = [...new Set([...(current.removedHosts ?? []), hostId])];
      await this._settings.put('global', { ...current, removedHosts });
      this._bump();
      return counts;
    });
  }

  /** Every stored alias: `[{ key, alias, updatedAt }]`. */
  async aliasList() {
    this.assertAvailable();
    const out = [];
    for (const [, record] of this._aliases?.entries?.() ?? []) {
      out.push({ key: record.key, alias: record.alias, updatedAt: record.updatedAt });
    }
    return out;
  }

  /**
   * Set or clear an alias for an existing resource key (exact identity incl.
   * generation). `alias` is a string (trimmed, sanitized, 1..40 chars) or
   * `null`/`''` to remove.
   */
  async setAlias(key, alias) {
    if (typeof key !== 'string' || key.length === 0) throw invalid('key is required');
    this.assertAvailable();
    if (this._resources.get(key) === undefined) {
      throw new XcError(CODES.NOT_FOUND, `no registered resource with key '${key}'`, { key });
    }
    let cleaned;
    if (alias === null || alias === '') {
      cleaned = null;
    } else {
      if (typeof alias !== 'string') throw invalid('alias must be a string or null');
      cleaned = cleanAlias(alias);
      if (cleaned.length < 1 || cleaned.length > ALIAS_MAX) {
        throw invalid(`alias must be 1..${ALIAS_MAX} characters after sanitizing`, { alias });
      }
    }
    return this._mutate(async () => {
      if (cleaned === null) {
        await this._aliases.delete(key);
        this._bump();
        return { key, alias: null };
      }
      const record = { key, alias: cleaned, updatedAt: Date.now() };
      await this._aliases.put(key, record);
      this._bump();
      return { key, alias: cleaned };
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
    settings: table(),
    aliases: table(),
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
    markVerified: fail, markUnreachable: fail, invalidateInventory: fail,
    conversationGet: fail, conversationAddRefs: fail, conversationSetAnnounced: fail,
    getSettings: fail, setSettings: fail, aliasList: fail, setAlias: fail,
    removedHosts: fail, hostCounts: fail, purgeHost: fail, removeHostLocal: fail,
    version: 0,
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
  // Prefer the injected service: Cordis throws on access to a non-injected property such as ctx.storage.
  const facility = ctx?.storageDomain ?? ctx?.storage?.domain;
  if (!facility || typeof facility.open !== 'function') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'ctx.storage.domain.open is not available');
  }
  const domain = await facility.open(registrySpec(name));
  try {
    return new Registry({
      hosts: domain.table('hosts'),
      resources: domain.table('resources'),
      conversations: domain.table('conversations'),
      settings: domain.table('settings'),
      aliases: domain.table('aliases'),
      close: () => domain.close(),
      name,
    });
  } catch (error) {
    // Acquisition succeeded: release it even if table construction fails.
    await domain.close();
    throw error;
  }
}
