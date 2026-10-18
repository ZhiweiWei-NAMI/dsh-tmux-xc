# dsh-tmux-xc

Cross-conversation **remote tmux** for DeepSeek Harness (DSH): a right-sidebar **tmux** panel that presents each host as a task list, a composer chip (**Reference**) that binds a conversation's agent to an exact pane, and an approval-gated tool surface so agents can inspect and operate that pane — safely and durably, even across chat reloads, DSH restarts, and `/compact`.

Plain ESM, no build step. Node ≥ 22. `MIT`. Current version **0.1.1**; the accepted artifact is commit **`c600ece`**, tarball SHA-1 `b39fe0019ebffd6aeb49a78b7f86362bf72dea07` (version alone does not identify it — an earlier 0.1.1 build failed submission and sent-history navigation). Independent SOL clicks verified the fixes and an independent ASTRA review accepted the candidate within the scope recorded in [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md). No publication or production update is implied.

---

## What it does

| Capability | What you get |
|---|---|
| **Task-centric panel** | A "tmux" tab in the DSH Web right sidebar (plus an opener icon in the composer toolbar). Hosts list their **tasks** (sessions); a task with one window and one pane is a single compact row, multi-window/multi-pane tasks expand. A task row is titled by its local alias or remote session name; pane rows read `窗格 <index> · <cmd>` (an alias wins). A collapsed task whose children have distinct aliases adds a **包含：…** subtitle naming those child tasks (so the developer task is visible while `claude-ready` is collapsed); expanding shows distinct child names instead of repeats. **高级详情** reveals sockets, server generation and `$N`/`@N`/`%N` ids. |
| **Local aliases** | **别名** on a row (or the `tmux_xc_alias` agent tool) sets a friendly display name. It is local metadata only: it never renames the remote tmux object, and setting an alias registers the target if it was not registered. |
| **Copy attach** | **复制连接命令** offers **Bash (Linux/macOS/Git Bash)** and **PowerShell (Windows)** forms. The ssh forms are `ssh -t -o ClearAllForwardings=yes '<alias>' '<remote tmux command>'` with the exact socket + session/window/pane target. **The ssh alias and its config must exist on the machine where you paste the command** (the plugin does not read or embed your ssh config); for `transport: local` the Bash form is the local tmux command and runs on the tmux machine. The **PowerShell entry is disabled with an explanation** for local hosts. `cmd.exe` is not supported. A failed copy leaves the clipboard unchanged. |
| **Reference** | **引用** inserts a native composer chip (`@[label](dsh-tmux:v1/...)`). Nothing is sent and no keystroke reaches tmux. Insertion is asynchronous — **wait until the chip is visibly in the composer before sending**; then the message keeps the token and re-renders as a chip after reload. |
| **One-click navigation** | Clicking a tmux chip in a conversation opens the tmux panel, re-resolves the exact identity, selects the target and shows a **read-only snapshot**. A stale reference shows an honest message and is never retargeted. Sent-history navigation was independently verified on the accepted candidate for exact-pane, reload, same-name replacement and restarted-server paths; renamed/moved targets were not tested. |
| **Durability** | References submitted in a conversation are stored per conversation and re-announced to the agent after `/compact`, so long chats keep working. |
| **Agent tools** | `tmux_xc_*` tools for list / inspect / resolve / references / capture / create / adopt / alias / send / detach / forget / kill. |
| **Approvals** | **One switch** in the panel: **插件审批 开/关**, default **ON**, covering create / send / delete(kill) / detach. OFF runs those actions without extra plugin approval on configured, non-removed hosts — it is not an authorization bypass: DSH host rules and SSH authentication still apply (an independent DSH host deny still blocked creation with the switch OFF). Explicit owner-side delete/remove confirmations are a separate mechanism and remain. |
| **Reliable send** | Text and `Enter` are two guarded steps (default 400 ms apart), so interactive CLIs receive a real Enter instead of a paste. The result reports `delivered` and a heuristic `submission` state — delivery is not execution, and `cleared` does not prove execution. Independently verified on a shell and on real Claude Code 2.1.302 (prompt submitted, no successful model response); other TUIs and platforms remain unverified. |

## How it fits the DSH pieces

It reuses DSH's own primitives (right-sidebar slots, input-trigger chips, `insertReference`, the approval card, storage domain, owner-only connection routes) and deliberately does **not** reuse the session-owned `dsh-terminal` handles or the local-only `dsh-tmux-cc` cockpit as a runtime dependency — see [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md).

## Requirements

