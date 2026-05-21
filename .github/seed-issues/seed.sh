#!/usr/bin/env bash
# Seed the issue tracker from the pre-drafted bodies in this directory.
# Re-runnable: skips files whose title already exists as an open issue.
set -euo pipefail

cd "$(dirname "$0")"

label_for() {
  case "$1" in
    network-request-*)   echo "new-network,needs-triage" ;;
    network-broken-*)    echo "broken,needs-triage" ;;
    network-api-changed-*) echo "broken,network-api" ;;
    skill-idea-*)        echo "skill-idea,discussion" ;;
    docs-*)              echo "docs" ;;
    setup-stuck-*)       echo "docs,setup" ;;
    correction-*)        echo "correction" ;;
    discussion-*)        echo "discussion" ;;
    *)                   echo "needs-triage" ;;
  esac
}

for f in *.md; do
  case "$f" in
    README.md) continue ;;
  esac
  title=$(grep -m1 '^# ' "$f" | sed 's/^# //')
  body=$(sed '1,/^# /d' "$f")
  labels=$(label_for "$f")
  echo "Filing: $title (labels: $labels)"
  if gh issue list --search "in:title \"$title\"" --state all --json title --jq '.[].title' | grep -Fxq "$title"; then
    echo "  skipped (issue with this title already exists)"
    continue
  fi
  printf '%s\n' "$body" | gh issue create --title "$title" --label "$labels" --body-file -
done
