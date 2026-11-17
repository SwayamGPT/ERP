#!/usr/bin/env bash
# Put build files on a public GitHub Release, so anyone can download them without a GitHub login
# (workflow artifacts always need one, even on a public repository).
#
#   publish-release.sh FILE...
#
# - On a version tag (v1.2.3): the release "Hisaab v1.2.3" (a normal, public release).
# - Otherwise: the pre-release "latest-build", whose tag is moved to this commit, so its links
#   never change:  https://github.com/<owner>/<repo>/releases/download/latest-build/<file>
# Files are uploaded with --clobber: a newer build replaces the older file of the same name.
# The Windows, macOS and Android jobs all call this, possibly at the same time.
#
# Needs GH_TOKEN (the workflow's GITHUB_TOKEN with contents: write) and a checkout.
set -euo pipefail

[ "$#" -gt 0 ] || { echo "No files to publish" >&2; exit 1; }
for f in "$@"; do [ -f "$f" ] || { echo "Missing: $f" >&2; exit 1; }; done

REPO="${GITHUB_REPOSITORY}"
SHORT="${GITHUB_SHA:0:7}"
if [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  TAG="${GITHUB_REF_NAME}"
  TITLE="Hisaab ${TAG}"
  PRE=""
else
  TAG="latest-build"
  TITLE="Hisaab — latest build"
  PRE="--prerelease"
  # Point the moving tag at this commit (every job of one push points it at the same commit).
  git tag -f "$TAG" "$GITHUB_SHA"
  git push -f origin "refs/tags/$TAG" || git push -f origin "refs/tags/$TAG"
fi

BASE="https://github.com/${REPO}/releases/download/${TAG}"
NOTES="$(cat <<EOF
Download — no GitHub account needed:

- **Windows:** [Hisaab-Setup-Windows.exe](${BASE}/Hisaab-Setup-Windows.exe) (or the [.msi](${BASE}/Hisaab-Windows.msi)). Windows may say "Windows protected your PC": click *More info → Run anyway*.
- **macOS:** [Hisaab-macOS.dmg](${BASE}/Hisaab-macOS.dmg). Open it and drag Hisaab to Applications; the first time, right-click Hisaab → *Open*.
- **Android:** [Hisaab-Android.apk](${BASE}/Hisaab-Android.apk). Open it on the phone and allow installing from this source. The phone app works with the shop computer over Wi-Fi.

Built from commit ${SHORT} on $(date -u +%Y-%m-%d).
EOF
)"

# Create the release if this is the first job to get here; another job may be doing the same.
for i in 1 2 3 4 5; do
  if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then break; fi
  gh release create "$TAG" -R "$REPO" --title "$TITLE" --notes "$NOTES" $PRE --verify-tag && break || sleep $((i * 3))
done

for i in 1 2 3; do
  gh release upload "$TAG" "$@" -R "$REPO" --clobber && break || sleep $((i * 5))
done
gh release edit "$TAG" -R "$REPO" --title "$TITLE" --notes "$NOTES" $PRE >/dev/null
echo "Published to ${BASE}/ :"
for f in "$@"; do echo "  ${BASE}/$(basename "$f")"; done
