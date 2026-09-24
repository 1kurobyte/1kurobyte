#!/usr/bin/env bash
# Builds a browser demo of Kaname into web/dist/: the kernel is booted from a
# GRUB ISO by v86, an x86 PC emulator compiled to WebAssembly.
#
#   ./web/build.sh && python3 web/dist/serve.py   # http://localhost:8000/
#
# Needs zig, grub-mkrescue (grub-pc-bin), xorriso, mtools, npm and curl.
# Two images are built: the default text-mode kernel and the "full" one
# (-Dfull=true, VBE framebuffer + 3D logo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$WEB/dist}"
TMP="$ROOT/.zig-cache/web"
V86_VERSION="${V86_VERSION:-0.5.462}"
V86_COMMIT="${V86_COMMIT:-5f9a90f}"   # matches the npm release above

cd "$ROOT"
mkdir -p "$OUT" "$TMP"

build_iso() { # <name> [zig build options...]
  local name="$1"; shift
  local iso="$TMP/iso-$name"
  rm -rf "$iso"; mkdir -p "$iso/boot/grub"
  zig build -Doptimize=ReleaseSafe --prefix "$TMP/out-$name" "$@"
  cp "$TMP/out-$name/bin/kaname.kernel" "$iso/boot/kaname.kernel"
  cp "$WEB/grub.cfg" "$iso/boot/grub/grub.cfg"
  grub-mkrescue -o "$OUT/$name.iso" "$iso" --compress=xz --core-compress=xz \
    --fonts= --themes= --locales= 2>/dev/null
}
build_iso kaname
build_iso kaname-full -Dfull=true

"$WEB/fetch-v86.sh" "$OUT/v86" "$V86_VERSION" "$V86_COMMIT"
git describe --tags --dirty > "$OUT/version.txt" 2>/dev/null || echo dev > "$OUT/version.txt"
cp "$WEB/index.html" "$WEB/serve.py" "$OUT/"
echo "Kaname web build ready in $OUT"
