# dsh-tmux-cc evaluation for dsh-tmux-xc

Read-only source investigation; no installation, build, tests, typecheck, SSH connection, or live DSH/tmux validation. Local snapshots are the evidence, not proof of working behavior on the target machines.

Citation roots: **N5** = `research/upstream/dsh-tmux-cc-0.5.3/package`; **N6** = `research/upstream/dsh-tmux-cc-0.6.0/package`; **H** = `research/upstream/github`. Citations below are `root/file:line` (ranges include both ends). H is v0.7.1, commit **87aa2a7cbb9e6b04d32d652517ae7f64058eceb3** (`git log -1` / `rev-parse HEAD`; version: H/package.json:2–3).

**Decision:** reuse the cockpit through a small fork pinned to **0.6.0**, plus a separate companion plugin for agent-facing remote operations. An unmodified dependency is insufficient: SSH must cover both process paths, and all three snapshots require tmux features absent from **3.0a**. For the smallest desktop renderer adaptation, retain a mirror-only legacy mode; do not silently emulate `ignore-size`. HEAD is preferable if its newer mobile/management features become requirements, but adds another compatibility obstacle (`#{L:...}`, tmux 3.4).

## 1. Architecture and DSH integration

| Surface | Implementation / evidence |
|---|---|
| Host entry | ESM `dist/index.js`; Cordis exports `name = 'tmux-cc'`, `inject = ['webServer']`, and `apply(ctx, config)`. One `TmuxRuntime` per plugin instance, shared across browser connections. N6/package.json:31–35; N6/dist/index.js:10–25; N6/dist/runtime.js:8–19. |
| Profile registration | `cordis.patch.yml` inserts `{id: tmux-cc, name: dsh-tmux-cc}`. Browser discovery is separate: exported `./client`, `dsh.client.platform = web`, package injection of client runtime, slots, settings and locale modules. The patch describes `/plugins/<pkg>/client.js` loading. N6/cordis.patch.yml:1–11; N6/package.json:51–63. |
| Browser entry | `window.__ModuleLoader__.load({id:'dsh-tmux-cc', factory(require)…})`, uses DSH's React. Browser plugin injects `slots`, `locale`, `settingsScope`. N6/lib/client.js:1–7,1973–1984. |
| Dock/panels | The persistent dock is a fixed DOM root appended directly to `document.body`, **not a conversation panel slot**. A React settings panel registers in `settings.section`, id `tmux-cc`, order 72. CSS/layout offsets accommodate the conversation column and bottom/right docking. N6/lib/client.js:466,735–750,1670–1676,1987–1995. |
| Terminal rendering | Browser xterm instances consume pane history/live output; `term.onData` emits WS `input`. xterm JS/CSS are served from installed `@xterm/xterm`, not fetched from a CDN. N6/lib/client.js:1069–1132; N6/dist/index.js:166–175. |
| Host settings | Namespace `tmux-cc`; schema has **only** `sizePolicy: auto \| mirror` (default auto). `tmuxBin`, `layouts`, launcher paths are composition config, not browser-editable settings fields. N6/dist/index.js:12–29; N6/dist/types.js:16–18. |
| Settings service | N6 imports `installSettingsSection`/`settingsNamespace` from `@deepseek-ai/dsh-settings` (`^0.1.1-rc.2`). H replaces those imports with local helpers using optional `ctx.inject(['settings'])`, `settings.register(ns,schema,{base})`, `scope.get()/watch()`. H's comment says the named exports disappeared in DSH 0.1.2. This is a concrete compatibility concern for 0.2.1-rc.2; the target DSH exports were not inspected here, so successful loading is **unverified**. N6/dist/index.js:5–6; N6/package.json:75–79; H/src/index.ts:21–52. |
| Lifecycle | Cordis effects register/unregister routes and dispose the runtime/WS server. Chat switching does not recreate this shell-level store. N6/dist/index.js:44–113; N6/lib/client.js:1975–1987. |

