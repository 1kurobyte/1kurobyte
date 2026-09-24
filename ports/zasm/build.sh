#!/usr/bin/env bash
# Builds the zasm playground into web/dist/: the unmodified assembler compiled
# to WebAssembly (run in a Web Worker), plus a small x86-64 sandbox that loads
# and executes the ELF files it produces, right in the page.
#
#   source /path/to/emsdk/emsdk_env.sh && ./web/build.sh
#   python3 -m http.server -d web/dist      # any static server works
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$WEB/dist}"

command -v emcc >/dev/null || { echo "emcc not found: source emsdk_env.sh first" >&2; exit 1; }

cd "$ROOT"
# src/io.c is swapped for web/io_web.c (see the comment at its top).
SRCS=$(make --no-print-directory --eval='print-srcs: ; @echo $(SRC)' print-srcs |
       tr ' ' '\n' | sed 's|^src/io\.c$|web/io_web.c|')
mkdir -p "$OUT"
# web/compat/syscall.h replaces <syscall.h>: zasm emits x86-64 syscall
# numbers, which have nothing to do with Emscripten's own.
emcc -O2 -std=gnu23 -D_GNU_SOURCE -Wall -Wextra -Iweb/compat -Isrc $SRCS -o "$OUT/zasm.js" \
  -sMODULARIZE -sEXPORT_NAME=createZasm -sENVIRONMENT=worker \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME -sALLOW_MEMORY_GROWTH \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain

# Syscall names for the sandbox's strace-like log.
sed -n 's/^# define SYS_\([a-z0-9_]*\) \([0-9]*\)$/\2 \1/p' web/compat/syscall.h |
  python3 -c 'import json,sys; print(json.dumps({int(n): s for n, s in (l.split() for l in sys.stdin)}))' \
  > "$OUT/syscalls.json"
cp "$WEB"/index.html "$WEB"/worker.js "$WEB"/x86.js "$OUT/"
cp -r "$WEB/examples" "$OUT/"
echo "zasm web build ready in $OUT"
