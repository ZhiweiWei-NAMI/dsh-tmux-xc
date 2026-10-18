import { randomBytes } from 'node:crypto';
import { XcError, CODES } from './errors.js';
import {
  shQuote,
  escapeTmuxFormat,
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

// Keep all explicit exits framed, including standalone guard fragments.
function endAndExit(nonce) {
  return `${end(nonce)}; exit 0`;
}

function prologue(nonce) {
  return [
    begin(nonce),
    // No globbing: every expansion below is data, never a path pattern.
    'set -f',
    'mid=$(cat /etc/machine-id 2>/dev/null || hostname)',
    record(nonce, 'host', ['"$mid"', '"$(id -u)"', '"$(id -un)"']),
    `command -v tmux >/dev/null 2>&1 || { ${staticRecord(nonce, 'err', 'REMOTE_TOOL_MISSING')}; ${endAndExit(nonce)}; }`,
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

function targetValue(expect) {
  const target = expect?.target;
  if (typeof target !== 'string' || !/^[$@%][0-9]+$/.test(target)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'guard target must look like $N, @N or %N');
  }
  return target;
}

function optionalCwd(cwd, quote = shQuote) {
  if (cwd === undefined || cwd === null || cwd === '') return '';
  if (typeof cwd !== 'string') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'cwd must be a string');
  }
  return ` -c ${quote(escapeTmuxFormat(cwd))}`;
}

function optionalCommand(command, quote = shQuote) {
  if (command === undefined || command === null) return '';
  if (!Array.isArray(command)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'command must be an argv array');
  }
  if (command.length === 0) return '';
  const argv = command.map((part) => {
    if (typeof part !== 'string' || part.length === 0) {
      throw new XcError(CODES.INVALID_ARGUMENT, 'command arguments must be non-empty strings');
    }
    return quote(part);
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

/** Quote for tmux's command parser, not for the surrounding POSIX shell. */
function tmuxQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'invalid tmux command argument');
  }
  return `"${value.replace(/[\\"$]/g, '\\$&')}"`;
}

function nativeRecord(nonce, head, ...fields) {
  const sep = `${FS}${nonce}${FS}`;
  const value = `XC1${nonce}${FS}${[head, ...fields].join(sep)}${RS}${nonce}${RS}`;
  return `display-message -p ${tmuxQuote(value)}`;
}

function generationCheck(gen) {
  if (typeof gen !== 'string' || !/^[0-9]+-[0-9]+$/.test(gen)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'guard requires a numeric server generation');
  }
  return `#{==:#{pid}-#{start_time},${gen}}`;
}

/**
 * One bound tmux client and one native command queue. if-shell -F is synchronous
 * (no run-shell or background job); tmux stops the branch's entire command list
 * on any action error, including all remaining chunks/keys and the success record.
 * Any later tmux invocation must have its own generation and identity guard.
 */
function guardedCommand(nonce, socket, expect, actions, { send = false } = {}) {
  assertNonce(nonce);
  const generation = generationCheck(expect?.gen);
  const target = targetValue(expect);
  const checks = [];
  for (const [field, kind, format] of [
    ['sid', 'session', 'session_id'], ['wid', 'window', 'window_id'], ['pid', 'pane', 'pane_id'],
  ]) {
    if (expect[field] !== undefined && expect[field] !== null) {
      checks.push([`#{==:#{${format}},${tmuxTarget(kind, intArg(expect[field], `${kind} id`))}}`, 'TARGET_CHANGED']);
    }
  }
  if (send) {
    checks.push(
      ['#{==:#{synchronize-panes},0}', 'SYNCHRONIZED_PANES'],
      ['#{==:#{pane_in_mode},0}', 'PANE_IN_MODE'],
      ['#{==:#{pane_dead},0}', 'PANE_DEAD'],
      ['#{==:#{pane_input_off},0}', 'PANE_INPUT_DISABLED'],
    );
  }
  const condition = checks.reduce((left, [right]) => `#{&&:${left},${right}}`, '1');
  const refusal = checks.reduceRight((rest, [check, code]) => `#{?${check},${rest},${code}}`, 'TARGET_CHANGED');
  const branch = `if-shell -F -t ${tmuxQuote(target)} ${tmuxQuote(condition)} ` +
    `${tmuxQuote([nativeRecord(nonce, 'guarded'), ...actions].join(' ; '))} ${tmuxQuote(nativeRecord(nonce, 'err', refusal))}`;
  return `${tmux(socket)} if-shell -F ${shQuote(generation)} ${shQuote(branch)} ` +
    shQuote(nativeRecord(nonce, 'err', 'SERVER_RESTARTED'));
}

