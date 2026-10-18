// dsh-tmux-xc browser bundle (WP4).
//
// A DSH web client for cross-conversation remote tmux: a right-sidebar panel that
// lists hosts -> sockets -> sessions -> windows -> panes, lets the user insert a
// durable tmux reference chip into the composer, and re-renders those chips in the
// sent-message history. It talks to the host only through the owner-only HTTP routes
// declared in docs/review/ROUTES-v2.md (document-relative fetch, same-origin).
//
// This file is loaded by the DSH module loader:
//   window.__ModuleLoader__.load({ id: 'dsh-tmux-xc', factory: (require) => ({ inject, apply }) })
//
// No JSX (we use react/jsx-runtime), no build step, plain ESM-compatible browser code.
// Remote strings are always rendered as React text nodes; the token grammar from
// docs/CONTRACTS.md is re-implemented here rather than imported from host code.

window.__ModuleLoader__.load({
  id: 'dsh-tmux-xc',
  factory: (require) => {
    const react = require('react');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');

    // --------------------------------------------------------------------------
    // Constants
    // --------------------------------------------------------------------------

    const NS = 'tmux-xc';           // locale namespace
    const TAB_ID = 'tmux-xc';       // sidebar tab id and kind (same string)
    const SOURCE_NAME = 'tmux-xc';  // input-trigger source name
    const API_PREFIX = './api/tmux-xc';

    // --------------------------------------------------------------------------
    // Locale dictionaries (zh + en). Keys are shared; t(key, params) interpolates
    // "{n}" style placeholders.
    // --------------------------------------------------------------------------

    const en = {
      title: 'tmux',
      openPanel: 'Open tmux panel',
      refresh: 'Refresh',
      scopeWorkspace: 'Workspace',
      scopeAll: 'All',
      loading: 'Loading…',
      empty: 'No hosts configured or reachable.',
      loadFailed: 'Failed to load: {message}',
      unreachable: 'unreachable',
      hostError: 'host error',
      unknownCommand: 'unknown command',
      resolveFailed: 'Could not resolve: {message}',
      noServer: 'no tmux server',
      verifiedNow: 'verified now',
      verifiedMin: 'verified {n}m ago',
      verifiedHour: 'verified {n}h ago',
      verifiedDay: 'verified {n}d ago',
      attached: '{n} attached',
      dead: 'dead',
      adopted: 'adopted',
      created: 'created',
      stale: 'stale',
      live: 'live',
      reference: 'Reference',
      copyAttach: 'Copy attach',
      forget: 'Forget',
      confirmForget: 'Forget "{label}" from the registry? This only removes the local record; the remote tmux is never touched.',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      inserted: 'Reference added to composer',
      insertFailed: 'The composer changed or is busy; the reference was not inserted.',
      sessionGone: 'This chat session is no longer mounted.',
      adoptFailed: 'Could not reference: {message}',
      forgot: 'Forgotten',
      actionFailed: 'The server did not accept this action.',
      candidatesSection: 'Adopted tmux references',
      untrusted: 'untrusted remote value',
    };

    const zh = {
      title: 'tmux',
      openPanel: '打开 tmux 面板',
      refresh: '刷新',
      scopeWorkspace: '仅工作区',
      scopeAll: '全部',
      loading: '加载中…',
      empty: '没有配置或可达的主机。',
      loadFailed: '加载失败：{message}',
      unreachable: '不可达',
      hostError: '主机错误',
      unknownCommand: '未知命令',
      resolveFailed: '解析失败：{message}',
      noServer: '无 tmux 服务器',
      verifiedNow: '刚刚验证',
      verifiedMin: '{n} 分钟前验证',
      verifiedHour: '{n} 小时前验证',
      verifiedDay: '{n} 天前验证',
      attached: '{n} 个连接',
      dead: '已死',
      adopted: '已采纳',
      created: '已创建',
      stale: '过期',
      live: '存活',
      reference: '引用',
      copyAttach: '复制连接命令',
      forget: '忘记',
      confirmForget: '从注册表忘记“{label}”？这只会删除本地记录，绝不会影响远程 tmux。',
      copied: '已复制',
      copyFailed: '复制失败',
      inserted: '已添加到输入框',
      insertFailed: '输入框已变化或正忙，引用未插入。',
      sessionGone: '当前会话已卸载。',
      adoptFailed: '引用失败：{message}',
      forgot: '已忘记',
      actionFailed: '服务端未接受此操作。',
      candidatesSection: '已采纳的 tmux 引用',
      untrusted: '不受信任的远程值',
    };

    // --------------------------------------------------------------------------
    // Reference token grammar (re-implemented; do not import host code).
    //   token = @[<label>](dsh-tmux:v1/<hostId>/<hostFp>/<socketId>/<gen>/<kind>/<sid>/<wid>/<pid>)
    // --------------------------------------------------------------------------

    const TOKEN_SOURCE = new RegExp('@\\[([^\\[\\]()]*)\\]\\(([^()\\s]+)\\)', 'gu');

    function decodeUri(uri) {
      if (typeof uri !== 'string') return null;
      const m = /^dsh-tmux:v1\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/(host|server|session|window|pane)\/([^/]*)\/([^/]*)\/([^/]*)$/.exec(uri);
      if (!m) return null;
      const num = (s) => {
        if (s === '' || s === '-') return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };
      return {
        v: 1,
        hostId: m[1],
        hostFp: m[2],
        socketId: m[3],
        gen: m[4],
        kind: m[5],
        sid: num(m[6]),
        wid: num(m[7]),
        pid: num(m[8]),
      };
    }

    // Extract the bare uri from either a token ("@[label](uri)") or a raw uri.
    function uriOf(ref) {
      if (typeof ref !== 'string') return null;
      const m = /@\[[^\[\]()]*\]\(([^()\s]+)\)/.exec(ref);
      return m ? m[1] : ref;
    }

    function tmuxTarget(kind, num) {
      if (num === null || num === undefined) return null;
      if (kind === 'session') return '$' + num;
      if (kind === 'window') return '@' + num;
      if (kind === 'pane') return '%' + num;
      return null;
    }

    // Find the first valid token at or after `from` in user text. Invalid decodes
    // are skipped so hostile text cannot crash the matcher.
    function tokenAt(text, from) {
      const re = new RegExp(TOKEN_SOURCE.source, 'gu');
      re.lastIndex = from;
      let m;
      while ((m = re.exec(text)) !== null) {
        const ref = decodeUri(m[2]);
        if (ref) return { start: m.index, end: m.index + m[0].length, label: m[1], uri: m[2], ref };
      }
      return undefined;
    }

    // Client-side label sanitation (light defense in depth; the host already
    // sanitizes inventory labels, but never trust a remote value).
    function cleanLabel(label, max = 120) {
      let s = String(label ?? '');
      s = s
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ') // C0/C1 except \t \n
        .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B-\u200D\uFEFF]/g, '') // bidi / zero-width
        .replace(/\s+/g, ' ')
        .trim();
      // The canonical host label limit counts Unicode code points, not UTF-16
      // units; keep emoji/non-BMP labels intact and identical in both chips.
      const points = Array.from(s);
      if (points.length > max) s = points.slice(0, max).join('');
      return s;
    }

    function tokenSafeLabel(label, max = 80) {
      return cleanLabel(label, max).replace(/[\[\]()]/g, '').replace(/`/g, '').trim();
    }

    // Never rebuild server tokens or derive chip labels from inventory row titles.
    function canonicalToken(token, uri) {
      if (typeof token !== 'string') return null;
      const found = tokenAt(token, 0);
      if (!found || found.start !== 0 || found.end !== token.length) return null;
      if (uri !== undefined && found.uri !== uri) return null;
      return found;
    }

    function chipLabel(label) {
      return tokenSafeLabel(label) || 'tmux';
    }

    // Both route envelopes and inventory host errors use {code, message}.
    // Never stringify an object: that hides the actual reason as [object Object].
    function errorText(value, fallback) {
      const detail = value && typeof value === 'object' && value.error != null ? value.error : value;
      const code = typeof detail?.code === 'string' ? cleanLabel(detail.code, 80) : '';
      const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : '';
      const text = cleanLabel(message, 240) || fallback;
      return code ? code + ': ' + text : text;
    }

    function idString(ref) {
      if (!ref) return '';
      if (ref.kind === 'host') return ref.hostId;
      if (ref.kind === 'server') return ref.hostId + ':' + ref.socketId;
      const t = tmuxTarget(ref.kind, ref.kind === 'session' ? ref.sid : ref.kind === 'window' ? ref.wid : ref.pid);
      return ref.hostId + ':' + ref.socketId + ':' + t;
    }

    // --------------------------------------------------------------------------
    // HTTP transport (document-relative, same-origin credentials).
    // --------------------------------------------------------------------------

    function apiUrl(path) {
      return new URL(API_PREFIX + path, document.baseURI);
    }

    async function api(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(apiUrl(path), {
        method,
        credentials: 'same-origin',
        signal,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { /* non-JSON body */ }
      }
      if (!response.ok || data?.ok === false) {
        const detail = data?.error ?? data;
        const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : response.statusText || ('HTTP ' + response.status);
        const err = new Error(message);
        err.status = response.status;
        err.code = typeof detail?.code === 'string' ? detail.code : undefined;
        throw err;
      }
      return data;
    }

    // Copy text to the clipboard with a textarea fallback for non-secure contexts.
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      }
    }

    // --------------------------------------------------------------------------
    // Inventory / hosts normalization
    // --------------------------------------------------------------------------

    function normalizeHosts(payload) {
      const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.hosts) ? payload.hosts : []);
      const map = Object.create(null);
      for (const h of list) {
        if (!h || typeof h !== 'object') continue;
        map[h.id] = h;
      }
      return map;
    }

    function posixQuote(value) {
      return "'" + String(value).replace(/'/g, "'\\''") + "'";
    }

    function attachCommand(hostMeta, socketMeta, node) {
      // Missing metadata must not silently select the default socket/transport.
      if (!hostMeta || !socketMeta) return null;
      const validId = (id) => Number.isSafeInteger(id) && id >= 0;
      if (!validId(node.sid)) return null;
      const parts = ['tmux'];
      if (socketMeta.path) parts.push('-S', posixQuote(socketMeta.path));
      else if (socketMeta.name) parts.push('-L', posixQuote(socketMeta.name));
      parts.push('attach', '-t', posixQuote('$' + node.sid));
      if (node.kind === 'window' || node.kind === 'pane') {
        if (!validId(node.wid)) return null;
        parts.push('\\;', 'select-window', '-t', posixQuote('@' + node.wid));
      }
      if (node.kind === 'pane') {
        if (!validId(node.pid)) return null;
        parts.push('\\;', 'select-pane', '-t', posixQuote('%' + node.pid));
      }
      const command = parts.join(' ');
      if (hostMeta.transport === 'local') return command;
      if (hostMeta.transport !== 'ssh' || typeof hostMeta.ssh !== 'string' || !hostMeta.ssh || hostMeta.ssh.startsWith('-')) return null;
      // ssh joins its command argv and invokes a second POSIX shell. Quote the
      // entire remote command locally, preserving $sid and tmux's escaped ';'.
      // attach + select-window + select-pane works on tmux 3.0a (no newer flags).
      return 'ssh -t ' + posixQuote(hostMeta.ssh) + ' ' + posixQuote(command);
    }

    function paneSecondaryTitle(pane, host, hostMeta) {
      const title = cleanLabel(pane.title);
      if (!title || title === cleanLabel(pane.cmd)) return null;
      const normalized = title.toLowerCase();
      const defaults = [host.id, host.label, hostMeta?.ssh];
      if (defaults.some((value) => typeof value === 'string' && cleanLabel(value).toLowerCase() === normalized)) return null;
      // tmux initializes titles to a hostname. Without a hostname field in the
      // route contract, suppress DNS-name-shaped defaults, including short names.
      if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i.test(title)) return null;
      return title;
    }

    function agoText(t, ts, now) {
      if (!ts) return null;
      const s = Math.max(0, Math.floor((now - ts) / 1000));
      if (s < 60) return t('verifiedNow');
      if (s < 3600) return t('verifiedMin', { n: String(Math.floor(s / 60)) });
      if (s < 86400) return t('verifiedHour', { n: String(Math.floor(s / 3600)) });
      return t('verifiedDay', { n: String(Math.floor(s / 86400)) });
    }

    function stateBadge(t, node) {
      if (node.state === 'unreachable') return t('unreachable');
      if (node.state === 'stale') return t('stale');
      if (node.origin === 'created') return t('created');
      if (node.adopted || node.origin === 'adopted') return t('adopted');
      return null;
    }

    // --------------------------------------------------------------------------
    // Icons (small inline SVGs)
    // --------------------------------------------------------------------------

    function terminalIcon(size) {
      return jsx('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
        children: jsxs(Fragment, { children: [
          jsx('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          jsx('path', { d: 'M4.5 6l2 2-2 2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          jsx('path', { d: 'M8 10h3.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ] }),
      });
    }

    // --------------------------------------------------------------------------
    // Shared tiny presentational components
    // --------------------------------------------------------------------------

    function Badge({ text, kind }) {
      return jsx('span', { className: 'xc-badge', 'data-kind': kind || 'plain', children: text });
    }

    function MetaLine({ text }) {
      if (!text) return null;
      return jsx('span', { className: 'xc-meta', title: text, children: text });
    }

    function ActionBtn({ label, onClick, disabled, title }) {
      return jsx('button', {
        type: 'button', className: 'xc-action', disabled: !!disabled, title: title || label,
        onClick: (event) => { event.stopPropagation(); onClick(); },
        children: label,
      });
    }

    function Caret({ expanded, onToggle, label }) {
      return jsx('button', {
        type: 'button', className: 'xc-caret', 'aria-label': label, 'aria-expanded': !!expanded,
        onClick: (event) => { event.stopPropagation(); onToggle(); },
        children: expanded ? '▾' : '▸',
      });
    }

    // --------------------------------------------------------------------------
    // Sent-message chip (slot "conversation.user.text.node", key "tmux-xc")
    // --------------------------------------------------------------------------

    function chipTitle(t, raw, ref, status) {
      const lines = [raw];
      if (ref) lines.push(ref.kind + ' ' + idString(ref));
      if (status?.error) {
        lines.push(t('resolveFailed', { message: errorText(status.error, t('actionFailed')) }));
      } else if (status) {
        if (typeof status.code === 'string') lines.push(cleanLabel(status.code));
        for (const warning of (Array.isArray(status.warnings) ? status.warnings : [])) {
          lines.push(errorText(warning, t('actionFailed')));
        }
      }
      return lines.filter(Boolean).join('\n');
    }

    function TmuxXcChip(props) {
      const { node, raw, interactive, t } = props;
      const data = node && node.data ? node.data : { label: '', uri: '' };
      const label = chipLabel(data.label);
      const uri = typeof data.uri === 'string' ? data.uri : '';
      const ref = decodeUri(uri);
      const [status, setStatus] = react.useState(null);

      react.useEffect(() => {
        if (!uri) return undefined;
        let alive = true;
        const controller = new AbortController();
        setStatus(null);
        api('/resolve?uri=' + encodeURIComponent(uri), { signal: controller.signal })
          .then((r) => { if (alive) setStatus(r); })
          .catch((err) => { if (alive && !controller.signal.aborted) setStatus({ error: err }); });
        return () => { alive = false; controller.abort(); };
      }, [uri]);

      const open = interactive && props.openPanel ? props.openPanel : null;
      const chipProps = {
        className: 'xc-refchip',
        title: chipTitle(t, raw, ref, status),
        children: jsxs(Fragment, { children: [
          terminalIcon(12),
          jsx('span', { className: 'xc-refchipLabel', children: label }),
        ] }),
      };
      if (open) {
        chipProps.role = 'button';
        chipProps.tabIndex = 0;
        chipProps.onClick = open;
        chipProps.onKeyDown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        };
      }
      return jsx('span', chipProps);
    }

    // --------------------------------------------------------------------------
    // Sidebar tab title (slot "sidebar.right.pane.tab.title")
    // --------------------------------------------------------------------------

    function TmuxXcTitle(props) {
      return jsx('span', { className: 'xc-title', children: props.t('title') });
    }

    // --------------------------------------------------------------------------
    // Sidebar panel (slot "sidebar.right.pane.tab")
    // --------------------------------------------------------------------------

    function TmuxXcPanel(props) {
      const { sessionId, t } = props;

      const [scope, setScope] = react.useState('workspace'); // 'workspace' | 'all'
      const [data, setData] = react.useState(null);
      const [hostsMeta, setHostsMeta] = react.useState(Object.create(null));
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [expanded, setExpanded] = react.useState(null); // null => defaults (hosts+sockets)
      const [notice, setNotice] = react.useState(null);
      const [now, setNow] = react.useState(() => Date.now());
      const panelContext = react.useRef(null);

      // A request belongs to this mounted panel/session generation, not whichever
      // chat happens to be selected when its response arrives.
      react.useLayoutEffect(() => {
        const context = { sessionId, inputActions: props.inputActions };
        panelContext.current = context;
        return () => { if (panelContext.current === context) panelContext.current = null; };
      }, [sessionId, props.inputActions]);

      const refresh = react.useCallback(async () => {
        setLoading(true);
        setError(null);
        const query = scope === 'all' ? '?all=1' : '';
        try {
          const [inventory, hosts] = await Promise.all([
            api('/inventory' + query),
            api('/hosts'),
          ]);
          setData(inventory);
          setHostsMeta(normalizeHosts(hosts));
        } catch (err) {
          setError(err);
        } finally {
          setLoading(false);
        }
      }, [scope]);

      // Re-load when scope changes or the session changes.
      react.useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refresh, sessionId]);

      // Keep "verified Xs ago" labels fresh.
      react.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
      }, []);

      // Transient action notice.
      react.useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 6000);
        return () => clearTimeout(timer);
      }, [notice]);

      const flash = (text) => setNotice(text);

      const hostsOf = (d) => (d && (Array.isArray(d) ? d : d.hosts)) || [];

      const setPanelExpanded = (key, value) => {
        setExpanded((prev) => {
          const defaults = prev === null;
          const next = new Set();
          if (defaults) {
            for (const h of hostsOf(data)) {
              next.add('h:' + h.id);
              for (const s of (h.sockets || [])) next.add('h:' + h.id + ':s:' + s.id);
            }
          } else {
            for (const k of prev) next.add(k);
          }
          if (value) next.add(key); else next.delete(key);
          return next;
        });
      };

      const isExpanded = (node) => {
        if (expanded === null) return node.kind === 'host' || node.kind === 'socket';
        return expanded.has(node.key);
      };

      // --- Reference / Copy / Forget actions (closure over ctx) ---

      async function onReference(node) {
        const context = panelContext.current;
        let binding;
        let input;
        try {
          binding = props.sessions.binding(sessionId);
          if (!binding || !context || context.sessionId !== sessionId) throw new Error(t('sessionGone'));
          input = props.conversation.input.for(binding.ctx);
          if (typeof context.inputActions?.captureInsertion !== 'function') throw new Error(t('insertFailed'));
          // Capture detect coordinates BEFORE the asynchronous call. Clipboard
          // draft.length expands existing chips and is never a valid substitute.
          const span = context.inputActions.captureInsertion();
          const before = input.state.getSnapshot();
          if (!span || span.draftRev !== before.draftRev || !['plain', 'claimed'].includes(before.phase)) throw new Error(t('insertFailed'));
          if (!decodeUri(node.uri)) throw new Error(t('actionFailed'));
          const response = await api('/adopt', {
            method: 'POST',
            body: { target: node.uri, sessionId },
          });
          const entry = response?.entry;
          const parsed = canonicalToken(entry?.token, node.uri);
          if (!parsed || entry.uri !== node.uri) throw new Error(t('actionFailed'));

          // Do not reacquire another input after the await, even for a remounted
          // session with the same id. The original span remains revision-CAS'd.
          if (panelContext.current !== context || props.sessions.binding(sessionId)?.ctx !== binding.ctx) throw new Error(t('sessionGone'));
          const after = input.state.getSnapshot();
          if (after.draftRev !== span.draftRev || !['plain', 'claimed'].includes(after.phase)) throw new Error(t('insertFailed'));
          const ok = input.insertReference({
            source: SOURCE_NAME,
            ref: entry.token,
            label: chipLabel(parsed.label),
            clipboardText: entry.token,
          }, span);
          if (!ok) throw new Error(t('insertFailed'));
          input.focus();
          flash(t('inserted'));
        } catch (err) {
          const message = t('adoptFailed', { message: errorText(err, t('actionFailed')) });
          if (panelContext.current === context) flash(message);
          // If the panel switched while waiting, report only to the original
          // retained chat; never resolve a different chat's composer as fallback.
          if (input && props.sessions.binding(sessionId)?.ctx === binding?.ctx) input.notify('error', message);
          if (err?.status === 409) await refresh();
        }
      }

      async function onCopy(node) {
        const hostMeta = hostsMeta[node.hostId];
        const socketMeta = hostMeta && (hostMeta.sockets || []).find((s) => s && s.id === node.socketId);
        const cmd = attachCommand(hostMeta, socketMeta, node);
        if (!cmd) { flash(t('copyFailed')); return; }
        const ok = await copyText(cmd);
        flash(ok ? t('copied') : t('copyFailed'));
      }

      async function onForget(node) {
        const label = cleanLabel(node.label, 120);
        if (!window.confirm(t('confirmForget', { label }))) return;
        try {
          await api('/forget', {
            method: 'POST',
            body: node.registryKey ? { key: node.registryKey } : { uri: node.uri },
          });
          flash(t('forgot'));
          refresh();
        } catch (err) {
          flash(t('actionFailed') + ': ' + errorText(err, t('actionFailed')));
        }
      }

      // --- Node rendering helpers ---

      function badgesFor(node, verifiedAt) {
        const items = [];
        const state = stateBadge(t, node);
        if (state) items.push(jsx(Badge, { text: state, kind: node.state || 'plain' }, node.key + ':state'));
        const ago = agoText(t, verifiedAt, now);
        if (ago) items.push(jsx(MetaLine, { text: ago }, node.key + ':ago'));
        return items;
      }

      function resourceNode(kind, host, socket, session, window, pane) {
        const hostLabel = cleanLabel(host.label || host.id);
        const sessionName = cleanLabel(session.name);
        const windowName = cleanLabel(window.name);
        const windowIndex = window.index;
        const sid = session.sid;
        const wid = window.wid;
        const pid = pane.pid;
        const own = kind === 'session' ? session : kind === 'window' ? window : pane;
        const base = {
          hostId: host.id,
          socketId: socket.id,
          hostLabel,
          sid, wid, pid,
          uri: own.uri,
          token: own.token,
          registryKey: own.key,
          adopted: own.adopted,
          origin: own.origin,
          state: own.state,
          lastVerifiedAt: own.lastVerifiedAt || host.verifiedAt,
        };
        if (kind === 'session') {
          return {
            key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid,
            kind, ...base,
            label: sessionName,
            idText: '$' + sid,
            meta: [session.attached ? t('attached', { n: String(session.attached) }) : null].filter(Boolean),
          };
        }
        if (kind === 'window') {
          return {
            key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid + ':W:' + wid,
            kind, ...base,
            label: (windowIndex !== undefined ? windowIndex + ':' : '') + (windowName || ''),
            idText: '@' + wid,
            meta: [],
          };
        }
        // pane
        return {
          key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid + ':W:' + wid + ':P:' + pid,
          kind, ...base, pid,
          label: '%' + pid + ' ' + (cleanLabel(pane.cmd) || t('unknownCommand')),
          meta: [
            paneSecondaryTitle(pane, host, hostsMeta[host.id]),
            pane.cwd ? cleanLabel(pane.cwd) : null,
            pane.dead ? t('dead') : null,
          ].filter(Boolean),
          dead: !!pane.dead,
        };
      }

      function renderActions(node) {
        if (node.kind !== 'session' && node.kind !== 'window' && node.kind !== 'pane') return null;
        const adopted = !!(node.adopted || node.origin);
        return jsxs('span', { className: 'xc-actions', children: [
          jsx(ActionBtn, { label: t('reference'), title: t('reference'), onClick: () => onReference(node) }, node.key + ':ref'),
          jsx(ActionBtn, { label: t('copyAttach'), title: t('copyAttach'), onClick: () => onCopy(node) }, node.key + ':copy'),
          adopted ? jsx(ActionBtn, { label: t('forget'), title: t('forget'), onClick: () => onForget(node) }, node.key + ':forget') : null,
        ] });
      }

      function renderNodeRow(node, verifiedAt, children) {
        const caret = node.kind === 'host' || node.kind === 'socket' || node.kind === 'session';
        const open = caret ? isExpanded(node) : false;
        return jsxs('div', { className: 'xc-node', 'data-kind': node.kind, children: [
          jsxs('div', { className: 'xc-nodeRow', children: [
            caret ? jsx(Caret, {
              expanded: open,
              label: t('title'),
              onToggle: () => setPanelExpanded(node.key, !open),
            }, node.key + ':caret') : jsx('span', { className: 'xc-caretSpacer' }),
            node.kind === 'pane' ? terminalIcon(12) : null,
            jsx('span', { className: 'xc-label', title: node.label, children: node.label }),
            node.idText ? jsx('span', { className: 'xc-ids', children: node.idText }, node.key + ':id') : null,
            badgesFor(node, verifiedAt),
          ] }),
          node.meta && node.meta.length ? jsx('div', { className: 'xc-metaRow', children: node.meta.map((m, i) => jsx(MetaLine, { text: m }, node.key + ':m' + i)) }) : null,
          renderActions(node),
          children,
        ] });
      }

      function renderPane(host, socket, session, window, pane) {
        const node = resourceNode('pane', host, socket, session, window, pane);
        return renderNodeRow(node, node.lastVerifiedAt, null);
      }

      function renderWindow(host, socket, session, window) {
        const node = resourceNode('window', host, socket, session, window, {});
        return renderNodeRow(node, node.lastVerifiedAt, jsx('div', { className: 'xc-children', children: (window.panes || []).map((pane) => renderPane(host, socket, session, window, pane)) }));
      }

      function renderSession(host, socket, session) {
        const node = resourceNode('session', host, socket, session, {}, {});
        const open = isExpanded(node);
        const children = open
          ? jsx('div', { className: 'xc-children', children: (session.windows || []).map((window) => renderWindow(host, socket, session, window)) })
          : null;
        return renderNodeRow(node, node.lastVerifiedAt, children);
      }

      function renderSocket(host, socket) {
        const server = socket.server || null;
        const key = 'h:' + host.id + ':s:' + socket.id;
        const open = isExpanded({ kind: 'socket', key });
        const children = open
          ? jsx('div', { className: 'xc-children', children: [
              server ? null : jsx('div', { className: 'xc-empty', children: t('noServer') }),
              ...(socket.sessions || []).map((session) => renderSession(host, socket, session)),
            ] })
          : null;
        return renderNodeRow({
          key,
          kind: 'socket',
          label: server && server.socketPath ? cleanLabel(server.socketPath) : cleanLabel(socket.id),
          idText: socket.id,
          meta: server && server.gen ? [cleanLabel(server.gen)] : [],
        }, host.verifiedAt, children);
      }

      function renderHost(host) {
        const key = 'h:' + host.id;
        const unreachable = host.status === 'unreachable' || host.reachable === false;
        const failed = host.status === 'error';
        const open = isExpanded({ kind: 'host', key });
        const children = open
          ? jsx('div', { className: 'xc-children', children: (host.sockets || []).map((socket) => renderSocket(host, socket)) })
          : null;
        const hostBadges = [jsx(MetaLine, { text: agoText(t, host.verifiedAt, now) }, key + ':ago')];
        if (unreachable || failed) hostBadges.unshift(jsx(Badge, {
          text: t(unreachable ? 'unreachable' : 'hostError'), kind: 'unreachable',
        }, key + ':status'));
        return jsxs('div', { className: 'xc-node', 'data-kind': 'host', children: [
          jsxs('div', { className: 'xc-nodeRow', children: [
            jsx(Caret, { expanded: open, label: t('title'), onToggle: () => setPanelExpanded(key, !open) }, key + ':caret'),
            jsx('span', { className: 'xc-label', children: cleanLabel(host.label || host.id) }),
            jsx('span', { className: 'xc-ids', children: host.id }, key + ':id'),
            ...hostBadges,
          ] }),
          host.error ? jsx('div', { className: 'xc-err', children: errorText(host.error, t('actionFailed')) }) : null,
          children,
        ] });
      }

      // --- Panel body ---

      const hosts = hostsOf(data);

      return jsxs('div', { className: 'xc-root', children: [
        jsxs('div', { className: 'xc-header', children: [
          jsx('span', { className: 'xc-headerTitle', children: t('title') }),
          jsxs('div', { className: 'xc-seg', role: 'group', 'aria-label': t('scopeWorkspace') + ' / ' + t('scopeAll'), children: [
            jsx('button', { type: 'button', className: 'xc-segItem', 'aria-pressed': scope === 'workspace', onClick: () => setScope('workspace'), children: t('scopeWorkspace') }),
            jsx('button', { type: 'button', className: 'xc-segItem', 'aria-pressed': scope === 'all', onClick: () => setScope('all'), children: t('scopeAll') }),
          ] }),
          jsx('button', { type: 'button', className: 'xc-action', disabled: loading, onClick: () => refresh(), children: t('refresh') }),
        ] }),
        notice ? jsx('div', { className: 'xc-notice', children: notice }) : null,
        loading ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
        error ? jsx('div', { className: 'xc-err', children: t('loadFailed', { message: errorText(error, t('actionFailed')) }) }) : null,
        !loading && !error && hosts.length === 0 ? jsx('div', { className: 'xc-empty', children: t('empty') }) : null,
        jsx('div', { className: 'xc-tree', children: hosts.map((host) => renderHost(host)) }),
      ] });
    }

    // --------------------------------------------------------------------------
    // Input-trigger source ("@tmux-xc") and codec
    // --------------------------------------------------------------------------

    function buildSource(ctx, t) {
      const source = {
        trigger: '@',
        name: SOURCE_NAME,
        order: 60,
        showGroupTitle: false,
        async candidates(session, req) {
          // Optional: adopted panes as @-mentions. Degrades to [] on any failure.
          try {
            if (req.signal.aborted) return [];
            const inventory = await api('/inventory?all=1', { signal: req.signal });
            const hosts = (inventory && (Array.isArray(inventory) ? inventory : inventory.hosts)) || [];
            const out = [];
            const pushNode = (node, hostLabel) => {
              if (!node?.uri || !(node.adopted || node.origin)) return;
              const parsed = canonicalToken(node.token, node.uri);
              if (!parsed) return;
              const label = chipLabel(parsed.label);
              out.push({
                name: label,
                label,
                description: cleanLabel(hostLabel, 120),
                section: t('candidatesSection'),
                value: JSON.stringify({ token: node.token }),
              });
            };
            for (const host of hosts) {
              for (const socket of (host.sockets || [])) {
                for (const session of (socket.sessions || [])) {
                  pushNode(session, host.label);
                  for (const window of (session.windows || [])) {
                    pushNode(window, host.label);
                    for (const pane of (window.panes || [])) {
                      pushNode(pane, host.label);
                    }
                  }
                }
              }
            }
            return out;
          } catch {
            return [];
          }
        },
        onPick(pick) {
          let parsed = null;
          try { parsed = JSON.parse(pick.candidate.value); } catch { /* fall through */ }
          const token = canonicalToken(parsed?.token);
          if (!token) return undefined;
          return {
            insert: {
              source: SOURCE_NAME,
              ref: parsed.token,
              label: chipLabel(token.label),
              clipboardText: parsed.token,
            },
          };
        },
        openReference(session, reference) {
          const decoded = reference && decodeUri(uriOf(reference.ref));
          if (!decoded) return false;
          try {
            ctx.sidebarRight.openTabIn(session.sessionId, TAB_ID);
            return true;
          } catch {
            return false;
          }
        },
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      };
      return source;
    }

    // --------------------------------------------------------------------------
    // apply(ctx) — Cordis entry point
    // --------------------------------------------------------------------------

    const inject = [
      'locale',
      'slots',
      'sessions',
      'conversation',
      'uiConversation',
      'inputTriggers',
      'sidebarRight',
      'sidebarRightTabs',
    ];

    const CSS = `
.xc-root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;overflow:auto;padding:8px 8px 16px;gap:8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px}
.xc-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.xc-headerTitle{font-weight:600}
.xc-seg{display:inline-flex;gap:2px;padding:1px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l3)}
.xc-segItem{font:inherit;font-size:11px;line-height:16px;padding:1px 8px;border:0;border-radius:calc(var(--dsw-radius-md,6px) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.xc-segItem[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.xc-action{font:inherit;font-size:11px;line-height:16px;padding:1px 8px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}
.xc-action:disabled{opacity:.5;cursor:default}
.xc-notice{color:var(--dsw-alias-state-business-primary);font-size:11px}
.xc-err{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-warn-primary));font-size:11px;overflow-wrap:anywhere}
.xc-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:4px 0}
.xc-tree{display:flex;flex-direction:column;gap:1px}
.xc-node{display:flex;flex-direction:column;border-radius:var(--dsw-radius-sm,4px);padding:2px 4px}
.xc-node:hover{background:var(--dsw-alias-bg-layer-2)}
.xc-nodeRow{display:flex;align-items:center;gap:4px;min-width:0}
.xc-caret,.xc-caretSpacer{flex:none;width:14px;text-align:center}
.xc-caret{font:inherit;font-size:10px;line-height:16px;padding:0;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.xc-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.xc-ids{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.xc-meta{color:var(--dsw-alias-label-tertiary);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.xc-metaRow{display:flex;gap:8px;padding-left:18px;min-width:0}
.xc-badge{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs,3px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
.xc-badge[data-kind=stale]{color:var(--dsw-alias-state-warn-primary)}
.xc-badge[data-kind=unreachable]{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-warn-primary))}
.xc-actions{display:flex;gap:4px;padding-left:18px;flex-wrap:wrap}
.xc-actions .xc-action{font-size:10.5px;padding:0 6px}
.xc-children{display:flex;flex-direction:column;padding-left:14px;border-left:.5px solid var(--dsw-alias-border-l2);margin-left:6px}
.xc-opener{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-md,6px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.xc-opener:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.xc-title{font-size:12px}
.xc-refchip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;height:20px;margin:0 1px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);vertical-align:baseline;cursor:default;max-width:100%}
.xc-refchip[role=button]{cursor:pointer}
.xc-refchip[role=button]:hover{background:var(--dsw-alias-bg-layer-3)}
.xc-refchipLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
`;

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tmux-xc: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-tmux-xc: styles');

      // Right-sidebar tab type.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        keepMounted: true,
        priority: 'extension',
        title: () => t('title'),
      }), 'dsh-tmux-xc: tab');

      // Tab body, keyed by the tab id. The injected sessionId is this mounted
      // panel's session; selection/expansion state lives in that component.
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        inject: (sessionId) => ({
          sessionId,
          sessions: ctx.sessions,
          conversation: ctx.conversation,
        }),
      }, TmuxXcPanel)), 'dsh-tmux-xc: panel');

      // Tab title.
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        locale: NS,
        inject: () => ({}),
      }, TmuxXcTitle)), 'dsh-tmux-xc: panel title');

      // Composer opener button. Registered as a closure so it can reach ctx
      // directly; the "conversation.input.right" list slot supplies `sessionId`
      // (session scope) and `t` (locale), with no inject contract to rely on.
      ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'dsh-tmux-xc-opener',
        order: 40,
        locale: NS,
      }, function TmuxXcOpener(props) {
        if (!props.sessionId) return null;
        return jsx('button', {
          type: 'button',
          className: 'xc-opener',
          title: props.t('openPanel'),
          'aria-label': props.t('openPanel'),
          onClick: () => { ctx.sidebarRight.openTabIn(props.sessionId, TAB_ID); },
          children: terminalIcon(14),
        });
      })), 'dsh-tmux-xc: opener');

      // Input-trigger source.
      ctx.effect(() => ctx.inputTriggers.registerSource(buildSource(ctx, t)), 'dsh-tmux-xc: @ source');

      // Sent-message token rule + keyed chip renderer.
      ctx.effect(() => ctx.uiConversation.userText.register({
        id: 'tmux-xc',
        order: 40,
        match(text, from) {
          const found = tokenAt(text, from);
          if (!found) return undefined;
          const label = chipLabel(found.label);
          return { id: 'tmux-xc', start: found.start, end: found.end, data: { label, uri: found.uri } };
        },
      }), 'dsh-tmux-xc: user-text rule');

      ctx.effect(() => ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
        name: 'conversation.user.text.node',
        key: 'tmux-xc',
        priority: 100,
        locale: NS,
        inject: (sessionId) => ({ openPanel: () => ctx.sidebarRight.openTabIn(sessionId, TAB_ID) }),
      }, TmuxXcChip)), 'dsh-tmux-xc: chip renderer');
    }

    return { name: 'dsh-tmux-xc', inject, apply };
  },
});
