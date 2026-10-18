import { randomBytes } from 'node:crypto';
import { XcError, CODES } from './errors.js';
import {
  shQuote,
  validateSessionName,
  validateSocketName,
  validateSocketPath,
  tmuxTarget,
} from './quote.js';

/**
 * Remote `sh -s` script builders.
 *
 * Framing (must match transport.parseRecords):
 *   start = "XC1" + nonce + "\x1f"
 *   sep   = "\x1f" + nonce + "\x1f"
 *   end   = "\x1e" + nonce + "\x1e\n"
 *
 * The nonce is a 12-hex literal inside the generated script, so untrusted tmux
 * values can never forge a record boundary. `created` records are produced by
 * tmux itself through `-P -F <record format>`, which keeps parsing trivial and
 * avoids splitting names in shell.
 */

const FS = '\x1f';
const RS = '\x1e';
const NONCE_RE = /^[0-9a-f]{12}$/;

/** @returns {string} 12 lowercase hex characters */
export function newNonce() {
  return randomBytes(6).toString('hex');
}

/**
 * Global tmux socket selector: "", `-L 'name'` or `-S '/path'`.
 * @param {{ id?: string, name?: string, path?: string }} socket
 * @returns {string}
 */
export function socketArgs(socket) {
  if (!socket || typeof socket !== 'object') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'socket descriptor is required');
  }
  if (socket.path !== undefined && socket.path !== null && socket.path !== '') {
    return `-S ${shQuote(validateSocketPath(socket.path))}`;
  }
  if (socket.name !== undefined && socket.name !== null && socket.name !== '') {
    return `-L ${shQuote(validateSocketName(socket.name))}`;
  }
  return '';
}

function tmux(socket) {
  const args = socketArgs(socket);
  return args ? `tmux -u ${args}` : 'tmux -u';
}

function assertNonce(nonce) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'nonce must be 12 lowercase hex characters');
  }
  return nonce;
}

/**
 * Build one protocol record as a `printf` command.
 * `words` are complete shell words (`'"$x"'` for expansions, `shQuote(...)`
 * for literals); every word becomes one `%s` field.
 */
function record(nonce, head, words = []) {
  const sep = `\\037${nonce}\\037`;
  const format =
    `XC1${nonce}\\037${head}` +
    words.map(() => `${sep}%s`).join('') +
    `\\036${nonce}\\036\\n`;
  return `printf '${format}'${words.length ? ` ${words.join(' ')}` : ''}`;
}

function staticRecord(nonce, head, ...fields) {
  return record(nonce, head, fields.map((field) => shQuote(field)));
}

function begin(nonce) {
  return staticRecord(nonce, 'begin');
}

function end(nonce) {
  return staticRecord(nonce, 'end');
}

function prologue(nonce) {
  return [
    begin(nonce),
    // No globbing: every expansion below is data, never a path pattern.
    'set -f',
    'mid=$(cat /etc/machine-id 2>/dev/null || hostname)',
    record(nonce, 'host', ['"$mid"', '"$(id -u)"', '"$(id -un)"']),
    `command -v tmux >/dev/null 2>&1 || { ${staticRecord(nonce, 'err', 'REMOTE_TOOL_MISSING')}; exit 0; }`,
  ].join('\n');
}

function finish(nonce, ...body) {
  return `${body.join('\n')}\n${end(nonce)}\n`;
}

