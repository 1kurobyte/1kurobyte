# zasm playground

`web/build.sh` compiles zasm to WebAssembly (Emscripten) and builds a page
where you edit a `.zasm` file, assemble it and run the resulting ELF.

```sh
source /path/to/emsdk/emsdk_env.sh
./web/build.sh                  # -> web/dist/, any static server works
python3 -m http.server -d web/dist
```

- The assembler runs in a Web Worker (`worker.js`), a fresh instance per run,
  and is killed if it takes more than 5 s.
- `x86.js` is a small x86-64 Linux sandbox: it loads the ELF's `PT_LOAD`
  segments, builds the initial process stack, interprets the integer subset
  of x86-64 and implements a few syscalls (`read`, `write`, `exit`, `brk`,
  `getpid`, `uname`, ...). Unsupported instructions or bad memory accesses
  end the program with `SIGILL`/`SIGSEGV`, as they would natively.
- The page also shows an strace-like syscall log, an instruction trace, a
  disassembly and a hexdump coloured by ELF structure.
- `compat/syscall.h` provides the x86-64 syscall numbers (Emscripten's differ),
  and `io_web.c` replaces `src/io.c`, whose `MAP_SHARED` output mapping is
  not written back by Emscripten's in-memory filesystem.
