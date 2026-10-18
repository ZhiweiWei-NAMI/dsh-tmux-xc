# Changelog

All notable changes to **dsh-tmux-xc**. Versions follow the plugin's `package.json`. UI strings are Chinese-first with an English table; this file is English.

## 0.1.1 — 2026-10-18

Distribution: [npm](https://www.npmjs.com/package/dsh-tmux-xc) and [GitHub](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/releases/tag/v0.1.1), tag **`v0.1.1`**.

**Runtime unchanged:** `lib/` is identical to the independently accepted baseline **`c600ece`** (`c600ecedf2e5504481e89a6aa8439478dd6b2a8d`). The release commit changes presentation only: READMEs, screenshots, documentation, and package discovery metadata. Independent SOL hands-on checks and ASTRA evidence/source review establish the scope recorded in [TEST-RESULTS.md](TEST-RESULTS.md).

**Artifact identity:** SHA-1 `b39fe0019ebffd6aeb49a78b7f86362bf72dea07` identifies the accepted **pre-marketing tarball**, not the published artifact. For the published tarball digest, use npm's **`dist.shasum`** in the [version registry record](https://registry.npmjs.org/dsh-tmux-xc/0.1.1). Documentation changes mean the two tarballs are not interchangeable.

An earlier 0.1.1 candidate at `1ee6f78` failed submission and sent-history navigation; it was not accepted. The fixes below belong to the accepted runtime, not a claim that every earlier 0.1.1 build passed.

Task-centric panel, local aliases, one approval switch, honest send reporting, panel-side deletion and chip navigation. Aliases never rename remote tmux objects; destructive controls issue scoped pane/window/session kills, not server-wide kill or file-removal commands.

### Added

- **Task-centric panel.** Hosts list **tasks** (sessions) directly. A task with exactly one window and one pane collapses to a single row; multi-window/multi-pane tasks expand. Registered (created/adopted) tasks carry a badge and sort first within a host. There is no workspace filter any more (inventory is always fetched with `all=1`; the route still accepts `workspace`).
- **高级详情 (Advanced details)** toggles socket details, server generation and `$N`/`@N`/`%N` ids; the setting is persisted in `localStorage`. Simple mode shows no durable ids.
- **Local aliases.** Panel action **别名** and agent tool **`tmux_xc_alias { ref, alias|null }`**. Aliases are local metadata only: they never rename the remote tmux object and need no approval. Setting an alias **adopts/registers the target first** if needed. Sanitized to 1..40 characters, no `[ ] ( )`, no control/bidi characters.
- **Config display hints** `hosts[].aliases: [{ session, window?, alias }]`: display-only names matched by remote session name (and optional window name). A local alias for the exact target wins. They live in the config, so they survive tmux restarts; identity is never derived from them.
- **Copy attach** offers **Bash (Linux/macOS/Git Bash)** and **PowerShell (Windows)** forms, both with `ssh -t -o ClearAllForwardings=yes` and the exact socket + `$`/`@`/`%` target. `cmd.exe` is not supported. For `transport: local`, the Bash form is the local tmux command only.
- **Panel deletion.** **删除窗格 / 删除窗口 / 删除会话** opens a click-confirmed dialog listing the exact scope (label, alias, host, socket, kind) and affected processes. It issues only the selected object's native tmux kill command, never `kill-server` or file removal. Native containment/linking semantics apply; deleting the last object can naturally stop the server.
- **Host removal.** **移除主机…** offers two explicit choices:
  - **仅从插件移除 (plugin-only):** purges the host's registrations and aliases and hides it; the remote tmux is untouched. Restore in **高级详情 → 已移除的主机**; the purged registrations/aliases are **not** restored.
  - **先终止所选远端会话，再移除主机:** issues native kills only for the selected **sessions** (never `kill-server`) and removes the host only when **every** selected kill succeeded; per-session results are shown honestly, and an unreachable host offers plugin-only removal. Both modes require typing the host ID. The profile config file is never edited; delete the host block there to remove it permanently.
- **One approval switch**: **插件审批 开/关** in the panel, default **ON**. ON = create / send / delete(kill) / detach ask; OFF = they run without plugin approval on configured, non-removed hosts. Precedence: panel setting > config `approval.enabled` (boolean) > deprecated 0.1.0 per-key `approval.create|send|detach: 'allow'` > ON. Read at call time (no restart). DSH host permission rules and SSH authentication failures still apply.
- **Reliable send.** Text/keys and `Enter` are separate guarded steps with `send.enterDelayMs` (default 400, clamp 0..5000). Results gain `delivered { text, keys, enter }` (enter may be `'unknown'`) and `submission { checked, state: 'cleared'|'pending'|'unknown' }` from a post-Enter cursor-line probe. Partial delivery is reported exactly, and mutations are never replayed.
- **One-click navigation.** Clicking a tmux chip in a conversation opens the tmux panel, re-resolves the exact identity, selects/highlights the target and shows a **read-only snapshot** ("只读快照，不是交互终端"). Stale references show an honest message (`SERVER_RESTARTED` / `TARGET_GONE` / `HOST_UNREACHABLE`) and are never retargeted.
- **Font size A−/A+** (10–18 px, default 12), persisted in `localStorage` and applied to both the panel and the snapshot.
- **Live refresh**: poll `GET /api/tmux-xc/version` every ~3 s while the panel is visible; refetch inventory only when the version changes, without overlapping requests.
- **Version endpoint / capture / kill / host-remove routes** under `/api/tmux-xc/` (owner-only), backing the panel features above.
- **Error codes** `APPROVAL_CANCELLED` (approval cancelled/aborted) and `APPROVAL_MISSING` (approved target identity missing; request approval again). Plugin refusals never say “the user rejected”.

### Changed

- **Approval defaults** moved from 0.1.0's per-key ask (create/send/detach ask, kill always ask) to **one switch, default ON**, covering create/send/delete(kill)/detach. `kill` follows the switch; the exact `confirm` target string is still required as an agent typo guard. Legacy per-key `allow` is deprecated and honoured **only** when neither a panel setting nor an explicit `approval.enabled` exists. OFF removes extra **plugin** asks only; an independently installed DSH host deny still blocks the call.
- **「忘记」 renamed to 「取消登记」** and moved into the row's **⋯** menu; it still removes only the plugin record (no remote effect) and does not cascade to registered child items, aliases or chat history.
- **Workspace filter removed** from the panel (the old 当前工作区/全部 toggle). Registered tasks are badged and sorted first instead. The panel lists the **configured hosts/sockets**, not every machine, and it shows live-discovered targets that are not registered — visibility does not require adoption.
- **Send** no longer claims success means execution: text and Enter are delivered separately, and `submission` is explicitly a heuristic. `delivered` ≠ executed, and `cleared` ≠ executed.
- **Panel layout** hides sockets/generations/ids in simple mode; they appear only in 高级详情. A **collapsed** session whose windows/panes carry distinct aliases now shows a `包含：…` subtitle listing the child task names (e.g. the developer task under `claude-ready`); expanding shows distinct window/pane names instead of repeating one alias. Display-only: no action's target scope changes.
- **Copy attach** now has two labeled shell entries instead of one generic command. For `transport: local`, the PowerShell entry is disabled with an explanation (local transport is unsupported), not an enabled entry that fails. Menus/modals are body-portaled and clamped to the viewport, so a bottom host menu is usable at 1500×950 without collapsing other hosts. The Bash tooltip and SSH prerequisite text state that local Bash runs on the tmux machine and that the ssh alias/config must exist on the connecting machine.
- **Host removal** loads its plan in **plugin-only** mode and resets the selection to empty; reaching remote termination requires explicitly choosing that mode, after which sessions start **unchecked**. This avoids treating a loaded plan as destructive intent.

### Fixed

- **Multi-digit pane acknowledgement (acceptance blocker on `1ee6f78`):** literal `%N` in the native acknowledgement was expanded by tmux 3.0a's `display-message`, so text was typed but the Enter guard refused and the call ended as `OUTCOME_UNKNOWN`. Fixed by escaping literal `%` **only** at the `display-message` output-format boundary; target operands, identity/generation guards, exact nonce-framed matching, the separate Enter step and no-replay behavior are unchanged. Rechecked on a multi-digit shell pane and on real Claude Code 2.1.302: one text-plus-Enter send each, both acknowledged, shell executed exactly once, Claude showed the prompt submitted with an empty input box. **No successful Claude model response was produced** (dummy key, loopback dead port), and Python and other TUIs were not retested.
- **Sent-history reference rendering (acceptance blocker on `1ee6f78`):** a sent tmux reference with a spaced label could be taken by the generic file-mention renderer, so the history chip opened a nonexistent file. The tmux sent-user-text rule now registers before the generic file rule (order 25 vs 30) with complete validated spaced-token matching, and the persisted token/URI path is retained. Rechecked: sent chip selected exactly the referenced pane with its marker (also after reload); an older stored message now renders as a tmux chip and fails stale after its target was deleted; same-name replacement and a restarted look-alike server gave zero selection and no replacement preview. Renamed/moved targets and other browsers were not tested.
- Panel navigation re-resolves the exact identity and never re-targets a stale reference to a look-alike object.
- Killing a last pane no longer leaves the panel selecting a reused numeric id; only a surviving ancestor is revealed.

### Migration 0.1.0 → 0.1.1

1. Upgrade with `dsh plugin --profile <profile> remove dsh-tmux-xc`, then `dsh plugin --profile <profile> add dsh-tmux-xc@0.1.1`. Remove/add also avoids pnpm retaining old files when reinstalling an unchanged version+path.
2. **Restart DSH** (host code is not hot-reloaded) and reload the page.
3. Decide the approval default: set `approval.enabled: true|false` and **remove the old per-key `approval.create/send/detach`** so a legacy `allow` cannot silently survive when neither the panel nor `approval.enabled` is set. The panel may show a “旧版每键配置仍生效” legacy-key note while those keys remain configured; the precedence above determines whether they actually apply.
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
