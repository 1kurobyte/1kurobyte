#!/usr/bin/env bash
# Builds a browser demo of TraSH into web/dist/: a tiny i386 Linux kernel and
# an initramfs (busybox + a static TraSH) booted by v86, an x86 PC emulator
# compiled to WebAssembly. The page connects the serial console to xterm.js.
#
#   ./web/build.sh && python3 web/dist/serve.py      # http://localhost:8000/
#
# Needs: zig, a host C compiler, make, flex, bison, bc, libelf, cpio, curl,
# npm, and tic (ncurses). No 32-bit host libraries: the whole i386 userland
# (ncurses, readline, TraSH, busybox) is cross-compiled against musl with
# `zig cc`, from pinned, checksummed upstream releases. The kernel is
# downloaded from kernel.org (KERNEL_VERSION) unless KERNEL_SRC=<dir or
# tarball> points at a source tree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$WEB/dist}"
WORK="${WORK:-$ROOT/build/web}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
DL="${DL_DIR:-$WORK/dl}"   # downloaded tarballs, kept across builds
# 6.12.48+ builds with GCC 15 (C23 by default); 6.6.52 does not.
KERNEL_VERSION="${KERNEL_VERSION:-6.12.48}"
V86_VERSION="${V86_VERSION:-0.5.462}"
V86_COMMIT="${V86_COMMIT:-5f9a90f}"
XTERM_VERSION="${XTERM_VERSION:-5.5.0}"
XTERM_FIT_VERSION="${XTERM_FIT_VERSION:-0.10.0}"
GNU_MIRROR="${GNU_MIRROR:-https://ftp.gnu.org/gnu}"
NCURSES_VERSION=6.3
NCURSES_SHA256=97fc51ac2b085d4cde31ef4d2c3122c21abc217e9090a43a30fc5ec21684e059
READLINE_VERSION=8.2
READLINE_SHA256=3feb7171f16a84ee82ca18a36d7b9be109a52c04f492a053331d7d1095007c35
BUSYBOX_VERSION=1.36.1
BUSYBOX_SHA256=b8cc24c9574d809e7279c3be349795c5d5ceb6fdf19ca709f80cde50e47de314
BUSYBOX_URL="${BUSYBOX_URL:-https://busybox.net/downloads/busybox-$BUSYBOX_VERSION.tar.bz2}"

mkdir -p "$OUT" "$WORK"

# --- Linux kernel ------------------------------------------------------------
kernel_tree() {
  local src="${KERNEL_SRC:-}"
  if [[ -z "$src" ]]; then
    mkdir -p "$DL"
    src="$DL/linux-$KERNEL_VERSION.tar.xz"
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

# --- i386 userland, cross-compiled with zig cc (musl, static) -----------------
fetch() { # <url> <sha256> <file>
  if [[ ! -f "$3" ]] || ! echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null; then
    curl -fL -o "$3.part" "$1"
    echo "$2  $3.part" | sha256sum -c --quiet - || { echo "checksum mismatch: $1" >&2; exit 1; }
    mv "$3.part" "$3"
  fi
}
unpack() { # <tarball> -> prints the fresh source dir
  local dir="$WORK/src/$(basename "$1" | sed -E 's/\.tar\.(gz|bz2|xz)$//')"
  rm -rf "$dir"; mkdir -p "$WORK/src"
  tar -xf "$1" -C "$WORK/src"
  echo "$dir"
}
log() { # <name> <command...>: quiet unless it fails
  local name="$1"; shift
  "$@" >"$WORK/$name.log" 2>&1 || { tail -40 "$WORK/$name.log" >&2; echo "$name failed (log: $WORK/$name.log)" >&2; exit 1; }
}

mkdir -p "$DL" "$WORK/bin"
fetch "$GNU_MIRROR/ncurses/ncurses-$NCURSES_VERSION.tar.gz" "$NCURSES_SHA256" "$DL/ncurses-$NCURSES_VERSION.tar.gz"
fetch "$GNU_MIRROR/readline/readline-$READLINE_VERSION.tar.gz" "$READLINE_SHA256" "$DL/readline-$READLINE_VERSION.tar.gz"
fetch "$BUSYBOX_URL" "$BUSYBOX_SHA256" "$DL/busybox-$BUSYBOX_VERSION.tar.bz2"

# Compiler wrapper; it also drops the GNU ld options zig's linker lacks.
cat > "$WORK/bin/i386-cc" <<'CC'
#!/bin/sh
for a; do
  shift
  case "$a" in
    -Wl,--warn-common|-Wl,--sort-common|-Wl,--sort-section,*|-Wl,--verbose|-Wl,-Map,*) ;;
    *) set -- "$@" "$a" ;;
  esac
