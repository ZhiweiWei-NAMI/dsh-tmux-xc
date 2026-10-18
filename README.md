# dsh-tmux-xc

**Remote tmux tasks, shared across DeepSeek Harness (DSH) conversations.**

See tasks across configured hosts, reference an exact pane in a chat, and ask the agent to capture output, send input, or delete a finished task. References preserve identity rather than guessing by name; approvals and explicit deletion scopes keep control visible.

[中文](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-tmux-xc) · **0.1.1** · Node ≥ 22

## Use cases

- Check the latest output of a long training run from another DSH conversation.
- Hand a running CLI agent a prompt, then capture its screen to check whether it was submitted.
- Clean up a finished experiment's tmux session without deleting its files or targeting other sessions.
- Jump from a sent chat reference back to the exact pane and its recent output.

## Feature tour

Real screenshots from an installed, isolated DSH instance with disposable demo tasks—not production workloads. The UI uses English; reference labels still contain Chinese kind words such as **窗格** (pane).

| Task tree | Approval switch |
|---|---|
| ![Host-to-task tree with aliases and an unreachable host](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/task-tree.png) | ![Plugin approval ON by default, with host-rules notice](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/approval-switch.png) |
| Display aliases expose child tasks; unreachable hosts stay visible. | One switch, default ON; DSH host rules still apply. |

![Sent conversation reference revealing the exact pane and read-only capture](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/reference-navigation.png)

A sent reference opens the exact pane; the agent reads demo output without sending input.

<details>
<summary>Snapshot and deletion dialogs</summary>

![Exact pane selected with an enlarged read-only snapshot](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/snapshot-preview.png)

Enlarge the snapshot with A−/A+; it is read-only, not an interactive or streaming terminal.

![Delete session confirmation naming its exact scope](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/delete-dialog.png)

Delete names the object and affected processes; no files are deleted.

![Host removal with remote mode explicitly chosen and no sessions selected](https://raw.githubusercontent.com/ZhiweiWei-NAMI/dsh-tmux-xc/v0.1.1/docs/images/host-remove-dialog.png)

Host removal defaults to plugin-only; shown here after choosing remote mode, with no sessions preselected.

</details>

## Install & quick start

Requires **Node ≥ 22**, DSH (**0.2.1-rc.2 tested**), **tmux ≥ 3.0a** on the target host (**3.0a tested**), and OpenSSH with a working non-interactive SSH alias.

Replace `<profile>` with your DSH profile name:

```sh
dsh plugin --profile <profile> add dsh-tmux-xc@0.1.1
```

Add this block to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`, replacing `gpu-server` with your SSH alias and the alias hint with your actual tmux names:

```yaml
- id: tmux-xc
  config:
    hosts:
      - id: gpu
        label: GPU server
        ssh: gpu-server
        aliases:
          - { session: train-llm, alias: "LLM training" }
    approval:
      enabled: true
```

Alias hints are display-only: they do not create or rename remote tasks. A local alias for an exact target takes precedence over a config hint. See the [installation guide (中文)](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/INSTALL.zh-CN.md) for sockets and other settings.

1. **Restart DSH and reload the page**—installation/configuration has no hot reload.
2. Open **tmux**, find a task, and click **Reference pane**. Wait until the chip is visible before sending your message; inserting it sends no tmux input.
3. Ask “Capture the recent output; do not send input.” Click the sent chip to return to that pane. For deliberate input, ask the agent to send and approve when prompted.

**Upgrading from 0.1.0:** run `dsh plugin --profile <profile> remove dsh-tmux-xc`, then the add command above; restart DSH. Review the [migration notes](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/CHANGELOG.md#migration-010--011).

## Safety & behavior at a glance

| Topic | Behavior |
|---|---|
| **Approval** | Default **ON**: agent create/send/delete/detach ask. **OFF** removes extra plugin approval on configured, non-removed hosts—not DSH host rules or SSH authentication. Owner-side delete/remove confirmations remain. Precedence: panel setting → explicit `approval.enabled` → legacy per-key `allow` (create/send/detach only) → ON. |
| **Delete** | Kills exactly the selected pane, window, or session and its contained tmux resources/processes. No file deletion or server-wide kill command. Read the scope: a collapsed task row can offer **Delete session**, not Delete pane. |
| **Remove host** | Defaults to **plugin-only**: hide the host and purge its registrations/aliases; remote tmux keeps running. Both modes require typing the host ID. Remote termination additionally requires explicitly choosing that mode and selecting sessions (initially none). The host is removed only if all selected kills succeed. Profile config is unchanged; restoring visibility does not restore purged metadata. |
| **Unregister** | Removes only one registration record—not remote processes, registered children, aliases, or chat history. Detach is different again: it disconnects clients while tasks keep running. |
| **Registration** | Plugin-created targets register automatically. Shell-created targets need adoption (`tmux_xc_adopt`) to register; Reference/alias actions also adopt as needed. Live inventory covers configured, non-removed hosts/sockets regardless of registration or workspace. |
| **Send** | Text and Enter are separate guarded steps. `delivered` means delivery, **not execution**; `submission.state: cleared` is a heuristic, **not proof of execution**. Capture/inspect before recovery; never blindly resend text. |
| **Identity** | References bind host, socket, server generation, and tmux IDs—not display names. Stale references fail explicitly and **never retarget** a replacement. |
| **Snapshot / attach** | Snapshots are read-only, point-in-time text; refresh for new output. Session/window references capture their active pane. For an interactive terminal, use **Copy attach** externally; the SSH alias/config must exist on the machine where you paste it. |

## Tested / not tested

**Tested:** DSH **0.2.1-rc.2 Web on Linux**, Node 22, tmux **3.0a**, and OpenSSH on Linux. Independent SOL hands-on evaluation and ASTRA evidence/source review accepted the runtime baseline `c600ece`; this release keeps `lib/` unchanged. Send was observed on a shell and **Claude Code 2.1.302**: the Claude prompt was submitted, but no successful model response was produced.

**Not verified:** Windows / Windows PowerShell 5.1, macOS, other DSH or tmux versions, or other TUIs beyond the shell and Claude Code on the accepted runtime. **`cmd.exe` is unsupported; local-transport PowerShell is disabled.** PowerShell 7.6 on Linux was checked by the manager, not the independent evaluator.

[Known limitations](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/KNOWN-LIMITATIONS.md) · [Compatibility](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/COMPATIBILITY.md) · [Usage (中文)](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/USAGE.zh-CN.md) · [Install (中文)](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/INSTALL.zh-CN.md) · [Changelog](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/CHANGELOG.md) · [Test results & evidence scope](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/docs/TEST-RESULTS.md)

## License

[MIT](https://github.com/ZhiweiWei-NAMI/dsh-tmux-xc/blob/v0.1.1/LICENSE).
