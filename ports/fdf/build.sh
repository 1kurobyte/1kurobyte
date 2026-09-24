#!/usr/bin/env bash
# Builds FdF for the browser (WebAssembly + pthreads) into web/dist/.
#
#   source /path/to/emsdk/emsdk_env.sh && ./web/build.sh
#   python3 web/serve.py          # then open http://localhost:8000/
#
# The unmodified sources are linked against web/mlx, a MiniLibX
# implementation backed by an HTML canvas. Maps up to MAX_MAP_BYTES are
# bundled; bigger ones can still be opened from the page (drag & drop).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$WEB/dist}"
OBJ="$ROOT/build/web"
MAX_MAP_BYTES="${MAX_MAP_BYTES:-2000000}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

command -v emcc >/dev/null || { echo "emcc not found: source emsdk_env.sh first" >&2; exit 1; }

cd "$ROOT"
# Reuse the exact source list of the native Makefile.
SRCS=$(make --no-print-directory --eval='print-srcs: ; @echo $(SRCS)' print-srcs)
LIBFT_SRCS=$(find lib/libft/src -name '*.c' | sort)

CFLAGS=(-O3 -std=gnu99 -pthread -Wall -Wextra
        -Iinclude -Ilib/libft/include -Iweb/mlx -Iweb/compat
        -include web/compat/glibc_compat.h)

OBJS=()
for src in $SRCS $LIBFT_SRCS web/mlx/mlx_web.c web/mlx/mlx_web_xpm.c; do
  o="$OBJ/${src%.c}.o"
  OBJS+=("$o")
  mkdir -p "$(dirname "$o")"
  emcc "${CFLAGS[@]}" -c "$src" -o "$o" &
  if (( $(jobs -rp | wc -l) >= JOBS )); then wait -n; fi
done
for pid in $(jobs -p); do wait "$pid"; done

# Stage the files the program opens at runtime.
STAGE="$OBJ/fs"
rm -rf "$STAGE"; mkdir -p "$STAGE/data" "$STAGE/assets"
cp assets/* "$STAGE/assets/"
find data -maxdepth 1 -type f -name '*.fdf' -size -"${MAX_MAP_BYTES}"c -exec cp {} "$STAGE/data/" \;

mkdir -p "$OUT"
emcc -O3 -pthread "${OBJS[@]}" -o "$OUT/fdf.js" \
  -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=14 -sEXIT_RUNTIME \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=2GB \
  -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
  -sENVIRONMENT=web,worker -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sINVOKE_RUN=0 -sFORCE_FILESYSTEM \
  --pre-js "$WEB/mlx/mlx_web.js" \
  --preload-file "$STAGE@/" -lm

ls "$STAGE/data" | sed 's/\.fdf$//' | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))' > "$OUT/maps.json"
cp "$WEB/index.html" "$WEB/coi-serviceworker.js" "$WEB/serve.py" "$OUT/"
echo "FdF web build ready in $OUT"