done
exec zig cc -target x86-linux-musl "$@"
CC
printf '#!/bin/sh\nexec zig ar "$@"\n' > "$WORK/bin/i386-ar"
printf '#!/bin/sh\nexec zig ranlib "$@"\n' > "$WORK/bin/i386-ranlib"
chmod +x "$WORK/bin"/i386-*
XCC="$WORK/bin/i386-cc" XAR="$WORK/bin/i386-ar" XRANLIB="$WORK/bin/i386-ranlib"
SYSROOT="$WORK/sysroot"
rm -rf "$SYSROOT"
CROSS=(--host=i686-linux-musl --build="$(uname -m)-linux-gnu" --prefix=/usr)

NCSRC="$(unpack "$DL/ncurses-$NCURSES_VERSION.tar.gz")"
(cd "$NCSRC" &&
  log ncurses-configure env CC="$XCC" AR="$XAR" RANLIB="$XRANLIB" ./configure "${CROSS[@]}" \
    --without-shared --without-cxx --without-cxx-binding --without-ada --without-progs \
    --without-tests --without-manpages --disable-db-install --with-termlib --disable-widec \
    --with-default-terminfo-dir=/usr/share/terminfo --with-terminfo-dirs=/usr/share/terminfo &&
  log ncurses-make make -j"$JOBS" libs &&
  log ncurses-install make DESTDIR="$SYSROOT" install.libs)

RLSRC="$(unpack "$DL/readline-$READLINE_VERSION.tar.gz")"
(cd "$RLSRC" &&
  log readline-configure env CC="$XCC" AR="$XAR" RANLIB="$XRANLIB" \
    CFLAGS="-O2 -I$SYSROOT/usr/include" LDFLAGS="-L$SYSROOT/usr/lib" \
    ./configure "${CROSS[@]}" --disable-shared --enable-static --with-curses &&
  log readline-make make -j"$JOBS" static &&
  log readline-install make DESTDIR="$SYSROOT" install-static)

# TraSH, built from a copy of the sources so the project tree stays untouched.
# NDEBUG must stay undefined to keep the `--disassemble` (-d) option, and
# zig cc defines it by itself at -O2, hence -UNDEBUG.
SH="$WORK/trash-src"
rm -rf "$SH"; mkdir -p "$SH"
(cd "$ROOT" && tar -cf - --exclude=./build --exclude=./web . ) | tar -xf - -C "$SH"
log trash make -C "$SH" MODE=release CC="$XCC" AR="$XAR" \
  CFLAGS_RELEASE="-O2 -UNDEBUG -I$SYSROOT/usr/include" \
  LDFLAGS="-Llib/libft -L$SYSROOT/usr/lib -static" \
  LDLIBS="-lftcore -lftvector -lftprintf -lftmath -lreadline -ltinfo" -j"$JOBS"

BBSRC="$(unpack "$DL/busybox-$BUSYBOX_VERSION.tar.bz2")"
(cd "$BBSRC" &&
  log busybox-config make defconfig &&
  sed -i 's/^# CONFIG_STATIC is not set/CONFIG_STATIC=y/; s/^CONFIG_TC=y/# CONFIG_TC is not set/' .config &&
  log busybox make -j"$JOBS" CC="$XCC" AR="$XAR" HOSTCC="${HOSTCC:-cc}" busybox busybox.links)
BUSYBOX="$BBSRC/busybox"

for bin in "$SH/minishell" "$BUSYBOX"; do
  file "$bin" | grep -q 'Intel 80386.*statically linked' ||
    { echo "$bin is not a static i386 executable" >&2; exit 1; }
done

# --- initramfs ------------------------------------------------------------------
FS="$WORK/rootfs"
rm -rf "$FS"
mkdir -p "$FS"/{bin,usr/bin,sbin,etc,proc,sys,dev,tmp,root,home/guest}
cp "$BUSYBOX" "$FS/bin/busybox"
for applet in $(sed 's|.*/||' "$BBSRC/busybox.links"); do  # all applets live in /bin
  [[ -e "$FS/bin/$applet" ]] || ln -s busybox "$FS/bin/$applet"
done
install -m 755 "$SH/minishell" "$FS/bin/trash"
strip "$FS/bin/trash"
install -m 755 "$WEB/rootfs/init" "$FS/init"
cp "$WEB/rootfs/passwd" "$WEB/rootfs/group" "$WEB/rootfs/motd" "$FS/etc/"
cp -r "$WEB/rootfs/home/guest/." "$FS/home/guest/"
echo /bin/trash > "$FS/etc/shells"
# readline needs terminfo entries for the xterm.js terminal
mkdir -p "$FS/usr/share/terminfo"
tic -x -o "$FS/usr/share/terminfo" -e xterm,xterm-256color "$NCSRC/misc/terminfo.src"
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