- DSH 0.2.1-rc.2 (Linux web **verified**; Windows desktop **expected, user verification pending** — not a support claim).
- Node ≥ 22.
- A remote **tmux ≥ 3.0a** (3.0a is the tested floor) on a Linux host, reached through an existing OpenSSH alias. The alias and its ssh config must exist **on the connecting machine**, since the copy command is only `ssh <alias> …`.
- Linux DSH can also talk to tmux running on the *same* host with `transport: local`; the local Bash command runs on the tmux machine and local PowerShell is disabled.
- Windows/macOS execution, PowerShell 5.1 and tmux versions other than 3.0a are **not** independently certified.

Full matrix: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Install (Linux)

```sh
# one of:
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc-0.1.1.tgz
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc          # a clone
dsh plugin --profile <profile> add github:ZhiweiWei-NAMI/dsh-tmux-xc#v0.1.1
```

The bundle is reconciled into the profile automatically. Then add a config block to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: namilab
        label: NaMILab
        ssh: NaMILab
```

…and restart DSH (host code is **not** hot-reloaded). Windows and uninstall: [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md).

Upgrading from 0.1.0? `remove` then `add` (pnpm keeps an unchanged version/path; the same-version caveat is documented in the install guide), then restart DSH. See [docs/CHANGELOG.md](docs/CHANGELOG.md).

## Configuration

Schema keys (as validated by `lib/index.js`):

```yaml
- id: tmux-xc
  config:
    hosts:                       # allow-list; agents/browser can only select from these
      - id: namilab              # [a-z0-9][a-z0-9_-]{0,31}; stable key used in references
        label: NaMILab           # display only
        ssh: NaMILab             # alias from the user's ssh config
        # transport: local       # DSH runs ON the tmux host: run scripts locally, no ssh
        sockets:                 # allow-list; default [{id: default}]
          - { id: default }      # default tmux socket
          - { id: xc, name: xc } # tmux -L xc
          - { id: lab, path: /tmp/tmux-lab/sock } # tmux -S (absolute POSIX path)
        newSession:
          command: []            # argv for NEW sessions; [] = tmux default-shell
          cwd: ''                # default start dir ('' = tmux default)
        aliases:                 # display-only name hints; identity is never derived from them
          - { session: claude-ready, window: work, alias: "tmux 插件开发" }
    sshPath: ''                  # '' -> resolve "ssh" on PATH (Windows: ssh.exe)
    sshConfigFile: ''            # optional -F (tests only); '' -> user's normal config
    connectTimeoutSec: 10
    commandTimeoutMs: 20000
    registryScope: user          # user | profile
    approval:
      enabled: true              # one switch; true = ask, false = allow. Unset = default ON
      # create/send/detach: deprecated 0.1.0 per-key 'allow' values still honoured
      # only when no panel setting and no explicit approval.enabled exists.
      # kill is not configurable; it follows `enabled`.
    send:
      enterDelayMs: 400          # 0..5000 ms between text and Enter
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 }
```

Agents and the browser can only *select* `hostId`/`socketId` from this list; they can never supply ssh options, aliases, binaries or socket paths.

### Config display aliases

`hosts[].aliases` entries match a **remote session name** (and optionally a **remote window name**) and only change what the panel shows:

```yaml
aliases:
  # The developer pane: session claude-ready, window work.
  - { session: claude-ready, window: work, alias: "tmux 插件开发" }
  # AC sessions (replace the placeholders with your remote session names).
  - { session: "<AC remote session>", alias: "AC" }
  # AeroWorld sessions.
  - { session: "<AeroWorld remote session>", alias: "AeroWorld" }
