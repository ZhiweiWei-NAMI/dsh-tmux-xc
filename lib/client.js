// dsh-tmux-xc browser bundle (WP4), v0.1.1.
//
// A DSH web client for cross-conversation remote tmux: a right-sidebar panel that
// lists hosts -> tasks (sessions) -> panes, lets the user insert a durable tmux
// reference chip into the composer, and re-renders those chips in the sent-message
// history. It talks to the host only through the owner-only HTTP routes declared
// in docs/review/ROUTES-v2.md (document-relative fetch, same-origin).
//
// This file is loaded by the DSH module loader as a classic script:
//   window.__ModuleLoader__.load({ id: 'dsh-tmux-xc', factory: (require) => ({ inject, apply }) })
//
// No JSX (we use react/jsx-runtime), no build step, plain browser code. Remote
// strings are always rendered as React text nodes; the token grammar from
// docs/CONTRACTS.md is re-implemented here rather than imported from host code.
//
// The pure attach-command builders are defined at top level (no browser APIs) so
// they can be unit-tested: when this file is evaluated outside a browser it
// publishes them on globalThis.__dshTmuxXcPure (see test/unit/client-pure.test.js).

// --------------------------------------------------------------------------
// Pure attach-command builders (no React, no browser APIs).
// --------------------------------------------------------------------------

function posixQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// PowerShell single-quoting: wrap in ' and double every embedded '.
function powerShellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// The remote-side tmux command (POSIX sh). Keeps the exact socket (-S path |
// -L name), exact $sid, and per-kind @wid / %pid targeting. Returns null for
// invalid ids so a copy can never select the default socket/transport silently.
function buildRemoteAttachCommand(node, socketMeta) {
  if (!node || !socketMeta) return null;
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
  return parts.join(' ');
}

// Bash / Linux / macOS / Git Bash form:
//   ssh -t -o ClearAllForwardings=yes <posixQuote(alias)> <posixQuote(remoteCommand)>
function attachCommandPosix(node, hostMeta, socketMeta) {
  if (!hostMeta || !socketMeta) return null;
  const command = buildRemoteAttachCommand(node, socketMeta);
  if (!command) return null;
  if (hostMeta.transport === 'local') return command;
  if (hostMeta.transport !== 'ssh' || typeof hostMeta.ssh !== 'string' || !hostMeta.ssh || hostMeta.ssh.startsWith('-')) return null;
  return 'ssh -t -o ClearAllForwardings=yes ' + posixQuote(hostMeta.ssh) + ' ' + posixQuote(command);
}