/** Hex keeps captured protocol markers from becoming nested err records. */
function diagnosticHex(word) {
  return `$(printf '%s' ${word} | head -c 8192 | od -An -v -tx1 | tr -d ' \\n')`;
}

/** Classify a failed single client without equating a passed guard with mutation. */
function checkedCommand(nonce, command, { mutating = true, completed } = {}) {
  return [
    `out=$(${command} 2>&1)`,
    'rc=$?',
    'if [ "$rc" -ne 0 ]; then',
    `  code=${shQuote(mutating ? 'OUTCOME_UNKNOWN' : 'REMOTE_ERROR')}`,
    '  case "$out" in',
    "    *\"no server running\"*|*\"error connecting to\"*|*\"failed to connect to server\"*) code=SERVER_GONE ;;",
    // Preserve identity failure before the guard, but a bad action target is a
    // rejected command. Completed actions below override ALL rejection codes.
    "    *\"can't find pane\"*|*\"can't find window\"*|*\"can't find session\"*)",
    `      case "$out" in *${shQuote(`XC1${nonce}${FS}guarded`)}*) code=REMOTE_ERROR ;; *) code=TARGET_GONE ;; esac ;;`,
    // Unrecognized runtime failures remain conservative.
    "    *\"usage:\"*|*\"unknown command:\"*|*\"unknown flag\"*|*\"invalid option\"*|*\"invalid argument\"*|*\"duplicate session:\"*|*\"no space for new pane\"*|*\"not in a mode\"*) code=REMOTE_ERROR ;;",
    '    *"no current target"*)',
    // A marker failure AFTER dispatch can follow a successful mutation (for
    // example a user hook destroyed the last pane). Only a pre-guard failure
    // proves this target error preceded all actions.
    `      case "$out" in *${shQuote(`XC1${nonce}${FS}guarded`)}*) ;; *) code=REMOTE_ERROR ;; esac ;;`,
    '  esac',
    `  case "$out" in *${shQuote(`XC1${nonce}${FS}progress`)}*|*${shQuote(`XC1${nonce}${FS}created`)}*) code=${mutating ? 'OUTCOME_UNKNOWN' : 'REMOTE_ERROR'} ;; esac`,
    // Multi-invocation mutations must retain progress from earlier clients.
    ...(mutating && completed ? [`  if [ ${completed} -gt 0 ]; then code=OUTCOME_UNKNOWN; fi`] : []),
    `  detail=${diagnosticHex('"$out"')}`,
    `  message=${shQuote('tmux action failed')}`,
    `  if [ "$code" = OUTCOME_UNKNOWN ]; then message=${shQuote('tmux action failed; verify with capture before retrying')}; fi`,
    record(nonce, 'err', ['"$code"', '"$message"', '"$detail"']),
    `  ${endAndExit(nonce)}`,
    'fi',
    'printf \'%s\\n\' "$out"',
  ].join('\n');
}

/** Standalone diagnostic only. Mutations use guardedCommand with their actions. */
export function guardSnippet(nonce, socket, expect) {
  return checkedCommand(nonce, guardedCommand(nonce, socket, expect, [nativeRecord(nonce, 'ok')]), { mutating: false });
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
    `  ${endAndExit(nonce)}`,
    'fi',
  );
}

/**
 * New session. Emits `['created', gen, sid, wid, pid, sessionName, windowName]`.
 */
