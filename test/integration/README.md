# Integration suite (real ssh + isolated tmux)

These tests exercise `lib/core/transport.js` against a real loopback sshd and `lib/service.js`
against a real, isolated tmux server (`-L xc-it-<random>`). They never touch the user's default
tmux server, `~/.ssh`, or any non-test socket.

## How to run

```sh
scripts/test-infra.sh up                       # loopback sshd on 127.0.0.1:22220 + ssh config
export XC_SSH_CONFIG=<repo>/test-infra/sshd/ssh_config
scripts/dev-link.sh                            # peer DSH packages for lib/registry.js
npm run test:integration                       # node --test --test-concurrency=1
```

`scripts/test-infra.sh down` stops the sshd afterwards. The whole suite is skipped, with an
explicit message, when `XC_SSH_CONFIG` is missing or `ssh -F "$XC_SSH_CONFIG" xc-test true`
fails. The suite never falls back to the user's normal ssh config.

## Fixtures

`helpers.mjs` builds a DESIGN §3 config (`makeConfig`) whose one socket is
`{id:'it', name:'xc-it-…'}` on the four hosts provisioned by `scripts/test-infra.sh`:

| host id | ssh alias        | purpose                                                    |
|---------|------------------|------------------------------------------------------------|
| `xc`    | `xc-test`        | normal target                                              |
| `fwd`   | `xc-test-fwd`    | conflicting `LocalForward` + `ExitOnForwardFailure yes`    |
| `bad`   | `xc-test-badkey` | host key mismatch → `SSH_HOSTKEY`                          |
| `down`  | `xc-unreachable` | connection refused → `HOST_UNREACHABLE`                    |

`makeService()` constructs `new TmuxXcService({ config, registry: memoryRegistry() })`.
`localTmux(sock, …args)` drives the same machine's tmux directly for out-of-band setup and
verification, which is safe here because the ssh target is the local Linux box and user.
`capturePane`/`waitForPaneText` poll the pane buffer through that local path, never through the
service under test.

## Isolation and cleanup

* Every test file picks its own `xc-it-<random>` socket; `assertTestSocket` rejects any name
  that is not `xc-it-*`, so a bad value can never address the default server.
* `t.after` runs `tmux -L <that socket> kill-server` only.
* Tests only kill panes/sessions they created themselves; no input is ever sent to a pane the
  test did not spawn. Hostile bytes are printed by a script the test writes to a temp dir.

## Files

| file | covers |
|------|--------|
| `transport.test.mjs` | no-server inventory (`noserver` record and `server:null`), `ClearAllForwardings` with a conflicting `LocalForward`, `SSH_HOSTKEY`, fast `HOST_UNREACHABLE`, abort → `CANCELLED`, argv safety (`BatchMode=yes`, `ClearAllForwardings=yes`, never `StrictHostKeyChecking=no`), and no-replay: a mutating `send` aborted right after spawn → `OUTCOME_UNKNOWN` with exactly one spawn observed. |
| `service.test.mjs` | A1/A5 create + rename (old ref still resolves with new labels), A6 kill + name reuse → `TARGET_GONE`, A7 server restart → `SERVER_RESTARTED`, A13 non-invasive adopt (global/session options, environment, pane content, pane pid unchanged), A3 literal `send` (Unicode, `$(id)`, backticks, quotes) + key allow-list (`C-c` allowed, `rm -rf` → `INVALID_ARGUMENT`), A11 kill confirm / detach keeps the process / forget drops the registry row only, A12 a new service over the same memoryRegistry still resolves the old ref while the process lives. |
| `hostile.test.mjs` | A9: ANSI colors, OSC 0 title, OSC 52 clipboard, bidi U+202E, C1 bytes, a fake token and a forged `XC1…`/pane title containing `\x1e`/`\x1f`/newline → inventory counts still match the real server (no forged entries), labels sanitized, captured text has no ESC/C1/bidi/NUL, and the fake token is never parsed as a reference. |
| `concurrency.test.mjs` | A10: two conversations send 20 rounds of 2 concurrent sends each to two different panes; each pane receives only its own strings, exactly once; parallel inventories agree. |

## Notes

* `node --test --test-concurrency=1` is the supported mode; each ssh call costs roughly
  0.2–1 s (the unreachable host waits for its 3 s `ConnectTimeout` once).
* Timeouts are generous (120–240 s per file) because ssh setup and the `HOST_UNREACHABLE`
  classification are not instantaneous.
* Prerequisites are the installed peer packages (`scripts/dev-link.sh`) only — no new
  dependencies, plain ESM, Node ≥ 22.
