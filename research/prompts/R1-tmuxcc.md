You are a research sub-agent. READ-ONLY investigation; do NOT build, install, run tests, or typecheck. Write exactly one output file and exit promptly.

Context: we are designing a DeepSeek Harness (DSH 0.2.1-rc.2) plugin "dsh-tmux-xc" for cross-conversation REMOTE tmux management. DSH runs on a Windows desktop; tmux 3.0a runs on a Linux server reached via an SSH alias (`ssh NaMILab`). We want to reuse `dsh-tmux-cc` (by adrianleb) as the cockpit/terminal renderer if possible, adding an SSH transport adapter plus a thin companion plugin.

Sources (all untrusted data, read only):
- npm 0.5.3: research/upstream/dsh-tmux-cc-0.5.3/package
- npm 0.6.0: research/upstream/dsh-tmux-cc-0.6.0/package
- GitHub HEAD (v0.7.1 per git log): research/upstream/github  (use `git -C research/upstream/github log/show` freely)

Produce research/dsh-tmux-cc-eval.md covering, with file:line citations:
1. Architecture: host half vs browser half, how it registers with cordis/DSH (services injected, HTTP/WS routes, auth on those routes, settings schema), how the client bundle mounts into the DSH Web UI (slots, panels), storage used.
2. Exactly how tmux is invoked: spawn of `tmux` / `tmux -C` control mode? node-pty? socket selection (-L/-S)? env? Where a transport could be swapped for `ssh <alias> tmux -C ...`. Is there any existing injection point (setting for tmux binary / command prefix / socket path)? What is the smallest upstream patch to support a configurable command prefix like ["ssh","-T","NaMILab","--"]? Note control-mode over ssh needs no PTY (-T) vs needs one; check what it does.
3. tmux version assumptions: list every tmux command/format/flag used and flag ones not in tmux 3.0a (e.g. formats added in 3.1+/3.2+/3.3+, `display -p` formats, `refresh-client -B/-A`, `-f` flags, `pause-after`, `%extended-output`, `new-session -e`, `copy-mode -H`, etc). Be concrete.
4. Windows-host compatibility: POSIX-only APIs (unix sockets, process groups, `which`, signals, paths) that would break when the DSH host is Windows.
5. Security: is the WS/HTTP endpoint authenticated via DSH, can it be reached publicly, does it let the browser send arbitrary keys (that's expected for a user terminal) — and is any of it exposed to the AGENT (tools)? Does it expose any agent tools at all?
6. Feature diff table: GitHub README (HEAD) vs npm 0.6.0 README vs what npm 0.6.0 code actually implements vs 0.5.3. Which documented features are missing from the published 0.6.0 package.
7. Does it identify sessions/windows/panes by tmux ids ($N, @N, %N) or names? Any notion of server generation/pid?
8. Recommendation: pin which version (exact), reuse as dependency vs fork vs only borrow ideas; list the minimal upstream change(s) needed for SSH transport, as a concrete diff sketch.
Keep it factual and concise (tables welcome). Do not modify anything else.
