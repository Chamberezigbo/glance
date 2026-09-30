#!/usr/bin/env bash
set -euo pipefail
LABEL="com.glance.agent"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "glance agent removed. It will not start at login."
