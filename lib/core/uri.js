/**
 * Durable tmux references: `dsh-tmux:v1/<hostId>/<hostFp>/<socketId>/<gen>/<kind>/<sid>/<wid>/<pid>`.
 * See docs/DESIGN.md §4. This module is pure; it never talks to a host.
 */
import { XcError, CODES } from './errors.js';
import { tokenSafeLabel } from './sanitize.js';

export const SCHEME = 'dsh-tmux';

const KINDS = ['host', 'server', 'session', 'window', 'pane'];

// Same shapes as quote.validateHostId / validateSocketName; duplicated on purpose so the
// codec does not depend on the quoting module.
const HOST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SOCKET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FP_RE = /^[0-9a-f]{12}$/;
const GEN_RE = /^\d+-\d+$/;
const ID_RE = /^(0|[1-9]\d*)$/;

function invalid(message, details) {
  return new XcError(CODES.INVALID_ARGUMENT, message, details);
}

function checkHostId(value, field = 'hostId') {
  if (typeof value !== 'string' || !HOST_ID_RE.test(value)) {
    throw invalid(`${field} must match ${HOST_ID_RE}`, { field, value });
  }
  return value;
}

function checkSocketId(value) {
  if (typeof value !== 'string' || !SOCKET_ID_RE.test(value)) {
    throw invalid(`socketId must match ${SOCKET_ID_RE}`, { field: 'socketId', value });
  }
  return value;
}

function checkFp(value) {
  if (typeof value !== 'string' || !FP_RE.test(value)) {
    throw invalid('hostFp must be 12 lowercase hex characters', { field: 'hostFp', value });
  }
  return value;
}

function checkGen(value) {
  if (typeof value !== 'string' || !GEN_RE.test(value)) {
    throw invalid('gen must be "<pid>-<start_time>" (digits separated by a dash)', { field: 'gen', value });
  }
  return value;
}

function checkKind(value) {
  if (!KINDS.includes(value)) {
    throw invalid(`kind must be one of ${KINDS.join(', ')}`, { field: 'kind', value });
  }
  return value;
}

function isEmptyId(value) {
  return value === null || value === undefined;
}

function checkId(value, field) {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw invalid(`${field} must be a non-negative integer or null`, { field, value });
  }
  return value;
}

function normalizeIds(ref) {
  const sid = isEmptyId(ref.sid) ? null : checkId(ref.sid, 'sid');
  const wid = isEmptyId(ref.wid) ? null : checkId(ref.wid, 'wid');
  const pid = isEmptyId(ref.pid) ? null : checkId(ref.pid, 'pid');
  return { sid, wid, pid };
}

/** Check the per-kind id rules; returns the normalized ids. */
function validateShape(kind, ids) {
  const { sid, wid, pid } = ids;
  if (kind === 'pane') {
    if (sid === null || wid === null || pid === null) {
      throw invalid('pane refs require sid, wid and pid', { kind, sid, wid, pid });
    }
  } else if (kind === 'window') {
    if (sid === null || wid === null || pid !== null) {
      throw invalid('window refs require sid and wid, with pid "-"', { kind, sid, wid, pid });
    }
  } else if (kind === 'session') {
    if (sid === null || wid !== null || pid !== null) {
      throw invalid('session refs require sid only, with wid and pid "-"', { kind, sid, wid, pid });
    }
  } else if (sid !== null || wid !== null || pid !== null) {
    throw invalid(`${kind} refs carry no ids, all must be "-"`, { kind, sid, wid, pid });
  }
  return ids;
}

/**
 * Build the canonical URI. Throws XcError(INVALID_ARGUMENT) for any malformed or
 * inconsistent field combination.
 */
export function encodeRef(ref) {
  if (!ref || typeof ref !== 'object') throw invalid('encodeRef expects a ref object');
  const hostId = checkHostId(ref.hostId);
  const hostFp = checkFp(ref.hostFp);
  const socketId = checkSocketId(ref.socketId);
  const gen = checkGen(ref.gen);
  const kind = checkKind(ref.kind);
  const { sid, wid, pid } = validateShape(kind, normalizeIds(ref));
  const id = (value) => (value === null ? '-' : String(value));
  return `${SCHEME}:v1/${hostId}/${hostFp}/${socketId}/${gen}/${kind}/${id(sid)}/${id(wid)}/${id(pid)}`;
}