function intArg(value, what, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new XcError(CODES.INVALID_ARGUMENT, `${what} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/**
 * Narrow a caller-provided expectation to exactly the ids implied by the
 * operation. A session operation must not compare unrelated pane ids, and a
 * window linked into several sessions must not be pinned to one session.
 */
function guardExpect(expect, ids) {
  return { gen: expect.gen, target: expect.target, ...ids };
}

function targetValue(expect) {
  const target = expect?.target;
  if (typeof target !== 'string' || !/^[$@%][0-9]+$/.test(target)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'guard target must look like $N, @N or %N');
  }
  return target;
}

function optionalCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return '';
  if (typeof cwd !== 'string') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'cwd must be a string');
  }
  return ` -c ${shQuote(cwd)}`;
}

function optionalCommand(command) {
  if (command === undefined || command === null) return '';
  if (!Array.isArray(command)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'command must be an argv array');
  }
  if (command.length === 0) return '';
  const argv = command.map((part) => {
    if (typeof part !== 'string' || part.length === 0) {
      throw new XcError(CODES.INVALID_ARGUMENT, 'command arguments must be non-empty strings');
    }
    return shQuote(part);
  });
  return ` -- ${argv.join(' ')}`;
}

function createdFormat(nonce) {
  const sep = `${FS}${nonce}${FS}`;
  return (
    `XC1${nonce}${FS}created${sep}#{pid}-#{start_time}${sep}#{session_id}` +
    `${sep}#{window_id}${sep}#{pane_id}${sep}#{session_name}${sep}#{window_name}` +
    `${RS}${nonce}${RS}`
  );
}

/**
 * Guard fragment: verify server generation and expected ids against a fresh
 * `display-message` before acting. On mismatch it emits
 * `['mismatch', gen, sid, wid, pid, target, expectedGen]`, the end record, and
 * exits 0 without running the caller's command.
 *
 * @param {string} nonce
 * @param {object} socket
 * @param {{ gen: string, sid?: number, wid?: number, pid?: number, target: string }} expect
 * @returns {string} sh fragment
 */
export function guardSnippet(nonce, socket, expect) {
  assertNonce(nonce);
  if (!expect || typeof expect !== 'object' || typeof expect.gen !== 'string' || !expect.gen) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'guard requires a server generation');
  }
  const target = targetValue(expect);
  // Expected ids are validated integers and rendered as quoted tmux targets
  // ("$3"); quoting keeps the shell from expanding them as positional params.
  const checks = [`[ "$1" = ${shQuote(expect.gen)} ]`];
  if (expect.sid !== undefined && expect.sid !== null) {
    checks.push(`[ "$2" = ${shQuote(tmuxTarget('session', intArg(expect.sid, 'session id')))} ]`);
  }
  if (expect.wid !== undefined && expect.wid !== null) {
    checks.push(`[ "$3" = ${shQuote(tmuxTarget('window', intArg(expect.wid, 'window id')))} ]`);
  }
  if (expect.pid !== undefined && expect.pid !== null) {
    checks.push(`[ "$4" = ${shQuote(tmuxTarget('pane', intArg(expect.pid, 'pane id')))} ]`);
  }
  const mismatch =
    `{ ${record(nonce, 'mismatch', [
      '"$1"',
      '"$2"',
      '"$3"',
      '"$4"',
      shQuote(target),
      shQuote(expect.gen),
    ])}; ${end(nonce)}; exit 0; }`;
  return [
    `g=$(${tmux(socket)} display-message -p -t ${shQuote(target)} ` +
      `'#{pid}-#{start_time} #{session_id} #{window_id} #{pane_id}' 2>/dev/null)`,
    'set -- $g',
    `if ${checks.join(' && ')}; then :; else ${mismatch}; fi`,
  ].join('\n');
}

/**
 * Full inventory script. Pane records are self-framed; tmux stderr is captured
 * (2>&1) only so a missing server can be classified as `['noserver']` instead
 * of a transport error. Anything outside a record is ignored by the parser.
 */
export function inventoryScript(nonce, socket) {
  assertNonce(nonce);
  const sep = `${FS}${nonce}${FS}`;
  const fmt =
    `XC1${nonce}${FS}pane${sep}#{pid}-#{start_time}${sep}#{socket_path}` +
    `${sep}#{session_id}${sep}#{session_name}${sep}#{session_created}${sep}#{session_attached}` +
    `${sep}#{window_id}${sep}#{window_index}${sep}#{window_name}${sep}#{window_active}` +
    `${sep}#{pane_id}${sep}#{pane_index}${sep}#{pane_active}${sep}#{pane_current_command}` +
    `${sep}#{pane_current_path}${sep}#{pane_dead}${sep}#{pane_width}${sep}#{pane_height}` +
    `${sep}#{pane_title}${RS}${nonce}${RS}`;
  // Pane records go straight to the script's stdout. Only tmux stderr is
  // captured (2>&1 into the command substitution), so a missing server can be
  // classified without polluting the record stream.
  return finish(
    nonce,
    prologue(nonce),
    'exec 3>&1',
    `out=$(${tmux(socket)} list-panes -a -F ${shQuote(fmt)} 2>&1 1>&3)`,
    'rc=$?',
    'exec 3>&-',
    'if [ "$rc" -ne 0 ]; then',
    '  first=$(printf \'%s\\n\' "$out" | sed -n \'1p\')',
    '  case "$out" in',
    `    *"no server running"*|*"error connecting to"*|*"failed to connect to server"*) ${staticRecord(nonce, 'noserver')} ;;`,
    `    *) ${record(nonce, 'err', [shQuote('REMOTE_ERROR'), '"$first"'])} ;;`,
    '  esac',
    '  exit 0',
    'fi',
  );
}

