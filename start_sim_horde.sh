#!/usr/bin/env bash
# Sim Horde for Linux:  ./start_sim_horde.sh
set -e
cd "$(dirname "$0")"
if [ ! -x horde_env/bin/python ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Sim Horde needs Python 3.10 or newer. Install it with your package manager"
    echo "(for example: sudo apt install python3 python3-venv), then run this again."
    exit 1
  fi
  echo "Setting up the Sim Horde (once, a few minutes)..."
  python3 -m venv horde_env
  horde_env/bin/pip install --upgrade pip -q
  horde_env/bin/pip install torch
fi
exec horde_env/bin/python worker.py "$@"
