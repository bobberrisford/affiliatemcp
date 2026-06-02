#!/usr/bin/env bash
#
# DEPRECATED — kept for back-compat, removed in 0.4.0.
#
# This is now a built-in CLI command. It no longer requires cloning the repo
# or having `gh` installed: if `gh` is present and signed in it's used
# automatically, otherwise you'll be prompted to paste a GitHub token.
#
#   npx affiliate-networks-mcp cowork-mirror              # create the private mirror
#   npx affiliate-networks-mcp cowork-mirror --sync       # refresh an existing mirror
#
# All arguments are forwarded unchanged.
#
set -euo pipefail

echo "note: scripts/fork-for-cowork.sh is deprecated — forwarding to" >&2
echo "      'npx affiliate-networks-mcp cowork-mirror'. This shim is removed in 0.4.0." >&2
echo >&2

exec npx --yes affiliate-networks-mcp@latest cowork-mirror "$@"
