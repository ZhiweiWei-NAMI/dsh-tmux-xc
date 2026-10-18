/**
 * Resolve a durable reference against a fresh inventory (DESIGN §4).
 *
 * A window may be linked into several sessions, so inventories can list the same
 * `@N` under multiple sessions. Pane ids are globally unique, so a pane ref is
 * never ambiguous; window refs are when their original session lost the link.
 */
import { XcError, CODES } from './errors.js';
import { sanitizeLabel } from './sanitize.js';

const OK = 'OK';
const OK_RELOCATED = 'OK_RELOCATED';

function fail(code, message, warnings = []) {
  return { code, warnings, message };
}

function targetOf(kind, { sid = null, wid = null, pid = null, session = null, window = null, pane = null } = {}) {
  return { kind, sid, wid, pid, session, window, pane };
}

function paneCount(session) {
  let count = 0;
  for (const window of session?.windows ?? []) count += window.panes?.length ?? 0;
  return count;
}

function onlyPane(session) {
  for (const window of session?.windows ?? []) {
    if ((window.panes?.length ?? 0) === 1) return { window, pane: window.panes[0] };
  }
  return { window: null, pane: null };
}

function sessionById(inv, sid) {
  return (inv?.sessions ?? []).find((session) => session.sid === sid) ?? null;
}

/** All occurrences of a window, one per session (deduplicated by session id). */
function windowOccurrences(inv, wid) {
  const found = [];
  const seen = new Set();
  for (const session of inv?.sessions ?? []) {
    for (const window of session.windows ?? []) {
      if (window.wid !== wid || seen.has(session.sid)) continue;
      seen.add(session.sid);
      found.push({ session, window });
    }
  }
  return found;
}

function paneOccurrences(inv, pid) {
  const found = [];
  for (const session of inv?.sessions ?? []) {
    for (const window of session.windows ?? []) {
      for (const pane of window.panes ?? []) {
        if (pane.pid === pid) found.push({ session, window, pane });
      }
    }
  }
  return found;
}

/**
 * Resolve `ref` against `inv`. Pure: never throws for a well-formed ref, reports
 * every outcome in the result code instead.
 */