export function createSessionScript(nonce, socket, { name, cwd, command, width, height, expectedGen } = {}) {
  assertNonce(nonce);
  validateSessionName(name);
  const x = width === undefined ? 200 : intArg(width, 'width', { min: 1, max: 1000 });
  const y = height === undefined ? 50 : intArg(height, 'height', { min: 1, max: 1000 });
  const base =
    `${tmux(socket)} new-session -d -s ${shQuote(escapeTmuxFormat(name))} -x ${x} -y ${y}` +
    optionalCwd(cwd);
  if (expectedGen === undefined) {
    return finish(nonce, prologue(nonce), createdScriptBody(nonce, base, command));
  }
  const action = `new-session -d -s ${tmuxQuote(escapeTmuxFormat(name))} -x ${x} -y ${y}` +
    optionalCwd(cwd, tmuxQuote) + ` -P -F ${tmuxQuote(createdFormat(nonce))}` + optionalCommand(command, tmuxQuote);
  const condition = expectedGen === null ? '#{==:#{session_id},}' : generationCheck(expectedGen);
  // tmux 3.0a display-message needs a live pane. On an empty server the
  // creation itself must be first; -P supplies the success/identity record.
  const actions = expectedGen === null ? [action] : [nativeRecord(nonce, 'guarded'), action];
  const invocation = `${tmux(socket)} ${expectedGen === null ? 'start-server \\; ' : ''}` +
    `if-shell -F ${shQuote(condition)} ${shQuote(actions.join(' ; '))} ` +
    shQuote(nativeRecord(nonce, 'err', 'SERVER_RESTARTED'));
  return finish(nonce, prologue(nonce), checkedCommand(nonce, invocation));
}

/** New window attached to a session (`-t $sid`). */
export function createWindowScript(nonce, socket, expect, { name, cwd, command } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const sid = intArg(expect.sid, 'session id');
  if (name !== undefined && name !== null) validateSessionName(name);
  const action =
    `new-window -d -t ${tmuxQuote(tmuxTarget('session', sid))}` +
    `${name !== undefined && name !== null ? ` -n ${tmuxQuote(escapeTmuxFormat(name))}` : ''}` +
    optionalCwd(cwd, tmuxQuote) + ` -P -F ${tmuxQuote(createdFormat(nonce))}` + optionalCommand(command, tmuxQuote);
  return finish(nonce, prologue(nonce), checkedCommand(nonce, guardedCommand(nonce, socket, expect, [action])));
}

/** Split a pane (`-t %pid`); horizontal means side-by-side (`-h`). */
export function splitPaneScript(nonce, socket, expect, { horizontal = false, cwd, command } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const pid = intArg(expect.pid, 'pane id');
  if (typeof horizontal !== 'boolean') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'horizontal must be a boolean');
  }
  const action =
    `split-window -d -t ${tmuxQuote(tmuxTarget('pane', pid))} ${horizontal ? '-h' : '-v'}` +
    optionalCwd(cwd, tmuxQuote) + ` -P -F ${tmuxQuote(createdFormat(nonce))}` + optionalCommand(command, tmuxQuote);
  return finish(nonce, prologue(nonce), checkedCommand(nonce, guardedCommand(nonce, socket, expect, [action])));
}

