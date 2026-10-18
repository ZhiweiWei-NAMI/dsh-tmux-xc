# dsh-tmux-cc fork note

This summarizes `research/dsh-tmux-cc-eval.md` (read-only source investigation of upstream `dsh-tmux-cc` 0.5.3 / 0.6.0 / GitHub 0.7.1). **Status: documented, not implemented.** `dsh-tmux-xc` does not depend on `dsh-tmux-cc` at runtime, and no fork has been built.

## 1. Why `dsh-tmux-cc` is not a runtime dependency

Upstream is a local-only user cockpit (a persistent browser dock rendering panes into xterm) with **no agent tools**. Using it unmodified as the transport/terminal backend for `dsh-tmux-xc` fails on several independent counts:

| Reason | Evidence |
|---|---|
| **tmux ≥ 3.2 attach flags** | It attaches with `attach-session -f ignore-size` and sizes via `refresh-client -f`; both the `-f` flag and the `ignore-size` value require tmux **3.2**. On the 3.0a floor this attachment fails as shipped. |
| **`client_flags` (3.2)** | It queries the `client_flags` format; that field was added in 3.2. |
| **`#{L:}` (3.4) in GitHub 0.7.1** | HEAD (0.7.1, `87aa2a7`) uses a `#{L:...}` client loop for its guarded detach; client loops first exist in tmux **3.4**. |
| **Local-only spawn in two code paths** | The persistent control client is `spawn(tmuxBin, ...)` and session discovery is a separate `execFile(tmuxBin, ['list-sessions', ...])`. `tmuxBin` is an *executable path*, not a shell command, so `ssh NaMILab tmux` cannot work as-is; **both** paths would need a transport seam, and even then OpenSSH joins remote argv with spaces (a remote shell re-parses them), so safe SSH needs per-arg POSIX quoting. |
| **Removed `dsh-settings` helpers** | 0.6.0 imports `installSettingsSection`/`settingsNamespace` from `@deepseek-ai/dsh-settings`; the eval notes these named exports disappeared in DSH 0.1.2 (GitHub 0.7.1 replaced them with direct `settings.register`). Compatibility with 0.2.1-rc.2 is unverified and likely broken. |
| **Host/Origin-only route fence** | Its HTTP/WS routes are fenced only by Host/Origin checks, with **no** cookie/session/token/Authorization validation. Treating them as a DSH-authenticated surface would be unsound. |
| **No agent tools** | No snapshot registers any tool-provider, agent-context injection, or MCP registration; it exposes only a web dock/settings UI. |
| **npm 0.6.0 vs GitHub 0.7.1 gap** | The published npm package is 0.6.0; 0.7.1 (session/client manager, pane swap, newer mobile UI, `#{L:}` guard) is GitHub-only. `dsh plugin add dsh-tmux-cc` delivers 0.6.0, not the HEAD manager. |

Net: 0.5.3/0.6.0/0.7.1 are all tmux-3.2+ (or 3.4+), local-only, settings-fragile, weakly-fenced, and agent-less. None of them can serve as the runtime backend for an agent-facing, SSH, tmux-3.0a plugin.

## 2. What is pinned instead

- The **core user experience** of `dsh-tmux-xc` (panel + references + agent tools) is implemented directly against DSH primitives; it does not use `dsh-tmux-cc`.
- If a **live terminal view** is desired later, the optional add-on is a **fork pinned to npm `dsh-tmux-cc@0.6.0`** (MIT), keeping its working renderer and applying the smallest transport/legacy patch. Do not use an unpinned GitHub branch; if the richer cockpit is required, pin **0.7.1 / `87aa2a7`** and additionally adapt its remote-cwd and pre-3.4 manager code.
- Until that fork exists and is verified, the panel offers **Copy attach command** (`ssh -t <alias> tmux … attach -t '$N'`) for the user's own terminal or the official DSH terminal panel.

## 3. Smallest upstream change (diff sketch, from eval §8)

A transport-only patch to 0.6.0: carry a process-invocation builder through the runtime and apply it to both the control spawn and the session-list exec. Sketch, not an applied implementation:

```diff
 // composition config: index -> RuntimeConfig -> control client/CLI runner
+ commandPrefix?: string[]       // e.g. ["ssh", "-T", "NaMILab", "--"]
+ prefixShell?: 'posix'          // remote command quoting; absent for argv wrappers
+ tmuxArgs?: string[]           // global args, e.g. ["-u", "-L", "research"]

+ function posixQuote(s) { return "'" + s.replaceAll("'", "'\\''") + "'" }
+ function invocation(bin, args, cfg) {
+   const target = [bin, ...(cfg.tmuxArgs ?? []), ...args]
+   const prefix = cfg.commandPrefix ?? []
+   if (!prefix.length) return { file: target[0], args: target.slice(1) }
+   const tail = cfg.prefixShell === 'posix'
+     ? ['exec ' + target.map(posixQuote).join(' ')]
+     : target
+   return { file: prefix[0], args: [...prefix.slice(1), ...tail] }
+ }

 // defaultTransport (N6/dist/tmux-client.js:514–523)
- const child = spawn(tmuxBin, args, options)
+ const call = invocation(tmuxBin, args, cfg)
+ const child = spawn(call.file, call.args, options) // pipes; shell:false
+ // Forward child 'error' to pending commands/UI, as well as exit/stderr.

 // listSessionsCli (N6/dist/tmux-client.js:442–456)
- await execFileAsync(tmuxBin, inventoryArgs, { timeout: 2000 })
+ const call = invocation(tmuxBin, inventoryArgs, cfg)
+ await execFileAsync(call.file, call.args, { timeout: configuredCliTimeout })
- catch { return [] }
+ // Return [] only for tmux's verified missing-server/no-sessions responses;
+ // propagate SSH auth/network/host-key errors, missing executables and timeouts.
```

For example, config resolves to local executable `ssh.exe` with `-T NaMILab --` and **one** remote command string equivalent to `exec 'tmux' '-u' '-C' 'attach-session' '-t' '=project'` in legacy mode. The SSH alias stays administrator-owned; `commandPrefix`, binary paths, and SSH flags must never be exposed as browser/agent input, and the timeout must accommodate a real SSH connection (not a 2 s network timeout silently producing "empty inventory").

Three further changes are required beyond generic SSH support:

1. **tmux 3.0a capability branch** — omit attach `-f`, avoid `client_flags`, disable dynamic sizing writes, and advertise mirror-only legacy capability (an untouched pipe control client is already excluded from sizing on 3.0a). Do not represent unavailable flags as `false` or failed inventory as zero clients.
2. **DSH settings compatibility** — port 0.7.1's direct `settings.register` (or equivalent confirmed against the target DSH API), replacing 0.6.0's removed `dsh-settings` named imports.
3. **Failure/identity integrity** — propagate subprocess `error`; narrow the inventory-error handling; report malformed required numbers instead of `Number(...) || 0` / 80×24 substitutes; introduce remote/server identity in the companion.

This is documented as the intended shape of a future fork, not a completed or verified implementation.
