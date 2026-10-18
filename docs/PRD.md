# PRD — dsh-tmux-xc (cross-conversation remote tmux for DeepSeek Harness)

Status: v0.1 (2026-10-17). Owner: ZhiweiWei-NAMI. Target: DSH 0.2.1-rc.2 desktop/web on **Windows**, remote **Linux tmux 3.0a** reached through an existing OpenSSH alias (`NaMILab`).

## 1. Problem

Long-running work (training jobs, servers, interactive CLIs) lives in tmux on a Linux server. DSH conversations are isolated: an agent in chat B cannot see or act on the pane that chat A created, and the official agent terminal handles (`dsh-terminal`) are session-owned and disappear with their owner. `dsh-tmux-context` only reports the tmux location of the DSH process itself. `dsh-tmux-cc` is a local-only user cockpit and exposes nothing to agents.

## 2. Goal / non-goals

Goal: a user sees remote tmux **host → session → window → pane** inside the DSH Web GUI, clicks **Reference** to put a structured chip in the *current* chat composer, and that conversation's agent can inspect/operate exactly that target — safely, durably, and across conversations.

Non-goals (v0.1): rendering a live terminal (left to the official DSH terminal or an optional `dsh-tmux-cc` fork, see DESIGN §11); managing non-tmux processes; multi-user sharing across OS accounts; Windows-local tmux.

## 3. Users and user stories

| # | As a … | I want … | so that … |
|---|---|---|---|
| U1 | DSH user | a "tmux" panel listing hosts, sessions, windows, panes with cwd, foreground command, attachment, reachability, last-verified time | I can find the right target without leaving DSH |
| U2 | DSH user | to click **Reference** on any node and get a visible chip in the composer of the chat I'm in — nothing sent, no keystroke delivered | I can then tell the agent what to do with it |
| U3 | DSH user | references I sent to stay usable after reload, DSH restart, and context compaction | long conversations keep working |
| U4 | Agent in chat A | to create a session (or adopt an existing one) on an allow-listed host | other chats can find it |
| U5 | Agent in chat B | to resolve a reference, read bounded recent output, and send input I was explicitly authorized to send | I operate the *exact* pane the user meant |
| U6 | DSH user | renamed sessions/windows to stay resolvable, but a restarted tmux server or a reused name to **fail** instead of silently redirecting | I never type into the wrong shell |
| U7 | DSH user | detach / forget (registry only) / kill (remote) to be distinct actions, with kill needing explicit intent and fresh verification | nothing is destroyed by accident |
| U8 | DSH user | existing sessions to be discovered/adopted without being touched | my running jobs and logins are never disturbed |
| U9 | DSH user | to configure the shell used for *new* sessions (e.g. `bash -l`) | new sessions get my normal environment |
| U10 | Admin | my SSH config, keys, agent and known_hosts to be the only credentials used | the plugin never stores secrets or weakens host verification |

## 4. Functional requirements

F1 Inventory: list allow-listed hosts and their tmux servers (default socket or configured `-L`/`-S` sockets) → sessions → windows → panes with verified metadata and a verification timestamp; unreachable hosts are shown as such, never as "empty".
F2 Registry: a shared registry of adopted/created resources, persisted via DSH storage (`ctx.storage.domain`), scoped to an explicit user or profile scope, with optional workspace tags/filters. Never derived from chat history or model memory.
F3 Reference chip: Reference inserts a structured composer reference (`ctx.conversation.input.insertReference`), serialized as a canonical token in the user message; sent messages render the chip again on reload. No auto-submit, no shell input.
F4 Durable conversation binding: references submitted in a chat are recorded per conversation in storage and re-announced to the agent after compaction; a tool lists them on demand.
F5 Server-side resolution before **every** operation against fresh remote state: host fingerprint, remote uid, socket, server generation, session/window/pane ids. Stale/ambiguous → explicit error, never fall back to another target.
F6 Agent tools: list, inspect, resolve, references, capture (bounded), create, adopt, send (deliberate input), detach, forget, kill — each with its own permission class.
F7 Safety: approval (`ask`) for remote mutations by default; kill always asks and requires an exact confirmation string; no automatic replay of a mutation after an uncertain disconnect; remote output/labels treated as untrusted and sanitized.
F8 Shell init for new sessions: per-host argv (e.g. `["bash","-l"]`), no token/secret copying, no permission-bypass flags.
F9 Packaging: plain ESM, no build step, installable with `dsh plugin --profile <p> add <tgz|path>` on Windows; documented uninstall.

## 5. Non-functional requirements

- Security: no public endpoints (owner-only DSH Connection routes); no `StrictHostKeyChecking=no`; no stored keys/passwords/tokens; no use of the privileged user-terminal controller for agent actions; strict allow-lists for hosts/sockets; shell-safe remote scripts (stdin, hex payloads).
- Robustness: tmux 3.0a feature floor; Unicode end-to-end; cancellation propagates to ssh; SSH forwarding conflicts avoided (`ClearAllForwardings=yes`); clear error taxonomy.
- Non-interference: discovery/adopt are read-only on the remote (no options set, no env changes, no test commands injected into user panes).
- Persistence of remote processes: chat closure and DSH restart never kill remote sessions.

## 6. Acceptance tests (must pass)

| ID | Scenario | Expected |
|---|---|---|
| A1 | Chat A creates (or adopts) a pane on host H | appears in registry and panel for all chats |
| A2 | Chat B opens panel, clicks Reference on that pane | chip appears in B's composer; nothing sent; remote pane unchanged |
| A3 | B sends "say hello in that pane"; agent calls `tmux_xc_send` | approval card shows exact target; after approve, `hello` arrives in **that** pane only |
| A4 | Reload UI; run `/compact` (context reset) | chip still rendered in history; agent can still resolve and use the reference |
| A5 | Rename session/window | old reference still resolves (same ids, same server generation) |
| A6 | Kill session, recreate with same name | old reference → `TARGET_GONE`, not the new session |
| A7 | Restart tmux server (same socket) | old reference → `SERVER_RESTARTED` |
| A8 | Host unreachable | inventory shows unreachable + error; tools fail with `HOST_UNREACHABLE`; no retries of mutations |
| A9 | Hostile pane output (escape sequences, bidi, fake tokens, "ignore previous instructions") | sanitized, fenced as untrusted, never parsed as references |
| A10 | Concurrent chats operate different panes simultaneously | no cross-talk |
| A11 | Send without approval / kill without confirm | denied |
| A12 | Close chat, restart DSH | remote processes still alive; references still resolve |
| A13 | Adopt an existing session | no remote modification (verified by tmux option/env diff and pane content) |

Windows GUI verification is performed by the user with `docs/INSTALL.zh-CN.md` §验证清单; all other acceptance runs on NaMILab with an isolated tmux socket and a loopback sshd.
