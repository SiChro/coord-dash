#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Simon Chromec
# Local demo: Debian + Node 22 + tmux container with three fake "coordinator" sessions.
# Dashboard: http://localhost:8099  password: test-password-123   Stop: docker rm -f coord-dash-demo
set -euo pipefail
cd "$(dirname "$0")/.."
docker rm -f coord-dash-demo >/dev/null 2>&1 || true
docker run -d --name coord-dash-demo -p 127.0.0.1:8099:8080 -v "$PWD":/app:ro node:22-bookworm sleep infinity >/dev/null
docker exec coord-dash-demo bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq tmux socat >/dev/null 2>&1'
docker exec coord-dash-demo bash -c '
set -e
mkdir -p -m 700 /root/.config/coord-dash
node -e "
const c=require(\"crypto\"),s=c.randomBytes(16);
require(\"fs\").writeFileSync(\"/root/.config/coord-dash/config.json\",JSON.stringify({host:\"127.0.0.1\",port:7681,sessions:[\"demo-a\",\"demo-b\"],
passwordHash:\"scrypt\$\"+s.toString(\"base64\")+\"\$\"+c.scryptSync(\"test-password-123\",s,32).toString(\"base64\"),
cookieSecret:c.randomBytes(32).toString(\"base64url\")}),{mode:0o600});"
cat > /root/fake.sh <<"EOS"
#!/bin/bash
printf "\e[1;35m✻ Fake coordinator\e[0m — session %s\n" "$1"
trap "printf \"\n\e[33m[got Ctrl-C]\e[0m\n\"" INT
while true; do IFS= read -r -p $'"'"'\e[36m> \e[0m'"'"' l || continue; printf "\e[90m%s\e[0m received: \e[1m%s\e[0m\n" "$(date +%T)" "$l"; done
EOS
chmod +x /root/fake.sh
export LANG=C.UTF-8
tmux new -d -s demo-a -x 120 -y 32 "/root/fake.sh demo-a"
tmux new -d -s demo-b -x 100 -y 30 "/root/fake.sh demo-b"
tmux new -d -s third -x 90 -y 20 top
cd /app && (nohup node server.js >/root/server.log 2>&1 &)
# the server only binds loopback; socat exposes it to the published container port for this demo
(nohup socat TCP-LISTEN:8080,fork,reuseaddr TCP:127.0.0.1:7681 >/dev/null 2>&1 &)
sleep 1; cat /root/server.log'
echo "Open http://localhost:8099  (password: test-password-123)"
