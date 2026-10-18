# Compatibility

Status key: **Verified** = observed on that target by the stated evidence owner — the project manager's real runs on NaMILab (DSH 0.2.1-rc.2, tmux 3.0a, Node 22), the integration suite on a loopback sshd + isolated tmux socket, the stated shell verification, or (where named) independent hands-on SOL evaluation; **Expected** = reasoned from the feature floor, not yet observed on that target; **Untested** = no data; **Unsupported** = known not to work by design.

**Release:** 0.1.1, released **2026-10-18** to [npm](https://www.npmjs.com/package/dsh-tmux-xc) and [GitHub](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/releases/tag/v0.1.1), tag **`v0.1.1`**. Runtime `lib/` is identical to the independently accepted baseline **`c600ece`**. The release commit changes presentation only: READMEs, screenshots, documentation, and package discovery metadata.

Evidence owners differ and are not interchangeable: SOL performed the independent hands-on evaluation; ASTRA reviewed evidence/source on the same runtime. Manager runs and automated suites are recorded separately in [TEST-RESULTS.md](TEST-RESULTS.md). SHA-1 `b39fe0019ebffd6aeb49a78b7f86362bf72dea07` identifies the accepted **pre-marketing tarball**, **not** the published artifact. The published digest is npm's **`dist.shasum`** in the [version registry record](https://registry.npmjs.org/dsh-tmux-xc/0.1.1), also recorded on the GitHub release.

Reviewer routing (quote from the review record): "SOL runs via dsh profile codex_sol + sol-high (openai-codex gpt-6.1-sol, reasoning effort high); ASTRA via codex_astra + astra-high (gpt-6-astra, high) — configured routing; DSH 0.2.1-rc.2 does not record the model/effort actually used." These are configured routes, not runtime attestation.

## Matrix

| Component | Version | Status | Notes |
|---|---|---|---|
| dsh-tmux-xc | 0.1.1 / `v0.1.1` | **Released; runtime acceptance scoped** | Published runtime matches `c600ece`; release presentation changes do not broaden platform/TUI coverage. Independent SOL clicks verified the fixes; ASTRA checked evidence and diff. See [CHANGELOG.md](CHANGELOG.md) and [TEST-RESULTS.md](TEST-RESULTS.md). |
| DSH — Linux web | 0.2.1-rc.2 | **Verified** | Plugin loads in DSH Web; "tmux" sidebar tab + composer opener icon; panel tree, Reference chip, approvals, reload + `/compact` exercised on the 0.1.0 baseline (manager). The 0.1.1 fixes (submission, sent-history/stale navigation, collapsed child-task subtitle, host-removal default) were verified by **independent SOL clicks** at `c600ece`; the earlier 0.1.1 `1ee6f78` build failed submission and sent-history navigation and that failure is fixed, not current. |
| DSH — Windows desktop | 0.2.1-rc.2 | **Expected; user verification pending** | Instructions only ([INSTALL.zh-CN.md](INSTALL.zh-CN.md) §验证清单); the developer has not verified Windows and neither SOL nor ASTRA executed it. Not a support claim. |
| DSH / tmux — macOS | any | **Untested** | No macOS execution is established by the Linux evidence. |
| CLI submission | Shell + Claude Code 2.1.302 on Linux | **Verified in scoped independent SOL checks** | Shell executed once; Claude prompt was submitted, but no successful model response was produced. Other TUIs were not verified on the accepted runtime; `cleared` alone is never proof of execution. |
| DSH — other versions | any | **Untested** | Peer ranges in `package.json` (`@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-tools` `^0.2.1-rc.2`; `@deepseek-ai/schemastery ^3.18.2`; `zod ^4.0.0`) define the intended surface; no other DSH release has been exercised. |
| tmux | 3.0a | **Verified** (manager + integration suite + independent SOL) | Tested floor; every remote script uses only 3.0a-era commands/formats (inventory `list-panes -a -F`, `send-keys -H`, `capture-pane -J`, `new-session -d -P -F`, `detach-client`, `kill-*`). Independent SOL submission, deletion and navigation checks ran on 3.0a/Linux. This is tmux/web acceptance, **not** a universal CLI or platform certification. See DESIGN §7. |
| tmux | 3.1 – 3.5 | **Expected** | Only 3.0a-era features are used; nothing from 3.1–3.5 is required, and no 3.1–3.5-only feature is assumed to be present. |
| tmux | < 3.0 | **Unsupported** | Below the tested floor. |
| OpenSSH — Linux | 8.x | **Verified** (manager) | Loopback sshd + real alias exercised (argv `BatchMode=yes`, `ClearAllForwardings=yes`, `RequestTTY=no`, no `StrictHostKeyChecking=no`, no agent/X11 forwarding). Independent SOL executed local Bash commands; its remote copy check required an isolated `-F` wrapper, i.e. the alias/config must exist on the connecting machine. |
| OpenSSH — Windows | Windows OpenSSH client | **Expected** | `ssh.exe` transport; user verifies non-interactive `ssh -o BatchMode=yes <alias> tmux -V`. The copy-attach PowerShell 5.1 path is **not verified** (below). |
| Node | 22 | **Verified** | `engines.node >= 22`; plain ESM, no build step. |
| dsh-tmux-cc | 0.5.3 / 0.6.0 / 0.7.1 | **Not used at runtime** | Evaluated and rejected as a runtime dependency; optional future live-view fork pinned to npm 0.6.0. See [dsh-tmux-cc-fork.md](dsh-tmux-cc-fork.md). |

## Platforms

| Platform | DSH placement | tmux placement | Transport | Status |
|---|---|---|---|---|
| Linux web | DSH on Linux | remote Linux (any reachable host) | `transport: ssh` | Verified: manager/integration; independent SOL for the 0.1.1 delta paths |
| Linux web | DSH on the tmux host itself | same host | `transport: local` | Verified (no ssh; identity still checked) — Bash observed on Linux, no local PowerShell |
| Windows desktop | DSH on Windows | remote Linux | `transport: ssh` via `ssh.exe` | Expected; user verification pending |

`transport: local` is **only** for DSH running on the tmux host itself; it is not a Windows option (Windows has no local Unix tmux socket to drive).

## Copy-attach commands

The panel's **复制连接命令 (Copy attach)** menu has two entries. The ssh forms emit `ssh -t -o ClearAllForwardings=yes '<ssh alias>' '<remote tmux command>'` with the exact socket (`-S <path>` / `-L <name>`) and the exact session/window/pane target (`$N` / `@N` / `%N`). For a `transport: local` host there is no ssh form: the Bash entry contains the local tmux command, and the PowerShell entry is **disabled with an explanation** ("local transport does not support PowerShell") rather than an enabled item that fails.

**Prerequisite on the connecting machine:** the ssh alias and its `~/.ssh/config` entry (host/port/user/jump host, or an `-F` config file) must exist where the copied command is pasted. The plugin does not read or embed the user's ssh config, and it never writes a server-only `-F` path into a portable clipboard command. A copy failure leaves the clipboard **unchanged**.

| Shell form | Environment | Status | Notes |
|---|---|---|---|
| Bash | Linux / macOS / Git Bash | **Verified on Linux by independent SOL (executed)**; macOS/Git Bash **expected, not executed** | POSIX single-quote escaping; `-o ClearAllForwardings=yes` present; executions selected the exact pane/window/session. Local Bash runs on the tmux machine. |
| PowerShell | PowerShell 7.6 on Linux | **Verified by the project manager, not by SOL** | Verified in both **Standard** and **Legacy** native argument-passing modes; PowerShell single-quoting doubles embedded `'`; `$ % @ ;` are literal inside the single-quoted remote command. |
| PowerShell | Windows PowerShell 5.1 + Windows OpenSSH | **Not verified** | Expected to work (same quoting rules), but not exercised on Windows; user verifies. |
| `cmd.exe` | — | **Unsupported** | `%` expansion and quoting rules differ; the menu tooltip says to use PowerShell. Do not paste the command into `cmd.exe`. |

## Feature floor

The plugin never uses tmux features newer than 3.0a. Specifically it does **not** rely on: `attach-session -f ignore-size`, `refresh-client -f`, `client_flags`, `new-session -e`, or `#{L:...}` — these are exactly the 3.2/3.4-era features that make upstream `dsh-tmux-cc` incompatible with 3.0a (DESIGN §7, §1).