Routes, unchanged in role at HEAD:

| Route | Behavior | Guard |
|---|---|---|
| `/tmux-cc/status` | JSON prefs, settings, snapshot/session inventory; no method restriction | HTTP Host/Origin fence |
| `/tmux-cc/prefs` | GET shared session hint; POST updates it; other methods 405; JSON limit 64 KiB | Same fence |
| `/tmux-cc/vendor/*` | Allowlisted `xterm.js`, `xterm.css`; missing files 404 | Same fence |
| `/tmux-cc/ws` | WS upgrade; runtime command/output channel; maximum WS payload 1 MiB | Fence plus mandatory Origin |

Evidence: N6/dist/index.js:30–109,134–175; H/src/index.ts:116–194. These are web-server route registrations, not agent-tool registrations. Authentication limits are discussed in §5.

Storage: N6 browser preferences live in `localStorage['dsh-tmux-cc:dock']`, version 2, including placement/open state/session/font/cursor/scrollback/confirmation. Pane instances, history seeds, live deltas and reconnect state are memory-only. Host prefs retain only a session hint in memory; host-wide sizing persistence is delegated to DSH's settings provider, not an upstream-owned file/database. N6/lib/client.js:7–12,145–156,227–260; N6/dist/runtime.js:11–12,42–56; N6/README.md:124–132. N5 stores unversioned browser prefs and also broadcasts presentation prefs through host memory; H upgrades the browser document to version 3. N5/lib/client.js:103–114,153,242; N5/dist/runtime.js:27–49; H/lib/client.js:7–11,348–360. No conversation-to-session database exists.

## 2. Actual tmux transport and replacement seams

- N6 attaches by `spawn(tmuxBin, ['-C','attach-session','-f','ignore-size','-t','='+session])`. It uses **single `-C`**, three ordinary pipes, **no node-pty and no PTY allocation**. The control client writes newline-framed tmux commands and parses `%begin/%end/%error`, `%output`, layout/session/window notifications and `%exit`. N6/dist/tmux-client.js:50–84,293–311,366–440,514–538.
- Session discovery is an independent `execFile(tmuxBin, ['list-sessions','-F',...], {timeout:2000})`, called when detached, before/after launch, and during attached snapshot refresh. Replacing only the persistent control spawn leaves inventory local. N6/dist/tmux-client.js:249,442–456; N6/dist/runtime.js:76–90,313–329.
- `tmuxBin = config.tmuxBin || process.env.DSH_TMUX_BIN || 'tmux'` is an existing executable-path setting. It is **not** a shell command: setting it to `ssh NaMILab tmux` asks Node to find an executable with that whole name. An executable wrapper accepting tmux argv could work without a patch, but a Windows `.cmd`/POSIX shell wrapper is not a portable direct `spawn` solution. N6/dist/index.js:21–25; N6/dist/tmux-client.js:444–448,514–515.
- There is a useful **internal** injection seam: `new TmuxControlClient(bin,{spawnTransport,listSessions,commandTimeoutMs})`. The exported package entry does not expose that class as its public API, and the runtime constructs it with only `tmuxBin`. This is not currently usable as a clean companion-plugin service hook. N6/dist/tmux-client.js:33–38; N6/dist/runtime.js:335–336; N6/package.json:31–35. H retains the seam and defines `ControlTransport`/`SpawnTransport`: H/src/tmux-client.ts:40–48,86–90.
- No explicit `-L`, `-S`, socket-path setting, command-prefix setting, or transport registry exists. Default server selection is left to tmux and the inherited environment. N6/dist/index.js:21–25; N6/dist/tmux-client.js:54–61,442–448,514–523. A future `tmuxArgs` setting must prepend global socket options to **every** tmux invocation.
- Spawn inherits `process.env`, overriding only LANG when it lacks `utf`. It does not unset `TMUX` or override `LC_ALL`/`LC_CTYPE`, so LANG alone does not guarantee a UTF-8 locale. One-shot CLI calls simply inherit the environment. Over SSH this local LANG does not automatically become the remote locale; use tmux's supported global `-u` or explicit remote locale configuration. N6/dist/tmux-client.js:444–448,515–523; [tmux 3.0a tmux.1:177–187](https://github.com/tmux/tmux/blob/3.0a/tmux.1#L177).
- Detach writes `detach-client\n`, then kills the child after 250 ms. There is no process-group kill or tmux-server kill. Default transport listens for child `exit` but **not child `error`**; missing `tmux`/`ssh.exe` can produce an unhandled spawn error and needs explicit propagation. N6/dist/tmux-client.js:93–109,529–538.

