#!/usr/bin/env bash
# Stage the live demo for Vercel: the web build plus the public data bundle, as one static site.
# Run from the repo root after `make data` and `pnpm --dir apps/web build`; then deploy with
#   cd "$OUT" && vercel deploy --prod
# Vercel doesn't pick precompressed files by Accept-Encoding, so the geometry (about 46 MB raw,
# 3 MB brotli) is shipped as its brotli copy and vercel.json labels it Content-Encoding: br.
# Every browser offers brotli over HTTPS. JSON is compressed by Vercel itself.
set -euo pipefail
OUT="${1:-build/vercel}"
DATA="$(cd data/build/current && pwd -P)"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R apps/web/dist/. "$OUT/"
(cd "$DATA" && find . -type f ! -name '*.br' ! -name '*.gz' ! -name 'geometry.*.bin' -print0) |
  while IFS= read -r -d '' f; do mkdir -p "$OUT/$(dirname "$f")"; cp "$DATA/$f" "$OUT/$f"; done
for g in "$DATA"/geometry.*.bin; do cp "$g.br" "$OUT/$(basename "$g")"; done
cp infra/vercel/vercel.json "$OUT/vercel.json"
echo "Staged $(find "$OUT" -type f | wc -l | tr -d ' ') files ($(du -sh "$OUT" | cut -f1)) in $OUT"
