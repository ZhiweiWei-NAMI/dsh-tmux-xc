/**
 * Owner-only HTTP routes for the browser client (the tmux panel).
 *
 * Registered on `ctx.connection.fetch`; Connection authenticates the browser
 * and only owner principals reach an exact route. JSON in/out, a 64 KiB body
 * cap, strict validation, and errors shaped `{ok:false, error:{code,message}}`.
 *
 * @module lib/routes
 */
import { XcError } from './core/errors.js';
import { decodeRef } from './core/uri.js';
import { labelFor } from './core/identity.js';
import { tokenSafeLabel } from './core/sanitize.js';

const MAX_BODY_BYTES = 64 * 1024;

// Deprecated 0.1.0 per-key approval config keys; only 'allow' is honoured.
const LEGACY_KEYS = ['create', 'send', 'detach'];

// Capture resolution outcomes that are reported as HTTP 200 `{ code, message }`
// rather than an error status, so the panel can render a best-effort read.
const CAPTURE_OUTCOME_CODES = new Set([
  'HOST_NOT_ALLOWED', 'SOCKET_NOT_ALLOWED', 'HOST_UNREACHABLE', 'SSH_AUTH', 'SSH_HOSTKEY',
  'SSH_MISSING', 'REMOTE_TOOL_MISSING', 'TIMEOUT', 'SERVER_GONE', 'SERVER_RESTARTED',
  'HOST_IDENTITY_CHANGED', 'TARGET_GONE', 'TARGET_CHANGED', 'AMBIGUOUS', 'OUTCOME_UNKNOWN',
  'PROTOCOL', 'REMOTE_ERROR', 'NOT_FOUND', 'PANE_DEAD', 'PANE_IN_MODE',
  'PANE_INPUT_DISABLED', 'SYNCHRONIZED_PANES',
]);

const STATUS_BY_CODE = {
  HOST_NOT_ALLOWED: 403,
  SOCKET_NOT_ALLOWED: 403,
  INVALID_ARGUMENT: 400,
  CONFIRM_MISMATCH: 400,
  NOT_FOUND: 404,
  TARGET_GONE: 409,
  TARGET_CHANGED: 409,
  REGISTRY_UNAVAILABLE: 503,
  SERVER_GONE: 409,
  SERVER_RESTARTED: 409,
  AMBIGUOUS: 409,
  HOST_IDENTITY_CHANGED: 409,
  HOST_UNREACHABLE: 502,
  SSH_AUTH: 502,
  SSH_HOSTKEY: 502,
  SSH_MISSING: 502,
  REMOTE_TOOL_MISSING: 502,
  TIMEOUT: 504,
  OUTCOME_UNKNOWN: 502,
  PROTOCOL: 502,
  REMOTE_ERROR: 502,
  CANCELLED: 499,
};

class RouteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function ok(value) {
  return json({ ok: true, ...value });
}

function fail(error) {
  if (error instanceof RouteError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof XcError) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    return json({ ok: false, error: { code: error.code, message: error.message } }, status);
  }
  return json({ ok: false, error: { code: 'INTERNAL', message: String(error) } }, 500);
}

async function readJson(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new RouteError('BODY_TOO_LARGE', 'request body exceeds 64 KiB', 413);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new RouteError('BODY_TOO_LARGE', 'request body exceeds 64 KiB', 413);
  }
  if (text.trim() === '') return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RouteError('INVALID_JSON', 'request body is not valid JSON', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RouteError('INVALID_JSON', 'request body must be a JSON object', 400);
  }
  return body;
}

function onlyFields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new RouteError('INVALID_ARGUMENT', 'unexpected request field', 400);
  }
}

function requireString(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new RouteError('INVALID_ARGUMENT', `${name} must be a string`, 400);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name, { allowEmpty: true });
}

function optionalBodyString(value, name) {
  return value === undefined ? undefined : requireString(value, name, { allowEmpty: true });
}

function parseBoolean(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new RouteError('INVALID_ARGUMENT', 'all must be a boolean', 400);
}

/** Integer query value bounded to [min, max], defaulting when absent. */
function boundedInt(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new RouteError('INVALID_ARGUMENT', `${name} must be an integer in [${min}, ${max}]`, 400);
  }
  const number = Number(value);
  return Math.min(max, Math.max(min, number));
}

/**
 * Effective settings (contract C): the one approval switch plus its source and
 * the stored removed-host list.
 */