// Windows PowerShell form. cmd.exe is NOT supported (its % / quoting rules differ
// from POSIX and PowerShell); the remote command from buildRemoteAttachCommand
// never contains '"', and $ % @ ; are literal inside PowerShell single quotes.
function attachCommandPowerShell(node, hostMeta, socketMeta) {
  if (!hostMeta || !socketMeta) return null;
  const command = buildRemoteAttachCommand(node, socketMeta);
  if (!command) return null;
  if (hostMeta.transport !== 'ssh' || typeof hostMeta.ssh !== 'string' || !hostMeta.ssh || hostMeta.ssh.startsWith('-')) return null;
  return 'ssh -t -o ClearAllForwardings=yes ' + powerShellQuote(hostMeta.ssh) + ' ' + powerShellQuote(command);
}

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
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

    const LS_ADVANCED = 'dsh-tmux-xc:advanced';
    const LS_FILTER = 'dsh-tmux-xc:filter';
    const LS_FONT = 'dsh-tmux-xc:fontSize';

    const FONT_MIN = 10;
    const FONT_MAX = 18;
    const FONT_DEFAULT = 12;
    const REFRESH_MS = 30000;

    function readStorage(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    }
    function writeStorage(key, value) {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    }

    // --------------------------------------------------------------------------
    // Locale dictionaries (zh + en). Keys are shared; t(key, params) interpolates
    // "{n}" style placeholders.
    // --------------------------------------------------------------------------

    const en = {
      title: 'tmux',
      openPanel: 'Open tmux panel',
      refresh: 'Refresh',
      lastRefresh: 'Last refresh {time}',
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
      insertFailed: 'The composer changed or is busy; the reference was not inserted.',
      sessionGone: 'This chat session is no longer mounted.',
      adoptFailed: 'Could not reference: {message}',
      actionFailed: 'The server did not accept this action.',
      candidatesSection: 'Adopted tmux references',
      untrusted: 'untrusted remote value',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      filterAll: 'All',
      filterRegistered: 'Registered',
      advanced: 'Advanced details',
      refSession: 'Reference session',
      refWindow: 'Reference window',
      refPane: 'Reference pane',
      alias: 'Alias',
      aliasTooltip: 'Only shown in this plugin; never renames the remote tmux session.',
      aliasPlaceholder: 'Alias (empty clears)',
      aliasSaved: 'Alias saved',
      unregister: 'Unregister',
      unregisterTooltip: "Removes only this plugin's record; the remote tmux session and its processes keep running.",
      unregisterConfirm: 'Unregister "{label}"? Removes only this plugin\'s record; the remote tmux session and its processes keep running.',
      unregistered: 'Unregistered',
      registeredNotice: 'Registered: {label} (visible in "Registered")',
      approval: 'Approval',
      approvalAsk: 'Ask each time',
      approvalAllow: 'Allow',
      approvalCreate: 'Create',
      approvalSend: 'Send',
      approvalDetach: 'Detach',
      approvalKill: 'Kill',
      approvalKillFixed: 'Always ask and require exact confirmation (not changeable)',
      approvalSourcePanel: 'panel setting',
      approvalSourceConfig: 'config file',
      approvalSourceDefault: 'default',
      approvalReset: 'Reset to default',
      approvalFootnote: "This only controls this plugin's approval prompts; other DSH host permission/denial rules still apply.",
      fontSizeSmaller: 'Decrease font size',
      fontSizeLarger: 'Increase font size',
      panelHint: 'This panel is a tmux structure view, not an interactive terminal; font size affects only panel display.',
      copyAttach: 'Copy attach',
      copyBash: 'Copy (Bash / Linux / macOS / Git Bash)',
      copyPowerShell: 'Copy (Windows PowerShell)',
      copyMenuTooltip: 'cmd.exe is not supported (% and quoting rules differ); use PowerShell.',
      moreActions: 'More actions',
    };

    const zh = {
      title: 'tmux',
      openPanel: '打开 tmux 面板',
      refresh: '刷新',
      lastRefresh: '上次刷新 {time}',
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
      insertFailed: '输入框已变化或正忙，引用未插入。',
      sessionGone: '当前会话已卸载。',
      adoptFailed: '引用失败：{message}',
      actionFailed: '服务端未接受此操作。',
      candidatesSection: '已采纳的 tmux 引用',
      untrusted: '不受信任的远程值',
      copied: '已复制',
      copyFailed: '复制失败',
      filterAll: '全部',
      filterRegistered: '已登记',
      advanced: '高级详情',
      refSession: '引用会话',
      refWindow: '引用窗口',
      refPane: '引用窗格',
      alias: '别名',
      aliasTooltip: '仅在本插件中显示，不修改远端 tmux 会话名',
      aliasPlaceholder: '别名（留空清除）',
      aliasSaved: '已保存别名',
      unregister: '取消登记',
      unregisterTooltip: '只删除本插件里的登记记录，不会关闭远端 tmux 会话或其中运行的进程。',
      unregisterConfirm: '取消登记“{label}”？只删除本插件里的登记记录，不会关闭远端 tmux 会话或其中运行的进程。',
      unregistered: '已取消登记',
      registeredNotice: '已登记：{label}（在“已登记”中可见）',
      approval: '审批',
      approvalAsk: '每次询问',
      approvalAllow: '直接执行',
      approvalCreate: '创建',
      approvalSend: '发送',
      approvalDetach: '分离',
      approvalKill: '关闭',
      approvalKillFixed: '始终询问并需输入确认（不可更改）',
      approvalSourcePanel: '面板设置',
      approvalSourceConfig: '配置文件',
      approvalSourceDefault: '默认',
      approvalReset: '恢复默认',
      approvalFootnote: '这里只控制本插件的审批提示；DSH 宿主的其他权限/拒绝规则仍然生效。',
      fontSizeSmaller: '减小字号',
      fontSizeLarger: '增大字号',
      panelHint: '此面板是 tmux 结构视图，不是交互终端；字号只影响面板显示。',
      copyAttach: '复制连接命令',
      copyBash: '复制（Bash / Linux / macOS / Git Bash）',
      copyPowerShell: '复制（Windows PowerShell）',
      copyMenuTooltip: 'cmd.exe 不支持（% 与引号规则不同），请用 PowerShell',
      moreActions: '更多操作',
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

    function paneSecondaryTitle(pane, host, hostMeta) {
      const title = cleanLabel(pane.title);
      if (!title || title === cleanLabel(pane.cmd)) return null;
      const normalized = title.toLowerCase();
      const defaults = [host.id, host.label, hostMeta?.ssh];
      if (defaults.some((value) => typeof value === 'string' && cleanLabel(value).toLowerCase() === normalized)) return null;
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

    // A tiny drop-down menu: trigger button + absolute popover. Closes on outside
    // pointer-down. `hint` (optional) renders as a non-interactive footer line.
    function Menu({ trigger, items, hint }) {
      const [open, setOpen] = react.useState(false);
      const rootRef = react.useRef(null);
      react.useEffect(() => {
        if (!open) return undefined;
        const onDoc = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
      }, [open]);
      return jsxs('span', { className: 'xc-menu', ref: rootRef, children: [
        jsx('button', {
          type: 'button', className: 'xc-action xc-menuTrigger', title: trigger.title || trigger.label,
          'aria-haspopup': 'menu', 'aria-expanded': !!open,
          onClick: (event) => { event.stopPropagation(); setOpen((v) => !v); },
          children: trigger.label,
        }),
        open ? jsxs('span', { className: 'xc-menuPop', role: 'menu', children: [
          ...items.map((item, i) => jsx('button', {
            type: 'button', role: 'menuitem', className: 'xc-menuItem', title: item.title,
            onClick: (event) => { event.stopPropagation(); setOpen(false); item.onClick(); },
            children: item.label,
          }, 'i' + i)),
          ...(hint ? [jsx('span', { className: 'xc-menuHint', children: hint }, 'hint')] : []),
        ] }) : null,
      ] });
    }

    // Inline alias editor (max 40 chars; Enter/blur saves, Escape cancels).
    function AliasEditor({ node, t, onSave, onCancel }) {
      const [value, setValue] = react.useState(node.alias || '');
      const inputRef = react.useRef(null);
      const committed = react.useRef(false);
      react.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
      const commit = () => {
        if (committed.current) return;
        committed.current = true;
        onSave(node, value);
      };
      return jsx('input', {
        ref: inputRef,
        type: 'text',
        className: 'xc-aliasInput',
        maxLength: 40,
        value,
        placeholder: t('aliasPlaceholder'),
        onChange: (event) => setValue(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        },
        onBlur: commit,
        onClick: (event) => event.stopPropagation(),
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

      const [advanced, setAdvanced] = react.useState(() => readStorage(LS_ADVANCED) === '1');
      const [filter, setFilter] = react.useState(() => (readStorage(LS_FILTER) === 'registered' ? 'registered' : 'all'));
      const [fontSize, setFontSize] = react.useState(() => {
        const n = Number(readStorage(LS_FONT));
        return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? Math.round(n) : FONT_DEFAULT;
      });
      const [data, setData] = react.useState(null);
      const [hostsMeta, setHostsMeta] = react.useState(Object.create(null));
      const [loading, setLoading] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [expanded, setExpanded] = react.useState(null); // null => defaults
      const [notice, setNotice] = react.useState(null);
      const [highlightKey, setHighlightKey] = react.useState(null);
      const [aliasTarget, setAliasTarget] = react.useState(null);
      const [lastRefreshedAt, setLastRefreshedAt] = react.useState(null);
      const [now, setNow] = react.useState(() => Date.now());
      const [approvalOpen, setApprovalOpen] = react.useState(false);
      const [approval, setApproval] = react.useState(null);
      const [approvalLoading, setApprovalLoading] = react.useState(false);
      const [approvalError, setApprovalError] = react.useState(null);
      const [approvalSaving, setApprovalSaving] = react.useState(null);
      const panelContext = react.useRef(null);
      const inFlightRef = react.useRef(false);

      react.useEffect(() => writeStorage(LS_ADVANCED, advanced ? '1' : '0'), [advanced]);
      react.useEffect(() => writeStorage(LS_FILTER, filter), [filter]);
      react.useEffect(() => writeStorage(LS_FONT, String(fontSize)), [fontSize]);

      // A request belongs to this mounted panel/session generation, not whichever
      // chat happens to be selected when its response arrives.
      react.useLayoutEffect(() => {
        const context = { sessionId, inputActions: props.inputActions };
        panelContext.current = context;
        return () => { if (panelContext.current === context) panelContext.current = null; };
      }, [sessionId, props.inputActions]);

      const refresh = react.useCallback(async () => {
        if (inFlightRef.current) return; // never overlap requests
        inFlightRef.current = true;
        setLoading(true);
        setError(null);
        try {
          // The client no longer sends a workspace: always fetch all registered nodes.
          const [inventory, hosts] = await Promise.all([
            api('/inventory?all=1'),
            api('/hosts'),
          ]);
          setData(inventory);
          setHostsMeta(normalizeHosts(hosts));
          setLastRefreshedAt(Date.now());
        } catch (err) {
          setError(err);
        } finally {
          inFlightRef.current = false;
          setLoading(false);
        }
      }, []);

      react.useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refresh, sessionId]);

      // Auto-refresh every 30 s while mounted and visible; never overlaps.
      react.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') refresh();
        }, REFRESH_MS);
        return () => clearInterval(timer);
      }, [refresh]);

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

      // Brief row highlight after a successful reference.
      react.useEffect(() => {
        if (!highlightKey) return undefined;
        const timer = setTimeout(() => setHighlightKey(null), 2000);
        return () => clearTimeout(timer);
      }, [highlightKey]);

      // Load approval settings when the section opens.
      react.useEffect(() => {
        if (!approvalOpen) return undefined;
        let alive = true;
        setApprovalLoading(true);
        setApprovalError(null);
        api('/settings')
          .then((r) => { if (alive) setApproval(r); })
          .catch((err) => { if (alive) setApprovalError(err); })
          .finally(() => { if (alive) setApprovalLoading(false); });
        return () => { alive = false; };
      }, [approvalOpen]);

      const flash = (text) => setNotice(text);

      const hostsOf = (d) => (d && (Array.isArray(d) ? d : d.hosts)) || [];

      function isRegistered(node) {
        return !!(node && (node.adopted || node.origin));
      }

      function sessionContainsRegistered(session) {
        if (isRegistered(session)) return true;
        for (const w of (session.windows || [])) {
          if (isRegistered(w)) return true;
          for (const p of (w.panes || [])) if (isRegistered(p)) return true;
        }
        return false;
      }

      function windowContainsRegistered(window) {
        if (isRegistered(window)) return true;
        for (const p of (window.panes || [])) if (isRegistered(p)) return true;
        return false;
      }

      function socketContainsRegistered(socket) {
        for (const session of (socket.sessions || [])) if (sessionContainsRegistered(session)) return true;
        return false;
      }

      function hostContainsRegistered(host) {
        for (const socket of (host.sockets || [])) if (socketContainsRegistered(socket)) return true;
        return false;
      }

      function countRegistered(hosts) {
        let n = 0;
        for (const host of hosts) {
          for (const socket of (host.sockets || [])) {
            for (const session of (socket.sessions || [])) {
              if (isRegistered(session)) n++;
              for (const w of (session.windows || [])) {
                if (isRegistered(w)) n++;
                for (const p of (w.panes || [])) if (isRegistered(p)) n++;
              }
            }
          }
        }
        return n;
      }

      function defaultExpandedKeys(hosts) {
        const keys = new Set();
        for (const h of hosts) {
          keys.add('h:' + h.id);
          for (const s of (h.sockets || [])) {
            keys.add('h:' + h.id + ':s:' + s.id);
            for (const session of (s.sessions || [])) {
              if (sessionContainsRegistered(session)) {
                keys.add('h:' + h.id + ':s:' + s.id + ':S:' + session.sid);
              }
            }
          }
        }
        return keys;
      }

      function toggleExpanded(node, value) {
        setExpanded((prev) => {
          const next = prev === null ? defaultExpandedKeys(hostsOf(data)) : new Set(prev);
          if (value) next.add(node.key); else next.delete(node.key);
          return next;
        });
      }

      function expandKeys(keys) {
        setExpanded((prev) => {
          const next = prev === null ? defaultExpandedKeys(hostsOf(data)) : new Set(prev);
          for (const k of keys) next.add(k);
          return next;
        });
      }

      function isExpanded(node) {
        if (!node.expandable) return false;
        if (expanded === null) {
          if (node.kind === 'host' || node.kind === 'socket') return true;
          if (node.kind === 'session') return !!node.autoExpand;
          return false;
        }
        return expanded.has(node.key);
      }

      // --- Reference / Copy / Unregister / Alias actions (closure over ctx) ---

      function ancestorKeys(node) {
        const keys = [];
        keys.push('h:' + node.hostId);
        keys.push('h:' + node.hostId + ':s:' + node.socketId);
        if (node.sid != null) keys.push('h:' + node.hostId + ':s:' + node.socketId + ':S:' + node.sid);
        if (node.wid != null) keys.push('h:' + node.hostId + ':s:' + node.socketId + ':S:' + node.sid + ':W:' + node.wid);
        keys.push(node.key);
        return keys;
      }

      // Reference label = the server kind-explicit label, with the host prefix
      // replaced by the node's alias when one is set (<alias> · 窗格 …).
      function referenceLabel(node) {
        const serverLabel = cleanLabel(node.serverLabel, 120);
        if (!node.alias) return serverLabel;
        const alias = cleanLabel(node.alias, 40);
        const prefix = cleanLabel(node.hostLabel, 80) + ' · ';
        const body = serverLabel.startsWith(prefix) ? serverLabel.slice(prefix.length) : serverLabel;
        return tokenSafeLabel(alias + ' · ' + body, 80) || serverLabel;
      }

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
            label: chipLabel(referenceLabel(node)),
            clipboardText: entry.token,
          }, span);
          if (!ok) throw new Error(t('insertFailed'));
          input.focus();
          flash(t('registeredNotice', { label: referenceLabel(node) }));
          expandKeys(ancestorKeys(node));
          setHighlightKey(node.key);
          refresh(); // refresh adopted flags / registered count
        } catch (err) {
          const message = t('adoptFailed', { message: errorText(err, t('actionFailed')) });
          if (panelContext.current === context) flash(message);
          if (input && props.sessions.binding(sessionId)?.ctx === binding?.ctx) input.notify('error', message);
          if (err?.status === 409) await refresh();
        }
      }

      async function onCopy(node, form) {
        const hostMeta = hostsMeta[node.hostId];
        const socketMeta = hostMeta && (hostMeta.sockets || []).find((s) => s && s.id === node.socketId);
        const cmd = form === 'powershell'
          ? attachCommandPowerShell(node, hostMeta, socketMeta)
          : attachCommandPosix(node, hostMeta, socketMeta);
        if (!cmd) { flash(t('copyFailed')); return; }
        const ok = await copyText(cmd);
        flash(ok ? t('copied') : t('copyFailed'));
      }

      async function onUnregister(node) {
        const label = rowTitle(node);
        if (!window.confirm(t('unregisterConfirm', { label }))) return;
        try {
          await api('/forget', {
            method: 'POST',
            body: node.registryKey ? { key: node.registryKey } : { uri: node.uri },
          });
          flash(t('unregistered'));
          refresh();
        } catch (err) {
          flash(t('actionFailed') + ': ' + errorText(err, t('actionFailed')));
        }
      }

      async function saveAlias(node, value) {
        setAliasTarget(null);
        const alias = String(value ?? '').trim();
        try {
          await api('/alias', {
            method: 'POST',
            body: { key: node.registryKey, alias: alias || null },
          });
          flash(t('aliasSaved'));
          refresh();
        } catch (err) {
          flash(t('actionFailed') + ': ' + errorText(err, t('actionFailed')));
        }
      }

      async function setApprovalValue(key, value) {
        setApprovalSaving(key);
        setApprovalError(null);
        try {
          const result = await api('/settings', {
            method: 'PUT',
            body: { approval: { [key]: value } },
          });
          setApproval(result);
        } catch (err) {
          setApprovalError(err);
        } finally {
          setApprovalSaving(null);
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

      function socketMetaOf(hostId, socketId) {
        const hostMeta = hostsMeta[hostId];
        return hostMeta && (hostMeta.sockets || []).find((s) => s && s.id === socketId);
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
          serverLabel: own.label,
          alias: own.alias || null,
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
            expandable: true,
            autoExpand: false,
          };
        }
        if (kind === 'window') {
          return {
            key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid + ':W:' + wid,
            kind, ...base,
            label: (windowIndex !== undefined ? windowIndex + ':' : '') + (windowName || ''),
            idText: '@' + wid,
            meta: [],
            expandable: false,
          };
        }
        // pane
        return {
          key: 'h:' + host.id + ':s:' + socket.id + ':S:' + sid + ':W:' + wid + ':P:' + pid,
          kind, ...base, pid,
          label: cleanLabel(pane.cmd) || t('unknownCommand'),
          idText: '%' + pid,
          meta: [
            paneSecondaryTitle(pane, host, hostsMeta[host.id]),
            pane.cwd ? cleanLabel(pane.cwd) : null,
            pane.dead ? t('dead') : null,
          ].filter(Boolean),
          dead: !!pane.dead,
          expandable: false,
        };
      }

      function sessionShape(session) {
        const windows = session.windows || [];
        const winCount = windows.length;
        const firstWindow = windows[0] || { panes: [] };
        const panes = firstWindow.panes || [];
        const singlePane = winCount === 1 && panes.length === 1 ? panes[0] : null;
        return {
          windows,
          singleWindow: winCount === 1,
          singlePane,
          multiWindow: winCount > 1,
          firstWindow,
        };
      }

      function rowTitle(node) {
        if (node.alias) return cleanLabel(node.alias, 40);
        return cleanLabel(node.label, 120);
      }

      function remoteNameMeta(node) {
        if (!node.alias) return null;
        const remote = cleanLabel(node.label, 120);
        const alias = cleanLabel(node.alias, 40);
        return remote && remote !== alias ? remote : null;
      }

      function shortCwd(cwd) {
        const s = cleanLabel(cwd, 240);
        if (!s) return null;
        const parts = s.split('/');
        if (parts.length <= 2) return s;
        return '…/' + parts.slice(-2).join('/');
      }

      function refLabelFor(node) {
        if (node.primaryRefKind === 'pane') return t('refPane');
        if (node.kind === 'session') return t('refSession');
        if (node.kind === 'window') return t('refWindow');
        return t('refPane');
      }

      function actionItems(node) {
        const items = [];
        if (node.secondaryRef) {
          items.push({ id: 'refSession', label: t('refSession'), title: t('refSession'), onClick: () => onReference(node.secondaryRef) });
        }
        items.push({ id: 'alias', label: t('alias'), title: t('aliasTooltip'), onClick: () => setAliasTarget(node) });
        if (isRegistered(node)) {
          items.push({ id: 'unregister', label: t('unregister'), title: t('unregisterTooltip'), onClick: () => onUnregister(node) });
        }
        return items;
      }

      function renderActions(node) {
        if (node.kind !== 'session' && node.kind !== 'window' && node.kind !== 'pane') return null;
        const refNode = node.refTarget || node;
        const primary = jsx(ActionBtn, { label: refLabelFor(node), title: refLabelFor(node), onClick: () => onReference(refNode) }, node.key + ':ref');
        const copyItems = [
          { id: 'copyPosix', label: t('copyBash'), title: t('copyMenuTooltip'), onClick: () => onCopy(node, 'posix') },
          { id: 'copyPs', label: t('copyPowerShell'), title: t('copyMenuTooltip'), onClick: () => onCopy(node, 'powershell') },
        ];
        const copyMenu = jsx(Menu, {
          trigger: { label: t('copyAttach'), title: t('copyMenuTooltip') },
          items: copyItems,
          hint: t('copyMenuTooltip'),
        }, node.key + ':copy');
        const more = actionItems(node);
        const overflow = more.length
          ? jsx(Menu, { trigger: { label: '⋯', title: t('moreActions') }, items: more }, node.key + ':more')
          : null;
        return jsxs('span', { className: 'xc-actions', children: [primary, copyMenu, overflow] });
      }

      function renderNodeRow(node, verifiedAt, children) {
        const caret = !!node.expandable;
        const open = caret ? isExpanded(node) : false;
        const label = rowTitle(node);
        const meta = [remoteNameMeta(node), ...(node.meta || [])].filter(Boolean);
        const editing = aliasTarget && aliasTarget.key === node.key;
        const cls = 'xc-node' + (highlightKey === node.key ? ' xc-highlight' : '');
        return jsxs('div', { className: cls, 'data-kind': node.kind, children: [
          jsxs('div', { className: 'xc-nodeRow', children: [
            caret ? jsx(Caret, {
              expanded: open,
              label: t('title'),
              onToggle: () => toggleExpanded(node, !open),
            }, node.key + ':caret') : jsx('span', { className: 'xc-caretSpacer' }),
            node.kind === 'pane' ? terminalIcon(12) : null,
            jsx('span', { className: 'xc-label', title: label, children: label }),
            advanced && node.idText ? jsx('span', { className: 'xc-ids', children: node.idText }, node.key + ':id') : null,
            badgesFor(node, verifiedAt),
          ] }),
          meta.length ? jsx('div', { className: 'xc-metaRow', children: meta.map((m, i) => jsx(MetaLine, { text: m }, node.key + ':m' + i)) }) : null,
          editing ? jsx(AliasEditor, { node, t, onSave: saveAlias, onCancel: () => setAliasTarget(null) }, node.key + ':aliasEdit') : renderActions(node),
          children,
        ] });
      }

      function renderPaneNode(host, socket, session, window, pane) {
        const node = resourceNode('pane', host, socket, session, window, pane);
        if (filter === 'registered' && !isRegistered(pane)) return null;
        return renderNodeRow(node, node.lastVerifiedAt, null);
      }

      function renderWindow(host, socket, session, window) {
        if (filter === 'registered' && !windowContainsRegistered(window)) return null;
        const node = resourceNode('window', host, socket, session, window, {});
        return renderNodeRow(node, node.lastVerifiedAt, jsx('div', { className: 'xc-children', children: (window.panes || []).map((pane) => renderPaneNode(host, socket, session, window, pane)) }));
      }

      function renderSession(host, socket, session) {
        if (filter === 'registered' && !sessionContainsRegistered(session)) return null;
        const shape = sessionShape(session);
        const node = resourceNode('session', host, socket, session, {}, {});
        node.expandable = !shape.singlePane || isRegistered(shape.singlePane);
        node.autoExpand = sessionContainsRegistered(session);

        if (shape.singlePane) {
          // Exactly one window with exactly one pane: the collapsed row's main
          // 引用 targets the PANE (never call a session a pane), with 引用会话
          // as a secondary action. Set this even when collapsed.
          const paneNode = resourceNode('pane', host, socket, session, shape.firstWindow, shape.singlePane);
          node.refTarget = paneNode;
          node.primaryRefKind = 'pane';
          node.secondaryRef = node; // 引用会话 -> the session itself
          node.meta = [cleanLabel(shape.singlePane.cmd), shortCwd(shape.singlePane.cwd)].filter(Boolean);
        }

        const open = isExpanded(node);
        let children = null;
        if (open) {
          if (shape.singlePane) {
            // Surface a registered pane as a child row so it stays manageable.
            children = isRegistered(shape.singlePane)
              ? jsx('div', { className: 'xc-children', children: [renderPaneNode(host, socket, session, shape.firstWindow, shape.singlePane)] })
              : null;
          } else if (shape.multiWindow) {
            children = jsx('div', { className: 'xc-children', children: shape.windows.map((w) => renderWindow(host, socket, session, w)) });
          } else {
            // One window with multiple panes -> list panes directly (skip window level).
            children = jsx('div', { className: 'xc-children', children: (shape.firstWindow.panes || []).map((pane) => renderPaneNode(host, socket, session, shape.firstWindow, pane)) });
          }
        }
        return renderNodeRow(node, node.lastVerifiedAt, children);
      }

      function renderSocket(host, socket) {
        if (filter === 'registered' && !socketContainsRegistered(socket)) return null;
        const server = socket.server || null;
        const key = 'h:' + host.id + ':s:' + socket.id;
        const open = isExpanded({ kind: 'socket', key, expandable: true });
        const children = open
          ? jsx('div', { className: 'xc-children', children: [
              server ? null : jsx('div', { className: 'xc-empty', children: t('noServer') }),
              ...(socket.sessions || []).map((session) => renderSession(host, socket, session)),
            ] })
          : null;
        return renderNodeRow({
          key,
          kind: 'socket',
          expandable: true,
          label: server && server.socketPath ? cleanLabel(server.socketPath) : cleanLabel(socket.id),
          idText: socket.id,
          meta: server && server.gen ? [cleanLabel(server.gen)] : [],
        }, host.verifiedAt, children);
      }

      function socketGroupLabel(host, socket) {
        const meta = socketMetaOf(host.id, socket.id);
        if (meta && meta.name) return cleanLabel(meta.name);
        if (meta && meta.path) return cleanLabel(meta.path);
        return cleanLabel(socket.id);
      }

      function renderHost(host) {
        if (filter === 'registered' && !hostContainsRegistered(host)) return null;
        const key = 'h:' + host.id;
        const unreachable = host.status === 'unreachable' || host.reachable === false;
        const failed = host.status === 'error';
        const open = isExpanded({ kind: 'host', key, expandable: true });
        const multiSocket = (host.sockets || []).length > 1;
        let children = null;
        if (open) {
          if (advanced) {
            children = jsx('div', { className: 'xc-children', children: (host.sockets || []).map((socket) => renderSocket(host, socket)) });
          } else {
            const items = [];
            for (const socket of (host.sockets || [])) {
              if (filter === 'registered' && !socketContainsRegistered(socket)) continue;
              if (multiSocket) {
                items.push(jsx('div', { className: 'xc-socketLabel', children: socketGroupLabel(host, socket) }, key + ':socket:' + socket.id));
              }
              for (const session of (socket.sessions || [])) {
                items.push(renderSession(host, socket, session));
              }
            }
            children = jsx('div', { className: 'xc-children', children: items });
          }
        }
        const hostBadges = [jsx(MetaLine, { text: agoText(t, host.verifiedAt, now) }, key + ':ago')];
        if (unreachable || failed) hostBadges.unshift(jsx(Badge, {
          text: t(unreachable ? 'unreachable' : 'hostError'), kind: 'unreachable',
        }, key + ':status'));
        return jsxs('div', { className: 'xc-node', 'data-kind': 'host', children: [
          jsxs('div', { className: 'xc-nodeRow', children: [
            jsx(Caret, { expanded: open, label: t('title'), onToggle: () => toggleExpanded({ kind: 'host', key, expandable: true }, !open) }, key + ':caret'),
            jsx('span', { className: 'xc-label', children: cleanLabel(host.label || host.id) }),
            advanced ? jsx('span', { className: 'xc-ids', children: host.id }, key + ':id') : null,
            ...hostBadges,
          ] }),
          host.error ? jsx('div', { className: 'xc-err', children: errorText(host.error, t('actionFailed')) }) : null,
          children,
        ] });
      }

      // --- Approval settings rendering ---

      function approvalSourceText(src) {
        if (src === 'panel') return t('approvalSourcePanel');
        if (src === 'config') return t('approvalSourceConfig');
        if (src === 'default') return t('approvalSourceDefault');
        return '';
      }

      function renderApprovalRow(key, label) {
        const effective = approval?.approval?.[key];
        const source = approval?.source?.[key];
        const busy = approvalLoading || approvalSaving === key;
        return jsxs('div', { className: 'xc-settingRow', children: [
          jsx('span', { className: 'xc-settingLabel', children: label }),
          jsxs('div', { className: 'xc-seg', role: 'group', children: [
            jsx('button', { type: 'button', className: 'xc-segItem', 'aria-pressed': effective === 'ask', disabled: busy, onClick: () => setApprovalValue(key, 'ask'), children: t('approvalAsk') }),
            jsx('button', { type: 'button', className: 'xc-segItem', 'aria-pressed': effective === 'allow', disabled: busy, onClick: () => setApprovalValue(key, 'allow'), children: t('approvalAllow') }),
          ] }),
          jsx('span', { className: 'xc-settingSource', children: approvalSourceText(source) }),
          source === 'panel'
            ? jsx('button', { type: 'button', className: 'xc-action', disabled: busy, onClick: () => setApprovalValue(key, null), children: t('approvalReset') })
            : null,
        ] });
      }

      function renderKillRow() {
        return jsxs('div', { className: 'xc-settingRow', children: [
          jsx('span', { className: 'xc-settingLabel', children: t('approvalKill') }),
          jsx('span', { className: 'xc-settingFixed', children: t('approvalKillFixed') }),
        ] });
      }

      function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      }

      // --- Panel body ---

      const hosts = hostsOf(data);
      const registeredCount = countRegistered(hosts);

      return jsxs('div', { className: 'xc-root', style: { '--xc-font-size': fontSize + 'px' }, children: [
        jsxs('div', { className: 'xc-header', children: [
          jsx('span', { className: 'xc-headerTitle', children: t('title') }),
          jsxs('div', { className: 'xc-seg', role: 'group', 'aria-label': t('filterAll') + ' / ' + t('filterRegistered'), children: [
            jsx('button', { type: 'button', className: 'xc-segItem', 'aria-pressed': filter === 'all', onClick: () => setFilter('all'), children: t('filterAll') }),
            jsx('button', { type: 'button', className: 'xc-segItem', 'aria-pressed': filter === 'registered', onClick: () => setFilter('registered'), children: t('filterRegistered') + ' (' + registeredCount + ')' }),
          ] }),
          jsx('button', { type: 'button', className: 'xc-action', 'aria-pressed': advanced, title: t('advanced'), onClick: () => setAdvanced((v) => !v), children: t('advanced') }),
          jsx('button', { type: 'button', className: 'xc-action', 'aria-pressed': approvalOpen, title: t('approval'), onClick: () => setApprovalOpen((v) => !v), children: t('approval') }),
          jsxs('span', { className: 'xc-fontGroup', children: [
            jsx('button', { type: 'button', className: 'xc-action xc-fontBtn', title: t('fontSizeSmaller'), 'aria-label': t('fontSizeSmaller'), disabled: fontSize <= FONT_MIN, onClick: () => setFontSize((f) => Math.max(FONT_MIN, f - 1)), children: 'A−' }),
            jsx('button', { type: 'button', className: 'xc-action xc-fontBtn', title: t('fontSizeLarger'), 'aria-label': t('fontSizeLarger'), disabled: fontSize >= FONT_MAX, onClick: () => setFontSize((f) => Math.min(FONT_MAX, f + 1)), children: 'A+' }),
          ] }),
          jsx('button', { type: 'button', className: 'xc-action', disabled: loading, onClick: () => refresh(), children: t('refresh') }),
          lastRefreshedAt ? jsx('span', { className: 'xc-lastRefresh', children: t('lastRefresh', { time: formatTime(lastRefreshedAt) }) }) : null,
        ] }),
        approvalOpen ? jsx('div', { className: 'xc-settings', children: jsxs(Fragment, { children: [
          approvalLoading ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
          approvalError ? jsx('div', { className: 'xc-err', children: errorText(approvalError, t('actionFailed')) }) : null,
          approval ? jsxs(Fragment, { children: [
            renderApprovalRow('create', t('approvalCreate')),
            renderApprovalRow('send', t('approvalSend')),
            renderApprovalRow('detach', t('approvalDetach')),
            renderKillRow(),
          ] }) : null,
          jsx('div', { className: 'xc-settingsFootnote', children: t('approvalFootnote') }),
        ] }) }) : null,
        notice ? jsx('div', { className: 'xc-notice', children: notice }) : null,
        loading ? jsx('div', { className: 'xc-empty', children: t('loading') }) : null,
        error ? jsx('div', { className: 'xc-err', children: t('loadFailed', { message: errorText(error, t('actionFailed')) }) }) : null,
        !loading && !error && hosts.length === 0 ? jsx('div', { className: 'xc-empty', children: t('empty') }) : null,
        jsx('div', { className: 'xc-tree', children: hosts.map((host) => renderHost(host)) }),
        jsx('div', { className: 'xc-footer', children: t('panelHint') }),
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
.xc-root{box-sizing:border-box;display:flex;flex-direction:column;height:100%;overflow:auto;padding:8px 8px 16px;gap:8px;color:var(--dsw-alias-label-primary);font-size:var(--xc-font-size,12px);line-height:1.35}
.xc-header{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.xc-headerTitle{font-weight:600}
.xc-seg{display:inline-flex;gap:2px;padding:1px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l3)}
.xc-segItem{font:inherit;font-size:.9167em;line-height:1.35;padding:1px 8px;border:0;border-radius:calc(var(--dsw-radius-md,6px) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.xc-segItem[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.xc-segItem:disabled{opacity:.5;cursor:default}
.xc-action{font:inherit;font-size:.9167em;line-height:1.35;padding:1px 8px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}
.xc-action[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);font-weight:500}
.xc-action:disabled{opacity:.5;cursor:default}
.xc-fontGroup{display:inline-flex;gap:2px;align-items:center}
.xc-fontBtn{min-width:26px;padding:1px 6px;text-align:center}
.xc-lastRefresh{color:var(--dsw-alias-label-tertiary);font-size:.8333em;font-variant-numeric:tabular-nums}
.xc-notice{color:var(--dsw-alias-state-business-primary);font-size:.9167em;overflow-wrap:anywhere}
.xc-err{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-warn-primary));font-size:.9167em;overflow-wrap:anywhere}
.xc-empty{color:var(--dsw-alias-label-tertiary);font-size:.9167em;padding:4px 0}
.xc-tree{display:flex;flex-direction:column;gap:1px}
.xc-node{display:flex;flex-direction:column;border-radius:var(--dsw-radius-sm,4px);padding:2px 4px}
.xc-node:hover{background:var(--dsw-alias-bg-layer-2)}
.xc-highlight{animation:xc-flash 1.8s ease-out}
@keyframes xc-flash{0%{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}100%{background:transparent;box-shadow:none}}
.xc-nodeRow{display:flex;align-items:center;gap:4px;min-width:0}
.xc-caret,.xc-caretSpacer{flex:none;width:14px;text-align:center}
.xc-caret{font:inherit;font-size:.8333em;line-height:1.35;padding:0;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.xc-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.xc-ids{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:.9167em}
.xc-meta{color:var(--dsw-alias-label-tertiary);font-size:.875em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.xc-metaRow{display:flex;gap:8px;padding-left:18px;min-width:0;flex-wrap:wrap}
.xc-badge{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs,3px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:.8333em;line-height:1.35}
.xc-badge[data-kind=stale]{color:var(--dsw-alias-state-warn-primary)}
.xc-badge[data-kind=unreachable]{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-state-warn-primary))}
.xc-actions{display:flex;gap:4px;padding-left:18px;flex-wrap:wrap;align-items:center}
.xc-actions .xc-action{font-size:.875em;padding:0 6px}
.xc-children{display:flex;flex-direction:column;padding-left:14px;border-left:.5px solid var(--dsw-alias-border-l2);margin-left:6px}
.xc-socketLabel{color:var(--dsw-alias-label-tertiary);font-size:.8333em;font-weight:600;padding:4px 0 0 4px}
.xc-menu{position:relative;display:inline-flex}
.xc-menuTrigger{padding:0 6px}
.xc-menuPop{position:absolute;z-index:30;top:100%;left:0;margin-top:2px;display:flex;flex-direction:column;gap:1px;min-width:180px;padding:3px;border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);box-shadow:0 4px 12px rgba(0,0,0,.18)}
.xc-menuItem{font:inherit;font-size:.9167em;line-height:1.35;text-align:left;padding:4px 8px;border:0;border-radius:var(--dsw-radius-sm,4px);background:none;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.xc-menuItem:hover{background:var(--dsw-alias-bg-layer-3)}
.xc-menuHint{font-size:.8333em;line-height:1.35;color:var(--dsw-alias-label-tertiary);padding:3px 8px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:2px}
.xc-aliasInput{font:inherit;font-size:.9167em;line-height:1.35;width:100%;max-width:260px;margin:2px 0 2px 18px;padding:2px 6px;border-radius:var(--dsw-radius-sm,4px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.xc-settings{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.xc-settingRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.xc-settingLabel{flex:none;min-width:44px;font-size:.9167em;font-weight:500}
.xc-settingSource{color:var(--dsw-alias-label-tertiary);font-size:.8333em}
.xc-settingFixed{color:var(--dsw-alias-label-tertiary);font-size:.8333em}
.xc-settingsFootnote{color:var(--dsw-alias-label-tertiary);font-size:.8333em}
.xc-footer{color:var(--dsw-alias-label-tertiary);font-size:.8333em;padding-top:4px;border-top:.5px solid var(--dsw-alias-border-l2)}
.xc-opener{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-md,6px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.xc-opener:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.xc-title{font-size:1em}
.xc-refchip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;height:20px;margin:0 1px;border-radius:var(--dsw-radius-md,6px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);vertical-align:baseline;cursor:default;max-width:100%}
.xc-refchip[role=button]{cursor:pointer}
.xc-refchip[role=button]:hover{background:var(--dsw-alias-bg-layer-3)}
.xc-refchipLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9167em}
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

      // Composer opener button.
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
}

// Test-only exports for test/unit/client-pure.test.js. In the browser (classic
// script) this is a no-op; Node evaluates this file as an ES module for its side
// effects and reads the pure builders off globalThis.
if (typeof window === 'undefined' && typeof globalThis !== 'undefined') {
  globalThis.__dshTmuxXcPure = {
    posixQuote,
    powerShellQuote,
    buildRemoteAttachCommand,
    attachCommandPosix,
    attachCommandPowerShell,
  };
}