export function resolve(ref, inv, { requirePane = false } = {}) {
  if (!ref || typeof ref !== 'object') {
    throw new XcError(CODES.INVALID_ARGUMENT, 'resolve expects a decoded ref object');
  }
  if (!inv || typeof inv !== 'object' || !inv.host) {
    throw new XcError(CODES.INVALID_ARGUMENT, 'resolve expects an inventory object');
  }

  if (ref.hostFp !== inv.host.fp) {
    return fail(CODES.HOST_IDENTITY_CHANGED,
      `host identity changed: reference fp ${ref.hostFp} != observed fp ${inv.host.fp}`);
  }

  if (ref.kind === 'host') {
    return { code: OK, target: targetOf('host', { host: inv.host }), warnings: [], message: 'host identity matches' };
  }

  if (!inv.server) {
    return fail(CODES.SERVER_GONE, 'no tmux server is running on that socket');
  }
  if (ref.kind === 'server') {
    if (ref.gen !== inv.server.gen) {
      return fail(CODES.SERVER_RESTARTED,
        `tmux server restarted: reference gen ${ref.gen}, observed gen ${inv.server.gen}`);
    }
    return {
      code: OK,
      target: { ...targetOf('server'), gen: inv.server.gen, socketPath: inv.server.socketPath ?? null },
      warnings: [],
      message: 'tmux server generation matches',
    };
  }
  if (ref.gen !== inv.server.gen) {
    return fail(CODES.SERVER_RESTARTED,
      `tmux server restarted: reference gen ${ref.gen}, observed gen ${inv.server.gen}`);
  }

  const warnings = [];

  if (ref.kind === 'session') {
    const session = sessionById(inv, ref.sid);
    if (!session) return fail(CODES.TARGET_GONE, `session $${ref.sid} no longer exists`);
    const count = paneCount(session);
    if (requirePane && count > 1) {
      return fail(CODES.AMBIGUOUS,
        `session $${session.sid} spans ${count} panes; an input operation needs exactly one pane`, warnings);
    }
    const single = count === 1 ? onlyPane(session) : { window: null, pane: null };
    return {
      code: OK,
      target: targetOf('session', {
        sid: session.sid,
        wid: single.window?.wid ?? null,
        pid: single.pane?.pid ?? null,
        session,
        window: single.window,
        pane: single.pane,
      }),
      warnings,
      message: `session $${session.sid} present`,
    };
  }

  if (ref.kind === 'window') {
    const occurrences = windowOccurrences(inv, ref.wid);
    if (occurrences.length === 0) return fail(CODES.TARGET_GONE, `window @${ref.wid} no longer exists`);

    const current = occurrences.find((item) => item.session.sid === ref.sid) ?? null;
    if (current) {
      const panes = current.window.panes ?? [];
      if (requirePane && panes.length > 1) {
        return fail(CODES.AMBIGUOUS,
          `window @${ref.wid} spans ${panes.length} panes; an input operation needs exactly one pane`, warnings);
      }
      if (occurrences.length > 1) {
        warnings.push(`window @${ref.wid} is linked into ${occurrences.length} sessions`);
      }
      const pane = panes.length === 1 ? panes[0] : null;
      return {
        code: OK,
        target: targetOf('window', {
          sid: current.session.sid,
          wid: current.window.wid,
          pid: pane?.pid ?? null,
          session: current.session,
          window: current.window,
          pane,
        }),
        warnings,
        message: `window @${ref.wid} present in session $${current.session.sid}`,
      };
    }

    const others = occurrences.slice();
    if (others.length > 1) {
      return fail(CODES.AMBIGUOUS,
        `window @${ref.wid} is linked into sessions ${others.map((o) => `$${o.session.sid}`).join(', ')} and not into $${ref.sid}`, warnings);
    }
    const moved = others[0];
    const panes = moved.window.panes ?? [];
    if (requirePane && panes.length > 1) {
      return fail(CODES.AMBIGUOUS,
        `window @${ref.wid} spans ${panes.length} panes; an input operation needs exactly one pane`, warnings);
    }
    warnings.push(`window @${ref.wid} moved from session $${ref.sid} to $${moved.session.sid}`);
    const pane = panes.length === 1 ? panes[0] : null;
    return {
      code: OK_RELOCATED,
      target: targetOf('window', {
        sid: moved.session.sid,
        wid: moved.window.wid,
        pid: pane?.pid ?? null,
        session: moved.session,
        window: moved.window,
        pane,
      }),
      warnings,
      message: `window @${ref.wid} is now in session $${moved.session.sid}`,
    };
  }

  if (ref.kind === 'pane') {
    const occurrences = paneOccurrences(inv, ref.pid);
    if (occurrences.length === 0) return fail(CODES.TARGET_GONE, `pane %${ref.pid} no longer exists`);

    const exact = occurrences.find((item) => item.session.sid === ref.sid && item.window.wid === ref.wid) ?? null;
    if (exact) {
      if (occurrences.length > 1) {
        warnings.push(`window @${exact.window.wid} is linked into ${new Set(occurrences.map((o) => o.session.sid)).size} sessions`);
      }
      return {
        code: OK,
        target: targetOf('pane', {
          sid: exact.session.sid,
          wid: exact.window.wid,
          pid: exact.pane.pid,
          session: exact.session,
          window: exact.window,
          pane: exact.pane,
        }),
        warnings,
        message: `pane %${ref.pid} present`,
      };
    }

    // Prefer the occurrence whose window is unchanged: the session link moved,
    // not the pane. Otherwise the pane itself was moved/broken out.
    const moved = occurrences.find((item) => item.window.wid === ref.wid) ?? occurrences[0];
    warnings.push(
      `pane %${ref.pid} moved from $${ref.sid}/@${ref.wid} to $${moved.session.sid}/@${moved.window.wid}`,
    );
    if (new Set(occurrences.map((o) => o.session.sid)).size > 1) {
      warnings.push(`window @${moved.window.wid} is linked into several sessions`);
    }
    return {
      code: OK_RELOCATED,
      target: targetOf('pane', {
        sid: moved.session.sid,
        wid: moved.window.wid,
        pid: moved.pane.pid,
        session: moved.session,
        window: moved.window,
        pane: moved.pane,
      }),
      warnings,
      message: `pane %${ref.pid} is now in $${moved.session.sid}/@${moved.window.wid}`,
    };
  }

  throw new XcError(CODES.INVALID_ARGUMENT, `unknown reference kind '${ref.kind}'`, { kind: ref.kind });
}

