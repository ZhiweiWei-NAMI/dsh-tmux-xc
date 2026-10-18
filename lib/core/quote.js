import { XcError, CODES } from './errors.js';

/**
 * POSIX single-quote a value for safe interpolation into an `sh -s` script.
 *
 * A single quote cannot appear inside a single-quoted shell string, so each
 * one is closed, escaped and reopened: `it's` -> `'it'\''s'`.
 * NUL is rejected because no shell variable or argv can carry it.
 *
 * @param {string} s
 * @returns {string}
 */
export function shQuote(s) {
  if (typeof s !== 'string') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'shQuote expects a string');
  }
  if (s.includes('\0')) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'NUL byte is not representable in a shell word');
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const HOST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SOCKET_ID_RE = HOST_ID_RE;
const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SOCKET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function requireString(s, what) {
  if (typeof s !== 'string') {
    throw new XcError(CODES.INVALID_ARGUMENT, `${what} must be a string`);
  }
  return s;
}

/**
 * SSH alias from the user's ssh config. No leading `-` (would parse as an
 * ssh option), no whitespace, no shell metacharacters.
 * @param {string} s
 */
export function validateAlias(s) {
  requireString(s, 'ssh alias');
  if (!ALIAS_RE.test(s)) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid ssh alias: ${JSON.stringify(s)}`);
  }
  return s;
}

/** Stable config key used inside references. */
export function validateHostId(s) {
  requireString(s, 'host id');
  if (!HOST_ID_RE.test(s)) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid host id: ${JSON.stringify(s)}`);
  }
  return s;
}

/** Stable socket config key; deliberately narrower than a tmux socket name. */
export function validateSocketId(s) {
  requireString(s, 'socket id');
  if (!SOCKET_ID_RE.test(s)) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid socket id: ${JSON.stringify(s)}`);
  }
  return s;
}

/** Escape the separate tmux format boundary, before shell/command quoting. */
export function escapeTmuxFormat(s) {
  requireString(s, 'tmux format value');
  if (s.includes('\0')) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'NUL byte is not representable in a tmux argument');
  }
  return s.replaceAll('#', '##');
}

/** tmux session name used with `new-session -s`. */
export function validateSessionName(s) {
  requireString(s, 'session name');
  if (!SESSION_NAME_RE.test(s)) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid session name: ${JSON.stringify(s)}`);
  }
  return s;
}

/**
 * Absolute POSIX socket path (`tmux -S`). It is interpolated into a script as
 * one quoted word, so only structural limits matter here: absolute, no NUL,
 * no newline, bounded length.
 */
export function validateSocketPath(s) {
  requireString(s, 'socket path');
  if (!s.startsWith('/')) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'socket path must be absolute');
  }
  if (s.includes('\0') || s.includes('\n') || s.includes('\r')) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'socket path must not contain NUL or newlines');
  }
  if (s.length > 200) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'socket path must be at most 200 characters');
  }
  return s;
}

/** tmux socket name (`tmux -L`). */
export function validateSocketName(s) {
  requireString(s, 'socket name');
  if (!SOCKET_NAME_RE.test(s)) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid socket name: ${JSON.stringify(s)}`);
  }
  return s;
}

/**
 * UTF-8 bytes of `text` as lowercase two-character hex strings.
 * Used for `send-keys -H`, so user payload never becomes shell text.
 * @param {string} text
 * @returns {string[]}
 */
export function toHexBytes(text) {
  if (typeof text !== 'string') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'toHexBytes expects a string');
  }
  return Array.from(Buffer.from(text, 'utf8'), (byte) => byte.toString(16).padStart(2, '0'));
}

const TARGET_PREFIX = { session: '$', window: '@', pane: '%' };

/**
 * tmux id target for a numeric id: `$3`, `@5`, `%7`.
 * @param {'session'|'window'|'pane'} kind
 * @param {number} num
 */
export function tmuxTarget(kind, num) {
  const prefix = TARGET_PREFIX[kind];
  if (!prefix) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid tmux target kind: ${JSON.stringify(kind)}`);
  }
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid tmux target number: ${JSON.stringify(num)}`);
  }
  return `${prefix}${num}`;
}