```

- A hint without `window` is a fallback for the session and its windows/panes; a hint with `window` applies to that window (and its panes).
- Hints are display-only, survive tmux restarts (they live in the config), and a **local alias for the exact target wins** over a config hint.
- Local aliases are keyed by exact identity including the tmux server generation; after a server restart, re-set the local alias (or use a config hint).

## Usage in 30 seconds

1. Open the **tmux** panel and find the task (session); expand it only if it has several windows/panes. A collapsed task shows a **包含：…** subtitle when its children have distinct aliases.
2. Optionally set **别名**, then click **引用** → wait until the chip is visibly in the composer (nothing is sent).
3. Tell the agent what to do ("run `git status` in that pane", "capture its recent output", …) and approve when asked.

Chat A can `create`/`adopt` a session so chat B finds it; chat B references a pane and the agent acts on exactly that pane. Create registers its result in code. A target an agent starts through a shell/terminal tool is **live-discovered** by inventory — it can appear in the panel after a refresh without adoption — but `tmux_xc_adopt` is required to **register** it (durable metadata, badge, alias/recovery basis). Tasks and worked examples: [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md).

## Agent tools

| Tool | Parameters | Policy | Purpose |
|---|---|---|---|
| `tmux_xc_list` | `hostId?`, `workspace?`, `all?` | allow | list hosts → sessions → windows → panes with ids, cwd, cmd, reachability, adopted status |
| `tmux_xc_inspect` | `ref` | allow | decode a reference; report resolution code + current names/cwd/cmd |
| `tmux_xc_resolve` | `ref` | allow | resolve to the exact target string (what `kill` needs as `confirm`) |
| `tmux_xc_references` | — | allow | list references submitted in **this** conversation (durable recovery; never guess by name/id) |
| `tmux_xc_capture` | `ref`, `lines?` | allow | bounded recent output, sanitized + fenced as untrusted |
| `tmux_xc_adopt` | `hostId`, `socketId?`, `target` | allow (registry write; remote read-only) | adopt an existing `$N`/`@N`/`%N` into the registry |
| `tmux_xc_alias` | `ref`, `alias` (string or `null`) | allow (local metadata) | set/clear a local alias; adopts the target first if needed; never renames remote tmux |
| `tmux_xc_create` | `hostId`, `socketId?`, `kind`, `name?`, `parentRef?`, `cwd?`, `horizontal?` | approval switch (create) | create session / window / pane; registers the result in code |
| `tmux_xc_send` | `ref`, `text?`, `keys?`, `enter?` | approval switch (send) | deliberate input to exactly one pane (≤ 16 KiB, hex-encoded); text and Enter are separate guarded steps |
| `tmux_xc_detach` | `ref` | approval switch (detach) | detach clients (remote processes keep running) |
| `tmux_xc_forget` | `ref?` or `key?` | allow | remove one registry entry only — never touches remote, does not cascade to registered children (panel label: **取消登记**) |
| `tmux_xc_kill` | `ref`, `confirm` | approval switch (delete/kill) | destroy exactly one session / window / pane; `confirm` = exact target string; never the server, never files |

With the plugin approval switch ON, the four mutating tools ask through DSH's native card. With it OFF they run without extra **plugin** approval on configured, non-removed hosts; DSH's own permission/host deny is a separate layer and still applies (verified: an independent DSH host deny rejected a create while the switch was OFF). Explicit delete/host-remove confirmations are owner UI actions, not plugin approval cards. In a permission mode where DSH has no approval channel and an ask is genuinely required, DSH itself denies with its own message; the plugin never reinterprets that as consent.

## Safety & identity

- **Allow-list only.** Hosts/sockets come from config; no credentials are stored and nothing weakens host verification (`BatchMode=yes`, `ClearAllForwardings=yes`, no agent/X11 forwarding, **no** `StrictHostKeyChecking=no`). The plugin uses your ssh config + `known_hosts`.
- **Owner-only.** Client routes are DSH-owner-only; discovery/adopt are read-only on the remote.
- **Stable identity.** A reference binds host fingerprint + uid + socket + server generation + `$`/`@`/`%` ids. Renamed objects still resolve; a restarted server or a reused name **fails** (`SERVER_RESTARTED` / `TARGET_GONE`) instead of redirecting to the wrong shell.
- **Distinct actions.** detach ≠ unregister (取消登记, the renamed forget) ≠ kill. A panel **删除窗格/窗口/会话** is a click-confirmed, exact-scope kill of one object; it never kills the tmux server and never deletes files. **取消登记** removes only that one registry record — it does not cascade to registered child items and does not erase aliases or chat history. **移除主机** defaults to plugin-only (purges local registrations/aliases; restore in 高级详情, data not restored); remote termination needs an explicit mode switch and an explicit session selection (which starts empty) and still never touches the tmux server; the host is removed only when every selected kill succeeded. It never edits the profile config file.
- `synchronize-panes` windows refuse input; captured output is sanitized and fenced as untrusted.

More: [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md), [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Documentation

| Doc | Language | Content |
|---|---|---|
| [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) | 中文 | 安装、配置、验证、升级、卸载 |
| [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md) | 中文 | 任务导向使用指南（面板、别名、审批、发送、删除、错误码） |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | English | version history and 0.1.0 → 0.1.1 migration notes |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | English | compatibility matrix (incl. the copy-attach shells) |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | English | known limitations |
| [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) | English | test results (unit, real-ssh integration, GUI acceptance) |
| [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md) | English | why not a runtime dep; fork note |
| [docs/PRD.md](docs/PRD.md) / [docs/DESIGN.md](docs/DESIGN.md) / [docs/CONTRACTS.md](docs/CONTRACTS.md) | English | product/design/contract source of truth |

## License

MIT.
