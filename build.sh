#!/usr/bin/env bash
# Builds the whole portfolio into site/: the desktop plus every project's
# browser build (each project's own web/build.sh) under site/apps/<id>/.
#
#   ./build.sh                       # clone every project, build everything
#   ./build.sh fdf zasm              # only (re)build some apps
#   SOURCES=~/src ./build.sh         # use existing checkouts: ~/src/<repo>
#                                    # (their web/ directory is replaced)
#
# Project repositories and refs are listed in projects.tsv; the projects are
# built unmodified, with ports/<id>/ copied in as their web/ directory. Requirements are
# the union of the projects' own (see .github/workflows/deploy.yml for a
# complete, working Ubuntu setup): emsdk (emcc on PATH), zig, grub-mkrescue,
# xorriso, mtools, gcc-multilib with i386 readline/ncurses, busybox-static:i386,
# kernel build deps, npm, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SITE="${SITE:-$ROOT/site}"
WORK="${WORK:-$ROOT/.work}"
ONLY=("$@")

mkdir -p "$SITE/apps" "$WORK"
cp "$ROOT"/{index.html,desktop.css,desktop.js,apps.json,coi-serviceworker.js,serve.py} "$SITE/"
touch "$SITE/.nojekyll"

while IFS=$'\t' read -r id repo ref; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  if (( ${#ONLY[@]} )) && [[ ! " ${ONLY[*]} " == *" $id "* ]]; then continue; fi
  name="${repo##*/}"
  if [[ -n "${SOURCES:-}" ]]; then
    src="$SOURCES/$name"
  else
    src="$WORK/$name"
    if [[ -d "$src/.git" ]]; then
      git -C "$src" reset -q --hard && git -C "$src" clean -qfdx
      git -C "$src" fetch -q --tags origin "$ref" && git -C "$src" checkout -q FETCH_HEAD
    else
      git clone -q --branch "$ref" "https://github.com/$repo.git" "$src"
      git -C "$src" fetch -q --tags   # kaname's build embeds `git describe`
    fi
  fi
  # The browser port lives here, in ports/<id>/: overlay it as the project's
  # web/ directory, plus source.patch for the rare source-level change.
  rm -rf "$src/web"
  cp -a "$ROOT/ports/$id" "$src/web"
  if [[ -f "$src/web/source.patch" ]]; then
    git -C "$src" apply "$src/web/source.patch"
  fi
  echo "==> $id ($repo@$ref)"
  rm -rf "$SITE/apps/$id"
  OUT="$SITE/apps/$id" "$src/web/build.sh" </dev/null
done < "$ROOT/projects.tsv"

echo "Site ready in $SITE — try: python3 $SITE/serve.py"
