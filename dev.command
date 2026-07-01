#!/bin/bash
# Double-click in Finder to launch the dev server (Electron + Vite, hot-reload).
# Opens on a blank canvas (VITE_FRESH_START) and runs detached so this Terminal
# window can close itself — the app keeps running in the background.
cd "$(dirname "$0")" || exit 1

# Stop a dev server left over from a previous launch so instances don't stack up.
pkill -f "electron-vite dev" 2>/dev/null

# Launch detached; logs go to a file since the window won't stay open to show them.
VITE_FRESH_START=1 nohup npm run dev >/tmp/compressor-editor-dev.log 2>&1 &
disown

# Give it a moment to spawn, then close this Terminal window.
sleep 1
osascript -e 'tell application "Terminal" to close front window' 2>/dev/null
