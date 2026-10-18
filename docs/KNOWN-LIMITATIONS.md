# Known limitations

These are current, intentional or structural limits of dsh-tmux-xc v0.1.0. They are not bugs to be silently papered over.

| # | Limitation | Detail / consequence | Workaround |
|---|---|---|---|
| 1 | **One DSH process per `$DSH_HOME` registry** | The registry is a DSH storage-domain JSON backend (`$DSH_HOME/storages/dsh_tmux_xc/`, per-record). Writes are **last-write-wins across processes**: two DSH processes sharing one `$DSH_HOME` can overwrite each other's registry entries. | Run a single DSH process per `$DSH_HOME`, or give each process its own `$DSH_HOME`. |
| 2 | **No live terminal rendering** | The panel shows a tree + metadata, not a streaming terminal. This is a v0.1 non-goal (PRD §2). | Use **复制连接命令 (Copy attach command)** — it emits `ssh -t <alias> tmux … attach -t '$N'` for your own terminal or the official DSH terminal panel (a user action, not an agent action). A future live view would come from the optional `dsh-tmux-cc` fork, not this plugin. |
| 3 | **No hot reload** | Host code under a profile's `node_modules` is not continuously watched; install/upgrade and config changes take effect only after a DSH restart (and page reload). | Restart DSH after install/upgrade or config edits; reload the page. |
| 4 | **Approvals impossible in "never" permission mode** | If the user's permission mode disables approvals (`approval: never`), the mutating tools (create/send/detach) and `kill` cannot show their approval card. The plugin **rejects** these calls rather than reinterpreting "cannot ask" as consent. | Enable approvals in DSH permission settings, or use a permission mode that permits `ask`. |
| 5 | **Restarts invalidate references by design** | tmux `$`/`@`/`%` ids are per-server and reset after a server restart. A reference binds the observed server generation, so a restarted server yields `SERVER_RESTARTED` and a reused name yields `TARGET_GONE` — never a silent redirect to the wrong shell. | Re-reference the current object from the panel after a restart/recreation. |
| 6 | **Capture is plain text (no colors)** | `capture-pane` output is stripped of ANSI/OSC/DCS sequences and other controls as part of untrusted-data sanitization. Colors and cursor control are not preserved. | Read the pane in a real terminal (Copy attach) when visual fidelity matters. |
| 7 | **Reference re-announce runs remote resolves** | After `/compact`, the plugin re-announces the conversation's references to the agent, and each reference is resolved against fresh remote state (an ssh round-trip) before the agent acts. This is intentional freshness, but it costs latency per step/reference. | Keep reference lists short; the agent re-resolves lazily only when it actually uses them. |
| 8 | **Windows path not verified by the developer** | Windows desktop + Windows OpenSSH client is documented as instructions and expected to work, but has not been exercised by the developer; the user verifies it ([INSTALL.zh-CN.md](INSTALL.zh-CN.md) §验证清单). | Report Windows findings against the checklist. |
| 9 | **`registryScope: profile` uses a hashed profile key** | The profile-scoped domain name is `dsh_tmux_xc_p_<profile>`, where the profile component is derived from the profile name. The key is not the raw profile string and is not meant to be read by hand. | Prefer `registryScope: user` for a single shared registry across the OS user's `$DSH_HOME`. |
| 10 | **`transport: local` only for DSH on the tmux host** | Local transport is supported only when the DSH process runs on the same Linux/macOS host as tmux. It is not a Windows option and cannot bridge to a remote host. | Use `transport: ssh` (default) for any remote host, including a Windows DSH host. |

## Also by design (not limitations)

- Discovery/adopt never modify remote tmux (no options, env, or test commands injected).
- detach ≠ forget ≠ kill: detach kicks clients (processes keep running); forget removes registry rows only; kill destroys remote objects.
- `synchronize-panes` windows refuse input (a pane can't be targeted uniquely).
- Untrusted remote output is sanitized and fenced; tokens inside captured output are never parsed as references.
