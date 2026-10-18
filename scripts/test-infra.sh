#!/bin/bash
# Integration-test infrastructure on the Linux tmux host (NaMILab):
# a user-level sshd on 127.0.0.1:22220 with its own host key, client key and known_hosts
# (StrictHostKeyChecking yes). It never touches ~/.ssh or the default tmux server.
#   scripts/test-infra.sh up|down|status      (state dir: test-infra/sshd, override with XC_INFRA)
set -eu
T=${XC_INFRA:-$(cd "$(dirname "$0")/.." && pwd)/test-infra}/sshd
case ${1:-status} in
up)
  mkdir -p "$T"; chmod 700 "$T"; cd "$T"
  [ -f host_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f host_ed25519 -C xc-test-host
  [ -f client_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f client_ed25519 -C xc-test-client
  cp client_ed25519.pub authorized_keys; chmod 600 authorized_keys
  cat > sshd_config <<EOC
Port 22220
ListenAddress 127.0.0.1
HostKey $T/host_ed25519
AuthorizedKeysFile $T/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
AllowUsers $(id -un)
AllowTcpForwarding yes
X11Forwarding no
PidFile $T/sshd.pid
LogLevel VERBOSE
EOC
  echo "[127.0.0.1]:22220 $(cut -d' ' -f1-2 host_ed25519.pub)" > known_hosts
  [ -f wrongkey ] || ssh-keygen -q -t ed25519 -N '' -f wrongkey -C wrong </dev/null
  echo "[127.0.0.1]:22220 $(cut -d' ' -f1-2 wrongkey.pub)" > known_hosts_wrong
  base="  User $(id -un)
  IdentityFile $T/client_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  BatchMode yes"
  cat > ssh_config <<EOC
Host xc-test
  HostName 127.0.0.1
  Port 22220
  UserKnownHostsFile $T/known_hosts
$base
Host xc-test-fwd
  HostName 127.0.0.1
  Port 22220
  UserKnownHostsFile $T/known_hosts
  LocalForward 127.0.0.1:22220 127.0.0.1:22
  ExitOnForwardFailure yes
$base
Host xc-test-badkey
  HostName 127.0.0.1
  Port 22220
  UserKnownHostsFile $T/known_hosts_wrong
$base
Host xc-unreachable
  HostName 127.0.0.1
  Port 22221
  ConnectTimeout 3
  UserKnownHostsFile $T/known_hosts
$base
EOC
  if [ -f sshd.pid ] && kill -0 "$(cat sshd.pid)" 2>/dev/null; then echo "sshd already running"; else /usr/sbin/sshd -f sshd_config -E "$T/sshd.log"; sleep 1; fi
  ssh -F ssh_config xc-test 'echo infra-ok $(tmux -V)'
  ;;
down) [ -f "$T/sshd.pid" ] && kill "$(cat "$T/sshd.pid")" 2>/dev/null; echo stopped ;;
status) [ -f "$T/sshd.pid" ] && kill -0 "$(cat "$T/sshd.pid")" 2>/dev/null && echo running || echo stopped ;;
esac
