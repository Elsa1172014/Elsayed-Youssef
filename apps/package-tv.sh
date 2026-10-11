#!/usr/bin/env bash
# Builds the web app and stages it for Samsung Tizen or LG webOS packaging.
# Usage: apps/package-tv.sh <tizen|webos> <https://your-api.example>
# Signing and store submission need the owner's developer accounts/certificates (see docs/DEPLOYMENT.md).
set -euo pipefail
target="${1:?usage: package-tv.sh <tizen|webos> <api-base-url>}"
api="${2:?api base url required (TV builds cannot use relative URLs)}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/apps/$target/build"

(cd "$root/apps/web" && npm ci && VITE_API_BASE="$api" npm run build)
rm -rf "$out" && mkdir -p "$out"
cp -R "$root/apps/web/dist/." "$out/"
case "$target" in
  tizen) cp "$root/apps/tizen/config.xml" "$root/apps/tizen/icon.png" "$out/"
         echo "Staged in $out. Next: tizen package -t wgt -s <your-cert-profile> -- $out" ;;
  webos) cp "$root/apps/webos/appinfo.json" "$root/apps/webos/icon.png" "$root/apps/webos/largeIcon.png" "$out/"
         echo "Staged in $out. Next: ares-package $out" ;;
  *) echo "unknown target" >&2; exit 1 ;;
esac
