# ~/projects — a live systems portfolio

A Hyprland-style tiling session in the browser where every project **runs for real**:

| App | What runs in the page |
| --- | --- |
| **Kaname** — x86 kernel (Zig) | The kernel's GRUB ISO, booted by [v86](https://github.com/copy/v86) (x86 PC emulator, JIT to WebAssembly) |
| **TraSH** — Unix shell (C) | A tiny i386 Linux + busybox + static TraSH in v86, on xterm.js via the serial console |
| **Cub3D** — raycaster (C) | Emscripten build; renderer pool and physics thread on Web Workers; MiniLibX on a `<canvas>` |
| **FdF** — wireframe renderer (C) | Emscripten build with the same canvas MiniLibX and a multithreaded rasterizer |
| **zasm** — assembler (C) | The assembler as WebAssembly; its ELF output runs in a small x86-64 Linux sandbox (`x86.js`) |

The projects are built from their own repositories **unmodified**: each
browser port (build script, page, glue code) lives here in `ports/<id>/` and
is copied into a fresh clone as its `web/` directory at build time.

## Build

```sh
./build.sh                    # clones projects.tsv, runs each web/build.sh -> site/
python3 site/serve.py         # http://localhost:8000/
./build.sh fdf zasm           # rebuild only some apps
SOURCES=~/src ./build.sh      # use local checkouts (~/src/<repo>) instead of cloning
```

The toolchain list is in the header of `build.sh`; `.github/workflows/deploy.yml`
installs all of it on Ubuntu, builds, and deploys `site/` to GitHub Pages
(on push, weekly, or by hand).

## Layout

- `index.html`, `desktop.css`, `desktop.js` — the session: dwindle tiling
  with gaps and gradient borders, a Waybar-like bar with 5 workspaces, a
  wofi-like launcher and keybinds (`Alt` stands in for `Super`: `Alt+D`
  launcher, `Alt+Q` close, `Alt+F` fullscreen, `Alt+1…5` workspaces,
  `Alt+Shift+1…5` move window, `Alt+arrows`/`hjkl` focus, `Alt+Enter` TraSH).
  Each app is an `<iframe>` created when its window opens and destroyed when
  it closes, so nothing runs in the background. Phones get a monocle layout.
- `apps.json` — app registry (names, blurbs, repositories, window sizes).
- `projects.tsv` — which repository and ref each app is built from.
- `ports/<id>/` — the browser port of each project (its `README.md` explains
  how it works). `ports/cub3d/source.patch` is the only source-level change:
  it lets Cub3D's Linux MiniLibX code paths build under `__EMSCRIPTEN__`.
- `coi-serviceworker.js` — makes the page cross-origin isolated on hosts that
  cannot send COOP/COEP headers (GitHub Pages), which WebAssembly threads need.

Deep links open an app directly: `/#kaname`, `/#trash`, `/#cub3d`, `/#fdf`, `/#zasm`.