function parseId(segment, field, uri) {
  if (segment === '-') return null;
  if (!ID_RE.test(segment)) {
    throw invalid(`${field} must be a canonical non-negative integer or "-"`, { field, uri });
  }
  const value = Number(segment);
  if (!Number.isSafeInteger(value)) {
    throw invalid(`${field} is outside the safe integer range`, { field, uri });
  }
  return value;
}

/**
 * Strict decode of a canonical URI. Anything else (version, charset, ids, kind
 * consistency) throws XcError(INVALID_ARGUMENT).
 */
export function decodeRef(uri) {
  if (typeof uri !== 'string') throw invalid('uri must be a string');
  if (uri.length === 0 || uri.length > 1024) throw invalid('uri length is out of range', { uri });
  const parts = uri.split('/');
  if (parts.length !== 9 || parts[0] !== `${SCHEME}:v1`) {
    throw invalid(`uri must have the form ${SCHEME}:v1/<hostId>/<hostFp>/<socketId>/<gen>/<kind>/<sid>/<wid>/<pid>`, { uri });
  }
  const [, hostId, hostFp, socketId, gen, kind, sidPart, widPart, pidPart] = parts;
  try {
    checkHostId(hostId);
    checkFp(hostFp);
    checkSocketId(socketId);
    checkGen(gen);
    checkKind(kind);
    const sid = parseId(sidPart, 'sid', uri);
    const wid = parseId(widPart, 'wid', uri);
    const pid = parseId(pidPart, 'pid', uri);
    validateShape(kind, { sid, wid, pid });
    return { v: 1, hostId, hostFp, socketId, gen, kind, sid, wid, pid };
  } catch (error) {
    if (error instanceof XcError) {
      error.details = { ...error.details, uri };
    }
    throw error;
  }
}

/**
 * Global token regex. Label excludes `[` `]` `(` `)` backtick and newlines; the URI
 * body excludes whitespace and parentheses, so a token can never span lines.
 */
export const TOKEN_RE = /@\[([^\[\]()`\n\r]*)\]\((dsh-tmux:v1\/[A-Za-z0-9_.\/-]+)\)/g;

/** Render a composer/history token. */
export function formatToken(label, uri) {
  return `@[${tokenSafeLabel(label)}](${uri})`;
}

/** All syntactically complete tokens whose URI decodes; invalid decodes are skipped. */
export function findTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
  const found = [];
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    let ref;
    try {
      ref = decodeRef(match[2]);
    } catch {
      continue;
    }
    found.push({ start: match.index, end: match.index + match[0].length, label: match[1], uri: match[2], ref });
  }
  return found;
}

/** A human-facing tmux target; also the `kill` confirmation string. */
export function targetString(ref) {
  if (!ref || typeof ref !== 'object') throw invalid('targetString expects a ref object');
  const hostId = checkHostId(ref.hostId);
  const socketId = checkSocketId(ref.socketId);
  const kind = checkKind(ref.kind);
  const { sid, wid, pid } = validateShape(kind, normalizeIds(ref));
  const suffix = kind === 'pane' ? `%${pid}`
    : kind === 'window' ? `@${wid}`
      : kind === 'session' ? `$${sid}`
        : kind;
  return `${hostId}:${socketId}:${suffix}`;
}

/**
 * Registry key. Length prefixes keep it unambiguous even though hostId/socketId may
 * contain `_` and gen contains `-`. The result is path-safe for the per-record JSON
 * backend (`[A-Za-z0-9_-]+`), which is why this is not the `~`-joined form sketched in
 * docs/CONTRACTS.md.
 */
export function resourceKey(ref) {
  if (!ref || typeof ref !== 'object') throw invalid('resourceKey expects a ref object');
  const hostId = checkHostId(ref.hostId);
  const socketId = checkSocketId(ref.socketId);
  const gen = checkGen(ref.gen);
  const kind = checkKind(ref.kind);
  const { sid, wid, pid } = validateShape(kind, normalizeIds(ref));
  const suffix = kind === 'pane' ? `p${pid}`
    : kind === 'window' ? `w${wid}`
      : kind === 'session' ? `s${sid}`
        : kind;
  return `h${hostId.length}_${hostId}_s${socketId.length}_${socketId}_g${gen}_${suffix}`;
}
