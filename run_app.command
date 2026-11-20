#!/bin/sh
# Opens the Press Start UA Launcher window (development copy, macOS): double-click in Finder.
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python app.py "$@"
