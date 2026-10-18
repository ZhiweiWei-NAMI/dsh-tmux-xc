# dsh-tmux-xc

Cross-conversation **remote tmux** for DeepSeek Harness (DSH): a right-sidebar "tmux" panel that shows your allow-listed hosts as a tree (`host → socket/server → session → window → pane`), a composer chip (**Reference**) that binds a conversation's agent to an exact pane, and an approval-gated tool surface so agents can inspect and operate that pane — safely and durably, even across chat reloads, DSH restarts, and `/compact`.

Plain ESM, no build step. Node ≥ 22. `MIT`.

---

## What it does

| Capability | What you get |
|---|---|
| **Panel** | A "tmux" tab in the DSH Web right sidebar (plus an opener icon in the composer toolbar). Lists hosts → sockets/server generations → sessions → windows → panes with foreground command, `cwd`, ids (`$N`/`@N`/`%N`), an **adopted** badge, and a last-verified time. Per-node actions: **引用 (Reference)**, **复制连接命令 (Copy attach)**, **忘记 (Forget** — adopted/created nodes only**)**. |
| **Reference** | Clicking **引用 / Reference** inserts a native composer chip (`@[label](dsh-tmux:v1/...)`). Nothing is sent and no keystroke reaches tmux. When you do send it, the message keeps the token and re-renders as a chip after reload. |
| **Durability** | References submitted in a conversation are stored per conversation and re-announced to the agent after `/compact`, so long chats keep working. |
| **Agent tools** | `tmux_xc_*` tools for list / inspect / resolve / references / capture / create / adopt / send / detach / forget / kill — each with its own permission class. |
| **Approvals** | Mutating tools (create/send/detach) ask via DSH's native approval card (**拒绝 / 允许一次**). `kill` **always** asks and requires an exact `confirm` string. |

## How it fits the DSH pieces

It reuses DSH's own primitives (right-sidebar slots, input-trigger chips, `insertReference`, the approval card, storage domain, owner-only connection routes) and deliberately does **not** reuse the session-owned `dsh-terminal` handles or the local-only `dsh-tmux-cc` cockpit as a runtime dependency — see [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md).

## Requirements

- DSH 0.2.1-rc.2 (Linux web **verified**; Windows desktop **expected, user-verified**).
- Node ≥ 22.
- A remote **tmux ≥ 3.0a** (3.0a is the tested floor) on a Linux host, reached through an existing OpenSSH alias.
- Linux DSH can also talk to tmux running on the *same* host with `transport: local`.

Full matrix: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Install (Linux)

```sh
# one of:
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc-0.1.0.tgz
dsh plugin --profile <profile> add /abs/path/to/dsh-tmux-xc          # a clone
dsh plugin --profile <profile> add github:ZhiweiWei-NAMI/dsh-tmux-xc#v0.1.0
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
    sshPath: ''                  # '' -> resolve "ssh" on PATH (Windows: ssh.exe)
    sshConfigFile: ''            # optional -F (tests only); '' -> user's normal config
    connectTimeoutSec: 10
    commandTimeoutMs: 20000
    registryScope: user          # user | profile
    approval:
      create: ask                # ask | allow
      send: ask                  # ask | allow
      detach: ask                # ask | allow
      # kill: always ask (not configurable); forget/adopt: allow (registry-only)
    capture: { defaultLines: 80, maxLines: 2000, maxBytes: 65536 }
```

Agents and the browser can only *select* `hostId`/`socketId` from this list; they can never supply ssh options, aliases, binaries or socket paths.

## Usage in 30 seconds

1. Open the **tmux** panel, expand to the pane you want.
2. Click **引用 / Reference** → a chip lands in the current composer (nothing sent).
3. Tell the agent what to do ("run `git status` in that pane", "capture its recent output", …) and approve when asked.

Chat A can `create`/`adopt` a session so chat B finds it; chat B references a pane and the agent acts on exactly that pane. Tasks and worked examples: [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md).

## Agent tools

| Tool | Parameters | Policy | Purpose |
|---|---|---|---|
| `tmux_xc_list` | `hostId?`, `workspace?`, `all?` | allow | list hosts → sessions → windows → panes with ids, cwd, cmd, reachability, adopted status |
| `tmux_xc_inspect` | `ref` | allow | decode a reference; report resolution code + current names/cwd/cmd |
| `tmux_xc_resolve` | `ref` | allow | resolve to the exact target string (what `kill` needs as `confirm`) |
| `tmux_xc_references` | — | allow | list references submitted in **this** conversation |
| `tmux_xc_capture` | `ref`, `lines?` | allow | bounded recent output, sanitized + fenced as untrusted |
| `tmux_xc_adopt` | `hostId`, `socketId?`, `target` | allow (registry write; remote read-only) | adopt an existing `$N`/`@N`/`%N` into the registry |
| `tmux_xc_create` | `hostId`, `socketId?`, `kind`, `name?`, `parentRef?`, `cwd?`, `horizontal?` | `approval.create` (ask) | create session / window / pane and register it |
| `tmux_xc_send` | `ref`, `text?`, `keys?`, `enter?` | `approval.send` (ask) | deliberate input to exactly one pane (≤ 16 KiB, hex-encoded) |
| `tmux_xc_detach` | `ref` | `approval.detach` (ask) | detach clients (remote processes keep running) |
| `tmux_xc_forget` | `ref?` or `key?` | allow | remove a registry entry only — never touches remote |
| `tmux_xc_kill` | `ref`, `confirm` | **always ask** | destroy session / window / pane; `confirm` = exact target string |

In a permission mode where approvals are disabled ("never"), the mutating tools are **rejected**, never auto-approved.

## Safety & identity

- **Allow-list only.** Hosts/sockets come from config; no credentials are stored and nothing weakens host verification (`BatchMode=yes`, `ClearAllForwardings=yes`, no agent/X11 forwarding, **no** `StrictHostKeyChecking=no`). The plugin uses your ssh config + `known_hosts`.
- **Owner-only.** Client routes are DSH-owner-only; discovery/adopt are read-only on the remote.
- **Stable identity.** A reference binds host fingerprint + uid + socket + server generation + `$`/`@`/`%` ids. Renamed objects still resolve; a restarted server or a reused name **fails** (`SERVER_RESTARTED` / `TARGET_GONE`) instead of redirecting to the wrong shell.
- **Distinct actions.** detach ≠ forget ≠ kill. `synchronize-panes` windows refuse input; captured output is sanitized and fenced as untrusted.

More: [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md), [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Documentation

| Doc | Language | Content |
|---|---|---|
| [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) | 中文 | 安装、配置、验证、卸载 |
| [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md) | 中文 | 任务导向使用指南 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | English | compatibility matrix |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | English | known limitations |
| [docs/dsh-tmux-cc-fork.md](docs/dsh-tmux-cc-fork.md) | English | why not a runtime dep; fork note |
| [docs/PRD.md](docs/PRD.md) / [docs/DESIGN.md](docs/DESIGN.md) / [docs/CONTRACTS.md](docs/CONTRACTS.md) | English | product/design/contract source of truth |

## License

MIT.
