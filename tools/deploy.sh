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

# Tests gate the deploy. LOGS may point at any folder of v4 captures.
LOGS=${LOGS:-../d3plg_susan_summary/example_logs}
if [ -d "$LOGS" ]; then
  node tools/selftest.js "$LOGS" >/dev/null || { node tools/selftest.js "$LOGS"; exit 1; }
  echo "selftest passed against $LOGS"
else
  echo "WARNING: no logs at $LOGS -- deploying without running the selftest." >&2
  echo "         set LOGS=/path/to/captures to gate the deploy on it." >&2
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
printf 'waiting for %s to serve v%s' "$URL" "$NEW"
for _ in $(seq 1 60); do
  if curl -fsS "$URL?cb=$RANDOM" | grep -q "id=\"ver\">v$NEW<"; then
    printf '\ndeployed: v%s is live\n' "$NEW"
    exit 0
  fi
  printf '.'
  sleep 5
done
printf '\nstill serving an older build after 5 minutes. Push succeeded; check\n'
printf 'https://github.com/macswg/d3_snapshot_diff/deployments\n'
exit 1
