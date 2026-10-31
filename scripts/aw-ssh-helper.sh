#!/bin/sh
# Agent Workspace SSH helper launcher (installed as bin/aw-ssh-helper in the
# standalone server archive). The desktop app runs exactly this file over
# `ssh -T`; it never passes folders, prompts or branches on the command line.
# If Node 24+ is not on this host's non-interactive PATH, set AW_NODE (for
# example with sshd's SetEnv, or by editing this file) to its absolute path.
dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 70
found=""
usable() {
  [ -n "$1" ] && [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null </dev/null)
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -ge 24 ]
}
for candidate in "${AW_NODE:-}" "$(command -v node 2>/dev/null)" \
  "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -z "$found" ] && usable "$candidate"; then found=$candidate; fi
done
if [ -z "$found" ] && [ -n "${SHELL:-}" ]; then
  candidate=$("$SHELL" -lc 'command -v node' 2>/dev/null </dev/null | tail -n 1)
  if usable "$candidate"; then found=$candidate; fi
fi
if [ -z "$found" ]; then
  echo "aw-ssh-helper: node-missing: Node.js 24 or newer was not found on this host" >&2
  exit 69
fi
exec "$found" "$dir/dist/server/stdio-host.mjs" "$@"
