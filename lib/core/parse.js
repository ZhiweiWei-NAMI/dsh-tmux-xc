import { createHash } from 'node:crypto';
import { XcError, CODES } from './errors.js';
import { sanitizeLabel } from './sanitize.js';

/**
 * Parsers for the XC1 protocol records produced by lib/core/scripts.js.
 * All numeric fields are parsed strictly: a malformed record increments
 * `malformed` and is skipped instead of defaulting to 0.
 */

const INT_RE = /^(0|[1-9][0-9]*)$/;
// tmux `#{session_id}`/`#{window_id}`/`#{pane_id}` render with their prefix.
const TMUX_ID_RE = /^[$@%](0|[1-9][0-9]*)$/;
const GEN_RE = /^[0-9]+-[0-9]+$/;

function parseCount(value) {
  if (typeof value !== 'string' || !INT_RE.test(value)) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : null;
}

function parseId(value, prefix) {
  if (typeof value !== 'string') return null;
  const match = TMUX_ID_RE.exec(value);
  if (!match) return null;
  // `session_id` must be `$N`, `window_id` `@N`, `pane_id` `%N`.
  if (prefix && value[0] !== prefix) return null;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) ? num : null;
}

function isField(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Decode a record field to a string (records come from parseRecords).
 * @param {unknown} rec
 * @returns {string[]}
 */
function fields(rec) {
  return Array.isArray(rec) ? rec.map((f) => (typeof f === 'string' ? f : '')) : [];
}

/**
 * `['host', machine, uid, user]` record.
 * @param {string[]} rec
 * @returns {{ machine: string, uid: string, user: string }}
 */
export function parseHostRecord(rec) {
  const [type, machine, uid, user] = fields(rec);
  if (type !== 'host' || !isField(machine) || !isField(uid) || !isField(user)) {
    throw new XcError(CODES.PROTOCOL, 'malformed host record');
  }
  return { machine, uid, user };
}

/**
 * Stable host fingerprint: first 12 hex of sha256(machine + "\n" + uid).
 * @param {string} machine
 * @param {string} uid
 * @returns {string}
 */
export function hostFingerprint(machine, uid) {
  if (typeof machine !== 'string' || typeof uid !== 'string') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'machine and uid must be strings');
  }
  return createHash('sha256').update(`${machine}\n${uid}`, 'utf8').digest('hex').slice(0, 12);
}

// tmux activity flags render as exactly "0" or "1"; anything else means the
// record is not trustworthy.
function parseFlag(value) {
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

const INVENTORY_FIELDS = 20;

/**
 * Build the host → server → sessions → windows → panes tree from inventory
 * records.
 *
 * @param {string[][]} records
 * @returns {{
 *   host: { fp: string, uid: string, user: string },
 *   server: null | { gen: string, socketPath: string },
 *   sessions: Array<object>,
 *   malformed: number,
 * }}
 */
export function parseInventory(records) {
  if (!Array.isArray(records)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'records must be an array');
  }

  let host = null;
  let server = null;
  let noserver = false;
  let malformed = 0;
  const panes = [];

  for (const raw of records) {
    const rec = fields(raw);
    const type = rec[0];
    if (type === 'begin' || type === 'end') continue;
    if (type === 'host') {
      try {
        const parsed = parseHostRecord(rec);
        if (host) {
          malformed += 1;
          continue;
        }
        host = parsed;
      } catch {
        malformed += 1;
      }
      continue;
    }
    if (type === 'noserver') {
      noserver = true;
      continue;
    }
    if (type === 'err') continue;
    if (type !== 'pane') {
      malformed += 1;
      continue;
    }

    if (rec.length !== INVENTORY_FIELDS) {
      malformed += 1;
      continue;
    }
    const [
      ,
      gen,
      socketPath,
      sidText,
      sessionName,
      sessionCreated,
      sessionAttached,
      widText,
      windowIndex,
      windowName,
      windowActive,
      pidText,
      paneIndex,
      paneActive,
      cmd,
      cwd,
      paneDead,
      width,
      height,
      title,
    ] = rec;
    const sid = parseId(sidText, '$');
    const wid = parseId(widText, '@');
    const pid = parseId(pidText, '%');
    const created = parseCount(sessionCreated);
    const attachedCount = parseCount(sessionAttached);
    const winIndex = parseCount(windowIndex);
    const paneIdx = parseCount(paneIndex);
    const w = parseCount(width);
    const h = parseCount(height);
    if (
      !GEN_RE.test(gen) ||
      !isField(socketPath) ||
      sid === null ||
      wid === null ||
      pid === null ||
      created === null ||
      attachedCount === null ||
      parseFlag(windowActive) === null ||
      parseFlag(paneActive) === null ||
      parseFlag(paneDead) === null ||
      winIndex === null ||
      paneIdx === null ||
      w === null ||
      h === null
    ) {
      malformed += 1;
      continue;
    }
    panes.push({
      gen,
      socketPath,
      sid,
      sessionName,
      created,
      // tmux reports the number of attached clients, not a flag.
      attached: attachedCount,
      wid,
      windowIndex: winIndex,
      windowName,
      windowActive: windowActive === '1',
      pid,
      paneIndex: paneIdx,
      paneActive: paneActive === '1',
      cmd,
      cwd,
      dead: paneDead === '1',
      width: w,
      height: h,
      title,
    });
  }

  if (!host) {
    throw new XcError(CODES.PROTOCOL, 'inventory is missing the host record');
  }

  const generated = panes.length > 0 ? panes[0].gen : null;
  const usable = panes.filter((pane) => pane.gen === generated);
  if (panes.length > 0 && usable.length !== panes.length) {
    malformed += panes.length - usable.length;
  }

  if (usable.length > 0) {
    server = { gen: usable[0].gen, socketPath: usable[0].socketPath };
  }

  const sessions = buildTree(usable);
  return {
    host: {
      fp: hostFingerprint(host.machine, host.uid),
      uid: host.uid,
      user: host.user,
    },
    server,
    sessions,
    malformed,
  };
}

