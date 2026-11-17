#!/bin/bash
# Seat summarize-up-to ahead of Claude Code's security default on a machine you
# administer, through a machine managed policy, with a per-project install as
# the fallback where the policy does not apply.
#
#   machine-policy.sh install <git ref> <percent> [project folder ...]
#   machine-policy.sh fallback <percent> [project folder ...]
#   machine-policy.sh update <git ref>
#   machine-policy.sh remove
#
# Run it as the user who runs the agents, not as root: it uses sudo only for
# /opt/claude-plugins and /etc/claude-code. The policy applies to every Claude
# Code session on the machine.
#
# Under a login whose organization delivers server-managed settings, even one
# key, Claude Code ignores this file ("first-wins"; a lower source cannot opt
# into merging with the source above it), at a start and at the hourly
# settings refresh of a running session alike. So the fallback (also alone,
# without sudo): the GitHub copy installed for every project of this user,
# which loads where the policy does not (behind the guard it cannot cut, so it
# switches compaction off), and the share written into the user's settings for
# both copies, so options the policy no longer supplies are not the defaults.
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

# The GitHub copy for every project, and the share in user settings for both
# copies of the mod. User settings, unlike the policy, are always read.
fallback() {
  local percent=$1; shift
  "$CLAUDE" plugin marketplace add groundnuty/claude-summarize-up-to 2>&1 | tail -1
  "$CLAUDE" plugin marketplace update groundnuty 2>&1 | tail -1
  # Installed where missing, else brought up to the marketplace's version.
  (cd "$HOME" && { "$CLAUDE" plugin install summarize-up-to@groundnuty --scope user 2>&1 | grep -q 'already installed' \
    && "$CLAUDE" plugin update summarize-up-to@groundnuty --scope user 2>&1 | tail -1 | cut -c1-120 || echo "   installed for every project"; })
  for d in "$@"; do (cd "$d" && { "$CLAUDE" plugin install summarize-up-to@groundnuty --scope local 2>&1 | grep -q 'already installed' \
    && "$CLAUDE" plugin update summarize-up-to@groundnuty --scope local 2>&1 | tail -1 | cut -c1-120 || echo "   installed in $d"; }); done
  python3 - "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "$percent" <<'PY'
import json, os, shutil, sys, time
path, percent = sys.argv[1], int(sys.argv[2])
data = json.load(open(path)) if os.path.exists(path) else {}
if os.path.exists(path):
    shutil.copy2(path, path + ".bak-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
options = {"compact_percent": percent, "auto_compact": True, "summarize_percent": percent}
configs = data.setdefault("pluginConfigs", {})
for plugin in ("summarize-up-to@groundnuty", "summarize-up-to@machine-mods"):
    configs.setdefault(plugin, {})["options"] = options
# Written in place, so a settings file that is a symlink stays one.
with open(path, "a+") as f:
    f.seek(0)
    f.truncate()
    f.write(json.dumps(data, indent=2) + "\n")
print(f"   user settings: both copies summarize the oldest {percent}%, partial auto-compaction on")
PY
}

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
  fallback)
    [ -n "${2:-}" ] || { say "usage: $0 fallback <percent> [project folder ...]"; exit 1; }
    p=$2; shift 2
    fallback "$p" "$@"
    say "done. Restart running sessions, or /reload-plugins in them, to load it."
    exit 0 ;;
  update)
    [ -n "${2:-}" ] || { say "usage: $0 update <git ref>"; exit 1; }
    checkout "$2"
    say "updated. /reload-plugins in a session loads it."
    exit 0 ;;
  install) ;;
  *) say "usage: $0 install <git ref> <percent> [project folder ...] | fallback <percent> [project folder ...] | update <git ref> | remove"; exit 1 ;;
esac

REF=${2:?git ref}; PERCENT=${3:?percent}; shift 3
[ "$(id -u)" != 0 ] || { say "run this as the agents' user, not as root"; exit 1; }
if [ -e "$POLICY" ] && ! sudo grep -q 'summarize-up-to@' "$POLICY"; then
  say "refusing: $POLICY exists and is not this tool's; nothing changed"; exit 1
fi
[ ! -e "$BASE" ] || { say "refusing: $BASE already exists; use update, or remove first; nothing changed"; exit 1; }

say "== 1. the fallback: the GitHub copy for every project, and the share in user settings"
fallback "$PERCENT" "$@"

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
  && grep -q "hooks module summarize-up-to@groundnuty not loaded" "$CHECK/debug2.txt" \
  && ! grep -q "hooks module summarize-up-to@groundnuty loaded" "$CHECK/debug2.txt" \
  && grep -q "Compaction reaches this mod in this session" "$CHECK/out2.txt" \
  && ! grep -q "Compaction is off" "$CHECK/out2.txt"; then
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
say "installed. Next: restart each agent, then /summarize-up-to status. A reload in a process older than this"
say "version can load both copies of the mod, and the one behind the guard then switches compaction off until a restart."
say "To update the mod: bash $0 update <git ref>. To undo: bash $0 remove"
