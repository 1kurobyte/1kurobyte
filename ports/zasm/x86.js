// x86.js - a tiny x86-64 Linux sandbox for the zasm playground.
//
// Loads a static ELF64 executable, maps its PT_LOAD segments and a stack the
// way the kernel does, then interprets it one instruction at a time. It covers
// the general-purpose integer subset a hand-written program uses (mov, lea,
// push/pop, the ALU ops, inc/dec, test, jmp/jcc/call/ret, syscall) and
// implements a few Linux syscalls; anything else stops the program the way a
// real CPU or kernel would (SIGILL, SIGSEGV, -ENOSYS).
//
//   const res = X86.run(elfBytes, { stdin: '', maxSteps: 1e6, syscallNames });
//   // res: { stdout, stderr, exit: {code}|{signal, reason}, trace, strace,
//   //        regs, steps, listing }

(function (global) {
  'use strict';

  const M64 = (1n << 64n) - 1n;
  const MASK = { 1: 0xffn, 2: 0xffffn, 4: 0xffffffffn, 8: M64 };
  const SIGN = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 1n << 63n };
  const R64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
               'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
  const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
               'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'];
  const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di',
               'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'];
  const R8REX = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil',
                 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'];
  const R8LEG = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
  const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
  const CC = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
  const ERRNO = { EBADF: 9, EFAULT: 14, EINVAL: 22, ENOSYS: 38, ENOMEM: 12 };

  class Fault extends Error {
    constructor(signal, reason) { super(reason); this.signal = signal; this.reason = reason; }
  }

  const hex = (v, w) => '0x' + BigInt.asUintN(64, BigInt(v)).toString(16).padStart(w || 0, '0');
  const sext = (v, size) => { v &= MASK[size]; return (v & SIGN[size]) ? v - (MASK[size] + 1n) : v; };

  // --- memory ------------------------------------------------------------------
  class Memory {
    constructor() { this.regions = []; }
    map(base, size, prot, name) {
      const r = { base, size, prot, name, bytes: new Uint8Array(size) };
      this.regions.push(r);
      return r;
    }
    find(addr, len) {
      for (const r of this.regions)
        if (addr >= r.base && addr + len <= r.base + r.size) return r;
      return null;
    }
    check(addr, len, need) {
      addr = Number(BigInt.asUintN(64, BigInt(addr)));
      const r = this.find(addr, len);
      if (!r || !r.prot.includes(need))
        throw new Fault('SIGSEGV', `${need === 'x' ? 'execute' : need === 'w' ? 'write' : 'read'} of ${len} byte(s) at ${hex(addr)}`);
      return [r, addr - r.base];
    }
    read(addr, size, need = 'r') {
      const [r, off] = this.check(addr, size, need);
      let v = 0n;
      for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(r.bytes[off + i]);
      return v;
    }
    write(addr, size, v) {
      const [r, off] = this.check(addr, size, 'w');
      v = BigInt.asUintN(64, v);
      for (let i = 0; i < size; i++) { r.bytes[off + i] = Number(v & 0xffn); v >>= 8n; }
    }
    bytes(addr, len, need = 'r') {
      if (len === 0) return new Uint8Array(0);
      const [r, off] = this.check(addr, len, need);
      return r.bytes.subarray(off, off + len);
    }
  }

  // --- ELF loading ---------------------------------------------------------------
  function load(elf) {
    const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
    if (elf.length < 64 || dv.getUint32(0) !== 0x7f454c46) throw new Error('not an ELF file');
    if (elf[4] !== 2 || elf[5] !== 1) throw new Error('not a little-endian ELF64 file');
    if (dv.getUint16(18, true) !== 62) throw new Error('not an x86-64 executable');
    const entry = Number(dv.getBigUint64(24, true));
    const phoff = Number(dv.getBigUint64(32, true));
    const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
    const mem = new Memory();
    let brk = 0;
    for (let i = 0; i < phnum; i++) {
      const o = phoff + i * phentsize;
      if (dv.getUint32(o, true) !== 1) continue; // PT_LOAD
      const flags = dv.getUint32(o + 4, true);
      const off = Number(dv.getBigUint64(o + 8, true));
      const vaddr = Number(dv.getBigUint64(o + 16, true));
      const filesz = Number(dv.getBigUint64(o + 32, true));
      const memsz = Number(dv.getBigUint64(o + 40, true));
      const base = Math.floor(vaddr / 4096) * 4096;
      const size = Math.ceil((vaddr + memsz) / 4096) * 4096 - base;
      const prot = (flags & 4 ? 'r' : '') + (flags & 2 ? 'w' : '') + (flags & 1 ? 'x' : '');
      const r = mem.map(base, size, prot, `segment ${i}`);
      r.bytes.set(elf.subarray(off, off + Math.min(filesz, elf.length - off)), vaddr - base);
      brk = Math.max(brk, base + size);
    }
    return { mem, entry, brk };
  }

  // --- decoder -------------------------------------------------------------------
  // Decodes one instruction at `rip` into { len, mnem, ops: [...], ... } where
  // operands are { t: 'reg'|'imm'|'mem'|'rel', ... }.
  function decode(mem, rip) {
    let p = rip;
    const byte = () => Number(mem.read(p++, 1, 'x'));
    const imm = (size) => { const v = mem.read(p, size, 'x'); p += size; return sext(v, size); };
    let rex = 0, opsz16 = false, b;
    for (;;) {
      b = byte();
      if (b === 0x66) { opsz16 = true; continue; }
      if (b >= 0x40 && b <= 0x4f) { rex = b; b = byte(); break; }
      break;
    }
    const W = !!(rex & 8), R = (rex >> 2) & 1, X = (rex >> 1) & 1, B = rex & 1;
    const osize = W ? 8 : opsz16 ? 2 : 4;
    const reg = (n, size) => ({ t: 'reg', n, size, rex: !!rex });

    function modrm(size) {
      const m = byte();
      const mod = m >> 6, r = ((m >> 3) & 7) | (R << 3), rm = m & 7;
      const res = { r, rOp: reg(r, size) };
      if (mod === 3) { res.rm = reg(rm | (B << 3), size); return res; }
      const op = { t: 'mem', size, base: null, index: null, scale: 1, disp: 0n, riprel: false };
      if (rm === 4) {
        const sib = byte();
        const scale = 1 << (sib >> 6), idx = ((sib >> 3) & 7) | (X << 3), base = sib & 7;
        if (idx !== 4) { op.index = idx; op.scale = scale; }
        if (base === 5 && mod === 0) op.disp = imm(4);
        else op.base = base | (B << 3);
      } else if (rm === 5 && mod === 0) {
        op.riprel = true; op.disp = imm(4);
      } else op.base = rm | (B << 3);
      if (mod === 1) op.disp = imm(1);
      else if (mod === 2) op.disp = imm(4);
      res.rm = op;
      return res;
    }

    const I = { rip, mnem: null, ops: [] };
    const fin = () => { I.len = p - rip; I.next = rip + I.len; for (const o of I.ops) if (o.riprel) o.ripBase = I.next; return I; };

    if (b === 0x0f) {
      const b2 = byte();
      if (b2 === 0x05) { I.mnem = 'syscall'; return fin(); }
      if (b2 === 0x0b) { I.mnem = 'ud2'; return fin(); }
      if (b2 === 0x1f) { const m = modrm(osize); I.mnem = 'nop'; I.ops = [m.rm]; return fin(); }
      if (b2 >= 0x80 && b2 <= 0x8f) { I.mnem = 'j' + CC[b2 & 15]; I.cc = b2 & 15; I.ops = [{ t: 'rel', v: imm(4) }]; return fin(); }
      if (b2 >= 0x90 && b2 <= 0x9f) { const m = modrm(1); I.mnem = 'set' + CC[b2 & 15]; I.cc = b2 & 15; I.ops = [m.rm]; return fin(); }
      if (b2 === 0xaf) { const m = modrm(osize); I.mnem = 'imul'; I.ops = [m.rOp, m.rm]; return fin(); }
      if (b2 === 0xb6 || b2 === 0xb7) { const m = modrm(b2 === 0xb6 ? 1 : 2); I.mnem = 'movzx'; m.rOp.size = osize; I.ops = [m.rOp, m.rm]; return fin(); }
      I.mnem = '(bad)'; I.bad = `0f ${b2.toString(16).padStart(2, '0')}`; return fin();
    }
    if (b < 0x40 && (b & 7) < 6) {
      const op = ALU[b >> 3], kind = b & 7;
      I.mnem = op;
      if (kind === 0 || kind === 1) { const m = modrm(kind ? osize : 1); I.ops = [m.rm, m.rOp]; }
      else if (kind === 2 || kind === 3) { const m = modrm(kind === 3 ? osize : 1); I.ops = [m.rOp, m.rm]; }
      else if (kind === 4) I.ops = [reg(0, 1), { t: 'imm', v: imm(1) }];
      else I.ops = [reg(0, osize), { t: 'imm', v: imm(osize === 8 ? 4 : osize) }];
      return fin();
    }
    if (b >= 0x50 && b <= 0x57) { I.mnem = 'push'; I.ops = [reg((b & 7) | (B << 3), opsz16 ? 2 : 8)]; return fin(); }
    if (b >= 0x58 && b <= 0x5f) { I.mnem = 'pop'; I.ops = [reg((b & 7) | (B << 3), opsz16 ? 2 : 8)]; return fin(); }
    if (b === 0x68) { I.mnem = 'push'; I.ops = [{ t: 'imm', v: imm(opsz16 ? 2 : 4), size: opsz16 ? 2 : 8 }]; return fin(); }
    if (b === 0x6a) { I.mnem = 'push'; I.ops = [{ t: 'imm', v: imm(1), size: opsz16 ? 2 : 8 }]; return fin(); }
    if (b >= 0x70 && b <= 0x7f) { I.mnem = 'j' + CC[b & 15]; I.cc = b & 15; I.ops = [{ t: 'rel', v: imm(1) }]; return fin(); }
    if (b === 0x80 || b === 0x81 || b === 0x83) {
      const size = b === 0x80 ? 1 : osize, m = modrm(size);
      I.mnem = ALU[m.r & 7];
      I.ops = [m.rm, { t: 'imm', v: imm(b === 0x81 ? (size === 8 ? 4 : size) : 1) }];
      return fin();
    }
    if (b === 0x84 || b === 0x85) { const m = modrm(b & 1 ? osize : 1); I.mnem = 'test'; I.ops = [m.rm, m.rOp]; return fin(); }
    if (b === 0x86 || b === 0x87) { const m = modrm(b & 1 ? osize : 1); I.mnem = 'xchg'; I.ops = [m.rm, m.rOp]; return fin(); }
    if (b >= 0x88 && b <= 0x8b) {
      const m = modrm(b & 1 ? osize : 1);
      I.mnem = 'mov'; I.ops = b & 2 ? [m.rOp, m.rm] : [m.rm, m.rOp];
      return fin();
    }
    if (b === 0x8d) { const m = modrm(osize); I.mnem = 'lea'; I.ops = [m.rOp, m.rm]; return fin(); }
    if (b === 0x90) { I.mnem = 'nop'; return fin(); }
    if (b === 0x99) { I.mnem = W ? 'cqo' : 'cdq'; return fin(); }
    if (b === 0xa8 || b === 0xa9) { const s = b & 1 ? osize : 1; I.mnem = 'test'; I.ops = [reg(0, s), { t: 'imm', v: imm(s === 8 ? 4 : s) }]; return fin(); }
    if (b >= 0xb0 && b <= 0xb7) { I.mnem = 'mov'; I.ops = [reg((b & 7) | (B << 3), 1), { t: 'imm', v: imm(1) }]; return fin(); }
    if (b >= 0xb8 && b <= 0xbf) { I.mnem = W ? 'movabs' : 'mov'; I.ops = [reg((b & 7) | (B << 3), osize), { t: 'imm', v: imm(osize) }]; return fin(); }
    if (b === 0xc3) { I.mnem = 'ret'; return fin(); }
    if (b === 0xc6 || b === 0xc7) {
      const size = b & 1 ? osize : 1, m = modrm(size);
      I.mnem = 'mov'; I.ops = [m.rm, { t: 'imm', v: imm(size === 8 ? 4 : size) }];
      return fin();
    }
    if (b === 0xcc) { I.mnem = 'int3'; return fin(); }
    if (b === 0xcd) { I.mnem = 'int'; I.ops = [{ t: 'imm', v: imm(1) & 0xffn }]; return fin(); }
    if (b === 0xe8) { I.mnem = 'call'; I.ops = [{ t: 'rel', v: imm(4) }]; return fin(); }
    if (b === 0xe9) { I.mnem = 'jmp'; I.ops = [{ t: 'rel', v: imm(4) }]; return fin(); }
    if (b === 0xeb) { I.mnem = 'jmp'; I.ops = [{ t: 'rel', v: imm(1) }]; return fin(); }
    if (b === 0xf4) { I.mnem = 'hlt'; return fin(); }
    if (b === 0xf6 || b === 0xf7) {
      const size = b & 1 ? osize : 1, m = modrm(size), sub = m.r & 7;
      if (sub === 0) { I.mnem = 'test'; I.ops = [m.rm, { t: 'imm', v: imm(size === 8 ? 4 : size) }]; }
      else { I.mnem = ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'][sub]; I.ops = [m.rm]; }
      return fin();
    }
    if (b === 0xfe || b === 0xff) {
      const size = b & 1 ? osize : 1, m = modrm(size), sub = m.r & 7;
      if (sub === 0 || sub === 1) { I.mnem = sub ? 'dec' : 'inc'; I.ops = [m.rm]; }
      else if (b === 0xff && (sub === 2 || sub === 4)) { I.mnem = sub === 2 ? 'call' : 'jmp'; m.rm.size = 8; I.ops = [m.rm]; I.indirect = true; }
      else if (b === 0xff && sub === 6) { I.mnem = 'push'; m.rm.size = 8; I.ops = [m.rm]; }
      else { I.mnem = '(bad)'; I.bad = b.toString(16); }
      return fin();
    }
    I.mnem = '(bad)'; I.bad = b.toString(16).padStart(2, '0');
    return fin();
  }

  function regName(o) {
    if (o.size === 8) return R64[o.n];
    if (o.size === 4) return R32[o.n];
    if (o.size === 2) return R16[o.n];
    return o.rex ? R8REX[o.n] : R8LEG[o.n];
  }

  function format(I) {
    const PTR = { 1: 'byte', 2: 'word', 4: 'dword', 8: 'qword' };
    const ops = I.ops.map((o) => {
      if (o.t === 'reg') return regName(o);
      if (o.t === 'imm') return o.v < 0n && o.v > -4096n ? '-' + hex(-o.v) : hex(o.v);
      if (o.t === 'rel') return hex(BigInt(I.next) + o.v);
      const parts = [];
      if (o.riprel) parts.push('rip');
      if (o.base !== null) parts.push(R64[o.base]);
      if (o.index !== null) parts.push(R64[o.index] + (o.scale > 1 ? '*' + o.scale : ''));
      let s = parts.join(' + ');
      if (o.disp || !parts.length) s += (o.disp < 0n ? ' - ' + hex(-o.disp) : (parts.length ? ' + ' : '') + hex(o.disp));
      const needSize = I.mnem !== 'lea' && !I.ops.some((x) => x.t === 'reg');
      return (needSize ? PTR[o.size] + ' ' : '') + '[' + s + ']';
    });
    return (I.mnem + ' ' + ops.join(', ')).trim();
  }

  // --- CPU --------------------------------------------------------------------------
  class CPU {
    constructor(mem, entry) {
      this.mem = mem;
      this.r = new Array(16).fill(0n);
      this.rip = entry;
      this.f = { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 };
    }
    get(o) {
      if (o.t === 'imm') return BigInt.asUintN(64, o.v) & MASK[o.size || 8];
      if (o.t === 'reg') {
        if (o.size === 1 && !o.rex && o.n >= 4 && o.n < 8) return (this.r[o.n - 4] >> 8n) & 0xffn;
        return this.r[o.n] & MASK[o.size];
      }
      return this.mem.read(this.ea(o), o.size);
    }
    set(o, v) {
      v = BigInt.asUintN(64, v) & MASK[o.size];
      if (o.t === 'reg') {
        const n = o.n;
        if (o.size === 8) this.r[n] = v;
        else if (o.size === 4) this.r[n] = v; // 32-bit writes zero-extend
        else if (o.size === 2) this.r[n] = (this.r[n] & ~0xffffn & M64) | v;
        else if (!o.rex && n >= 4 && n < 8) this.r[n - 4] = (this.r[n - 4] & ~0xff00n & M64) | (v << 8n);
        else this.r[n] = (this.r[n] & ~0xffn & M64) | v;
      } else this.mem.write(this.ea(o), o.size, v);
    }
    ea(o) {
      let a = o.disp;
      if (o.riprel) a += BigInt(o.ripBase);
      if (o.base !== null) a += this.r[o.base];
      if (o.index !== null) a += this.r[o.index] * BigInt(o.scale);
      return BigInt.asUintN(64, a);
    }
    push(v, size = 8) {
      this.r[4] = (this.r[4] - BigInt(size)) & M64;
      this.mem.write(this.r[4], size, v);
    }
    pop(size = 8) {
      const v = this.mem.read(this.r[4], size);
      this.r[4] = (this.r[4] + BigInt(size)) & M64;
      return v;
    }
    flagsLogic(res, size) {
      res &= MASK[size];
      Object.assign(this.f, { cf: 0, of: 0, zf: +(res === 0n), sf: +!!(res & SIGN[size]), pf: parity(res) });
    }
    alu(op, a, b, size) {
      const m = MASK[size], s = SIGN[size];
      let res;
      switch (op) {
        case 'add': case 'adc': {
          const c = op === 'adc' ? BigInt(this.f.cf) : 0n;
          res = (a + b + c) & m;
          this.f.cf = +((a + b + c) > m);
          this.f.of = +(!((a ^ b) & s) && !!((a ^ res) & s));
          break;
        }
        case 'sub': case 'sbb': case 'cmp': {
          const c = op === 'sbb' ? BigInt(this.f.cf) : 0n;
          res = (a - b - c) & m;
          this.f.cf = +(a < b + c);
          this.f.of = +(!!((a ^ b) & s) && !!((a ^ res) & s));
          break;
        }
        case 'and': res = a & b; this.f.cf = this.f.of = 0; break;
        case 'or': res = a | b; this.f.cf = this.f.of = 0; break;
        case 'xor': res = a ^ b; this.f.cf = this.f.of = 0; break;
      }
      this.f.zf = +(res === 0n); this.f.sf = +!!(res & s); this.f.pf = parity(res);
      return res;
    }
    cond(cc) {
      const f = this.f;
      const r = [f.of, f.cf, f.zf, f.cf | f.zf, f.sf, f.pf, +(f.sf !== f.of), +(f.zf || f.sf !== f.of)][cc >> 1];
      return cc & 1 ? !r : !!r;
    }
  }

  function parity(v) { let x = Number(v & 0xffn), p = 1; while (x) { p ^= x & 1; x >>= 1; } return p; }

  // --- Linux syscalls -------------------------------------------------------------------
  function makeKernel(cpu, opts, out) {
    const mem = cpu.mem;
    const dec = new TextDecoder();
    const stdin = new TextEncoder().encode(opts.stdin || '');
    let stdinPos = 0, brk = opts.brk, brkStart = opts.brk;
    const cstr = (addr, max = 256) => {
      const b = [];
      try { for (let i = 0; i < max; i++) { const c = Number(mem.read(BigInt(addr) + BigInt(i), 1)); if (!c) break; b.push(c); } } catch (e) { /* unmapped */ }
      return dec.decode(new Uint8Array(b));
    };
    const quote = (bytes) => JSON.stringify(dec.decode(bytes.subarray(0, 32))) + (bytes.length > 32 ? '...' : '');

    const table = {
      0: (fd, buf, n) => { // read
        if (Number(fd) !== 0) return [-ERRNO.EBADF];
        const len = Math.min(Number(n), stdin.length - stdinPos);
        const dst = mem.bytes(buf, len, 'w');
        dst.set(stdin.subarray(stdinPos, stdinPos + len)); stdinPos += len;
        return [len, `read(0, ${quote(dst)}, ${n})`];
      },
      1: (fd, buf, n) => { // write
        fd = Number(fd);
        if (fd !== 1 && fd !== 2) return [-ERRNO.EBADF];
        const bytes = mem.bytes(buf, Number(n)).slice();
        out.push({ fd, bytes });
        return [bytes.length, `write(${fd}, ${quote(bytes)}, ${n})`];
      },
      12: (addr) => { // brk
        addr = Number(addr);
        if (addr > brk) {
          const size = Math.ceil((addr - brk) / 4096) * 4096;
          mem.map(brk, size, 'rw', 'heap'); brk += size;
        }
        return [addr >= brkStart ? Math.max(addr, brkStart) : brk];
      },
      9: (addr, len, prot, flags) => { // mmap (anonymous only)
        if (!(Number(flags) & 0x20)) return [-ERRNO.ENOSYS];
        const size = Math.ceil(Number(len) / 4096) * 4096;
        const base = opts.mmapNext; opts.mmapNext += size + 4096;
        mem.map(base, size, (Number(prot) & 1 ? 'r' : '') + (Number(prot) & 2 ? 'w' : '') + (Number(prot) & 4 ? 'x' : ''), 'mmap');
        return [base];
      },
      11: () => [0], // munmap: pretend
      35: () => [0], // nanosleep: instant
      39: () => [4242], // getpid
      110: () => [1], // getppid
      102: () => [1000], 104: () => [1000], 107: () => [1000], 108: () => [1000],
      201: (t) => { const now = BigInt(Math.floor(Date.now() / 1000)); if (t) mem.write(t, 8, now); return [now]; },
      63: (buf) => { // uname
        ['Linux', 'zasm-sandbox', '6.16.0', '#1 x86.js', 'x86_64', '(none)'].forEach((s, i) => {
          const dst = mem.bytes(BigInt(buf) + BigInt(i * 65), 65, 'w'); dst.fill(0);
          dst.set(new TextEncoder().encode(s));
        });
        return [0];
      },
      20: (fd, iov, cnt) => { // writev
        let total = 0;
        for (let i = 0; i < Number(cnt); i++) {
          const base = mem.read(BigInt(iov) + BigInt(16 * i), 8), len = mem.read(BigInt(iov) + BigInt(16 * i + 8), 8);
          const [n] = table[1](fd, base, len);
          if (n < 0) return [n];
          total += n;
        }
        return [total];
      },
      60: (code) => { throw { exit: Number(code & 0xffn) }; },
      231: (code) => { throw { exit: Number(code & 0xffn) }; },
      62: (pid, sig) => { throw new Fault('SIG' + (['', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV'][Number(sig)] || Number(sig)), 'kill() sent to self'); },
    };

    return function syscall() {
      const nr = Number(cpu.r[0]);
      const args = [cpu.r[7], cpu.r[6], cpu.r[2], cpu.r[10], cpu.r[8], cpu.r[9]];
      const name = (opts.syscallNames && opts.syscallNames[nr]) || `syscall_${nr}`;
      let ret, text;
      const fn = table[nr];
      if (!fn) ret = -ERRNO.ENOSYS;
      else {
        try { [ret, text] = fn(...args); }
        catch (e) {
          if (e.exit !== undefined) { opts.strace.push(`${name}(${e.exit}) = ?`); throw e; }
          if (e instanceof Fault) { ret = -ERRNO.EFAULT; } else throw e;
        }
      }
      if (!text) text = `${name}(${args.slice(0, arity(nr)).map((a) => hex(a)).join(', ')})`;
      const errname = Object.keys(ERRNO).find((k) => ERRNO[k] === -ret);
      opts.strace.push(`${text} = ${ret < 0 ? `-1 ${errname || ''} (${-ret})${fn ? '' : ' [not implemented in the sandbox]'}` : typeof ret === 'number' && ret > 4096 ? hex(ret) : ret}`);
      cpu.r[0] = BigInt.asUintN(64, BigInt(ret));
    };
  }
  function arity(nr) { return { 39: 0, 102: 0, 104: 0, 107: 0, 108: 0, 110: 0, 60: 1, 231: 1, 12: 1, 201: 1, 63: 1 }[nr] ?? 3; }

  // --- execution ------------------------------------------------------------------------
  function exec(cpu, I, syscall) {
    const [a, b] = I.ops;
    cpu.rip = I.next;
    switch (I.mnem) {
      case 'nop': case 'cdq': break;
      case 'cqo': cpu.r[2] = cpu.r[0] & SIGN[8] ? M64 : 0n; break;
      case 'mov': case 'movabs': case 'movzx': cpu.set(a, cpu.get(b)); break;
      case 'lea': cpu.set(a, cpu.ea(b)); break;
      case 'push': cpu.push(a.t === 'imm' ? BigInt.asUintN(64, a.v) : cpu.get(a), a.size === 2 ? 2 : 8); break;
      case 'pop': cpu.set(a, cpu.pop(a.size === 2 ? 2 : 8)); break;
      case 'xchg': { const t = cpu.get(a); cpu.set(a, cpu.get(b)); cpu.set(b, t); break; }
      case 'add': case 'or': case 'adc': case 'sbb': case 'and': case 'sub': case 'xor': case 'cmp': {
        const size = a.size;
        const bv = b.t === 'imm' ? BigInt.asUintN(64, b.v) & MASK[size] : cpu.get(b);
        const r = cpu.alu(I.mnem, cpu.get(a), bv, size);
        if (I.mnem !== 'cmp') cpu.set(a, r);
        break;
      }
      case 'test': {
        const bv = b.t === 'imm' ? BigInt.asUintN(64, b.v) & MASK[a.size] : cpu.get(b);
        cpu.flagsLogic(cpu.get(a) & bv, a.size);
        break;
      }
      case 'inc': case 'dec': {
        const cf = cpu.f.cf;
        cpu.set(a, cpu.alu(I.mnem === 'inc' ? 'add' : 'sub', cpu.get(a), 1n, a.size));
        cpu.f.cf = cf;
        break;
      }
      case 'not': cpu.set(a, ~cpu.get(a)); break;
      case 'neg': cpu.set(a, cpu.alu('sub', 0n, cpu.get(a), a.size)); break;
      case 'imul': { const r = sext(cpu.get(a), a.size) * sext(cpu.get(b), a.size); cpu.set(a, r); break; }
      case 'jmp': cpu.rip = I.indirect ? Number(cpu.get(a)) : I.next + Number(a.v); break;
      case 'call': cpu.push(BigInt(I.next)); cpu.rip = I.indirect ? Number(cpu.get(a)) : I.next + Number(a.v); break;
      case 'ret': cpu.rip = Number(cpu.pop()); break;
      case 'syscall': cpu.r[1] = BigInt(I.next); cpu.r[11] = 0x202n; syscall(); break;
      case 'hlt': throw new Fault('SIGSEGV', 'hlt is a privileged instruction (general protection fault)');
      case 'int3': throw new Fault('SIGTRAP', 'breakpoint (int3)');
      case 'int': throw new Fault('SIGSEGV', `int ${hex(a.v)} is not allowed from user mode here (general protection fault)`);
      case 'ud2': throw new Fault('SIGILL', 'ud2');
      default:
        if (I.mnem.startsWith('j') && I.cc !== undefined) { if (cpu.cond(I.cc)) cpu.rip = I.next + Number(a.v); break; }
        if (I.mnem.startsWith('set')) { cpu.set(a, cpu.cond(I.cc) ? 1n : 0n); break; }
        throw new Fault('SIGILL', `illegal or unsupported instruction${I.bad ? ' (opcode ' + I.bad + ')' : ''} at ${hex(I.rip)}`);
    }
  }

  function run(elf, opts = {}) {
    const maxSteps = opts.maxSteps || 1000000, traceMax = opts.traceMax || 400;
    const { mem, entry, brk } = load(elf);
    // Initial process stack, as execve() leaves it: argc, argv, envp, auxv.
    const STACK_TOP = 0x7ffffffff000, STACK_SIZE = 0x21000;
    const stack = mem.map(STACK_TOP - STACK_SIZE, STACK_SIZE, 'rw', 'stack');
    const cpu = new CPU(mem, entry);
    const name = new TextEncoder().encode('./a.out\0');
    let sp = STACK_TOP - 64;
    stack.bytes.set(name, sp - stack.base);
    const argv0 = sp;
    sp = Math.floor((sp - 64) / 16) * 16; // 16-byte aligned, as the ABI requires
    for (const [i, v] of [1, argv0, 0, 0, 0, 0].entries()) mem.write(BigInt(sp + i * 8), 8, BigInt(v));
    cpu.r[4] = BigInt(sp);

    const out = [], strace = [], trace = [];
    const kopts = { ...opts, brk, mmapNext: 0x7f0000000000, strace };
    const syscall = makeKernel(cpu, kopts, out);
    let exit = null, steps = 0;
    try {
      while (steps < maxSteps) {
        const rip = cpu.rip;
        const I = decode(mem, rip);
        if (trace.length < traceMax) {
          const before = cpu.r.slice();
          trace.push({ rip, bytes: Array.from(mem.bytes(rip, I.len, 'x')), text: format(I), changes: null });
          exec(cpu, I, syscall);
          trace[trace.length - 1].changes = cpu.r.map((v, i) => (v !== before[i] ? `${R64[i]}=${hex(v)}` : null)).filter(Boolean);
        } else exec(cpu, I, syscall);
        steps++;
      }
      if (!exit) exit = { signal: 'SIGKILL', reason: `stopped after ${maxSteps} instructions (infinite loop?)` };
    } catch (e) {
      steps++;
      const last = trace[trace.length - 1];
      if (last && !last.changes) last.changes = [];
      if (e && e.exit !== undefined) exit = { code: e.exit };
      else if (e instanceof Fault) exit = { signal: e.signal, reason: e.reason, rip: cpu.rip };
      else throw e;
    }
    const cat = (fd) => new TextDecoder().decode(concat(out.filter((o) => o.fd === fd).map((o) => o.bytes)));
    return {
      stdout: cat(1), stderr: cat(2), output: out, exit, trace, strace, steps,
      regs: Object.fromEntries(R64.map((n, i) => [n, hex(cpu.r[i], 16)]).concat([['rip', hex(cpu.rip, 16)]])),
      flags: { ...cpu.f },
    };
  }

  // Disassembles the executable bytes of every PT_LOAD segment from the entry point.
  function disassemble(elf, maxInsns = 512) {
    const { mem, entry } = load(elf);
    const rows = [];
    let rip = entry;
    const seg = mem.find(entry, 1);
    const end = seg ? seg.base + seg.size : entry;
    while (rip < end && rows.length < maxInsns) {
      let I;
      try { I = decode(mem, rip); } catch (e) { break; }
      const bytes = Array.from(mem.bytes(rip, I.len, 'x'));
      // Stop at the zero padding that follows the code.
      if (bytes.every((x) => !x) && mem.bytes(rip, end - rip, 'x').every((x) => !x)) break;
      rows.push({ rip, bytes, text: format(I) });
      rip = I.next;
    }
    return rows;
  }

  function concat(arrs) {
    const n = arrs.reduce((s, a) => s + a.length, 0), r = new Uint8Array(n);
    let o = 0; for (const a of arrs) { r.set(a, o); o += a.length; }
    return r;
  }

  global.X86 = { run, disassemble, load, decode, format };
})(typeof window !== 'undefined' ? window : globalThis);
