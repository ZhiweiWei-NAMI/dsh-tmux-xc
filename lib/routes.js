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

const MAX_BODY_BYTES = 64 * 1024;

const STATUS_BY_CODE = {
  HOST_NOT_ALLOWED: 403,
  SOCKET_NOT_ALLOWED: 403,
  INVALID_ARGUMENT: 400,
  CONFIRM_MISMATCH: 400,
  NOT_FOUND: 404,
  TARGET_GONE: 409,
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

function parseBoolean(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new RouteError('INVALID_ARGUMENT', 'all must be a boolean', 400);
}

async function handle(service, fn) {
  try {
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
    handle(service, (s) => {
      const url = new URL(request.url);
      return s.inventory({
        hostId: optionalString(url.searchParams.get('hostId'), 'hostId'),
        workspace: optionalString(url.searchParams.get('workspace'), 'workspace'),
        all: parseBoolean(url.searchParams.get('all')),
        signal: request.signal,
      });
    }),
  );

  register('/api/tmux-xc/resolve', ['GET'], (request) =>
    handle(service, (s) => {
      const url = new URL(request.url);
      const uri = requireString(url.searchParams.get('uri'), 'uri');
      return s.resolveRef(uri, { signal: request.signal });
    }),
  );

  register('/api/tmux-xc/adopt', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      const hostId = requireString(body.hostId, 'hostId');
      const socketId = optionalString(body.socketId, 'socketId');
      const target = requireString(body.target, 'target');
      const sessionId = optionalString(body.sessionId, 'sessionId');
      const workspace = optionalString(body.workspace, 'workspace');
      return s.adopt({
        hostId,
        socketId,
        target,
        by: { sessionId, workspace },
        signal: request.signal,
      });
    }),
  );

  register('/api/tmux-xc/forget', ['POST'], (request) =>
    handle(service, async (s) => {
      const body = await readJson(request);
      const uri = optionalString(body.uri, 'uri');
      const key = optionalString(body.key, 'key');
      if (uri === undefined && key === undefined) {
        throw new RouteError('INVALID_ARGUMENT', 'forget requires uri or key', 400);
      }
      return { forgotten: await s.forget({ uri, key }) };
    }),
  );

  return async () => {
    await Promise.all(disposers.reverse().map((dispose) => dispose()));
  };
}