function buildTree(panes) {
  const sessions = new Map();
  for (const pane of panes) {
    let session = sessions.get(pane.sid);
    if (!session) {
      session = {
        sid: pane.sid,
        name: sanitizeLabel(pane.sessionName),
        created: pane.created,
        attached: pane.attached,
        windows: new Map(),
      };
      sessions.set(pane.sid, session);
    }
    let window = session.windows.get(pane.wid);
    if (!window) {
      window = {
        wid: pane.wid,
        index: pane.windowIndex,
        name: sanitizeLabel(pane.windowName),
        active: pane.windowActive,
        panes: [],
      };
      session.windows.set(pane.wid, window);
    }
    window.panes.push({
      pid: pane.pid,
      index: pane.paneIndex,
      active: pane.paneActive,
      cmd: sanitizeLabel(pane.cmd),
      cwd: sanitizeLabel(pane.cwd),
      dead: pane.dead,
      width: pane.width,
      height: pane.height,
      title: sanitizeLabel(pane.title),
    });
  }

  return [...sessions.values()]
    .sort((a, b) => a.sid - b.sid)
    .map((session) => ({
      ...session,
      windows: [...session.windows.values()]
        .sort((a, b) => a.index - b.index || a.wid - b.wid)
        .map((window) => ({
          ...window,
          panes: window.panes.sort((a, b) => a.index - b.index || a.pid - b.pid),
        })),
    }));
}

/**
 * `['created', gen, sid, wid, pid, sessionName, windowName]` record.
 * @param {string[][]} records
 * @returns {{ gen: string, sid: number, wid: number, pid: number, sessionName: string, windowName: string }}
 */
export function parseCreated(records) {
  if (!Array.isArray(records)) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'records must be an array');
  }
  const found = records.find((rec) => Array.isArray(rec) && rec[0] === 'created');
  if (!found) {
    throw new XcError(CODES.PROTOCOL, 'no created record');
  }
  const [, gen, sidText, widText, pidText, sessionName, windowName] = fields(found);
  const sid = parseId(sidText, '$');
  const wid = parseId(widText, '@');
  const pid = parseId(pidText, '%');
  if (
    !GEN_RE.test(gen ?? '') ||
    sid === null ||
    wid === null ||
    pid === null ||
    !isField(sessionName) ||
    typeof windowName !== 'string'
  ) {
    throw new XcError(CODES.PROTOCOL, 'malformed created record');
  }
  return {
    gen,
    sid,
    wid,
    pid,
    sessionName: sanitizeLabel(sessionName),
    windowName: sanitizeLabel(windowName),
  };
}

function findRecord(records, type) {
  const found = records.find((rec) => Array.isArray(rec) && rec[0] === type);
  return found === undefined ? null : fields(found);
}

/** Largest suffix of `text` whose visible tail can be searched on one row. */
const SUBMISSION_TAIL_CHARS = 24;

/**
 * Visible tail used by the post-Enter submission heuristic: the last
 * `SUBMISSION_TAIL_CHARS` non-space characters of the delivered text, with
 * newlines removed (tmux joins a wrapped cursor row). Returns '' when the text
 * has no visible characters (e.g. keys-only or whitespace-only payloads), in
 * which case the heuristic cannot decide and the caller must report `unknown`.
 *
 * @param {string} text
 * @returns {string}
 */
