#!/usr/bin/env bash
#
# Bump the version, commit, push, and wait for GitHub Pages to serve it.
#
#   tools/deploy.sh "commit message"          # patch: 1.0.0 -> 1.0.1
#   tools/deploy.sh minor "commit message"    # 1.0.0 -> 1.1.0
#   tools/deploy.sh major "commit message"    # 1.0.0 -> 2.0.0
#
# The version lives in one place, the #ver span in index.html, and is rewritten
# here rather than by hand -- a footer nobody remembers to edit is worse than no
# footer, because it looks authoritative while being wrong.
#
# Pages serves main at root with no build step, so pushing IS the deploy. The
# wait at the end is the only way to know it actually landed: the build API
# lags behind the CDN, so this polls the served file for the new version rather
# than trusting the reported build status.
set -euo pipefail

cd "$(dirname "$0")/.."

LEVEL=patch
case "${1:-}" in
  major|minor|patch) LEVEL=$1; shift ;;
esac
MSG=${1:-}
[ -n "$MSG" ] || { echo "usage: tools/deploy.sh [major|minor|patch] \"commit message\"" >&2; exit 1; }

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || { echo "on '$BRANCH', not main -- Pages builds main" >&2; exit 1; }

# Tests gate the deploy, and a gate that cannot find a corpus is closed, not
# open. This used to default LOGS to a folder that did not exist, warn, and
# deploy anyway -- so the self-test silently stopped running on every deploy.
# With no LOGS the suite resolves its own corpus (tools/logs.local, then the
# plugin repo next door), the same list `node tools/selftest.js` uses by hand.
# SKIP_SELFTEST=1 is the deliberate way through when there is truly no corpus.
SELFTEST=(node tools/selftest.js)
[ -n "${LOGS:-}" ] && SELFTEST+=("$LOGS")
if [ "${SKIP_SELFTEST:-}" = 1 ]; then
  echo "WARNING: SKIP_SELFTEST=1 -- deploying without running the selftest." >&2
elif OUT=$("${SELFTEST[@]}" 2>&1); then
  echo "selftest passed against $(printf '%s\n' "$OUT" | sed -n 's/^logs: \([^(]*\)  (.*/\1/p')"
else
  printf '%s\n' "$OUT" | grep -E 'FAIL|^ {9}|no captures|no folder|Error' >&2 || printf '%s\n' "$OUT" >&2
  echo "selftest failed or found no corpus -- not deploying." >&2
  echo "add a capture folder to tools/logs.local, or set LOGS=/path, or SKIP_SELFTEST=1." >&2
  exit 1
fi

CUR=$(sed -n 's/.*id="ver">v\([0-9]*\.[0-9]*\.[0-9]*\)<.*/\1/p' index.html)
[ -n "$CUR" ] || { echo "no version found in index.html -- is the #ver span intact?" >&2; exit 1; }

IFS=. read -r MA MI PA <<<"$CUR"
case "$LEVEL" in
  major) MA=$((MA + 1)); MI=0; PA=0 ;;
  minor) MI=$((MI + 1)); PA=0 ;;
  patch) PA=$((PA + 1)) ;;
esac
NEW="$MA.$MI.$PA"

# -i '' is the BSD/macOS spelling; this is not portable to GNU sed as written.
sed -i '' "s|id=\"ver\">v$CUR<|id=\"ver\">v$NEW<|" index.html
echo "version $CUR -> $NEW"

git add -A
git commit -q -m "$MSG" -m "Deploy v$NEW."
git tag -a "v$NEW" -m "v$NEW"
git push -q origin main
git push -q origin "v$NEW"
echo "pushed $(git rev-parse --short HEAD), tagged v$NEW"

URL=https://macswg.github.io/d3_snapshot_diff/

# Fetch to a file and grep the file, rather than piping curl into grep. Under a
# sandbox that denies curl its stdout the pipe fails, curl exits 56, and the
# match never happens -- so the loop ran the full five minutes and reported a
# failed deploy twice while the new version was already live. A poll that cannot
# tell "not deployed yet" from "could not look" is worse than no poll.
PAGE=$(mktemp)
trap 'rm -f "$PAGE"' EXIT

printf 'waiting for %s to serve v%s' "$URL" "$NEW"
for _ in $(seq 1 60); do
  if curl -fsS "$URL?cb=$RANDOM" -o "$PAGE" 2>/dev/null; then
    if grep -q "id=\"ver\">v$NEW<" "$PAGE"; then
      printf '\ndeployed: v%s is live\n' "$NEW"
      exit 0
    fi
    FETCHED=yes
  fi
  printf '.'
  sleep 5
done

# Distinguish the two failures. Serving an old build is a Pages problem; never
# having fetched at all is a problem with this machine, and saying "still
# serving an older build" in that case sends you to the wrong dashboard.
if [ "${FETCHED:-}" = yes ]; then
  printf '\nstill serving an older build after 5 minutes. Push succeeded; check\n'
  printf 'https://github.com/macswg/d3_snapshot_diff/deployments\n'
else
  printf '\ncould not reach %s at all -- push succeeded, but this machine never\n' "$URL"
  printf 'fetched the page, so whether it deployed is unknown. Check by hand.\n'
fi
exit 1
