#!/bin/bash
# Seat summarize-up-to ahead of Claude Code's security default on a machine you
# administer, through a machine managed policy, with a per-project install as
# the fallback where the policy does not apply.
#
#   machine-policy.sh install <git ref> <percent> [project folder ...]
#   machine-policy.sh update <git ref>
#   machine-policy.sh remove
#
# Run it as the user who runs the agents, not as root: it uses sudo only for
# /opt/claude-plugins and /etc/claude-code. The policy applies to every Claude
# Code session on the machine.
#
# Under a login whose organization delivers server-managed settings, even one
# key, Claude Code ignores this file ("first-wins"; a lower source cannot opt
# into merging with the source above it). There the per-project install loads
# instead, behind the guard: it cannot cut, so it switches compaction off.
# Its own marketplace name keeps the two apart: with the same name, adopting the
# policy would merge the per-project installs into one that such a login drops.
set -euo pipefail

REPO=https://github.com/groundnuty/claude-summarize-up-to
BASE=/opt/claude-plugins/machine-mods
PLUGIN=$BASE/summarize-up-to
POLICY=/etc/claude-code/managed-settings.json
OLD=/opt/claude-plugins/claude-summarize-up-to
CLAUDE=$(command -v claude || echo /home/linuxbrew/.linuxbrew/bin/claude)

say() { printf '%s\n' "$*"; }

remove() {
  say "== removing the machine policy and the admin folder"
  sudo rm -f "$POLICY"
  sudo rmdir /etc/claude-code 2>/dev/null || true
  sudo rm -rf "$BASE" "$OLD"
  sudo rmdir /opt/claude-plugins 2>/dev/null || true
  say "removed. Per-project installs stay as they are."
}

checkout() {
  sudo git -C "$PLUGIN" fetch -q origin
  sudo git -C "$PLUGIN" -c advice.detachedHead=false checkout -q "$1"
  sudo chown -R root:root "$PLUGIN"
  sudo chmod -R go-w "$PLUGIN"
  say "   $(sudo git -C "$PLUGIN" log --oneline -1)"
}

case "${1:-}" in
  remove) remove; exit 0 ;;
  update)
    [ -n "${2:-}" ] || { say "usage: $0 update <git ref>"; exit 1; }
    checkout "$2"
    say "updated. /reload-plugins in a session loads it."
    exit 0 ;;
  install) ;;
  *) say "usage: $0 install <git ref> <percent> [project folder ...] | update <git ref> | remove"; exit 1 ;;
esac

REF=${2:?git ref}; PERCENT=${3:?percent}; shift 3
[ "$(id -u)" != 0 ] || { say "run this as the agents' user, not as root"; exit 1; }
if [ -e "$POLICY" ] && ! sudo grep -q 'summarize-up-to@' "$POLICY"; then
  say "refusing: $POLICY exists and is not this tool's; nothing changed"; exit 1
fi
[ ! -e "$BASE" ] || { say "refusing: $BASE already exists; use update, or remove first; nothing changed"; exit 1; }

say "== 1. the fallback: installed per project, from GitHub"
"$CLAUDE" plugin marketplace add groundnuty/claude-summarize-up-to 2>&1 | tail -1
for d in "$@"; do (cd "$d" && "$CLAUDE" plugin install summarize-up-to@groundnuty --scope local 2>&1 | tail -1 | cut -c1-120); done

say "== 2. the mod, root-owned, at $PLUGIN"
sudo install -d -o root -g root -m 755 /opt/claude-plugins "$BASE" "$BASE/.claude-plugin"
sudo tee "$BASE/.claude-plugin/marketplace.json" > /dev/null <<'EOF'
{
  "name": "machine-mods",
  "owner": { "name": "this machine's administrator" },
  "plugins": [
    { "name": "summarize-up-to", "source": "./summarize-up-to", "description": "Summarize the oldest part of a conversation, keeping the rest verbatim" }
  ]
}
EOF
sudo git clone -q "$REPO" "$PLUGIN"
checkout "$REF"
for p in / /opt /opt/claude-plugins "$BASE" "$PLUGIN"; do
  read -r owner mode < <(stat -c '%U %a' "$p")
  case "$mode" in *[2367]?|*[2367]) say "refusing: $p is writable by others ($mode)"; remove; exit 1 ;; esac
  [ "$owner" = root ] || { say "refusing: $p is owned by $owner"; remove; exit 1; }
done

say "== 3. the machine policy at $POLICY"
sudo install -d -o root -g root -m 755 /etc/claude-code
sudo tee "$POLICY" > /dev/null <<EOF
{
  "extraKnownMarketplaces": {
    "machine-mods": { "source": { "source": "directory", "path": "$BASE" } }
  },
  "enabledPlugins": { "summarize-up-to@machine-mods": true },
  "prependPlugins": ["summarize-up-to@machine-mods", "sec-default@builtin"],
  "pluginConfigs": {
    "summarize-up-to@machine-mods": {
      "options": { "compact_percent": $PERCENT, "auto_compact": true, "summarize_percent": $PERCENT }
    }
  }
}
EOF
sudo chmod 644 "$POLICY"

say "== 4. a first start, in which Claude Code adopts the policy, and a second to check"
CHECK=$(mktemp -d /tmp/sut-machine-policy-check-XXXXXX)
cd "$CHECK"
# As in an agent's project: the machine's mod and a per-project install together.
"$CLAUDE" plugin install summarize-up-to@groundnuty --scope local > /dev/null 2>&1 || true
for run in 1 2; do
  timeout 150 "$CLAUDE" -p "/summarize-up-to status" --model claude-haiku-5-5 --strict-mcp-config --tools "" \
    --debug-file "$CHECK/debug$run.txt" < /dev/null > "$CHECK/out$run.txt" 2>&1 || true
done
state=failed
if grep -q "hooks module summarize-up-to@machine-mods loaded (worker.*tier prepend)" "$CHECK/debug2.txt" \
  && grep -q "Compaction reaches this mod in this session" "$CHECK/out2.txt"; then
  state=passed
elif grep -q "sec-default@builtin seated outermost: this machine has managed settings" "$CHECK/debug2.txt"; then
  state=organization
fi
"$CLAUDE" plugin uninstall summarize-up-to@groundnuty --scope local > /dev/null 2>&1 || true
cd /
case "$CHECK" in
  /tmp/sut-machine-policy-check-?*)
    rm -rf "$CHECK"
    rm -rf "$HOME/.claude/projects/$(printf '%s' "$CHECK" | sed 's#[^A-Za-z0-9]#-#g')" ;;
esac
case "$state" in
  passed)
    say "   PASS the mod loads as this machine's own, ahead of the guard, and compaction reaches it" ;;
  organization)
    say "   NOTE the login active now belongs to an organization with server-managed settings, so Claude Code ignores"
    say "        this file while it is active, and the per-project installs act instead. Check again under a personal login." ;;
  *)
    say "   FAIL the mod did not load as this machine's own"; remove; exit 1 ;;
esac
say "installed. Next: /reload-plugins in each agent, then /summarize-up-to status."
say "To update the mod: bash $0 update <git ref>. To undo: bash $0 remove"
