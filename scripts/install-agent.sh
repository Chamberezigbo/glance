#!/usr/bin/env bash
# Install (or reinstall) the login agent, so glance is there after a reboot.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.glance.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -x "$ROOT/bin/glance.app/Contents/MacOS/glance" ] || { echo "bin/glance-hotkey is not built. Run: npm run setup:hotkey"; exit 1; }
[ -f "$ROOT/dist/cli.js" ]       || { echo "dist/ is not built. Run: npm run build"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.glance"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__LOGS__|$HOME/.glance|g" \
  "$ROOT/scripts/com.glance.agent.plist.template" > "$PLIST"

# bootout is idempotent-ish; ignore "not loaded" on a first install.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

# Sweep strays. A bootout does not always reap a process that launchd has lost
# track of, and every survivor puts another icon in the menu bar.
pkill -f "glance.app/Contents/MacOS/glance" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "installed: $PLIST"
echo "glance now starts at login. Press ⌥Space to ask."
echo "  stop:      launchctl bootout gui/$UID/$LABEL"
echo "  uninstall: scripts/uninstall-agent.sh"
