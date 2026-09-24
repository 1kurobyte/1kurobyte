# Cub3D in the browser

`web/` builds the Cub3D sources to WebAssembly with Emscripten.

```sh
source /path/to/emsdk/emsdk_env.sh
./web/build.sh                  # -> web/dist/
python3 web/dist/serve.py       # http://localhost:8000/
```

- **`mlx/`** is a MiniLibX implementation on top of an HTML `<canvas>`
  (same API and X11 event numbers/keysyms as minilibx-linux). The program
  runs with `PROXY_TO_PTHREAD`, so `main()` and `mlx_loop()` live in a Web
  Worker and may block like they do under X11; input reaches them through a
  lock-free ring buffer in shared memory.
- The renderer thread pool and the physics thread are real threads (pthreads → Web Workers), which
  need `SharedArrayBuffer`, i.e. a cross-origin isolated page: `serve.py`
  sends the COOP/COEP headers, and `coi-serviceworker.js` provides them on
  static hosts such as GitHub Pages.
- **`compat/`** fills in the few glibc-only names the sources use.
- `maps/` and `textures/` are bundled; a `.cub` file can be dropped on the page.
- Mouse look uses the Pointer Lock API: click the view to capture the mouse,
  `Esc` releases it. The only source change is letting the Linux MiniLibX code
  paths (`__linux__`) also build under `__EMSCRIPTEN__`.
