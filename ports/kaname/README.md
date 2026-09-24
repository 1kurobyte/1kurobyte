# Kaname in the browser

`web/build.sh` boots the kernel in [v86](https://github.com/copy/v86), an x86
PC emulator with a JIT to WebAssembly. The page shows the VGA/VBE screen,
forwards the keyboard and mirrors COM1 in a side panel.

```sh
./web/build.sh                  # needs zig, grub-mkrescue, xorriso, npm, curl
python3 web/dist/serve.py       # http://localhost:8000/
```

Two GRUB images are produced: `kaname.iso` (default build, VGA text mode)
and `kaname-full.iso` (`-Dfull=true`, VBE framebuffer and the 3D logo).
`web/grub.cfg` is `meta/grub.cfg` without the menu timeout. The v86 release
is pinned in `build.sh` and fetched by `fetch-v86.sh`.