/** Throw for every non-success outcome; return the fresh target otherwise. */
export function assertResolved(result) {
  if (!result || (result.code !== OK && result.code !== OK_RELOCATED)) {
    throw new XcError(result?.code ?? CODES.TARGET_GONE, result?.message ?? 'reference could not be resolved', {
      warnings: result?.warnings ?? [],
    });
  }
  return result.target;
}

/** Build a canonical ref for a live inventory object. */
export function refFromInventory(hostId, socketId, inv, kind, num) {
  if (!inv?.host) throw new XcError(CODES.INVALID_ARGUMENT, 'refFromInventory expects an inventory object');
  const base = {
    hostId,
    hostFp: inv.host.fp,
    socketId,
    gen: inv.server?.gen ?? '0-0',
    kind,
    sid: null,
    wid: null,
    pid: null,
  };
  const notFound = (what) => new XcError(CODES.NOT_FOUND, `${what} not found in the current inventory`);

  if (kind === 'host') return base;
  if (kind === 'server') {
    if (!inv.server) throw notFound('tmux server');
    return base;
  }
  if (!inv.server) throw notFound('tmux server');

  if (kind === 'session') {
    const session = sessionById(inv, num);
    if (!session) throw notFound(`session $${num}`);
    return { ...base, sid: session.sid };
  }
  if (kind === 'window') {
    const [first] = windowOccurrences(inv, num);
    if (!first) throw notFound(`window @${num}`);
    return { ...base, sid: first.session.sid, wid: num };
  }
  if (kind === 'pane') {
    const [first] = paneOccurrences(inv, num);
    if (!first) throw notFound(`pane %${num}`);
    return { ...base, sid: first.session.sid, wid: first.window.wid, pid: num };
  }
  throw new XcError(CODES.INVALID_ARGUMENT, `unknown reference kind '${kind}'`, { kind });
}

/** Display label, e.g. `NaMILab · train:0.1 %7`. */
export function labelFor(hostLabel, target) {
  if (!target) return sanitizeLabel(hostLabel ?? '');
  const host = hostLabel ? sanitizeLabel(hostLabel) : '';
  const name = target.session?.name ?? 'session';
  let body;
  switch (target.kind) {
    case 'host':
      return sanitizeLabel(host || 'host');
    case 'server':
      body = target.gen ? `server ${target.gen}` : 'server';
      break;
    case 'session':
      body = target.pid !== null && target.pid !== undefined
        ? `${name}:${target.window?.index ?? 0}.${target.pane?.index ?? 0} %${target.pid}`
        : `${name} $${target.sid}`;
      break;
    case 'window':
      body = `${name}:${target.window?.index ?? 0} @${target.wid}`;
      break;
    case 'pane':
    default:
      body = `${name}:${target.window?.index ?? 0}.${target.pane?.index ?? 0} %${target.pid}`;
      break;
  }
  return sanitizeLabel(host ? `${host} · ${body}` : body);
}
