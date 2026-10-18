# Test results — dsh-tmux-xc 0.1.1

Run on **NaMILab** (Linux), 2026-10-18, by the project manager (centralized validation; sub-agents generated code and did not run tests). Same toolchain as 0.1.0 below (DSH 0.2.1-rc.2 in an isolated `DSH_HOME`, tmux 3.0a, OpenSSH 8.2p1 loopback sshd, Node 22.23.2, headless Chromium). The user's live DSH, `~/.ssh`, default tmux server and existing tasks (AC, AeroWorld, the developer pane) were never driven; every destructive check used disposable sessions on dedicated sockets.

| Check | Result |
|---|---|
| Unit (`npm test`) | **549 / 549** |
| Integration, real ssh + tmux 3.0a (`npm run test:integration`) | **33 / 33** (adds `send-submit`: Ink-like raw-mode TUI submits; sticky line → `submission.state: pending`) |
| Independent reviews (sol-xhigh, not the authors) | RV-A safety/approval: 8 findings; RV-B correctness/navigation/simplicity: 17 findings — all accepted and fixed (astra-high refine), re-validated |
| Package | `dist/dsh-tmux-xc-0.1.1.tgz`, installed from the tarball into the isolated profile (remove + add), DSH restarted |

## 0.1.1 acceptance evidence

| # | Item | Evidence |
|---|---|---|
| 1 | Task-centric tree | GUI: simple mode lists `host → task` rows; single-window/single-pane tasks are one row; multi-pane task lists `窗格 0 · bash`, `窗格 1 · bash`; no `$ @ %` ids, generation or socket in simple mode; all appear in 高级详情. Alias `AC` set from the panel: row title `AC`, remote name `ac-demo` kept as secondary; inventory shows the session registered with `alias: AC` (local). |
| 2 | Copy-attach commands | Panel copies labelled Bash and PowerShell strings (cmd.exe tooltip: not supported). Executed for a pane target on a disposable server: Bash → client attached to session `task one` (name with a space) with `@1 %1` selected; PowerShell 7.6.7 in both `Standard` and `Legacy` native-argument modes → `@1 %2` selected. Both include `-o ClearAllForwardings=yes`. Windows PowerShell 5.1 + Windows OpenSSH: **not verified**. |
| 3 | Real delete | GUI 删除会话 dialog shows remote name, host, socket, kind and “all windows/panes and processes end; no files deleted; other sessions unaffected”; one click → only `del-me` disappeared (out-of-band `tmux list-panes` diff). 移除主机: unreachable host offers only plugin-only removal with an explanation; reachable host — only `rm-sel` selected → only `rm-sel` killed (diff), host removed after all kills succeeded, result row `NaMILab ssh loopback · 会话 rm-sel: 已终止`; restored from 高级详情. Unit: invalid batches kill nothing; partial failure keeps the host. |
| 4 | Workspace/all | No 当前工作区 / 全部 / 已登记 buttons exist; panel always requests all workspaces. |
| 5 | Registration & visibility | Agent `tmux_xc_adopt` in another chat → the open panel showed the `已采纳` badge 7.3 s after the turn started (version polling, no manual refresh). Plugin create registers in code (badge `已创建`); aliasing registers. |
| 6 | Approval switch | Default ON (source 默认): agent create → native approval card. Switched OFF in the panel → persisted after page reload (source 面板设置) → agent create ran with no card. Restored ON. Unit: precedence panel > explicit config > legacy per-key > ON; kill follows the switch; approval snapshot enforced even if the switch flips mid-card; DSH asks preserved. |
| 7 | Font size | A+ ×3 → 15 px; after page reload still 15 px; A− back to 12 px. |
| 8 | Send / submit | Reproduced the bug on a disposable Claude Code 2.1.302 TUI (API pointed at a dead local port, nothing sent out): a long text + Enter in one tmux invocation stays in the input box. With 0.1.1 the plugin's `send` (922-byte payload, Enter as a second guarded step) was submitted (`submission.state: cleared`) at the default 400 ms and even at 0 ms. Result separates `delivered` from `submission`; guard refusal of the text step stops before Enter; unknown Enter outcome is reported as unknown. |
| 9 | One-click navigation | With the sidebar closed, clicking the tmux chip in a sent message opened the tmux panel, selected and highlighted exactly the `ac-demo` pane and showed a read-only snapshot containing the marker (`只读快照，不是交互终端`). After restarting the tmux server with a look-alike `ac-demo` `%0`, the same chip showed `引用已失效：tmux 服务已重启`, selected nothing and showed no look-alike content. |

