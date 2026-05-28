#!/usr/bin/env bash
#
# Mirror this repo into a PRIVATE repo in your own GitHub account so it can
# be added to a Claude Cowork organization marketplace. Cowork blocks public
# repos from being synced into org marketplaces, and GitHub forks of a public
# repo can't be made private — so we mirror-clone + push to a fresh private
# repo instead of using `gh repo fork`.
#
# Usage:
#   scripts/fork-for-cowork.sh                 # creates $you/affiliatemcp-internal
#   scripts/fork-for-cowork.sh my-repo-name    # creates $you/my-repo-name
#   scripts/fork-for-cowork.sh --sync          # re-mirror upstream into the same private repo
#
# Requirements:
#   - gh CLI installed and authenticated (`gh auth status`)
#   - Network access to github.com
#
set -euo pipefail

UPSTREAM="bobberrisford/affiliatemcp"
DEFAULT_NAME="affiliatemcp-internal"
SYNC_MODE=false

if [[ "${1:-}" == "--sync" ]]; then
  SYNC_MODE=true
  TARGET_NAME="${2:-$DEFAULT_NAME}"
else
  TARGET_NAME="${1:-$DEFAULT_NAME}"
fi

# --- preflight ---------------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required. Install: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

USER="$(gh api user --jq .login)"
TARGET_FULL="$USER/$TARGET_NAME"
TARGET_URL="https://github.com/$TARGET_FULL.git"

# --- create or verify target -------------------------------------------------

if gh repo view "$TARGET_FULL" >/dev/null 2>&1; then
  if $SYNC_MODE; then
    echo "Found existing $TARGET_FULL — will re-mirror upstream into it."
  else
    echo "error: $TARGET_FULL already exists. Use --sync to re-mirror, or pass a different name." >&2
    exit 1
  fi
else
  if $SYNC_MODE; then
    echo "error: --sync requires $TARGET_FULL to already exist." >&2
    exit 1
  fi
  echo "Creating private repo $TARGET_FULL..."
  gh repo create "$TARGET_FULL" --private \
    --description "Private mirror of $UPSTREAM for Claude Cowork org marketplace" >/dev/null
fi

# --- mirror push -------------------------------------------------------------

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Cloning $UPSTREAM (bare) ..."
git clone --quiet --bare "https://github.com/$UPSTREAM.git" "$TMPDIR/mirror.git"

echo "Pushing mirror to $TARGET_FULL ..."
( cd "$TMPDIR/mirror.git" && git push --mirror --quiet "$TARGET_URL" )

# --- next steps --------------------------------------------------------------

cat <<EOF

Done. Private mirror is at: https://github.com/$TARGET_FULL

Next steps for Claude Cowork desktop:
  1. Open Cowork desktop → Organization settings → Plugins
  2. Click "Add plugin" → choose GitHub as the source
  3. Enter: $TARGET_FULL
  4. Once synced, install: affiliate-networks-mcp

To keep the mirror up to date when this repo releases a new version:
  scripts/fork-for-cowork.sh --sync $TARGET_NAME

EOF
