# Changelog

All notable changes to **dsh-tmux-xc**. Versions follow the plugin's `package.json`. UI strings are Chinese-first with an English table; this file is English.

## 0.1.1

Task-centric panel, local aliases, one approval switch, honest send reporting, panel-side deletion and chip navigation. No remote tmux objects are renamed, no tmux server is ever killed, and no remote files are touched.

### Added

- **Task-centric panel.** Hosts list **tasks** (sessions) directly. A task with exactly one window and one pane collapses to a single row; multi-window/multi-pane tasks expand. Registered (created/adopted) tasks carry a badge and sort first within a host. There is no workspace filter any more (inventory is always fetched with `all=1`; the route still accepts `workspace`).
- **高级详情 (Advanced details)** toggles socket details, server generation and `$N`/`@N`/`%N` ids; the setting is persisted in `localStorage`. Simple mode shows no durable ids.
- **Local aliases.** Panel action **别名** and agent tool **`tmux_xc_alias { ref, alias|null }`**. Aliases are local metadata only: they never rename the remote tmux object and need no approval. Setting an alias **adopts/registers the target first** if needed. Sanitized to 1..40 characters, no `[ ] ( )`, no control/bidi characters.
- **Config display hints** `hosts[].aliases: [{ session, window?, alias }]`: display-only names matched by remote session name (and optional window name). A local alias for the exact target wins. They live in the config, so they survive tmux restarts; identity is never derived from them.
- **Copy attach** offers **Bash (Linux/macOS/Git Bash)** and **PowerShell (Windows)** forms, both with `ssh -t -o ClearAllForwardings=yes` and the exact socket + `$`/`@`/`%` target. `cmd.exe` is not supported. For `transport: local`, the Bash form is the local tmux command only.
- **Panel deletion.** **删除窗格 / 删除窗口 / 删除会话** opens a click-confirmed dialog that lists the exact scope (label, alias, host, socket, kind) and what dies (processes; no files; other objects unaffected). It kills only that object — never the tmux server, never files.
- **Host removal.** **移除主机…** offers two explicit choices:
  - **仅从插件移除 (plugin-only):** purges the host's registrations and aliases and hides it; the remote tmux is untouched. Restore in **高级详情 → 已移除的主机**; the purged registrations/aliases are **not** restored.
  - **先终止所选远端会话，再移除主机:** terminates only the selected **sessions** (never the tmux server) and removes the host only when **every** selected kill succeeded; per-session results are shown honestly, and an unreachable host offers plugin-only removal. The profile config file is never edited; delete the host block there to remove it permanently.
- **One approval switch**: **插件审批 开/关** in the panel, default **ON**. ON = create / send / delete(kill) / detach ask; OFF = they run without plugin approval on configured, non-removed hosts. Precedence: panel setting > config `approval.enabled` (boolean) > deprecated 0.1.0 per-key `approval.create|send|detach: 'allow'` > ON. Read at call time (no restart). DSH host permission rules and SSH authentication failures still apply.
- **Reliable send.** Text/keys and `Enter` are separate guarded steps with `send.enterDelayMs` (default 400, clamp 0..5000). Results gain `delivered { text, keys, enter }` (enter may be `'unknown'`) and `submission { checked, state: 'cleared'|'pending'|'unknown' }` from a post-Enter cursor-line probe. Partial delivery is reported exactly, and mutations are never replayed.
- **One-click navigation.** Clicking a tmux chip in a conversation opens the tmux panel, re-resolves the exact identity, selects/highlights the target and shows a **read-only snapshot** ("只读快照，不是交互终端"). Stale references show an honest message (`SERVER_RESTARTED` / `TARGET_GONE` / `HOST_UNREACHABLE`) and are never retargeted.
- **Font size A−/A+** (10–18 px, default 12), persisted in `localStorage` and applied to both the panel and the snapshot.
- **Live refresh**: poll `GET /api/tmux-xc/version` every ~3 s while the panel is visible; refetch inventory only when the version changes, without overlapping requests.
- **Version endpoint / capture / kill / host-remove routes** under `/api/tmux-xc/` (owner-only), backing the panel features above.
- **Error codes** `APPROVAL_CANCELLED` (approval cancelled/aborted) and `APPROVAL_MISSING` (approved target identity missing; request approval again). Plugin refusals never say “the user rejected”.

### Changed

- **Approval defaults** moved from 0.1.0's per-key ask (create/send/detach ask, kill always ask) to **one switch, default ON**, covering create/send/delete(kill)/detach. `kill` follows the switch; the exact `confirm` target string is still required as an agent typo guard. Legacy per-key `allow` is deprecated and honoured **only** when neither a panel setting nor an explicit `approval.enabled` exists.
- **「忘记」 renamed to 「取消登记」** and moved into the row's **⋯** menu; it still removes only the plugin record (no remote effect).
- **Workspace filter removed** from the panel (the old 当前工作区/全部 toggle). Registered tasks are badged and sorted first instead.
- **Send** no longer claims success means execution: text and Enter are delivered separately, and `submission` is explicitly a heuristic. `delivered` ≠ executed.
- **Panel layout** hides sockets/generations/ids in simple mode; they appear only in 高级详情.
- **Copy attach** now has two labeled shell entries instead of one generic command.

### Fixed

- Enter is delivered as its own guarded invocation after a delay, so Ink/raw-mode CLIs (Claude Code, Codex CLI, …) no longer treat `text\r` as a paste and leave the text unsubmitted.
- Panel navigation re-resolves the exact identity and never re-targets a stale reference to a look-alike object.
- Killing a last pane no longer leaves the panel selecting a reused numeric id; only a surviving ancestor is revealed.

### Migration 0.1.0 → 0.1.1

1. Upgrade with `dsh plugin --profile <profile> remove dsh-tmux-xc`, then `dsh plugin --profile <profile> add <0.1.1 tarball>` (or bump `version` before packing). pnpm keeps an unchanged version+path otherwise.
2. **Restart DSH** (host code is not hot-reloaded) and reload the page.
3. Decide the approval default: set `approval.enabled: true|false` and **remove the old per-key `approval.create/send/detach`** so a legacy `allow` cannot silently survive when neither the panel nor `approval.enabled` is set. The panel shows a “旧版每键配置仍生效” note while legacy keys are active.
4. Registry data (adopted/created entries, aliases, settings, conversation references) is readable as-is; no manual data migration is needed.
5. Expect the UI renames: 忘记 → 取消登记, no workspace toggle, delete/host-remove dialogs, alias editor, approval switch, font controls.

## 0.1.0

Initial release.

- Right-sidebar tmux panel: `host → socket/server generation → session → window → pane`, with `$N`/`@N`/`%N` ids, `cwd`, foreground command, adopted/created badges and last-verified time.
- Composer **Reference** chips (`@[label](dsh-tmux:v1/...)`), durable per-conversation references, re-announced after `/compact`.
- Agent tools: `tmux_xc_list`, `_inspect`, `_resolve`, `_references`, `_capture`, `_create`, `_adopt`, `_send`, `_detach`, `_forget`, `_kill`.
- Per-key approval (`create`/`send`/`detach: ask|allow`; `kill` always ask) through DSH's native approval card, bound to the approved identity.
- SSH transport with `BatchMode=yes`, `ClearAllForwardings=yes`, strict host-key verification, allow-listed hosts/sockets, hex payloads, guarded mutations, no replay of uncertain mutations.
- `transport: local` for DSH running on the tmux host; `registryScope: user|profile`; persistent or explicit in-memory registry.
