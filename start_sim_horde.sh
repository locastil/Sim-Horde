#!/usr/bin/env bash
# Sim Horde for Linux:  ./start_sim_horde.sh
set -e
cd "$(dirname "$0")"
if [ ! -x horde_env/bin/python ]; then
  echo "Setting up the Sim Horde (once, a few minutes)..."
  python3 -m venv horde_env
  horde_env/bin/pip install --upgrade pip -q
  horde_env/bin/pip install torch
fi
exec horde_env/bin/python worker.py "$@"
