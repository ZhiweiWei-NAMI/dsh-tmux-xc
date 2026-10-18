// Integration suite for dsh-tmux-xc.
//
// These tests exercise lib/core/transport.js against a real loopback sshd and
// lib/service.js against a real, isolated tmux server (`-L xc-it-<random>`). They never touch
// the user's default tmux server, ~/.ssh, or any non-test socket.
//
//   1. scripts/test-infra.sh up                       # loopback sshd + ssh config
//   2. export XC_SSH_CONFIG=<repo>/test-infra/sshd/ssh_config
//   3. scripts/dev-link.sh                            # peer DSH packages for lib/registry.js
//   4. npm run test:integration                       # node --test --test-concurrency=1
//
// The whole suite is skipped (with an explicit message) when XC_SSH_CONFIG is missing or
// `ssh -F "$XC_SSH_CONFIG" xc-test true` fails.

## Fixtures

`helpers.mjs` builds a DESIGN §3 config (`makeConfig`) whose one socket is `{id:'it',
name:'xc-it-…'}` on the four hosts provisioned by `scripts/test-infra.sh`:

| host id | ssh alias       | purpose                                                   |
|---------|-----------------|-----------------------------------------------------------|
| `xc`    | `xc-test`       | normal target                                             |
| `fwd`   | `xc-test-fwd`   | conflicting `LocalForward` + `ExitOnForwardFailure yes`   |
| `bad`   | `xc-test-badkey`| host key mismatch → `SSH_HOSTKEY`                         |
| `down`  | `xc-unreachable`| connection refused → `HOST_UNREACHABLE`                   |

`makeService()` constructs `new TmuxXcService({ config, registry: memoryRegistry() })`.
`localTmux(sock, …args)` drives the same machine's tmux directly for out-of-band setup and
verification, which is safe here because the ssh target is the local Linux box and user.

## Isolation and cleanup

* Every test file picks its own `xc-it-<random>` socket; `makeConfig` rejects any other name.
* `t.after` runs `tmux -L <that socket> kill-server` only.
* Tests only kill panes/sessions they created themselves; no input is ever sent to a pane the
  test did not spawn. Hostile bytes are printed by a script the test writes to a temp dir.

## Files

| file | covers |
|------|--------|
| `transport.test.mjs` | no-server inventory, `ClearAllForwardings` with a conflicting `LocalForward`, `SSH_HOSTKEY`, fast `HOST_UNREACHABLE`, abort → `CANCELLED`, argv safety (`BatchMode=yes`, `ClearAllForwardings=yes`, never `StrictHostKeyChecking=no`). |
| `service.test.mjs` | A1/A5 create + rename, A6 name reuse → `TARGET_GONE`, A7 `SERVER_RESTARTED`, A13 non-invasive adopt, A3 literal `send` + key allow-list, A11 kill confirm / detach / forget, A12 restart with the same registry. |
| `hostile.test.mjs` | A9: ANSI/OSC/C1/bidi titles and output, forged `XC1` framing, a fake `@[x](dsh-tmux:…)` token → inventory counts unchanged, output sanitized, tokens never parsed from captured text. |
| `concurrency.test.mjs` | A10: two conversations, 20 concurrent sends each to two different panes, no cross-talk or duplicates; parallel inventories agree. |
| `mutation.test.mjs` | no-replay: an abort right after spawn for a mutating `send` → `OUTCOME_UNKNOWN` with exactly one spawn observed. |

## Notes

* `node --test --test-concurrency=1` is the supported mode; each ssh call costs ~0.2–1 s.
* Timeouts are generous (120–240 s per file) because `HOST_UNREACHABLE` waits for the ssh
  `ConnectTimeout` and mutation classification needs a stable ssh session.
* Prerequisites are installed peers (`scripts/dev-link.sh`) only — no new dependencies.