export function submissionTail(text) {
  if (typeof text !== 'string') return '';
  return Array.from(text.replace(/\s+/g, '')).slice(-SUBMISSION_TAIL_CHARS).join('');
}

/**
 * Classify the post-Enter cursor row.
 *
 * `pending` when the visible tail of the sent text is still on the cursor line
 * (likely still in an input box), `cleared` otherwise, `unknown` when the probe
 * produced no usable row. This is a heuristic: it never claims the target
 * program executed the task.
 *
 * @param {{ text?: string, cursor?: string[][]|null, tail?: string }} input
 * @returns {{ checked: boolean, state: 'cleared'|'pending'|'unknown', detail?: string }}
 */
export function classifySubmission({ text = '', cursor = null, tail } = {}) {
  const needle = typeof tail === 'string' ? tail : submissionTail(text);
  const record = Array.isArray(cursor) && cursor[0] === 'cursor' ? fields(cursor) : null;
  const hex = record?.[1];
  if (record === null || typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(hex)) {
    return { checked: false, state: 'unknown', detail: 'cursor line was not captured' };
  }
  // The capture is bounded remotely to a few KiB; decode only that much.
  const line = sanitizeLabel(Buffer.from(hex, 'hex').toString('utf8'), 2048);
  if (!needle) {
    // Nothing visible could still be sitting in an input box.
    return { checked: true, state: 'cleared', detail: 'sent text has no visible characters' };
  }
  const pending = line.replace(/\s+/g, '').includes(needle);
  return pending ? { checked: true, state: 'pending' } : { checked: true, state: 'cleared' };
}

const ENTER_FAIL_CODES = new Set([
  'SERVER_GONE', 'SERVER_RESTARTED', 'TARGET_GONE', 'TARGET_CHANGED',
  'SYNCHRONIZED_PANES', 'PANE_IN_MODE', 'PANE_DEAD', 'PANE_INPUT_DISABLED',
  'OUTCOME_UNKNOWN', 'REMOTE_ERROR',
]);

/**
 * Parse the `enterfail` record emitted when the Enter step's guard or tmux
 * invocation failed. Returns null when Enter may have been delivered.
 *
 * @param {string[][]} records
 * @returns {{ code: string, detail?: string } | null}
 */
export function parseEnterFailure(records) {
  const rec = findRecord(records, 'enterfail');
  if (rec === null) return null;
  const code = isField(rec[1]) && ENTER_FAIL_CODES.has(rec[1]) ? rec[1] : 'OUTCOME_UNKNOWN';
  let detail;
  if (typeof rec[2] === 'string' && /^(?:[0-9a-f]{2})*$/.test(rec[2]) && rec[2].length > 0) {
    const text = Buffer.from(rec[2], 'hex').toString('utf8').replace(
      new RegExp(`XC1[0-9a-f]{12}\\x1f[\\s\\S]*?\\x1e[0-9a-f]{12}\\x1e(?:\\n|$)`, 'g'), '',
    );
    const cleaned = sanitizeLabel(text, 300);
    if (cleaned) detail = cleaned;
  }
  return { code, ...(detail ? { detail } : {}) };
}

/**
 * Parse the read-only post-Enter cursor record `['cursor', <hex>, <cy>]`.
 *
 * @param {string[][]} records
 * @returns {string[][] | null} the raw record for classifySubmission
 */
export function parseCursorRecord(records) {
  const rec = findRecord(records, 'cursor');
  if (rec === null) return null;
  const [, hex, cy] = rec;
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(hex) || hex.length > 2 * 8192) return null;
  if (typeof cy !== 'string' || !/^(0|[1-9][0-9]*)$/.test(cy)) return null;
  return rec;
}

/**
 * Post-Enter heuristic over the records of one send script.
 *
 * `pending` means the visible tail of the sent text is still on the cursor row
 * (likely still sitting in an input box); `cleared` means it is no longer
 * visible; `unknown` covers a failed/malformed probe or text with no visible
 * characters to compare. It never claims the target program ran the task.
 *
 * @param {string[][]} records
 * @param {string} text the delivered text (for the visible tail)
 * @returns {{ checked: boolean, state: 'cleared'|'pending'|'unknown', detail?: string }}
 */
export function parseSubmission(records, text = '') {
  const cursor = parseCursorRecord(Array.isArray(records) ? records : []);
  return classifySubmission({ text, cursor });
}
