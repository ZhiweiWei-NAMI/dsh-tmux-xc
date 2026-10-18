# Compatibility

Status key: **Verified** = observed in the manager's real runs on NaMILab (DSH 0.2.1-rc.2, tmux 3.0a, Node 22) or by the integration suite on a loopback sshd + isolated tmux socket; **Expected** = reasoned from the feature floor, not yet observed on that target; **Untested** = no data; **Unsupported** = known not to work by design.

## Matrix

| Component | Version | Status | Notes |
|---|---|---|---|
| DSH — Linux web | 0.2.1-rc.2 | **Verified** | Plugin loads in DSH Web; "tmux" sidebar tab + composer opener icon; panel tree, Reference chip, approvals, reload + `/compact` all exercised. |
| DSH — Windows desktop | 0.2.1-rc.2 | **Expected — user-verified, pending** | Instructions only ([INSTALL.zh-CN.md](INSTALL.zh-CN.md) §验证清单); the developer has not verified Windows. |
| DSH — other versions | any | **Untested** | Peer ranges in `package.json` (`@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-tools` `^0.2.1-rc.2`; `@deepseek-ai/schemastery ^3.18.2`; `zod ^4.0.0`) define the intended surface; no other DSH release has been exercised. |
| tmux | 3.0a | **Verified** | Tested floor; every remote script uses only 3.0a-era commands/formats (inventory `list-panes -a -F`, `send-keys -H`, `capture-pane -J`, `new-session -d -P -F`, `detach-client`, `kill-*`). See DESIGN §7. |
| tmux | 3.1 – 3.5 | **Expected** | Only 3.0a-era features are used; nothing from 3.1–3.5 is required, and no 3.1–3.5-only feature is assumed to be present. |
| tmux | < 3.0 | **Unsupported** | Below the tested floor. |
| OpenSSH — Linux | 8.x | **Verified** | Loopback sshd + real alias exercised (argv `BatchMode=yes`, `ClearAllForwardings=yes`, `RequestTTY=no`, no `StrictHostKeyChecking=no`, no agent/X11 forwarding). |
| OpenSSH — Windows | Windows OpenSSH client | **Expected** | `ssh.exe` transport; user verifies non-interactive `ssh -o BatchMode=yes <alias> tmux -V`. |
| Node | 22 | **Verified** | `engines.node >= 22`; plain ESM, no build step. |
| dsh-tmux-cc | 0.5.3 / 0.6.0 / 0.7.1 | **Not used at runtime** | Evaluated and rejected as a runtime dependency; optional future live-view fork pinned to npm 0.6.0. See [dsh-tmux-cc-fork.md](dsh-tmux-cc-fork.md). |

## Platforms

| Platform | DSH placement | tmux placement | Transport | Status |
|---|---|---|---|---|
| Linux web | DSH on Linux | remote Linux (any reachable host) | `transport: ssh` | Verified |
| Linux web | DSH on the tmux host itself | same host | `transport: local` | Verified (no ssh; identity still checked) |
| Windows desktop | DSH on Windows | remote Linux | `transport: ssh` via `ssh.exe` | Expected — user-verified, pending |

`transport: local` is **only** for DSH running on the tmux host itself; it is not a Windows option (Windows has no local Unix tmux socket to drive).

## Feature floor

The plugin never uses tmux features newer than 3.0a. Specifically it does **not** rely on: `attach-session -f ignore-size`, `refresh-client -f`, `client_flags`, `new-session -e`, or `#{L:...}` — these are exactly the 3.2/3.4-era features that make upstream `dsh-tmux-cc` incompatible with 3.0a (DESIGN §7, §1).