**SSH:** `ssh -T NaMILab -- <remote-command>` fits the pipe-based `tmux -C` protocol. `-T` disables PTY allocation; do not change to `-t`/`-tt` or tmux `-CC`. In tmux 3.0a, the terminal-attribute setup requiring a TTY is for double-control mode: [client.c:309–320](https://github.com/tmux/tmux/blob/3.0a/client.c#L309). OpenSSH supports the proposed post-destination `--` by reparsing options; using `ssh -T -- NaMILab` is another spelling. [OpenSSH ssh.c:1106–1149](https://github.com/openssh/openssh-portable/blob/V_9_9_P2/ssh.c#L1106).

**A plain argv prepend is insufficient for safe SSH semantics.** OpenSSH joins remote-command arguments with spaces; a remote shell then parses that string. Session names with spaces, format strings with tabs, and HEAD's literal `;` command separator must be shell-quoted as individual remote argv values. Keep stdout exclusively for the protocol. [OpenSSH ssh.c:1162–1184](https://github.com/openssh/openssh-portable/blob/V_9_9_P2/ssh.c#L1162). The local Node call can still use `shell:false`; that does not remove the remote shell boundary.

HEAD has **four** routing surfaces: persistent transport; inventory runner `runTmuxCli`; runtime `runTmux` for pane swap; management `TmuxRunner`. Local recipe executables are a fifth, deliberately separate administrative action. H/src/tmux-client.ts:615–638; H/src/tmux-cli.ts:6–11,51–54; H/src/runtime.ts:353–373,584; H/src/tmux-management.ts:125–151. HEAD `create(cwd)` additionally performs local filesystem validation, so routing child processes alone is still insufficient (§4).

## 3. Exhaustive tmux command/format compatibility inventory

Scope is production host/browser code, excluding upstream tests, screenshot fixtures and arbitrary administrator-supplied launcher contents. N5/N6 share the command vocabulary below; differences are noted. H additions are listed separately.

| Command / options actually used | Versions | tmux 3.0a |
|---|---|---|
| Global `-C`; `attach-session -f ignore-size -t =<session>` | All | `-C` and exact session target work; **attach `-f` and `ignore-size` require 3.2**. Attachment fails as shipped. |
| `display-message -p '<format>'`; `display-message -p -F '<format>'` | All | Supported, subject to individual format support below. |
| `list-sessions -F`; `list-windows -F`; `list-panes -F`; `list-panes -s -F 'x'`; `list-clients -t =<session> -F` | All | Commands/options supported; `client_flags` is missing. |
| `send-keys -t <pane> -H <hex bytes>` | All | Supported. This is **send-keys -H**, not copy-mode -H. |
| `select-pane -t <pane>`; `select-pane -L/-R/-U/-D`; `select-window -t <window>` | All | Supported. The `-L/-S` global socket selectors are never used by upstream. |
| `capture-pane -e -p -J -t <pane> -S -<lines>` | All | Supported. N5 fixes depth at 200; N6/H request 0–20,000 lines and cap reply bytes at 800,000. |
| `resize-pane -Z -t`; `resize-pane -t -x/-y`; `split-window -h/-v`; `kill-pane [-t]`; `detach-client` | All | Supported. H split additionally targets `-t <pane>`. |
| `refresh-client -f ignore-size` / `-f !ignore-size` | All | **Not supported; 3.2+.** 3.0a uppercase `-F` supports `no-output` only, so changing letter case is not a fix. |
| `refresh-client -C <cols>x<rows>` | All | Supported. |
| `refresh-client -C <cols>x<rows> -f !ignore-size` | N6/H | **Not supported** because of `-f`. N5 performs separate flag/grid changes. |
| `new-window`; directional `resize-pane -t -L/-R/-U/-D <cells>` | H | Supported. |
| `swap-pane -d -s <pane> -t <pane>` | H | Supported; executed through a separate one-shot CLI call. |
| `list-clients -F` without `-t` | H manager | Supported; inventories every session on that server. |
| `new-session -d -s <name> [-c <cwd>] -- <shell> -l` | H manager | Supported; multiple shell argv arguments already work in 3.0a. **No `new-session -e` is used.** |
| `start-server ; show-options -gqv default-shell` | H manager | Supported. The semicolon is an internal tmux command boundary, and must survive the SSH remote shell as a literal argv item. |
| `rename-session -t =<name> -- <newName>` | H manager | Supported. |
| `if-shell -F <guard> 'detach-client -t <name>' 'display-message -p DSH_CLIENT_STALE'` | H manager | Commands/options supported, but the guard's **`#{L:...}` requires 3.4**, so guarded detach is incompatible. |

Local invocation citations: N6/dist/tmux-client.js:54–61,84,102,122–247,442–448; N5/dist/tmux-client.js:140–153,202–211; H/src/tmux-client.ts:254–267,333–338; H/src/runtime.ts:584; H/src/tmux-management.ts:81–85,137–157,175–184. Compatibility checked against tagged primary sources: [3.0a tmux.1](https://github.com/tmux/tmux/blob/3.0a/tmux.1), [cmd-send-keys.c:32–38](https://github.com/tmux/tmux/blob/3.0a/cmd-send-keys.c#L32), [cmd-refresh-client.c:34–40,116–150](https://github.com/tmux/tmux/blob/3.0a/cmd-refresh-client.c#L116), [spawn.c:395–410](https://github.com/tmux/tmux/blob/3.0a/spawn.c#L395), and [3.2 CHANGES:181–191](https://github.com/tmux/tmux/blob/3.2/CHANGES#L181). These establish concrete blockers rather than assuming the README's tested version is a minimum.

**Every format actually queried:**

| Group | Formats | 3.0a result / local citation |
|---|---|---|
| Session | `session_name`, `session_attached`, `session_windows` | All exist. N6/dist/tmux-client.js:243,447; H/src/tmux-cli.ts:53. |
| Window | `window_id`, `window_index`, `window_name`, `window_active`, `window_width`, `window_height`, `window_visible_layout`, `window_zoomed_flag` | All exist, including `window_visible_layout`. N6/dist/tmux-client.js:243–248. |
| Pane | `pane_id`, `pane_index`, `pane_title`, `pane_left`, `pane_top`, `pane_width`, `pane_height`, `pane_active`, `@dsh_role` | Built-ins all exist; `@dsh_role` is an optional user option, not a required newer built-in. N6/dist/tmux-client.js:247. |
| Control client | `client_name`, `client_flags` | Name exists; **flags added in 3.2**. N6/dist/tmux-client.js:84,201. |
| H client inventory | `client_name`, `client_pid`, `client_created`, `session_name`, `client_tty`, `client_termname`, `client_width`, `client_height`, `client_flags`, `client_control_mode` | All except `client_flags` exist. H/src/tmux-management.ts:81–85. |
| H detach guard | `#{L:...}` client loop; nested `#{?:...}`, `#{&&:...}`, `#{==:...}` over name/pid/created; literal escapes `##`, `#,`, `#}` | Conditional/comparison primitives are old; **client loop first exists in 3.4**, absent through 3.3. H/src/tmux-management.ts:112–113,175–183. |

Format evidence: [3.0a format.c:2084–2102](https://github.com/tmux/tmux/blob/3.0a/format.c#L2084), [client fields:2122–2135](https://github.com/tmux/tmux/blob/3.0a/format.c#L2122), [window fields:2173–2213](https://github.com/tmux/tmux/blob/3.0a/format.c#L2173), [pane fields:2251–2275](https://github.com/tmux/tmux/blob/3.0a/format.c#L2251); [3.3 modifier dispatch](https://github.com/tmux/tmux/blob/3.3/format.c), [3.4 client-loop dispatch:4490–4492](https://github.com/tmux/tmux/blob/3.4/format.c#L4490).

Protocol: parser handles `%begin/%end/%error <time> <number> <flags>` (bit 0 distinguishes its commands), `%output`, `%layout-change`, `%window-pane-changed`, `%session-window-changed`, `%window-renamed`, `%session-changed`, `%session-renamed`, `%window-add/%window-close`, `%unlinked-window-add/%unlinked-window-close`, and `%exit`. They trigger decoding or full refresh rather than being required handshake capabilities; missing notifications on older versions are different from invalid commands. N6/dist/tmux-client.js:366–440; H/src/tmux-client.ts has the same notification vocabulary.

**Not used anywhere in the production paths:** `refresh-client -B`, `refresh-client -A`, `pause-after`, `%extended-output`, `new-session -e`, `copy-mode -H`, tmux global `-f <config-file>`. Do not attribute those requirements to this plugin. It only understands `%output`, so enabling newer pause/extended-output features externally would require parser work. The actual client-flag `-f` is a different option from global configuration `-f`. For provenance, subscription and pause/resume support appear in [3.2 CHANGES:106–121](https://github.com/tmux/tmux/blob/3.2/CHANGES#L106).

**Practical 3.0a path:** attach using `-C attach-session -t =<name>` with no `-f`; never send `refresh-client -C` in this legacy mirror mode. tmux 3.0a ignores a control client's dimensions until `CLIENT_SIZECHANGED` is set, so an untouched pipe control client is already excluded from sizing. [resize.c:66–75](https://github.com/tmux/tmux/blob/3.0a/resize.c#L66). This is a real legacy behavior to implement explicitly. It does not supply modern dynamic takeover/release or a `client_flags` inventory; disable those capabilities rather than inventing flag values or viewer counts. Merely choosing today's `sizePolicy: mirror` does not help: upstream still passes the unsupported attach flags before applying that policy.

## 4. Windows host compatibility

| Finding | Impact |
|---|---|
| Local tmux assumption | README explicitly supports Linux/macOS, with tmux on the DSH host. Native Windows cannot use this Unix tmux executable/socket path directly; `ssh.exe` transport moves that requirement to Linux. N6/README.md:43–48. |
| Node host APIs | Host uses portable fs/path/url APIs, pipe subprocesses and HTTP/WS. There is **no node-pty**, Unix-domain `net.connect`, `which` executable lookup, `/proc` lookup, negative-PID kill, process-group API or hardcoded local `/tmp` socket access in production code. The Unix tmux socket is used by the **remote tmux client**, not by the Node host. N6/dist/index.js:1–9; N6/dist/tmux-client.js:1–6,514–538; H/src/tmux-management.ts:1–3. |
| Child lifecycle | `child.kill()` targets only the child (ssh.exe after adaptation); it is not POSIX process-group logic. Windows termination differs from Unix signals; ordinary detach relies on the protocol write first. Add child spawn-error handling. N6/dist/tmux-client.js:93–109,535–538. |
| Recipes | `execFile(layout.launch, launchArgs)` runs **locally**, including on a Windows DSH host. A configured Linux launcher path will fail there; a Windows batch file also does not behave like a directly executable Unix script. Configure an explicit SSH launcher or move recipe execution into the remote backend. N6/dist/runtime.js:313–329. |
| H remote cwd | Manager validates cwd with host `node:path.isAbsolute`, then **local `stat(cwd)`**, and validates remote `default-shell` with host `isAbsolute` too. Linux `/home/...` cwd and `/bin/bash` are interpreted using Windows path rules; local stat cannot establish remote existence. Replace these with POSIX path validation and remote tmux/filesystem handling before claiming remote creation works. H/src/tmux-management.ts:54–56,137–150. |
| SSH/environment | `tmuxBin` becomes a remote executable name; local executable must be Windows OpenSSH `ssh.exe` (PATH/absolute path). SSH alias/config/key resolution belongs to the Windows user running DSH. Local LANG inheritance is not remote locale provisioning. N6/dist/index.js:22; N6/dist/tmux-client.js:515–523. |

No source-level native-addon obstacle was found. That is not a live Windows compatibility result.

## 5. Security and agent exposure

**The plugin does not authenticate users.** Its “trusted” checks read `ctx.get('webRuntime')?.trustedHosts`, allow loopback Host names or matching trusted authorities, reject `Sec-Fetch-Site: cross-site`, and require any supplied Origin to have the same authority. HTTP permits absent Origin; WS requires it. There is no cookie/session/token/Authorization validation, remote-peer-IP check, or DSH authentication-service call in the plugin. N6/dist/index.js:30–35,44–109; N6/dist/trust.js:14–59; H/src/index.ts:116–121.

It registers on DSH's existing web server rather than opening a listener. Therefore public reachability depends on DSH binding, proxy and firewall configuration. These sources cannot establish any outer DSH middleware's authentication behavior. The plugin fence alone **does not make a public port private**: a non-browser client can supply an accepted Host and matching Origin. The README explicitly treats web-port access as shell-equivalent and says there is no separate login. N6/README.md:202–208.

Browser users can send arbitrary UTF-8 terminal input, hex-encoded as `send-keys -H`; this is expected shell-equivalent user-terminal functionality, not a constrained command sandbox. Input targeting is not restricted to the visible-pane list: `sendKeys` quotes its target but does not check membership. Even H's visible-pane check applies to selected operations, not raw input. N6/dist/runtime.js:477–502; N6/dist/tmux-client.js:122–132; H/src/tmux-client.ts:202–211,398–402. All browser tabs share one attachment/session; attach/detach/window/focus actions affect the other viewers. N6/dist/runtime.js:8–19,95–125; H/README.md:111–114.

**No agent tools are registered** in any snapshot. There is no tool-provider, agent-context injection, MCP registration, or automatic insertion of terminal output into conversations: host registration exports only the web plugin; browser registration installs the dock/settings UI. N6/dist/index.js:10–114; N6/lib/client.js:1973–2002; H/src/index.ts:56–62,93–200. An agent already allowed general shell/network access could independently contact these endpoints; “no registered tool” is not endpoint isolation. `dsh-tmux-xc` must deliberately define its own agent-tool scope and stable remote identifiers.

## 6. Feature comparison and publication gaps

| Feature | H README v0.7.1 | N6 README | N6 code | N5 code |
|---|---|---|---|---|
| Persistent bottom/right cockpit, native pane grid/window tabs, focus/zoom/split/resize, bilingual UI | Yes | Yes | Yes | Yes |
| Create/rename sessions; list/selectively detach native clients | Yes, sessions & clients manager | Not claimed | **Absent** | Absent |
| Drag pane titles to swap native panes | Yes | Not claimed | **Absent** | Absent |
| Ctrl+B `c/n/p/0–9/d`; expanded macOS shortcut map, optional compact splits | Yes | Only arrows/x/z/splits claimed | **Absent expanded actions**; earlier key map only | Earlier key map |
| Mobile readable font floor, two-axis grid pan, synthetic TUI wheel scroll, title drag, touch dividers | Yes | Earlier mirror drawer; dividers disabled | **Absent newer behavior**; basic momentum scroll, keyboard toggle, visual viewport | Earlier drawer/basic scrolling |
| Font size/cursor/scrollback/close-confirm settings; browser-local presentation | Yes | Yes | Implemented; local document v2 | Limited font/dock settings; other prefs synchronize through host |
| Host sizing policy Auto/Mirror, atomic takeover, bounded per-request history | Yes | Yes | Implemented, assuming compatible tmux/settings API | No host settings schema; separate flag/grid updates; fixed 200-line capture |
| Pane-close confirmation | Explicit modal | Repeat activation within 3 seconds | Repeat activation implemented | No equivalent preference/confirmation mechanism |
| xterm version / settings helper compatibility | H package xterm 6; local settings helper | N6 package xterm 5.5 | xterm 5.5; imports old DSH helper exports | xterm 5.5; no N6 host-settings helper integration |
| Remote SSH, Windows-host support, tmux 3.0a compatibility, agent tools | Not claimed | Not claimed | Absent | Absent |

Evidence: H/README.md:31–49,96–195; N6/README.md:31–48,89–134; N6/lib/client.js:145–156,224–239,388–396,1161–1263,1634–1661,1907–1965; N6/dist/runtime.js:435–511; N5/dist/runtime.js:30–49; N5/dist/tmux-client.js:140–153,202–211; H/src/runtime.ts:569–605; H/lib/client.js:264,344,1467,1618–1627; N6/package.json:75–79; H/package.json:78–81.

The substantial “missing npm features” are **HEAD documentation/code being newer than the published 0.6.0 package**, not N6 promising the entire HEAD manager. H/README.md:53–63 explicitly calls 0.7.1 GitHub-only and identifies npm as 0.6.0; do not expect `dsh plugin add dsh-tmux-cc` to deliver the manager/swap/new mobile UI.

One narrower N6 README/code gap: README says mouse-reporting programs receive finger gestures (N6/README.md:107), but its custom touch handler **abandons** a gesture when xterm mouse reporting is enabled; it does not implement H's synthetic wheel path. This source establishes missing explicit forwarding, not that every program/browser combination fails. N6/lib/client.js:1161–1168,1213–1218 versus H/lib/client.js:1618–1627,1669–1688.

## 7. Identity and cross-conversation semantics

- Sessions use **names**, not `#{session_id}` / `$N`: inventory is `{name, attached, windows}`; attach/count use exact `=<name>`, and recipes map IDs to names. N6/dist/tmux-client.js:54–61,201,442–451; N6/dist/runtime.js:307–310. HEAD retains name-based sessions and renaming behavior. H/src/tmux-cli.ts:51–62; H/src/tmux-management.ts:154–157.
- Windows use **`@N` IDs**, panes **`%N` IDs**, with names/titles/indexes only as metadata. Layout numeric pane IDs are matched against `%N` after removing `%`, with a coordinate-match fallback. N6/dist/tmux-client.js:243–248,458–489.
- HEAD native clients use **name + client PID + creation timestamp** to reject stale detach selections; this is **client identity**, not server identity. H/src/tmux-management.ts:34–42,81–104,160–185.
- No snapshot queries `#{pid}` (server PID), server start time, session ID, explicit socket identity or remote-host identity. `attachmentGeneration` is only an in-process counter invalidating asynchronous work after attachment replacement. N6/dist/runtime.js:30–31,95–109,391–418; H/src/runtime.ts:58–59. IDs can be reused after a server restart; the companion should bind records to SSH target + selected socket + observed server generation, and resolve real `$N/@N/%N` before operating. Names alone are inadequate durable cross-conversation identity.

## 8. Minimal changes and concrete transport sketch

**Pin/fork choice:** start from **dsh-tmux-cc 0.6.0**, preserve its renderer and MIT attribution, and keep the patch narrow. Reusing it unmodified as a dependency does not expose a runtime/service seam to inject SSH. Borrowing only ideas would unnecessarily replace the working renderer. Do not use an unpinned GitHub branch. If choosing the richer cockpit later, pin **0.7.1 / 87aa2a7cbb9e6b04d32d652517ae7f64058eceb3**, with explicit remote-cwd and pre-3.4 manager adaptations. Licensing/version evidence: N6/package.json:2–5; H/package.json:2–5; H/README.md:53–63.

Smallest **transport-only** patch to N6: carry a process-invocation builder through the runtime and apply it to both control spawn and session-list exec. Expose that same backend to the companion if both must share one attachment. A configurable argv prefix handles wrappers; an SSH prefix additionally needs remote-shell serialization. Sketch, not an applied implementation:

```diff
 // composition config: index -> RuntimeConfig -> control client/CLI runner
+ commandPrefix?: string[]       // e.g. ["ssh", "-T", "NaMILab", "--"]
+ prefixShell?: 'posix'          // remote command quoting; absent for argv wrappers
+ tmuxArgs?: string[]           // global args, e.g. ["-u", "-L", "research"]

+ function posixQuote(s) { return "'" + s.replaceAll("'", "'\\''") + "'" }
+ function invocation(bin, args, cfg) {
+   const target = [bin, ...(cfg.tmuxArgs ?? []), ...args]
+   const prefix = cfg.commandPrefix ?? []
+   if (!prefix.length) return { file: target[0], args: target.slice(1) }
+   const tail = cfg.prefixShell === 'posix'
+     ? ['exec ' + target.map(posixQuote).join(' ')]
+     : target
+   return { file: prefix[0], args: [...prefix.slice(1), ...tail] }
+ }

 // defaultTransport (N6/dist/tmux-client.js:514–523)
- const child = spawn(tmuxBin, args, options)
+ const call = invocation(tmuxBin, args, cfg)
+ const child = spawn(call.file, call.args, options) // pipes; shell:false
+ // Forward child 'error' to pending commands/UI, as well as exit/stderr.

 // listSessionsCli (N6/dist/tmux-client.js:442–456)
- await execFileAsync(tmuxBin, inventoryArgs, { timeout: 2000 })
+ const call = invocation(tmuxBin, inventoryArgs, cfg)
+ await execFileAsync(call.file, call.args, { timeout: configuredCliTimeout })
- catch { return [] }
+ // Return [] only for tmux's verified missing-server/no-sessions responses;
+ // propagate SSH auth/network/host-key errors, missing executables and timeouts.
```

For example, configuration resolves to local executable `ssh.exe` with `-T NaMILab --` and **one** remote command string equivalent to `exec 'tmux' '-u' '-C' 'attach-session' '-t' '=project'` in legacy mode. Keep the SSH alias administrator-owned; do not expose commandPrefix, binary paths or SSH flags as browser/agent input. Timeout must accommodate the real SSH connection instead of silently turning a two-second network timeout into empty inventory. Recipe launch remains explicitly local unless separately routed.

Three additional changes are necessary for this specific target, beyond generic SSH support:

1. **tmux 3.0a capability branch:** omit attach `-f`, avoid `client_flags`, disable all dynamic sizing writes and advertise mirror-only capability as described in §3. Do not represent unavailable flags as false or failed inventory as zero clients. Prefer a small explicit legacy backend over backporting HEAD's 3.4 client-detach guard.
2. **DSH settings compatibility:** port H/src/index.ts:21–52's direct settings-service registration (or equivalent confirmed against the target DSH API), replacing N6's legacy named imports. Do not claim 0.2.1-rc.2 compatibility until actual target loading is observed.
3. **Failure/identity integrity:** propagate subprocess errors; port H/src/tmux-cli.ts:14–62's narrow inventory-error handling; report malformed required numbers rather than N6's `Number(...) || 0` / 80×24 substitutes; introduce remote/server identity in the companion. Existing substitutions are visible at N6/dist/tmux-client.js:263–270,442–479 and persist in parts of H/src/tmux-client.ts:375–385. A transport failure must not become a successful empty remote inventory.

This delivers a plausible small renderer fork plus thin remote companion without asserting that a prefix setting alone makes the current releases compatible with Windows + remote tmux 3.0a.