/**
 * New session. Emits `['created', gen, sid, wid, pid, sessionName, windowName]`.
 */
export function createSessionScript(nonce, socket, { name, cwd, command, width, height } = {}) {
  assertNonce(nonce);
  validateSessionName(name);
  const x = width === undefined ? 200 : intArg(width, 'width', { min: 1, max: 1000 });
  const y = height === undefined ? 50 : intArg(height, 'height', { min: 1, max: 1000 });
  const base =
    `${tmux(socket)} new-session -d -s ${shQuote(name)} -x ${x} -y ${y}` +
    optionalCwd(cwd);
  return finish(nonce, prologue(nonce), createdScriptBody(nonce, base, command));
}

/** New window attached to a session (`-t $sid`). */
export function createWindowScript(nonce, socket, expect, { name, cwd, command } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const sid = intArg(expect.sid, 'session id');
  if (name !== undefined && name !== null) validateSessionName(name);
  const base =
    `${tmux(socket)} new-window -d -t ${shQuote(tmuxTarget('session', sid))}` +
    `${name !== undefined && name !== null ? ` -n ${shQuote(name)}` : ''}` +
    optionalCwd(cwd);
  return finish(
    nonce,
    prologue(nonce),
    guardSnippet(nonce, socket, guardExpect(expect, { sid })),
    createdScriptBody(nonce, base, command),
  );
}

/** Split a pane (`-t %pid`); horizontal means side-by-side (`-h`). */
export function splitPaneScript(nonce, socket, expect, { horizontal = false, cwd, command } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const pid = intArg(expect.pid, 'pane id');
  if (typeof horizontal !== 'boolean') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'horizontal must be a boolean');
  }
  const base =
    `${tmux(socket)} split-window -d -t ${shQuote(tmuxTarget('pane', pid))} ` +
    `${horizontal ? '-h' : '-v'}` +
    optionalCwd(cwd);
  return finish(
    nonce,
    prologue(nonce),
    guardSnippet(nonce, socket, guardExpect(expect, { pid })),
    createdScriptBody(nonce, base, command),
  );
}

// The body of a created-object script (no prologue/end) so it can follow a guard.
// `-P -F` must precede `-- <argv>`: anything after `--` belongs to the new
// process, not to tmux.
function createdScriptBody(nonce, base, command) {
  return [
    `out=$(${base} -P -F ${shQuote(createdFormat(nonce))}${optionalCommand(command)} 2>&1)`,
    'rc=$?',
    'if [ "$rc" -ne 0 ]; then',
    '  first=$(printf \'%s\\n\' "$out" | sed -n \'1p\')',
    `  ${record(nonce, 'err', [shQuote('REMOTE_ERROR'), '"$first"'])}`,
    '  exit 0',
    'fi',
    'printf \'%s\\n\' "$out"',
  ].join('\n');
}

/** Named keys accepted by sendScript (DESIGN §7). */
export const NAMED_KEYS = Object.freeze([
  'Enter',
  'Escape',
  'Tab',
  'BSpace',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'C-c',
  'C-d',
  'C-z',
  'C-l',
]);

const NAMED_KEY_SET = new Set(NAMED_KEYS);
const HEX_BYTE_RE = /^[0-9a-f]{2}$/;
const SEND_CHUNK_BYTES = 256;
const MAX_SEND_BYTES = 16 * 1024;

