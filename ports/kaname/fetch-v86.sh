#!/usr/bin/env bash
# Downloads a pinned v86 release (emulator + BIOS images) into <dir>.
#   fetch-v86.sh <dir> <npm-version> <git-commit>
set -euo pipefail
DIR="$1"; VERSION="$2"; COMMIT="$3"
[[ -f "$DIR/libv86.js" && -f "$DIR/.version" && "$(cat "$DIR/.version")" == "$VERSION" ]] && exit 0
mkdir -p "$DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
(cd "$TMP" && npm pack --silent "v86@$VERSION" >/dev/null && tar xzf v86-*.tgz)
cp "$TMP/package/build/libv86.js" "$TMP/package/build/v86.wasm" "$TMP/package/LICENSE" "$DIR/"
for f in seabios.bin vgabios.bin; do
  curl -fsSL -o "$DIR/$f" "https://raw.githubusercontent.com/copy/v86/$COMMIT/bios/$f"
done
echo "$VERSION" > "$DIR/.version"
