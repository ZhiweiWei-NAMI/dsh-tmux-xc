# Route contract v2 (binding for RF-A host and RF-B client)
All responses JSON. Errors: HTTP 4xx/5xx with `{ ok:false, error:{ code, message } }` (stale/changed identity → 409).
- GET  /api/tmux-xc/hosts → `{ ok:true, hosts:[{ id, label, transport:'ssh'|'local', ssh?: '<alias>', sockets:[{ id, name?: '<-L name>', path?: '<-S path>' }] }] }`
- GET  /api/tmux-xc/inventory[?all=1&workspace=…&host=…] → `{ ok:true, hosts:[{ id, label, status:'ok'|'unreachable'|'error', error?:{code,message}, verifiedAt, sockets:[{ id, server:{gen,socketPath}|null, sessions:[…nodes…] }] }] }`; every session/window/pane node carries `uri`, `token` (canonical, see below), `label`, `adopted`, `origin?`, `state?`, `key?`, `lastVerifiedAt?`.
- POST /api/tmux-xc/adopt body `{ target: '<dsh-tmux uri>', workspace?: string, sessionId?: string }` → `{ ok:true, entry:{ uri, token, label, key, origin, state } }`. The server adopts exactly the identity in the uri (same generation) or fails 409 with SERVER_RESTARTED/TARGET_GONE/HOST_IDENTITY_CHANGED; it never substitutes a newer generation.
- POST /api/tmux-xc/forget body `{ key }` or `{ uri }` → `{ ok:true, removed:boolean }`
- GET  /api/tmux-xc/resolve?uri=… → `{ ok:true, code, label?, target?, warnings:[] }` (absent fields omitted, never undefined)
Canonical token = `formatToken(labelFor(hostLabel, target), uri)` — the same full label (e.g. `NaMILab · demo-a:0.0 %3`, tokenSafeLabel ≤ 80) is used for the composer chip, the stored message token and the history chip. The client must insert `entry.token` from the adopt response verbatim.
