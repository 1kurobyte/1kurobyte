// mlx_web.js - browser side of the MiniLibX web port (Emscripten --pre-js).
//
// Runs on the page's main thread: owns the <canvas>, turns DOM input into
// X11-style events (same numbering and keysyms as minilibx-linux) and pushes
// them into the ring buffer that mlx_loop() drains from its worker thread.

if (typeof window !== 'undefined' && !ENVIRONMENT_IS_PTHREAD) {
  Module.mlx = (function () {
    const EV = { KeyPress: 2, KeyRelease: 3, ButtonPress: 4, ButtonRelease: 5,
                 MotionNotify: 6, DestroyNotify: 17 };

    // KeyboardEvent.code -> X11 keysym. Letters and digits use the physical
    // key so WASD-style bindings work on any keyboard layout.
    const SPECIAL = {
      Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, NumpadEnter: 0xff8d,
      Backspace: 0xff08, Delete: 0xffff, Insert: 0xff63, Home: 0xff50,
      End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
      ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
      ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3,
      ControlRight: 0xffe4, AltLeft: 0xffe9, AltRight: 0xffea,
      MetaLeft: 0xffeb, MetaRight: 0xffec, CapsLock: 0xffe5,
      Space: 0x20, Minus: 0x2d, Equal: 0x3d, BracketLeft: 0x5b,
      BracketRight: 0x5d, Backslash: 0x5c, Semicolon: 0x3b, Quote: 0x27,
      Backquote: 0x60, Comma: 0x2c, Period: 0x2e, Slash: 0x2f,
      NumpadAdd: 0xffab, NumpadSubtract: 0xffad, NumpadMultiply: 0xffaa,
      NumpadDivide: 0xffaf,
    };

    function keysym(e) {
      const c = e.code || '';
      if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3) + 32;
      if (/^Digit[0-9]$/.test(c)) return c.charCodeAt(5);
      if (/^Numpad[0-9]$/.test(c)) return 0xffb0 + (c.charCodeAt(6) - 48);
      if (/^F([1-9]|1[0-2])$/.test(c)) return 0xffbe + parseInt(c.slice(1), 10) - 1;
      if (c in SPECIAL) return SPECIAL[c];
      if (e.key && e.key.length === 1) return e.key.toLowerCase().charCodeAt(0);
      return 0;
    }

    const self = {
      canvas: null, ctx: null, image: null, ring: 0, cap: 0,
      autorepeat: true, wantLock: false, vx: 0, vy: 0, frames: 0,

      attach(ring, cap) { self.ring = ring; self.cap = cap; },

      push(type, a, b, c) {
        if (!self.ring) return;
        const base = self.ring >> 2;
        const head = Atomics.load(HEAP32, base);
        const tail = Atomics.load(HEAP32, base + 1);
        if (head - tail >= self.cap) return; // full: drop, like a slow X client
        const at = base + 2 + (head % self.cap) * 4;
        HEAP32[at] = type; HEAP32[at + 1] = a | 0;
        HEAP32[at + 2] = b | 0; HEAP32[at + 3] = c | 0;
        Atomics.store(HEAP32, base, head + 1);
      },

      createWindow(w, h, title) {
        const cv = Module.canvas;
        cv.width = w; cv.height = h;
        self.canvas = cv;
        self.ctx = cv.getContext('2d', { alpha: false });
        self.ctx.fillStyle = '#000'; self.ctx.fillRect(0, 0, w, h);
        if (Module.onWindow) Module.onWindow(w, h, title);
        bind(cv);
      },

      destroyWindow() { if (Module.onWindowClosed) Module.onWindowClosed(); },

      blit(ptr, w, h, x, y) {
        if (!self.ctx) return;
        if (!self.image || self.image.width !== w || self.image.height !== h)
          self.image = self.ctx.createImageData(w, h);
        self.image.data.set(HEAPU8.subarray(ptr, ptr + w * h * 4));
        self.ctx.putImageData(self.image, x, y);
        self.frames++;
      },

      clear() {
        if (!self.ctx) return;
        self.ctx.fillStyle = '#000';
        self.ctx.fillRect(0, 0, self.canvas.width, self.canvas.height);
      },

      pixel(x, y, color) {
        if (!self.ctx) return;
        self.ctx.fillStyle = '#' + (color & 0xffffff).toString(16).padStart(6, '0');
        self.ctx.fillRect(x, y, 1, 1);
      },

      text(x, y, color, str) {
        if (!self.ctx) return;
        self.ctx.fillStyle = '#' + (color & 0xffffff).toString(16).padStart(6, '0');
        self.ctx.font = '12px monospace';
        self.ctx.fillText(str, x, y);
      },

      hideCursor(hide) {
        self.wantLock = hide;
        if (self.canvas) self.canvas.style.cursor = hide ? 'none' : '';
        if (!hide && document.pointerLockElement === self.canvas)
          document.exitPointerLock();
      },

      // Asks the program to quit, as if the window manager closed the window.
      close() { self.push(EV.DestroyNotify, 0, 0, 0); },
    };

    function pos(e) {
      const r = self.canvas.getBoundingClientRect();
      return [Math.floor((e.clientX - r.left) * self.canvas.width / r.width),
              Math.floor((e.clientY - r.top) * self.canvas.height / r.height)];
    }

    function locked() { return document.pointerLockElement === self.canvas; }

    function bind(cv) {
      if (cv.dataset.mlxBound) return;
      cv.dataset.mlxBound = '1';
      cv.tabIndex = 0;
      cv.addEventListener('contextmenu', (e) => e.preventDefault());
      cv.addEventListener('keydown', (e) => {
        const k = keysym(e);
        if (!k) return;
        e.preventDefault();
        if (e.repeat && !self.autorepeat) return;
        self.push(EV.KeyPress, k, 0, 0);
      });
      cv.addEventListener('keyup', (e) => {
        const k = keysym(e);
        if (!k) return;
        e.preventDefault();
        self.push(EV.KeyRelease, k, 0, 0);
      });
      cv.addEventListener('mousedown', (e) => {
        cv.focus();
        if (self.wantLock && !locked()) {
          const p = pos(e); self.vx = p[0]; self.vy = p[1];
          cv.requestPointerLock();
        }
        const p = locked() ? [self.vx, self.vy] : pos(e);
        self.push(EV.ButtonPress, [1, 2, 3, 8, 9][e.button] || 1, p[0], p[1]);
        e.preventDefault();
      });
      window.addEventListener('mouseup', (e) => {
        if (!self.canvas) return;
        const p = locked() ? [self.vx, self.vy] : pos(e);
        self.push(EV.ButtonRelease, [1, 2, 3, 8, 9][e.button] || 1, p[0], p[1]);
      });
      cv.addEventListener('mousemove', (e) => {
        if (locked()) {
          self.vx += e.movementX; self.vy += e.movementY;
          self.push(EV.MotionNotify, self.vx, self.vy, 0);
        } else {
          const p = pos(e);
          self.push(EV.MotionNotify, p[0], p[1], 0);
        }
      });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = locked() ? [self.vx, self.vy] : pos(e);
        const b = e.deltaY < 0 ? 4 : 5;
        self.push(EV.ButtonPress, b, p[0], p[1]);
        self.push(EV.ButtonRelease, b, p[0], p[1]);
      }, { passive: false });
      cv.addEventListener('blur', () => {
        // Release every key we know of so nothing stays stuck when focus
        // leaves the canvas mid-press.
        for (const k of [0x77, 0x61, 0x73, 0x64, 0x20, 0x63, 0x65, 0xff51,
                         0xff52, 0xff53, 0xff54, 0xffe1, 0xffe3])
          self.push(EV.KeyRelease, k, 0, 0);
      });
    }

    return self;
  })();
}