async function effectiveSettings(service) {
  const stored = await service.registry.getSettings();
  const panelEnabled = stored?.approval?.enabled;
  const configApproval = service.config?.approval ?? {};
  const configuredEnabled = configApproval.enabled;
  const enabled = typeof panelEnabled === 'boolean'
    ? panelEnabled
    : typeof configuredEnabled === 'boolean' ? configuredEnabled : true;
  const source = typeof panelEnabled === 'boolean'
    ? 'panel'
    : typeof configuredEnabled === 'boolean' ? 'config' : 'default';
  const legacyAllow = LEGACY_KEYS.filter((key) => configApproval[key] === 'allow');
  return {
    approval: { enabled, source, legacyAllow },
    removedHosts: stored?.removedHosts ?? [],
  };
}

async function handle(service, fn) {
  try {
    service.assertAvailable?.();
    return ok(await fn(service));
  } catch (error) {
    return fail(error);
  }
}

/**
 * Register the client routes. Returns a disposer that unregisters all routes.
 */
export function registerRoutes(ctx, service) {
  const disposers = [];

  const register = (path, methods, fetch) => {
    disposers.push(ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }));
  };

  register('/api/tmux-xc/hosts', ['GET'], (request) =>
    handle(service, (s) => ({ hosts: s.hosts() })),
  );

  register('/api/tmux-xc/inventory', ['GET'], (request) =>
    handle(service, async (s) => {
      const url = new URL(request.url);
      const { hosts } = await s.inventory({
        hostId: optionalString(url.searchParams.get('host'), 'host'),
        workspace: optionalString(url.searchParams.get('workspace'), 'workspace'),
        all: parseBoolean(url.searchParams.get('all')),
        signal: request.signal,
      });
      // The legacy reachable flag belongs to tool rendering, not ROUTES-v2.
      // `alias`/`aliasSource` are already decorated by the service.
      return { hosts: hosts.map(({ reachable, ...host }) => host) };
    }),
  );

  // One exact path registers once; GET and PUT share the handler and dispatch.
  register('/api/tmux-xc/settings', ['GET', 'PUT'], (request) =>
    handle(service, async (s) => {
      if (request.method === 'GET') return effectiveSettings(s);
      const body = await readJson(request);
      onlyFields(body, ['approval', 'removedHosts']);
      let approval;
      if (body.approval !== undefined) {
        if (body.approval === null || typeof body.approval !== 'object' || Array.isArray(body.approval)) {
          throw new RouteError('INVALID_ARGUMENT', 'approval must be an object', 400);
        }
        onlyFields(body.approval, ['enabled']);
        if (Object.hasOwn(body.approval, 'enabled') &&
            body.approval.enabled !== null && typeof body.approval.enabled !== 'boolean') {
          throw new RouteError('INVALID_ARGUMENT', 'approval.enabled must be a boolean or null', 400);
        }
        if (Object.hasOwn(body.approval, 'enabled')) {
          approval = { enabled: body.approval.enabled };
        }
      }
      let removedHosts;
      if (body.removedHosts !== undefined) {
        if (!Array.isArray(body.removedHosts) ||
            body.removedHosts.some((id) => typeof id !== 'string' || id.length === 0)) {
          throw new RouteError('INVALID_ARGUMENT', 'removedHosts must be an array of host ids', 400);
        }
        // Restoring hosts is allowed (a shorter list); adding new ids here is not.
        const stored = (await s.registry.getSettings())?.removedHosts ?? [];
        const extra = body.removedHosts.filter((id) => !stored.includes(id));
        if (extra.length > 0) {
          throw new RouteError('INVALID_ARGUMENT', `cannot add hosts to removedHosts here (remove via host/remove): ${extra.join(', ')}`, 400);
        }
        removedHosts = body.removedHosts;
      }
      await s.registry.setSettings({ ...(approval !== undefined ? { approval } : {}), ...(removedHosts !== undefined ? { removedHosts } : {}) });
      return effectiveSettings(s);
    }),
  );

  register('/api/tmux-xc/alias', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      onlyFields(body, ['uri', 'alias']);
      const uri = requireString(body.uri, 'uri');
      decodeRef(uri);
      const alias = (body.alias === null || body.alias === '')
        ? null
        : requireString(body.alias, 'alias');
      return s.alias({ uri, alias, signal: request.signal });
    }),
  );

  register('/api/tmux-xc/version', ['GET'], () =>
    handle(service, (s) => ({ version: s.registry.version ?? 0 })),
  );

  register('/api/tmux-xc/capture', ['GET'], (request) => {
    try {
      service.assertAvailable?.();
    } catch (error) {
      return fail(error);
    }
    const url = new URL(request.url);
    let uri;
    let lines;
    try {
      uri = requireString(url.searchParams.get('uri'), 'uri');
      lines = boundedInt(url.searchParams.get('lines'), 'lines', 1, 500, 200);
    } catch (error) {
      return fail(error);
    }
    return service.capture({ uri, lines, signal: request.signal }).then(
      (result) => json({
        ok: true, code: 'OK',
        label: result.target, kind: result.kind,
        text: result.text, truncated: result.truncated,
      }),
      (error) => {
        if (error instanceof XcError && error.code !== 'INVALID_ARGUMENT' &&
            CAPTURE_OUTCOME_CODES.has(error.code)) {
          return json({ ok: true, code: error.code, message: error.message });
        }
        return fail(error);
      },
    );
  });

  // Preparing a user-opened terminal is read-only: verify the durable target,
  // then expose only configured connection metadata, never credentials.
  register('/api/tmux-xc/terminal-target', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      onlyFields(body, ['uri']);
      const uri = requireString(body.uri, 'uri');
      const { ref, result } = await s.resolveRef(uri, { signal: request.signal, requirePane: true });
      if (ref.kind !== 'pane') throw new RouteError('INVALID_ARGUMENT', 'open a specific pane card', 400);
      // Relocated references need a refreshed card rather than silently changing context.
      if (result.code !== 'OK') throw new XcError(result.code === 'OK_RELOCATED' ? 'TARGET_CHANGED' : result.code, result.message || 'Target changed; refresh the task list.');
      const host = s.hosts().find(item => item.id === ref.hostId);
      const socket = host?.sockets?.find(item => item.id === ref.socketId);
      if (!host || !socket) throw new RouteError('NOT_FOUND', 'connection is no longer configured', 404);
      return { node: ref, host: { transport: host.transport, ssh: host.ssh }, socket: { path: socket.path, name: socket.name } };
    }),
  );

  register('/api/tmux-xc/kill', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      onlyFields(body, ['uri', 'confirm']);
      const uri = requireString(body.uri, 'uri');
      const confirm = requireString(body.confirm, 'confirm');
      const result = await s.kill({ uri, confirm, signal: request.signal });
      return { killed: result.killed, label: result.target };
    }),
  );

  register('/api/tmux-xc/host/remove-plan', ['GET'], (request) =>
    handle(service, (s) => {
      const url = new URL(request.url);
      const host = requireString(url.searchParams.get('host'), 'host');
      return s.removePlan({ hostId: host, signal: request.signal });
    }),
  );

  register('/api/tmux-xc/host/remove', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      onlyFields(body, ['host', 'mode', 'killUris', 'confirm']);
      const host = requireString(body.host, 'host');
      const mode = requireString(body.mode, 'mode');
      if (mode !== 'local' && mode !== 'remote') {
        throw new RouteError('INVALID_ARGUMENT', 'mode must be "local" or "remote"', 400);
      }
      const confirm = requireString(body.confirm, 'confirm');
      let killUris;
      if (body.killUris !== undefined) {
        if (!Array.isArray(body.killUris) || body.killUris.some((value) => typeof value !== 'string')) {
          throw new RouteError('INVALID_ARGUMENT', 'killUris must be an array of uris', 400);
        }
        killUris = body.killUris;
      }
      return s.removeHost({ host, mode, killUris, confirm, signal: request.signal });
    }),
  );

  register('/api/tmux-xc/resolve', ['GET'], (request) =>
    handle(service, async (s) => {
      const url = new URL(request.url);
      const uri = requireString(url.searchParams.get('uri'), 'uri');
      const { ref, result } = await s.resolveRef(uri, { signal: request.signal });
      const host = s.hosts().find((host) => host.id === ref.hostId);
      return {
        code: result.code, warnings: result.warnings ?? [],
        ...(result.target ? { target: result.target, label: tokenSafeLabel(labelFor(host?.label ?? ref.hostId, result.target)) } : {}),
      };
    }),
  );

  register('/api/tmux-xc/adopt', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      onlyFields(body, ['target', 'workspace', 'sessionId']);
      const target = requireString(body.target, 'target');
      decodeRef(target); // The browser must adopt a durable identity, never a bare id.
      const sessionId = optionalBodyString(body.sessionId, 'sessionId');
      const workspace = optionalBodyString(body.workspace, 'workspace');
      const entry = await s.adopt({
        target,
        by: { sessionId, workspace },
        signal: request.signal,
      });
      return { entry: { uri: entry.uri, token: entry.token, label: entry.label,
        key: entry.key, origin: entry.origin, state: entry.state } };
    }),
  );

  register('/api/tmux-xc/forget', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      onlyFields(body, ['key', 'uri']);
      const uri = optionalBodyString(body.uri, 'uri');
      const key = optionalBodyString(body.key, 'key');
      if ((uri === undefined) === (key === undefined)) {
        throw new RouteError('INVALID_ARGUMENT', 'forget requires exactly one of uri or key', 400);
      }
      return { removed: await s.forget({ uri, key }) };
    }),
  );

  return async () => {
    await Promise.all(disposers.reverse().map((dispose) => dispose()));
  };
}