/**
 * Send hex payload bytes plus allow-listed named keys to one pane.
 * Text is written as `send-keys -H`, at most 256 bytes per invocation.
 */
export function sendScript(nonce, socket, expect, { hex = [], keys = [], enter = false } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const pid = intArg(expect.pid, 'pane id');
  if (!Array.isArray(hex) || hex.some((b) => typeof b !== 'string' || !HEX_BYTE_RE.test(b))) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'hex must be an array of 2-char lowercase hex bytes');
  }
  if (!Array.isArray(keys) || keys.some((key) => !NAMED_KEY_SET.has(key))) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'unsupported named key');
  }
  if (typeof enter !== 'boolean') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'enter must be a boolean');
  }
  if (hex.length > MAX_SEND_BYTES) {
    throw new XcError(CODES.INVALID_ARGUMENT, `text payload exceeds ${MAX_SEND_BYTES} bytes`);
  }
  // Quoted for the tmux argv; the record field needs the raw target.
  const target = tmuxTarget('pane', pid);
  const quotedTarget = shQuote(target);
  const lines = [prologue(nonce), guardSnippet(nonce, socket, guardExpect(expect, { pid }))];
  for (let i = 0; i < hex.length; i += SEND_CHUNK_BYTES) {
    const chunk = hex.slice(i, i + SEND_CHUNK_BYTES);
    lines.push(`${tmux(socket)} send-keys -t ${quotedTarget} -H ${chunk.join(' ')}`);
  }
  for (const key of keys) {
    lines.push(`${tmux(socket)} send-keys -t ${quotedTarget} ${shQuote(key)}`);
  }
  if (enter) {
    lines.push(`${tmux(socket)} send-keys -t ${quotedTarget} Enter`);
  }
  lines.push(record(nonce, 'ok', [quotedTarget, shQuote(String(hex.length))]));
  return finish(nonce, ...lines);
}

/**
 * Capture pane history as hex (POSIX od/tr). One `['capture', hex]` record.
 */
export function captureScript(nonce, socket, expect, { lines = 80 } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const pid = intArg(expect.pid, 'pane id');
  const count = intArg(lines, 'lines', { min: 1, max: 2000 });
  const target = shQuote(tmuxTarget('pane', pid));
  return finish(
    nonce,
    prologue(nonce),
    guardSnippet(nonce, socket, guardExpect(expect, { pid })),
    `hex=$(${tmux(socket)} capture-pane -p -J -t ${target} -S -${count} | od -An -v -tx1 | tr -d ' \\n')`,
    record(nonce, 'capture', ['"$hex"']),
  );
}

/** Detach every client attached to the target session. */
export function detachScript(nonce, socket, expect) {
  assertNonce(nonce);
  targetValue(expect);
  const sid = intArg(expect.sid, 'session id');
  const target = shQuote(tmuxTarget('session', sid));
  return finish(
    nonce,
    prologue(nonce),
    guardSnippet(nonce, socket, guardExpect(expect, { sid })),
    `${tmux(socket)} detach-client -s ${target}`,
    record(nonce, 'ok', [target]),
  );
}

const KILL_COMMAND = { session: 'kill-session', window: 'kill-window', pane: 'kill-pane' };
const KILL_FIELD = { session: 'sid', window: 'wid', pane: 'pid' };

/** Kill a session, window or pane by numeric id. */
export function killScript(nonce, socket, expect, kind) {
  assertNonce(nonce);
  targetValue(expect);
  const command = KILL_COMMAND[kind];
  if (!command) {
    throw new XcError(CODES.INVALID_ARGUMENT, `invalid kill kind: ${JSON.stringify(kind)}`);
  }
  const id = intArg(expect[KILL_FIELD[kind]], `${kind} id`);
  const target = shQuote(tmuxTarget(kind, id));
  return finish(
    nonce,
    prologue(nonce),
    guardSnippet(nonce, socket, guardExpect(expect, { [KILL_FIELD[kind]]: id })),
    `${tmux(socket)} ${command} -t ${target}`,
    record(nonce, 'ok', [target]),
  );
}