// Legacy unpinned new-session entry point. Guarded creation uses one native queue.
// `-P -F` must precede `-- <argv>`: anything after `--` belongs to the new process.
function createdScriptBody(nonce, base, command) {
  return [
    `out=$(${base} -P -F ${shQuote(createdFormat(nonce))}${optionalCommand(command)} 2>&1)`,
    'rc=$?',
    'if [ "$rc" -ne 0 ]; then',
    '  first=$(printf \'%s\\n\' "$out" | sed -n \'1p\')',
    `  ${record(nonce, 'err', [shQuote('REMOTE_ERROR'), '"$first"'])}`,
    `  ${endAndExit(nonce)}`,
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
  const target = tmuxTarget('pane', pid);
  const quotedTarget = tmuxQuote(target);
  const actions = [];
  for (let i = 0; i < hex.length; i += SEND_CHUNK_BYTES) {
    const chunk = hex.slice(i, i + SEND_CHUNK_BYTES);
    actions.push(`send-keys -t ${quotedTarget} -H ${chunk.join(' ')}`);
  }
  for (const key of keys) actions.push(`send-keys -t ${quotedTarget} ${tmuxQuote(key)}`);
  if (enter) actions.push(`send-keys -t ${quotedTarget} Enter`);
  // A later rejection must not hide bytes/keys already accepted by tmux.
  const tracked = actions.flatMap((action) => [action, nativeRecord(nonce, 'progress')]);
  tracked.push(nativeRecord(nonce, 'ok', target, String(hex.length)));
  return finish(nonce, prologue(nonce), checkedCommand(nonce,
    guardedCommand(nonce, socket, expect, tracked, { send: true })));

}

/**
 * Bound newest raw bytes remotely BEFORE hex encoding. Raw tmux stdout is spooled
 * to a private file, never an unbounded shell variable or transport record.
 * Emits ['capture', hex, '1'|'0']; trimming skips a partial leading UTF-8 codepoint.
 */
export function captureScript(nonce, socket, expect, { lines = 80, maxBytes = 65536 } = {}) {
  assertNonce(nonce);
  targetValue(expect);
  const pid = intArg(expect.pid, 'pane id');
  const count = intArg(lines, 'lines', { min: 1, max: 2000 });
  const budget = intArg(maxBytes, 'maxBytes', { min: 1, max: 1024 * 1024 });
  const invocation = guardedCommand(nonce, socket, expect,
    [`capture-pane -p -J -t ${tmuxQuote(tmuxTarget('pane', pid))} -S -${count}`]);
  const header = `XC1${nonce}${FS}guarded${RS}${nonce}${RS}`;
  const failure = `{ ${staticRecord(nonce, 'err', 'REMOTE_ERROR', 'capture failed')}; ${endAndExit(nonce)}; }`;
  return finish(nonce, prologue(nonce),
    'umask 077',
    `tmp=$(mktemp -d /tmp/dsh-tmux-xc.XXXXXXXXXX) || ${failure}`,
    // Only these fixed filenames inside the just-created private directory are removed.
    'trap \'rm -f "$tmp/raw" "$tmp/err" "$tmp/tail" "$tmp/hex"; rmdir "$tmp"\' 0',
    'trap \'exit 1\' 1 2 15',
    `${invocation} >"$tmp/raw" 2>"$tmp/err"`,
    'rc=$?',
    'IFS= read -r header <"$tmp/raw"',
    'if [ "$rc" -ne 0 ]; then',
    '  detail=$(head -c 1024 "$tmp/err")',
    '  code=REMOTE_ERROR',
    '  case "$detail" in',
    '    *"no server running"*|*"error connecting to"*|*"failed to connect to server"*) code=SERVER_GONE ;;',
    '    *"can\'t find pane"*|*"can\'t find window"*|*"can\'t find session"*) code=TARGET_GONE ;;',
    '  esac',
    record(nonce, 'err', ['"$code"', shQuote('capture failed'), `"${diagnosticHex('"$detail"')}"`]),
    `  ${endAndExit(nonce)}`,
    'fi',
    `if [ "$header" != ${shQuote(header)} ]; then`,
    // A guard refusal contains one bounded framed err record, not pane output.
    `  head -c 1024 "$tmp/raw"; ${endAndExit(nonce)}`,
    'fi',
    `size=$(wc -c <"$tmp/raw") || ${failure}`,
    `size=$((size - ${Buffer.byteLength(header) + 1}))`,
    'truncated=0',
    `if [ "$size" -gt ${budget} ]; then size=${budget}; truncated=1; fi`,
    `tail -c "$size" "$tmp/raw" >"$tmp/tail" || ${failure}`,
    `od -An -v -tx1 "$tmp/tail" >"$tmp/hex" || ${failure}`,
    `hex=$(tr -d ' \\n' <"$tmp/hex") || ${failure}`,
    'if [ "$truncated" = 1 ]; then',
    '  while :; do case "$hex" in [89ab][0-9a-f]*) hex=${hex#??} ;; *) break ;; esac; done',
    'fi',
    record(nonce, 'capture', ['"$hex"', '"$truncated"']),
  );
}

/** Detach enumerated clients; emit ['ok', sessionTarget, 'detached', count]. */
export function detachScript(nonce, socket, expect) {
  assertNonce(nonce);
  targetValue(expect);
  const sid = intArg(expect.sid, 'session id');
  const target = tmuxTarget('session', sid);
  const header = `XC1${nonce}${FS}guarded${RS}${nonce}${RS}`;
  const progress = `XC1${nonce}${FS}progress${RS}${nonce}${RS}`;
  const clientStart = `XC1${nonce}${FS}client${FS}${nonce}${FS}`;
  const clientEnd = `${RS}${nonce}${RS}`;
  const list = guardedCommand(nonce, socket, expect, [
    // Frame names rather than splitting on newlines supplied by a client.
    `list-clients -t ${tmuxQuote(target)} -F ${tmuxQuote(`${clientStart}#{client_name}${clientEnd}`)}`,
  ]);
  const invalidList = `${staticRecord(nonce, 'err', 'PROTOCOL', 'invalid client list')}; ${endAndExit(nonce)}`;
  // The marker occurs only inside a shell single-quoted tmux branch. Splice a
  // double-quoted expansion there, never eval client-provided text. Client names
  // need two tmux escaping passes: the action argument and its enclosing queue.
  const marker = `XC_DETACH_CLIENT_${nonce}`;
  const template = guardedCommand(nonce, socket, expect, [
    `detach-client -t ${tmuxQuote(marker)}`, nativeRecord(nonce, 'progress'),
  ]);
  // The socket selector precedes the branch and could contain the same text.
  const markerAt = template.lastIndexOf(marker);
  const detach = template.slice(0, markerAt) + "'\"$client_quoted\"'" + template.slice(markerAt + marker.length);
  return finish(nonce, prologue(nonce),
    // tmux 3.0a's session-wide detach needs a current attached client, even when
    // there are none to detach. list-clients succeeds with an empty list.
    checkedCommand(nonce, list, { mutating: false }),
    `case "$out" in ${shQuote(header)}|${shQuote(`${header}\n`)}*) ;; *) ${endAndExit(nonce)} ;; esac`,
    `clients=\${out#${shQuote(header)}}`,
    `client_start=${shQuote(clientStart)}`,
    `client_end=${shQuote(clientEnd)}`,
    // Only the list's record separators are consumed; a name can contain spaces,
    // shell syntax or newlines without becoming another target or command.
    `newline=${shQuote('\n')}`,
    'detached=0',
    'while [ -n "$clients" ]; do',
    `  case "$clients" in "$newline$client_start"*"$client_end"*) ;; *) ${invalidList} ;; esac`,
    '  clients=${clients#"$newline$client_start"}',
    '  client=${clients%%"$client_end"*}',
    '  clients=${clients#*"$client_end"}',
    `  [ -n "$client" ] || { ${invalidList}; }`,
    // A suffix keeps command substitution from stripping client-name newlines.
    `  client_quoted=$(printf '%s_' "$client" | sed ${shQuote(String.raw`s/[\\"$]/\\&/g; s/[\\"$]/\\&/g`)})`,
    '  client_quoted=${client_quoted%_}',
    // Recheck the original generation AND every approved ancestor in the same
    // invocation as each detach: reconnecting must never mutate a new server.
    checkedCommand(nonce, detach, { completed: '"$detached"' }),
    `  case "$out" in *${shQuote(progress)}*) detached=$((detached + 1)) ;; *) ${endAndExit(nonce)} ;; esac`,
    'done',
    record(nonce, 'ok', [shQuote(target), shQuote('detached'), '"$detached"']),
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
  const target = tmuxTarget(kind, id);
  // Killing the last pane/window/session can leave NO target for 3.0a's
  // display-message. Only the shell may report success after the client exits.
  return finish(nonce, prologue(nonce), checkedCommand(nonce,
    guardedCommand(nonce, socket, expect, [`${command} -t ${tmuxQuote(target)}`])),
    `case "$out" in *${shQuote(`XC1${nonce}${FS}guarded`)}*) ${staticRecord(nonce, 'ok', target)} ;; esac`);

}
