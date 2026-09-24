#!/usr/bin/env bash
# Builds a browser demo of TraSH into web/dist/: a tiny i386 Linux kernel and
# an initramfs (busybox + a static TraSH) booted by v86, an x86 PC emulator
# compiled to WebAssembly. The page connects the serial console to xterm.js.
#
#   ./web/build.sh && python3 web/dist/serve.py      # http://localhost:8000/
#
# Needs (Debian/Ubuntu names): gcc-multilib libreadline-dev:i386
# libncurses-dev:i386 busybox-static:i386 flex bison bc libelf-dev cpio npm
# curl, and a Linux source tree: KERNEL_SRC=<dir or tarball>, otherwise the
# linux-source package's tarball or a kernel.org download is used.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$WEB/dist}"
WORK="${WORK:-$ROOT/build/web}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
KERNEL_VERSION="${KERNEL_VERSION:-6.6.52}"
V86_VERSION="${V86_VERSION:-0.5.462}"
V86_COMMIT="${V86_COMMIT:-5f9a90f}"
XTERM_VERSION="${XTERM_VERSION:-5.5.0}"
XTERM_FIT_VERSION="${XTERM_FIT_VERSION:-0.10.0}"
BUSYBOX="${BUSYBOX:-/bin/busybox}"

mkdir -p "$OUT" "$WORK"

# --- Linux kernel ------------------------------------------------------------
kernel_tree() {
  local src="${KERNEL_SRC:-}"
  if [[ -z "$src" ]]; then
    src=$(ls /usr/src/linux-source-*.tar.* 2>/dev/null | head -1 || true)
  fi
  if [[ -z "$src" ]]; then
    src="$WORK/linux-$KERNEL_VERSION.tar.xz"
    [[ -f "$src" ]] || curl -fL -o "$src" \
      "https://cdn.kernel.org/pub/linux/kernel/v${KERNEL_VERSION%%.*}.x/linux-$KERNEL_VERSION.tar.xz"
  fi
  if [[ -d "$src" ]]; then echo "$src"; return; fi
  local dir="$WORK/linux"
  if [[ ! -f "$dir/.extracted" ]]; then
    rm -rf "$dir"; mkdir -p "$dir"
    tar -xf "$src" -C "$dir" --strip-components=1
    touch "$dir/.extracted"
  fi
  echo "$dir"
}

KSRC="$(kernel_tree)"
KOUT="$WORK/linux-build"
mkdir -p "$KOUT"
make -s -C "$KSRC" O="$KOUT" ARCH=i386 tinyconfig
"$KSRC/scripts/kconfig/merge_config.sh" -m -O "$KOUT" "$KOUT/.config" "$WEB/linux.config" >/dev/null
make -s -C "$KSRC" O="$KOUT" ARCH=i386 olddefconfig
make -s -C "$KSRC" O="$KOUT" ARCH=i386 -j"$JOBS" bzImage
cp "$KOUT/arch/x86/boot/bzImage" "$OUT/bzImage"

# --- TraSH, statically linked for i386 ----------------------------------------
# Built from a copy of the sources so the native build tree stays untouched.
# NDEBUG is left undefined to keep the `--disassemble` (-d) option.
SH="$WORK/trash-src"
rm -rf "$SH"; mkdir -p "$SH"
(cd "$ROOT" && tar -cf - --exclude=./build --exclude=./web . ) | tar -xf - -C "$SH"
make -s -C "$SH" MODE=release CC="gcc -m32" CFLAGS_RELEASE="-O2" \
  LDFLAGS="-Llib/libft -static" \
  LDLIBS="-lftcore -lftvector -lftprintf -lftmath -lreadline -ltinfo" -j"$JOBS" \
  >"$WORK/trash-build.log" 2>&1 || { cat "$WORK/trash-build.log" >&2; exit 1; }
file "$SH/minishell" | grep -q 'Intel 80386.*statically linked' ||
  { echo "static i386 TraSH build failed" >&2; exit 1; }

# --- initramfs ------------------------------------------------------------------
file "$BUSYBOX" | grep -q 'Intel 80386.*statically linked' ||
  { echo "$BUSYBOX is not a static i386 busybox (install busybox-static:i386)" >&2; exit 1; }
FS="$WORK/rootfs"
rm -rf "$FS"
mkdir -p "$FS"/{bin,usr/bin,sbin,etc,proc,sys,dev,tmp,root,home/guest}
cp "$BUSYBOX" "$FS/bin/busybox"
for applet in $("$BUSYBOX" --list); do
  [[ -e "$FS/bin/$applet" ]] || ln -s busybox "$FS/bin/$applet"
done
install -m 755 "$SH/minishell" "$FS/bin/trash"
strip "$FS/bin/trash"
install -m 755 "$WEB/rootfs/init" "$FS/init"
cp "$WEB/rootfs/passwd" "$WEB/rootfs/group" "$WEB/rootfs/motd" "$FS/etc/"
cp -r "$WEB/rootfs/home/guest/." "$FS/home/guest/"
echo /bin/trash > "$FS/etc/shells"
for t in xterm xterm-256color; do  # readline needs terminfo for xterm.js
  f=$(find /usr/share/terminfo /lib/terminfo -name "$t" 2>/dev/null | head -1 || true)
  if [[ -n "$f" ]]; then install -D -m 644 "$f" "$FS/usr/share/terminfo/x/$t"; fi
done
chmod 1777 "$FS/tmp"
(cd "$FS" && find . | sort | cpio -o -H newc --owner=0:0 --quiet | gzip -9) > "$OUT/initramfs.cpio.gz"

# --- web page and its runtime ---------------------------------------------------
"$WEB/fetch-v86.sh" "$OUT/v86" "$V86_VERSION" "$V86_COMMIT"
fetch_npm() { # <package> <version> <dest dir> <files...>
  local pkg="$1" ver="$2" dest="$3"; shift 3
  local tmp; tmp="$(mktemp -d)"
  (cd "$tmp" && npm pack --silent "$pkg@$ver" >/dev/null && tar xzf ./*.tgz)
  mkdir -p "$dest"
  for f in "$@"; do cp "$tmp/package/$f" "$dest/"; done
  rm -rf "$tmp"
}
fetch_npm @xterm/xterm "$XTERM_VERSION" "$OUT/xterm" lib/xterm.js css/xterm.css LICENSE
fetch_npm @xterm/addon-fit "$XTERM_FIT_VERSION" "$OUT/xterm" lib/addon-fit.js

cp "$WEB/index.html" "$WEB/serve.py" "$OUT/"
echo "TraSH web build ready in $OUT"