Not verified: Windows DSH desktop and Windows PowerShell 5.1/OpenSSH (user); the real `NaMILab` alias from Windows; tmux other than 3.0a; DSH other than 0.2.1-rc.2; hot reload (not supported).

---

# Test results — dsh-tmux-xc 0.1.0

Run on **NaMILab** (Linux, hostname `nami-SYS-4029GP-TRT`), 2026-10-17, by the project manager (centralized validation; sub-agents did not run tests). Windows desktop verification is left to the user (see [INSTALL.zh-CN.md](INSTALL.zh-CN.md)).

| Component | Version |
|---|---|
| DSH | 0.2.1-rc.2 (`dsh web`, isolated `DSH_HOME`, profile `xcweb`, model workbuddy deepseek-v4.1-flash) |
| tmux | 3.0a |
| OpenSSH | 8.2p1 (client and a user-level loopback `sshd` on 127.0.0.1:22220 with its own host key, `StrictHostKeyChecking yes`) |
| Node | 22.23.2 |
| Browser | Chromium 1248 via playwright-core (headless) |

Isolation: every test used a dedicated tmux socket (`-L xc-it-<random>`, `-L xc-e2e`) and disposable sessions; the user's default tmux server, `~/.ssh`, and `~/.dsh` were never touched. No test injected commands into pre-existing user panes.

## 1. Unit tests — 410 / 410 pass

`npm test` (`node --test test/unit/*.test.js`, ~0.35 s, no network). Files: core-quote, core-sanitize, core-transport, core-scripts, core-parse, uri, identity, registry, service, tools-policy, tools-integration (real DSH tool runtime/value validator), routes, index, index-rv1, hooks-rv1.

## 2. Integration tests (real ssh + real tmux 3.0a) — 30 / 30 pass

`XC_SSH_CONFIG=test-infra/sshd/ssh_config npm run test:integration` (~40 s). Setup: `scripts/test-infra.sh up`.

| Suite | Cases (PRD id) |
|---|---|
| transport | no server → `noserver` record, service `server:null`; alias with conflicting `LocalForward` + `ExitOnForwardFailure` works (ClearAllForwardings); host-key mismatch → `SSH_HOSTKEY`; refused → `HOST_UNREACHABLE` fast; AbortSignal cancels a read; argv has `BatchMode=yes`, `ClearAllForwardings=yes`, never disables host-key checking (A8) |
| service | A1/A5 create + rename keeps ref; A6 kill + recreate same name → `TARGET_GONE`; A7 server restart → `SERVER_RESTARTED`; A13 adopt non-invasive (global/session options, environment, pane content, pane pid identical); A3 literal send (`hello 你好 🌏 $(id) \`x\` 'q'`, no expansion), named-key allow-list; A11 kill needs exact confirm, detach keeps processes, forget only drops the entry; A12 new service over same registry resolves old ref, process survives; empty-server create, multi-pane parents, detach and last-session/window/pane kill |
| core safety (review RV1) | `cwd` containing `#(touch …)`/`#{…}`/`'`/space stays literal, no shell job; synchronized two-pane window → `SYNCHRONIZED_PANES`, no bytes delivered, option untouched; copy-mode / input-off / dead panes → distinct refusal codes; stale generation/ancestry cannot redirect queued actions; rejected first action → `REMOTE_ERROR` with tmux diagnostics; action failure stops later chunks/Enter; capture failure framed; multi-MB capture bounded remotely, UTF-8 boundary safe |
| hostile data | ANSI/OSC 0/OSC 52/U+202E/C1 output and a pane title containing `\x1e`, `\x1f`, newline and a forged `XC1…` record: no forged inventory entries, labels/output sanitized, fake tokens in output never parsed (A9) |
| concurrency | two conversations × 20 rounds of concurrent sends to two panes — no cross-talk; parallel inventories agree (A10) |
| no-replay | send aborted right after the script was written → `OUTCOME_UNKNOWN`, exactly one mutating spawn |

## 3. GUI acceptance in the installed DSH Web app — all pass

Plugin installed **from the packed tarball** (`dsh plugin --profile xcweb add …/dist/dsh-tmux-xc-0.1.0.tgz`, real copy, not a link), persistent registry (`storages/dsh_tmux_xc/`), DSH restarted after install. Driven with `scripts/e2e/acceptance.mjs`; every remote effect was verified out-of-band with `tmux -L xc-e2e capture-pane` hashes. Screenshots in [`docs/evidence/`](evidence/) (repository only, not shipped in the npm package).

