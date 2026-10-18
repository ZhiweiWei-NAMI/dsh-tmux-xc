# Compatibility

Status key: **Verified** = observed in the manager's real runs on NaMILab (DSH 0.2.1-rc.2, tmux 3.0a, Node 22), by the integration suite on a loopback sshd + isolated tmux socket, or (for the copy-attach shells) by the stated shell verification; **Expected** = reasoned from the feature floor, not yet observed on that target; **Untested** = no data; **Unsupported** = known not to work by design.

## Matrix

| Component | Version | Status | Notes |
|---|---|---|---|
| dsh-tmux-xc | 0.1.1 | Current release | Task-centric panel, local/config aliases, delete/host-remove, one approval switch, split text/Enter send, chip navigation snapshot. See [CHANGELOG.md](CHANGELOG.md). |
| DSH — Linux web | 0.2.1-rc.2 | **Verified** | Plugin loads in DSH Web; "tmux" sidebar tab + composer opener icon; panel tree, Reference chip, approvals, reload + `/compact` all exercised on the 0.1.0 baseline. 0.1.1-specific behaviour is recorded in the manager-maintained [TEST-RESULTS.md](TEST-RESULTS.md). |
| DSH — Windows desktop | 0.2.1-rc.2 | **Expected — user-verified, pending** | Instructions only ([INSTALL.zh-CN.md](INSTALL.zh-CN.md) §验证清单); the developer has not verified Windows. |
| DSH — other versions | any | **Untested** | Peer ranges in `package.json` (`@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-tools` `^0.2.1-rc.2`; `@deepseek-ai/schemastery ^3.18.2`; `zod ^4.0.0`) define the intended surface; no other DSH release has been exercised. |
| tmux | 3.0a | **Verified** | Tested floor; every remote script uses only 3.0a-era commands/formats (inventory `list-panes -a -F`, `send-keys -H`, `capture-pane -J`, `new-session -d -P -F`, `detach-client`, `kill-*`). See DESIGN §7. |
| tmux | 3.1 – 3.5 | **Expected** | Only 3.0a-era features are used; nothing from 3.1–3.5 is required, and no 3.1–3.5-only feature is assumed to be present. |
| tmux | < 3.0 | **Unsupported** | Below the tested floor. |
| OpenSSH — Linux | 8.x | **Verified** | Loopback sshd + real alias exercised (argv `BatchMode=yes`, `ClearAllForwardings=yes`, `RequestTTY=no`, no `StrictHostKeyChecking=no`, no agent/X11 forwarding). |
| OpenSSH — Windows | Windows OpenSSH client | **Expected** | `ssh.exe` transport; user verifies non-interactive `ssh -o BatchMode=yes <alias> tmux -V`. The copy-attach PowerShell 5.1 path is **not verified by us** (below). |
| Node | 22 | **Verified** | `engines.node >= 22`; plain ESM, no build step. |
| dsh-tmux-cc | 0.5.3 / 0.6.0 / 0.7.1 | **Not used at runtime** | Evaluated and rejected as a runtime dependency; optional future live-view fork pinned to npm 0.6.0. See [dsh-tmux-cc-fork.md](dsh-tmux-cc-fork.md). |

## Platforms

| Platform | DSH placement | tmux placement | Transport | Status |
|---|---|---|---|---|
| Linux web | DSH on Linux | remote Linux (any reachable host) | `transport: ssh` | Verified |
| Linux web | DSH on the tmux host itself | same host | `transport: local` | Verified (no ssh; identity still checked) |
| Windows desktop | DSH on Windows | remote Linux | `transport: ssh` via `ssh.exe` | Expected — user-verified, pending |

`transport: local` is **only** for DSH running on the tmux host itself; it is not a Windows option (Windows has no local Unix tmux socket to drive).

## Copy-attach commands

The panel's **复制连接命令 (Copy attach)** menu has two entries. Both emit the same shape — `ssh -t -o ClearAllForwardings=yes '<ssh alias>' '<remote tmux command>'` — with the exact socket (`-S <path>` / `-L <name>`) and the exact session/window/pane target (`$N` / `@N` / `%N`). For a `transport: local` host there is no ssh form: the Bash entry contains the local tmux command, and the PowerShell entry (ssh-only) reports a copy failure — use the Bash entry.

| Shell form | Environment | Status | Notes |
|---|---|---|---|
| Bash | Linux / macOS / Git Bash | **Verified** | POSIX single-quote escaping; `-o ClearAllForwardings=yes` present. |
| PowerShell | PowerShell 7.6 on Linux | **Verified** | Verified in both **Standard** and **Legacy** native argument-passing modes; PowerShell single-quoting doubles embedded `'`; `$ % @ ;` are literal inside the single-quoted remote command. |
| PowerShell | Windows PowerShell 5.1 + Windows OpenSSH | **Not verified by us** | Expected to work (same quoting rules), but not exercised on Windows; user verifies. |
| `cmd.exe` | — | **Unsupported** | `%` expansion and quoting rules differ; the menu tooltip says to use PowerShell. Do not paste the command into `cmd.exe`. |

## Feature floor

The plugin never uses tmux features newer than 3.0a. Specifically it does **not** rely on: `attach-session -f ignore-size`, `refresh-client -f`, `client_flags`, `new-session -e`, or `#{L:...}` — these are exactly the 3.2/3.4-era features that make upstream `dsh-tmux-cc` incompatible with 3.0a (DESIGN §7, §1).
