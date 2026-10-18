# Test results — dsh-tmux-xc 0.1.1

## Summary — accepted with scoped qualifications

> **0.1.1 released 2026-10-18 to [npm](https://www.npmjs.com/package/dsh-tmux-xc) and [GitHub](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/releases/tag/v0.1.1), tag `v0.1.1`.** Runtime `lib/` is identical to the independently accepted baseline `c600ece`. Independent SOL clicks verified the fixes; ASTRA checked the evidence and diff. Acceptance remains scoped to the observations below.
>
> - The unified task tree exposes child task names, including the developer task. Plugin-created targets register automatically; other targets need adoption for registration.
> - Copy commands target the selected resource. SSH aliases/config must exist on your connecting machine; local Bash runs on the tmux machine. Local PowerShell is disabled; Windows remains unverified.
> - Delete really terminates the selected pane/window/session. Host removal defaults to plugin-only; remote termination requires explicit session selection. Unregister removes one record, not descendants, and leaves tmux running.
> - Approval defaults ON and persists. OFF permits authorized create/send/delete without extra plugin cards; an independent DSH deny still blocked creation. Font size persists in this browser.
> - One-shot shell execution and real Claude prompt submission passed. Delivery or `cleared` does not prove execution or a successful model response.
> - Sent references open the exact target's read-only snapshot; tested stale/restarted references fail without retargeting.
>
> Reviewer model/effort routing was configured, but runtime attestation is unavailable. Publication does not broaden the evaluated platform or feature scope.

## Release artifact and accepted runtime

The release commit changes **presentation only**: READMEs, screenshots, documentation, and package discovery metadata. It does not change `lib/`. No tests were rerun for this release-writing pass; the runtime evidence below is retained, not presented as a new campaign. The README screenshots were captured separately by the manager from the installed isolated candidate with disposable demo tasks; they illustrate the UI, not additional independent acceptance tests.

**Accepted baseline.** `dsh-tmux-xc` **0.1.1**, branch `v011-int`, commit **`c600ecedf2e5504481e89a6aa8439478dd6b2a8d`** = `1ee6f78` + lane A `802b872` + lane B `b55b75d`. The manager installed and restarted the pre-marketing package; independent SOL verified all **15 installed `lib` files** against `git show c600ece:lib/...` byte-for-byte.

**Do not confuse the artifacts.** SHA-1 **`b39fe0019ebffd6aeb49a78b7f86362bf72dea07`** identifies the accepted **pre-marketing tarball**, **not** the published tarball. The published package includes updated documentation. Its digest is npm's **`dist.shasum`** in the [0.1.1 registry record](https://registry.npmjs.org/dsh-tmux-xc/0.1.1), also recorded on the [GitHub release](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/releases/tag/v0.1.1). Version alone does not identify the evaluated artifact.

## Runtime acceptance — 0.1.1 at `c600ece`

**Environment.** Isolated installed profile `xcweb` (`test-infra/dsh-home`), loopback web port 3190; DSH **0.2.1-rc.2**, tmux **3.0a**, Chromium **156.0.8078.4**, viewport 1500×950. Disposable `xc-e2e` / `xc-local` and reviewer-owned sockets; no live AC, AeroWorld or developer target, no user credentials, no production DSH configuration. This is not an exhaustive OS process audit.

**Reviewers and routing.** **SOL** (independent hands-on evaluator, not the fixes' author) ran the browser clicks; **ASTRA** (independent judge) reviewed the evidence and diff read-only. Routing statement: "SOL runs via dsh profile codex_sol + sol-high (openai-codex gpt-6.1-sol, reasoning effort high); ASTRA via codex_astra + astra-high (gpt-6-astra, high) — configured routing; DSH 0.2.1-rc.2 does not record the model/effort actually used." These are configured routes, not runtime attestation; no substitute reviewer is claimed. The `WorkBuddy / DeepSeek / High` shown in screenshots is the agent under test.

**Evidence classes (kept separate).**

| Evidence | What it establishes | Scope |
|---|---|---|
| Independent SOL recheck, `c600ece` (retained private report, action logs, traces, command/PID evidence) | Actual browser clicks and functional checks on the fixed candidate: one-shot submission, sent-history/stale navigation, changed UI, approval OFF, independent DSH host deny | 15 installed files matched; driver timeouts and the attempt sent before asynchronous chip insertion are not counted as passes |
| Independent ASTRA acceptance, `c600ece` | Evidence/source judgment on all nine requirements; no remaining functional blocker; documentation corrections subsequently applied | Read-only review; ran no tests, browser or tmux |
| Reused independent SOL click evidence, `1ee6f78` (tarball SHA-1 `3762dc52a9666b753eff282018c80aeed12ec407`) | Baseline task tree, copy/clipboard, deletion/unregister, unified inventory, registration, approval ON/OFF/persistence, font size — and the two original blockers | Reused as delta baseline, not re-run on `c600ece` |
| Manager automated runs | Unit **555 / 555** and real-SSH/tmux integration **34 / 34** reported for the fixed tree, plus a direct-service `%17` probe | Manager-reported, supplemental; **not** independent SOL clicks, not rerun by ASTRA |
| Manager GUI runs (historical `1ee6f78`, 549/549 and 33/33) | Earlier manager-observed behaviour, including GUI acceptance | Historical; rows 8/9 below were contradicted as final acceptance |

Earlier automated totals for `1ee6f78` were 549/549 unit and 33/33 integration; the figures above for the fixed candidate are the manager's later run. Test counts are recorded for provenance only — the acceptance rests on the independently recorded clicks and effects.

### Nine requirements on the fixed candidate (scoped)

| # | Current status | Independent basis and user-facing boundary |
|---|---|---|
| 1 | Pass, scoped | Collapsed `claude-ready` now shows "包含：tmux 插件开发"; the expanded pane is not a duplicate alias. Session/task tree retained; not a new task ontology. |
| 2 | Pass with platform qualifications | Local Bash clipboard `$0` and prior executed Bash session/window/pane commands; local PowerShell disabled/explained. SSH alias/config must exist on the connecting machine. No PowerShell/Windows execution by SOL. |
| 3 | Pass, scoped | UI deletion of `%23` preserved sibling `%24` and its PID; host removal killed only the selected `sol-r-host` and preserved `local-demo` PID 3822106; settled plan defaults to plugin-only, remote mode starts empty. Unreachable dialog inspected and cancelled, not submitted. No OS-wide process audit. |
| 4 | Pass — reused | Unified inventory of configured hosts/sockets; no competing workspace/all/registered controls; out-of-workspace targets stayed visible. |
| 5 | Pass, scoped | GUI-agent creation returned a registered session and a created badge; developer task discoverable via the new subtitle. Arbitrary shell-created targets are not automatically registered; live discovery and registration differ. |
| 6 | Pass, scoped | Persistent switch, default ON; OFF create → send → delete ran with no extra plugin cards. An independently installed DSH `tools/pre-execute` deny rejected one create on an allowed host with no target change. Not a built-in permissions-UI test; send/delete/detach denials and direct owner routes were not covered by that policy. |
| 7 | Pass — reused | First SOL's 14px persisted across page and isolated DSH restart; the recheck ended at restored 12px. Browser-local, not cross-device. |
| 8 | Pass for observed shell and real Claude Code | Exactly one text-plus-Enter send each to `%21` and `%22`; both acknowledged text and Enter; shell scratch file proves one execution. Claude Code 2.1.302 shows the prompt in history above an empty input box; the dummy-key/loopback API failed, so there was **no successful model response**. `cleared` remains a heuristic. |
| 9 | Pass for tested sent-history/stale paths | Sent chip → click selected only `%21` with its marker, also after reload; the previously broken stored message now renders and fails stale; same-name replacement and a restarted look-alike server gave zero selection/no replacement preview (`SERVER_RESTARTED`). |

**Observed vs. inferred.** The rows above are observed browser/tmux effects or read-only source verification. **Inferred, not observed:** that the fixes generalise to other TUIs, other tmux versions, Windows or macOS. **Untested:** Python (intentionally not repeated), multiline/Unicode payloads, a successful Claude response, renamed/moved targets, arbitrary host policies beyond the custom deny, actual unreachable-host removal and mixed-success host termination, and cross-device font sync.

**Cleanup and residual metadata.** Reviewer-created sessions were deleted through the UI or explicit isolated-socket cleanup, and the temporary policy and profile edits were restored byte-for-byte. Afterwards, clearing a deleted session's alias through the ordinary API returned `409 TARGET_GONE`, so the historical evaluator alias "SOL Recheck Shell Task" may remain in alias storage; no corresponding tmux process or registered target remains. This is disclosed cleanup metadata, not a functional defect. No live fixture pane IDs/PIDs changed; that is tmux-scope evidence, not a global subprocess audit.

**Coverage boundary.** Release authorization is separate from runtime acceptance. This evidence does not certify Windows/macOS or every CLI, and does not cover later implementation changes. This release retains the accepted `lib/` bytes; any future runtime change needs its own proportional review. The underlying independent review records are retained privately, not shipped in the repository or npm package.

---

# Historical — 0.1.1 at `1ee6f78` (superseded as final acceptance)

Run on **NaMILab** (Linux), 2026-10-18, by the project manager (sub-agents generated code and did not run tests). Same toolchain as 0.1.0 below (DSH 0.2.1-rc.2 in an isolated `DSH_HOME`, tmux 3.0a, OpenSSH 8.2p1 loopback sshd, Node 22.23.2, headless Chromium). The user's live DSH, `~/.ssh`, default tmux server and existing tasks (AC, AeroWorld, the developer pane) were never driven; destructive checks used disposable sessions on dedicated sockets.

This was the manager's own run on `1ee6f784642f072d8e6f10df4daec0acea424ce0` (tarball SHA-1 `3762dc52a9666b753eff282018c80aeed12ec407`). Independent SOL then reproduced two blockers on the same commit, and ASTRA did not accept it. The rows below are retained as historical manager observations, not as final acceptance.

| Check | Result |
|---|---|
| Unit (`npm test`) | **549 / 549** (earlier automated result) |
| Integration, real ssh + tmux 3.0a (`npm run test:integration`) | **33 / 33** (earlier automated result; adds `send-submit`: Ink-like raw-mode TUI submits; sticky line → `submission.state: pending`) |
| Independent reviews (sol-xhigh, not the authors) | RV-A safety/approval: 8 findings; RV-B correctness/navigation/simplicity: 17 findings — **static reviews only**: no browser, SSH, tmux or test execution, so they are not click testing or functional acceptance |
| Package | `dist/dsh-tmux-xc-0.1.1.tgz`, installed from the tarball into the isolated profile (remove + add), DSH restarted |

## 0.1.1 manager observations on 1ee6f78

| # | Item | Historical observation |
|---|---|---|
| 1 | Task-centric tree | GUI: simple mode lists `host → task` rows; single-window/single-pane tasks are one row; multi-pane task lists `窗格 0 · bash`, `窗格 1 · bash`; no `$ @ %` ids, generation or socket in simple mode; all appear in 高级详情. Alias `AC` set from the panel: row title `AC`, remote name `ac-demo` kept as secondary; inventory shows the session registered with `alias: AC` (local). |
| 2 | Copy-attach commands | Panel copies labelled Bash and PowerShell strings (cmd.exe tooltip: not supported). Executed for a pane target on a disposable server: Bash → client attached to session `task one` (name with a space) with `@1 %1` selected; PowerShell 7.6.7 in both `Standard` and `Legacy` native-argument modes → `@1 %2` selected. Both include `-o ClearAllForwardings=yes`. Windows PowerShell 5.1 + Windows OpenSSH: **not verified**. |
| 3 | Real delete | GUI 删除会话 dialog shows remote name, host, socket, kind and “all windows/panes and processes end; no files deleted; other sessions unaffected”; one click → only `del-me` disappeared (out-of-band `tmux list-panes` diff). 移除主机: unreachable host offers only plugin-only removal with an explanation; reachable host — only `rm-sel` selected → only `rm-sel` killed (diff), host removed after all kills succeeded, result row `NaMILab ssh loopback · 会话 rm-sel: 已终止`; restored from 高级详情. Unit: invalid batches kill nothing; partial failure keeps the host. |
| 4 | Workspace/all | No 当前工作区 / 全部 / 已登记 buttons exist; panel always requests all workspaces. |
| 5 | Registration & visibility | Agent `tmux_xc_adopt` in another chat → the open panel showed the `已采纳` badge 7.3 s after the turn started (version polling, no manual refresh). Plugin create registers in code (badge `已创建`); aliasing registers. |
| 6 | Approval switch | Default ON (source 默认): agent create → native approval card. Switched OFF in the panel → persisted after page reload (source 面板设置) → agent create ran with no card. Restored ON. Unit: precedence panel > explicit config > legacy per-key > ON; kill follows the switch; approval snapshot enforced even if the switch flips mid-card; DSH asks preserved. |
| 7 | Font size | A+ ×3 → 15 px; after page reload still 15 px; A− back to 12 px. |
| 8 | Send / submit | **Historical manager observation — contradicted as final acceptance on `1ee6f78`.** The manager reported that a long text + Enter submitted with the plugin's guarded two-step send (`submission.state: cleared`) at 400 ms and at 0 ms. Independent SOL clicks on the same commit observed typed-but-unsubmitted text and `OUTCOME_UNKNOWN` on a shell, a Python REPL and real Claude Code 2.1.302 (first independent SOL evaluation, submission section). The cause of the discrepancy is **not proven**; the earlier claim is retained as history only. Fixed in `c600ece` (literal-percent acknowledgement repair) and rechecked — see the current section. |
| 9 | One-click navigation | **Historical manager observation — contradicted as final acceptance on `1ee6f78`.** The manager reported that a sent-message tmux chip selected the exact `ac-demo` pane and showed a read-only snapshot, and that a restarted look-alike `%0` produced `引用已失效：tmux 服务已重启`. Independent SOL clicks on the same commit instead got a built-in file chip pointing at a nonexistent file (first independent SOL evaluation, navigation section). Whether the manager's run depended on live page state is a hypothesis, not a proven reconstruction; the earlier claim is retained as history only. Fixed in `c600ece` (sent-user-text precedence) and rechecked — see the current section. |

Not verified in that run: Windows DSH desktop and Windows PowerShell 5.1/OpenSSH (user); the real `NaMILab` alias from Windows; tmux other than 3.0a; DSH other than 0.2.1-rc.2; hot reload (not supported).

---

# Historical — dsh-tmux-xc 0.1.0

Run on **NaMILab** (Linux, hostname `nami-SYS-4029GP-TRT`), 2026-10-17, by the project manager (sub-agents did not run tests). Windows desktop verification is left to the user (see [INSTALL.zh-CN.md](INSTALL.zh-CN.md)).

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

Found by central runs, live-DSH probing, and the independent sol-xhigh review ([review/RV1.md](review/RV1.md), 21 findings; static review, not click testing): missing end record on early exits; private-field declarations; transport envelope passed to parsers; client routes 404 (connection service probed at apply time); `transport: local` dropped by the config schema; non-transport errors shown as "unreachable"; `ctx.storage` accessed without injection (previously masked by a silent in-memory fallback — now fail-closed); tmux format injection through `-c` (`#(…)`); `synchronize-panes` broadcast; approval not bound to the approved identity; guard and action in separate tmux clients; created identity rebuilt from a later inventory; approval cards hiding Enter/control bytes; lifecycle disposal; tool outputs with `undefined`; mid-turn references not recorded; composer insertion offsets; profile-scope collisions; unbounded capture; tmux 3.0a `detach-client -s` requiring an attached client.

## 6. Not verified here

- Windows DSH desktop (by agreement, the user verifies with INSTALL.zh-CN.md).
- The real `NaMILab` alias from Windows; the loopback alias `xc-test` exercised the same OpenSSH code path on Linux.
- tmux versions other than 3.0a; DSH versions other than 0.2.1-rc.2.
- Hot reload (not supported; restart required).