| PRD | Scenario | Result | Evidence |
|---|---|---|---|
| A1 | Chat A asks the agent to create `demo-a` on host `lab` (ssh loopback) | native approval card (fully localized, lists host/socket/generation/cwd/parent/command) → approved → `$1 demo-a` exists; registry file `resources/…_s1.json` written | `A1-approval0.png`, `A1.png` |
| A2 | Chat B opens the tmux tab, clicks **引用** on pane `%1` | composer chip `NaMILab ssh loopback · demo-a:0.0 %1`; **0 messages sent**; remote panes unchanged | `A2-chip.png` |
| A3 | B asks to send `echo hello-from-B` + Enter to that pane | approval card shows 发送输入, ids `$1 @1 %1`, cwd, 追加回车 是, exact input → approved → only `%1` changed (`%0` hash identical); conversation reference persisted | `A3-approval0.png`, `A3.png` |
| A4 | Reload page, run `/compact` (11 records compacted), then "send `echo hello-after-compact` to the pane I referenced earlier" | history chip still rendered after reload; plugin re-announced the reference index after compaction; agent re-resolved (`OK`) and, after approval, only `%1` received the text | `A4-reload.png`, `A4-compacted.png`, `A4-after.png` |
| A12 | Stop and restart the DSH web process | pane ids, pane pids and server generation byte-identical; agent recovered the reference via `tmux_xc_references` from durable storage, resolved `OK`, captured read-only (no approval, nothing sent) | `A12.png` |
| A6/A7 (GUI) | Kill the tmux server, start a new one with a **same-name** `demo-a` (whose pane is again `%1`), ask the same chat to send | agent reports `SERVER_RESTARTED` (reference gen `3330620-…` vs observed `3339625-…`); no approval requested; the look-alike pane is unchanged | `A7-stale-gui.png` |
| A8 (GUI) | Host `down` (ssh alias to a closed port) | panel shows 不可达 with `HOST_UNREACHABLE: ssh failed: … Connection refused` | `A3.png` (panel) |
| — | `transport: local` host on the same machine | lists the same server without ssh | `A3.png` (panel) |

Persisted session log check (decoded from `session.v4.jsonl.zstd`): user messages store the canonical token `@[label](dsh-tmux:v1/lab/<fp>/e2e/<gen>/pane/<s>/<w>/<p>)`; after `compaction/summary` the next turn contains a source-attributed `tmux-xc-reference` user message listing the reference with its fresh resolution code.

## 4. Packaging

| Check | Result |
|---|---|
| `npm run pack:release` | `dist/dsh-tmux-xc-0.1.0.tgz` (lib, README×2, LICENSE, cordis.patch.yml, docs/*.md) |
| Fresh profile install from tarball | bundle auto-reconciled into `dsh.profile.bundles`; DSH peer packages (`@deepseek-ai/dsh-tools`, `dsh-storage-domain`, `schemastery`, `zod`) resolved by the DSH loader without a local `node_modules`; 11 tools registered; registry persisted |
| `dsh plugin remove` | bundle removed from the profile; config block and registry data untouched |
| Same-version reinstall | pnpm keeps the old copy — documented (`remove` then `add`) |

## 5. Defects found and fixed during validation (high level)

Found by central runs, live-DSH probing, and the independent sol-xhigh review ([review/RV1.md](review/RV1.md), 21 findings): missing end record on early exits; private-field declarations; transport envelope passed to parsers; client routes 404 (connection service probed at apply time); `transport: local` dropped by the config schema; non-transport errors shown as "unreachable"; `ctx.storage` accessed without injection (previously masked by a silent in-memory fallback — now fail-closed); tmux format injection through `-c` (`#(…)`); `synchronize-panes` broadcast; approval not bound to the approved identity; guard and action in separate tmux clients; created identity rebuilt from a later inventory; approval cards hiding Enter/control bytes; lifecycle disposal; tool outputs with `undefined`; mid-turn references not recorded; composer insertion offsets; profile-scope collisions; unbounded capture; tmux 3.0a `detach-client -s` requiring an attached client.

## 6. Not verified here

- Windows DSH desktop (by agreement, the user verifies with INSTALL.zh-CN.md).
- The real `NaMILab` alias from Windows; the loopback alias `xc-test` exercised the same OpenSSH code path on Linux.
- tmux versions other than 3.0a; DSH versions other than 0.2.1-rc.2.
- Hot reload (not supported; restart required).
