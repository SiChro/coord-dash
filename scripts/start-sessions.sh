#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Simon Chromec
# Start the tmux sessions listed in a sessions file, unless they are already running.
# Each session gets a normal login shell, and the command is typed into it, so when the
# command ends (e.g. you quit Claude Code) the session stays open with a shell.
#
# Usage: scripts/start-sessions.sh [FILE]   (default: ~/.config/coord-dash/sessions)
# Line format (see sessions.example):  name | working directory | command
set -eu

FILE="${1:-${XDG_CONFIG_HOME:-$HOME/.config}/coord-dash/sessions}"
if [ ! -r "$FILE" ]; then
  echo "start-sessions: cannot read $FILE (copy sessions.example there)" >&2
  exit 1
fi

trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }

status=0
while IFS='|' read -r name dir cmd || [ -n "$name" ]; do
  name=$(trim "$name")
  case "$name" in '' | '#'*) continue ;; esac
  dir=$(trim "${dir:-}")
  cmd=$(trim "${cmd:-}")
  case "$dir" in '~') dir="$HOME" ;; '~/'*) dir="$HOME/${dir#\~/}" ;; '') dir="$HOME" ;; esac
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z0-9_-]{1,64}$'; then
    echo "start-sessions: skipping \"$name\": names may only use A-Z a-z 0-9 _ -" >&2
    status=1
    continue
  fi
  if [ ! -d "$dir" ]; then
    echo "start-sessions: skipping $name: no directory $dir" >&2
    status=1
    continue
  fi
  if tmux has-session -t "=$name" 2>/dev/null; then
    echo "start-sessions: $name already running"
    continue
  fi
  tmux new-session -d -s "$name" -c "$dir"
  if [ -n "$cmd" ]; then
    tmux send-keys -t "=$name:" -l -- "$cmd"
    tmux send-keys -t "=$name:" Enter
  fi
  echo "start-sessions: started $name in $dir"
done < "$FILE"
exit "$status"
