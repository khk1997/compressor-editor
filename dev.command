#!/bin/bash
# Double-click in Finder to launch the dev server (Electron + Vite, hot-reload).
# Resolve to this script's own folder so it works no matter where it's run from.
cd "$(dirname "$0")" || exit 1
echo "Starting Compressor Editor (dev mode)…"
npm run dev
