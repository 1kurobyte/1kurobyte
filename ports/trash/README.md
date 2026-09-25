# TraSH in the browser

TraSH needs a real Unix underneath (`fork`, `execve`, pipes, signals, a tty),
so instead of emulating those, `web/build.sh` builds a small Linux system and
boots it in [v86](https://github.com/copy/v86), an x86 PC emulator that JITs
to WebAssembly:

- a ~1.6 MB i386 kernel: `tinyconfig` + `linux.config`;
- an initramfs with a static i386 TraSH, busybox, and `rootfs/init`, which
  keeps a TraSH session running on the serial console. The userland (ncurses,
  readline, TraSH, busybox) is cross-compiled against musl with `zig cc`
  from pinned, checksummed releases, so no 32-bit host libraries are needed;
- a page that connects that serial console to xterm.js.

```sh
./web/build.sh                  # see the header of build.sh for packages
python3 web/dist/serve.py       # http://localhost:8000/
```

It boots in a few seconds. TraSH is built without `NDEBUG`, so `trash -d`
(disassemble the bytecode of each command) is available.
