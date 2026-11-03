/**
 * Pure JavaScript x86-64 Machine Code Assembler
 *
 * No GCC, no Clang, no NASM, no external toolchain or linker.
 * Direct opcode emission into Buffer with 2-pass label resolution.
 */

// GPR indices (64-bit)
export const REG = Object.freeze({
  RAX: 0, RCX: 1, RDX: 2, RBX: 3, RSP: 4, RBP: 5, RSI: 6, RDI: 7,
  R8: 8,  R9: 9,  R10: 10, R11: 11, R12: 12, R13: 13, R14: 14, R15: 15,
});

// XMM indices (128-bit)
export const XMM = Object.freeze({
  XMM0: 0,  XMM1: 1,  XMM2: 2,  XMM3: 3,  XMM4: 4,  XMM5: 5,  XMM6: 6,  XMM7: 7,
  XMM8: 8,  XMM9: 9,  XMM10: 10, XMM11: 11, XMM12: 12, XMM13: 13, XMM14: 14, XMM15: 15,
});

export const COND = Object.freeze({
  O: 0x0, NO: 0x1, B: 0x2, C: 0x2, NAE: 0x2, AE: 0x3, NB: 0x3, NC: 0x3,
  E: 0x4, Z: 0x4, NE: 0x5, NZ: 0x5, BE: 0x6, NA: 0x6, A: 0x7, NBE: 0x7,
  S: 0x8, NS: 0x9, P: 0xa, PE: 0xa, NP: 0xb, PO: 0xb,
  L: 0xc, NGE: 0xc, GE: 0xd, NL: 0xd, LE: 0xe, NG: 0xe, G: 0xf, NLE: 0xf,
});

export class Assembler {
  constructor(baseVaddr = 0x401000) {
    this.baseVaddr = baseVaddr;
    this.bytes = [];
    this.labels = new Map();
    this.fixups = [];
  }

  // Label definition
  label(name) {
    if (this.labels.has(name)) {
      throw new Error(`Duplicate label: ${name}`);
    }
    this.labels.set(name, this.bytes.length);
  }

  // Current PC
  get pc() {
    return this.bytes.length;
  }

  get vaddr() {
    return this.baseVaddr + this.bytes.length;
  }

  emit(...b) {
    for (let i = 0; i < b.length; i++) {
      this.bytes.push(b[i] & 0xff);
    }
  }

  emitU16(v) {
    this.emit(v & 0xff, (v >> 8) & 0xff);
  }

  emitU32(v) {
    this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  }

  emitU64(v) {
    const b = BigInt(v);
    for (let i = 0; i < 8; i++) {
      this.emit(Number((b >> BigInt(i * 8)) & 0xffn));
    }
  }

  emitBytes(buf) {
    for (let i = 0; i < buf.length; i++) {
      this.bytes.push(buf[i]);
    }
  }

  // REX prefix
  rex(w = 1, r = 0, x = 0, b = 0) {
    const wr = w ? 8 : 0;
    const rr = (r >= 8 ? 1 : 0) << 2;
    const xr = (x >= 8 ? 1 : 0) << 1;
    const br = b >= 8 ? 1 : 0;
    const byte = 0x40 | wr | rr | xr | br;
    if (byte !== 0x40 || w) {
      this.emit(byte);
    }
  }

  // ModR/M
  modrm(mod, reg, rm) {
    return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);
  }

  // SIB
  sib(scale, index, base) {
    return ((scale & 3) << 6) | ((index & 7) << 3) | (base & 7);
  }

  // --- ALU Register-to-Register (Pure Register Machine) ---
  // add dst, src
  add(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x01, this.modrm(3, src, dst));
  }

  // sub dst, src
  sub(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x29, this.modrm(3, src, dst));
  }

  // xor dst, src
  xor(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x31, this.modrm(3, src, dst));
  }

  // and dst, src
  and(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x21, this.modrm(3, src, dst));
  }

  // and dst, imm8
  andImm8(dst, imm8) {
    this.rex(1, 0, 0, dst);
    this.emit(0x83, this.modrm(3, 4, dst), imm8 & 0xff);
  }

  // and dst, imm32 (sign-extended; safe for masks like 0xff)
  andImm32(dst, imm32) {
    this.rex(1, 0, 0, dst);
    this.emit(0x81, this.modrm(3, 4, dst));
    this.emitU32(imm32);
  }

  // or dst, src
  or(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x09, this.modrm(3, src, dst));
  }

  // imul dst, src (dst = dst * src)
  imul(dst, src) {
    this.rex(1, dst, 0, src);
    this.emit(0x0f, 0xaf, this.modrm(3, dst, src));
  }

  // div reg64 (RDX:RAX / reg64 -> RAX=quotient, RDX=remainder)
  divReg(reg) {
    this.rex(1, 0, 0, reg);
    this.emit(0xf7, this.modrm(3, 6, reg));
  }

  // cmp dst, src
  cmp(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x39, this.modrm(3, src, dst));
  }

  // test dst, src
  test(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x85, this.modrm(3, src, dst));
  }

  // bt dst, imm8: copy bit imm8 of dst into CF (does not modify dst).
  btImm(dst, imm8) {
    this.rex(1, 0, 0, dst);
    this.emit(0x0f, 0xba, this.modrm(3, 4, dst), imm8 & 0xff);
  }

  // mov dst, src (GPR to GPR)
  mov(dst, src) {
    this.rex(1, src, 0, dst);
    this.emit(0x89, this.modrm(3, src, dst));
  }

  // mov dst, imm64
  movImm64(dst, imm64) {
    // 0x48 | B, 0xb8 + (dst & 7), 8 bytes
    this.emit(0x48 | (dst >= 8 ? 1 : 0), 0xb8 + (dst & 7));
    this.emitU64(imm64);
  }

  // mov dst, imm32 (sign-extended to 64-bit)
  movImm32(dst, imm32) {
    this.rex(1, 0, 0, dst);
    this.emit(0xc7, this.modrm(3, 0, dst));
    this.emitU32(imm32);
  }

  // add dst, imm32
  addImm32(dst, imm32) {
    this.rex(1, 0, 0, dst);
    this.emit(0x81, this.modrm(3, 0, dst));
    this.emitU32(imm32);
  }

  // sub dst, imm32
  subImm32(dst, imm32) {
    this.rex(1, 0, 0, dst);
    this.emit(0x81, this.modrm(3, 5, dst));
    this.emitU32(imm32);
  }

  // cmp dst, imm32
  cmpImm32(dst, imm32) {
    this.rex(1, 0, 0, dst);
    this.emit(0x81, this.modrm(3, 7, dst));
    this.emitU32(imm32);
  }

  // neg dst (two's complement)
  neg(dst) {
    this.rex(1, 0, 0, dst);
    this.emit(0xf7, this.modrm(3, 3, dst));
  }

  // bswap r32 (register halves)
  bswap32(dst) {
    this.rex(0, 0, 0, dst);
    this.emit(0x0f, 0xc8 | (dst & 7));
  }

  // inc dst
  inc(dst) {
    this.rex(1, 0, 0, dst);
    this.emit(0xff, this.modrm(3, 0, dst));
  }

  // dec dst
  dec(dst) {
    this.rex(1, 0, 0, dst);
    this.emit(0xff, this.modrm(3, 1, dst));
  }

  // shl dst, cl
  shlCl(dst) {
    this.rex(1, 0, 0, dst);
    this.emit(0xd3, this.modrm(3, 4, dst));
  }

  // shl dst, src (shift dst by the CL-derived value; alias of shlCl)
  shl(dst, src) {
    this.shlCl(dst);
  }

  // shl dst, imm8
  shlImm8(dst, imm8) {
    this.rex(1, 0, 0, dst);
    this.emit(0xc1, this.modrm(3, 4, dst), imm8 & 0xff);
  }

  // shr dst, cl
  shrCl(dst) {
    this.rex(1, 0, 0, dst);
    this.emit(0xd3, this.modrm(3, 5, dst));
  }

  // shr dst, imm8
  shrImm8(dst, imm8) {
    this.rex(1, 0, 0, dst);
    this.emit(0xc1, this.modrm(3, 5, dst), imm8 & 0xff);
  }

  // rol dst, imm8
  rolImm(dst, imm8) {
    this.rex(1, 0, 0, dst);
    this.emit(0xc1, this.modrm(3, 0, dst), imm8 & 0xff);
  }

  // ror dst, imm8
  rorImm(dst, imm8) {
    this.rex(1, 0, 0, dst);
    this.emit(0xc1, this.modrm(3, 1, dst), imm8 & 0xff);
  }

  // lea dst, [rip + label]
  leaRip(dst, labelName) {
    this.rex(1, dst, 0, 0);
    this.emit(0x8d, this.modrm(0, dst, 5));
    this.fixups.push({
      type: 'rip_disp32',
      offset: this.bytes.length,
      label: labelName,
      insnEnd: this.bytes.length + 4,
    });
    this.emitU32(0); // placeholder
  }

  // load: mov dst, [base + disp32]
  load64(dst, base, disp32 = 0) {
    this.rex(1, dst, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x8b, this.modrm(0, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x8b, this.modrm(0, dst, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x8b, this.modrm(1, dst, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x8b, this.modrm(1, dst, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x8b, this.modrm(2, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x8b, this.modrm(2, dst, base));
      }
      this.emitU32(disp32);
    }
  }

  // store: mov [base + disp32], src
  store64(base, src, disp32 = 0) {
    this.rex(1, src, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(0, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x89, this.modrm(0, src, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(1, src, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x89, this.modrm(1, src, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(2, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x89, this.modrm(2, src, base));
      }
      this.emitU32(disp32);
    }
  }

  // store word: mov word ptr [base + disp32], src16
  store16(base, src, disp32 = 0) {
    this.emit(0x66);
    this.rex(0, src, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(0, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x89, this.modrm(0, src, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(1, src, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x89, this.modrm(1, src, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(2, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x89, this.modrm(2, src, base));
      }
      this.emitU32(disp32);
    }
  }

  // store dword: mov dword ptr [base + disp32], src32
  store32(base, src, disp32 = 0) {
    this.rex(0, src, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(0, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x89, this.modrm(0, src, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(1, src, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x89, this.modrm(1, src, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x89, this.modrm(2, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x89, this.modrm(2, src, base));
      }
      this.emitU32(disp32);
    }
  }

  // store byte: mov byte ptr [base + disp32], src8
  store8(base, src, disp32 = 0) {
    this.rex(0, src, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x88, this.modrm(0, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x88, this.modrm(0, src, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x88, this.modrm(1, src, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x88, this.modrm(1, src, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x88, this.modrm(2, src, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x88, this.modrm(2, src, base));
      }
      this.emitU32(disp32);
    }
  }

  // --- Vector SIMD Instructions (XMM0 - XMM15) ---
  // pxor dst, src (XMM to XMM)
  pxor(dst, src) {
    this.emit(0x66);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0xef, this.modrm(3, dst, src));
  }

  // paddq dst, src (packed 64-bit int add)
  paddq(dst, src) {
    this.emit(0x66);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0xd4, this.modrm(3, dst, src));
  }

  // paddd dst, src (packed 32-bit int add)
  paddd(dst, src) {
    this.emit(0x66);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0xfe, this.modrm(3, dst, src));
  }

  // movdqa dst, src (aligned 128-bit move)
  movdqa(dst, src) {
    this.emit(0x66);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x6f, this.modrm(3, dst, src));
  }

  // movdqu dst, src (unaligned 128-bit move)
  movdqu(dst, src) {
    this.emit(0xf3);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x6f, this.modrm(3, dst, src));
  }

  // xorps dst, src
  xorps(dst, src) {
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x57, this.modrm(3, dst, src));
  }

  // addps dst, src
  addps(dst, src) {
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x58, this.modrm(3, dst, src));
  }

  // mulps dst, src
  mulps(dst, src) {
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x59, this.modrm(3, dst, src));
  }

  // aesenc dst, src (AES encryption round - zero-spill RandomX primitive)
  aesenc(dst, src) {
    this.emit(0x66);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x38, 0xdc, this.modrm(3, dst, src));
  }

  // aesdec dst, src
  aesdec(dst, src) {
    this.emit(0x66);
    this.rex(0, dst, 0, src);
    this.emit(0x0f, 0x38, 0xde, this.modrm(3, dst, src));
  }

  // movq xmmDst, gprSrc
  movqToXmm(xmmDst, gprSrc) {
    this.emit(0x66);
    this.rex(1, xmmDst, 0, gprSrc);
    this.emit(0x0f, 0x6e, this.modrm(3, xmmDst, gprSrc));
  }

  // movq gprDst, xmmSrc
  movqFromXmm(gprDst, xmmSrc) {
    this.emit(0x66);
    this.rex(1, xmmSrc, 0, gprDst);
    this.emit(0x0f, 0x7e, this.modrm(3, xmmSrc, gprDst));
  }

  // --- AVX-512 ZMM Register Operations ---
  //
  // EVEX prefix + opcode + ModRM (mod=3).
  //   mm: 1=0F, 2=0F38, 3=0F3A
  //   pp: 0=none, 1=66, 2=F3, 3=F2
  //   ll: 0=128, 1=256, 2=512
  //   vvvv/aaa are actual register / mask numbers (0..31 / 0..7).
  // Extension bits in the EVEX prefix are inverted.
  evex(mm, w, pp, z, ll, b, vvvv, aaa, reg, rm, opcode) {
    const R = (reg >> 3) & 1, Rp = (reg >> 4) & 1;
    const B = (rm >> 3) & 1, X = (rm >> 4) & 1;
    const Vp = (vvvv >> 4) & 1, v4 = vvvv & 0xf;
    const p0 = ((1 - R) << 7) | ((1 - X) << 6) | ((1 - B) << 5) | ((1 - Rp) << 4) | (mm & 3);
    const p1 = (w << 7) | (((~v4) & 0xf) << 3) | (1 << 2) | (pp & 3);
    const p2 = (z << 7) | ((ll & 3) << 5) | (b << 4) | ((1 - Vp) << 3) | (aaa & 7);
    this.emit(0x62, p0, p1, p2, opcode, this.modrm(3, reg & 7, rm & 7));
  }

  // vmovdqu64 zmm1, zmm2 (move 512 bits)
  vmovdqu64(dst, src) {
    this.evex(1, 1, 2, 0, 2, 0, 0, 0, dst, src, 0x6f);
  }

  // EVEX memory form with mod=10 (disp32), no index register.
  evexMem(mm, w, pp, z, ll, b, vvvv, aaa, reg, base, disp32, opcode) {
    const R = (reg >> 3) & 1, Rp = (reg >> 4) & 1;
    const B = (base >> 3) & 1, X = 0;
    const Vp = (vvvv >> 4) & 1, v4 = vvvv & 0xf;
    const p0 = ((1 - R) << 7) | ((1 - X) << 6) | ((1 - B) << 5) | ((1 - Rp) << 4) | (mm & 3);
    const p1 = (w << 7) | (((~v4) & 0xf) << 3) | (1 << 2) | (pp & 3);
    const p2 = (z << 7) | ((ll & 3) << 5) | (b << 4) | ((1 - Vp) << 3) | (aaa & 7);
    this.emit(0x62, p0, p1, p2, opcode);
    if ((base & 7) === 4) {
      this.emit(this.modrm(2, reg & 7, 4), 0x24);
    } else {
      this.emit(this.modrm(2, reg & 7, base & 7));
    }
    this.emitU32(disp32);
  }

  // vmovdqu64 zmm, [base + disp32]
  vmovdqu64Load(dst, base, disp32 = 0) {
    this.evexMem(1, 1, 2, 0, 2, 0, 0, 0, dst, base, disp32, 0x6f);
  }

  // vmovdqu64 [base + disp32], zmm
  vmovdqu64Store(base, disp32, src) {
    this.evexMem(1, 1, 2, 0, 2, 0, 0, 0, src, base, disp32, 0x7f);
  }

  // vpbroadcastq zmm1, r64 (broadcast 64-bit int to all lanes)
  vpbroadcastq(zmm, gpr) {
    this.evex(2, 1, 1, 0, 2, 0, 0, 0, zmm, gpr, 0x7c);
  }

  // vpaddq zmm1, zmm2, zmm3 (packed 64-bit add)
  vpaddq(dst, src1, src2) {
    this.evex(1, 1, 1, 0, 2, 0, src1, 0, dst, src2, 0xd4);
  }

  // vpxorq zmm1, zmm2, zmm3 (packed XOR)
  vpxorq(dst, src1, src2) {
    this.evex(1, 1, 1, 0, 2, 0, src1, 0, dst, src2, 0xef);
  }

  // vpmullq zmm1, zmm2, zmm3 (packed 64-bit multiply)
  vpmullq(dst, src1, src2) {
    this.evex(2, 1, 1, 0, 2, 0, src1, 0, dst, src2, 0xb4);
  }

  // vpcompressq zmm1{k}{z}, zmm2 (pack masked lanes to the bottom)
  // Note: vpcompressq stores reg (source) into rm (destination).
  vpcompressq(dst, src, k, zeroing = true) {
    this.evex(2, 1, 1, zeroing ? 1 : 0, 2, 0, 0, k, src, dst, 0x8b);
  }

  // vpblendmq zmm1{k}, zmm2, zmm3 (masked lane blend; k picks zmm3)
  vpblendmq(dst, src1, src2, k) {
    this.evex(2, 1, 1, 0, 2, 0, src1, k, dst, src2, 0x64);
  }

  // vpermq zmm1, zmm2, zmm3 (variable lane permutation)
  vpermq(dst, index, data) {
    this.evex(2, 1, 1, 0, 2, 0, index, 0, dst, data, 0x36);
  }

  // kmovq k1, r64 (mask register <- GPR)
  kmovq(k, gpr) {
    const B = (gpr >> 3) & 1;
    this.emit(0xc4, 0xc1 | ((1 - B) << 5), 0xfb, 0x92, this.modrm(3, k, gpr));
  }

  // vmovq r64, xmm (VEX; supports xmm0-15)
  vmovq_gpr_xmm(gpr, xmm) {
    const R = (xmm >> 3) & 1, B = (gpr >> 3) & 1;
    const b1 = ((1 - R) << 7) | (1 << 6) | ((1 - B) << 5) | 1;
    this.emit(0xc4, b1, 0xf9, 0x7e, this.modrm(3, xmm, gpr));
  }

  // vmovq xmm, r64 (VEX; supports xmm0-15)
  vmovq_xmm_gpr(xmm, gpr) {
    const R = (xmm >> 3) & 1, B = (gpr >> 3) & 1;
    const b1 = ((1 - R) << 7) | (1 << 6) | ((1 - B) << 5) | 1;
    this.emit(0xc4, b1, 0xf9, 0x6e, this.modrm(3, xmm, gpr));
  }

  // vpinsrq xmm1, xmm2, r64, imm8 (insert 64-bit int into xmm)
  vpinsrq(dst, src, gpr, imm8) {
    const R = (dst >> 3) & 1, B = (gpr >> 3) & 1;
    const v4 = src & 0xf;
    const b1 = ((1 - R) << 7) | (1 << 6) | ((1 - B) << 5) | 3;
    const b2 = 0x80 | (((~v4) & 0xf) << 3) | 1;
    this.emit(0xc4, b1, b2, 0x22, this.modrm(3, dst, gpr), imm8 & 0xff);
  }

  // vpextrq r64, xmm1, imm8 (extract 64-bit int from xmm)
  vpextrq(gpr, xmm, imm8) {
    const R = (xmm >> 3) & 1, B = (gpr >> 3) & 1;
    const b1 = ((1 - R) << 7) | (1 << 6) | ((1 - B) << 5) | 3;
    this.emit(0xc4, b1, 0xf9, 0x16, this.modrm(3, xmm, gpr), imm8 & 0xff);
  }

  // movq xmm, r64 (move 64-bit to low lane of xmm)
  movq_xmm_r64(xmm, gpr) {
    this.emit(0x66);
    this.rex(1, xmm, 0, gpr);
    this.emit(0x0f, 0x6e, this.modrm(3, xmm & 7, gpr & 7));
  }

  // movq r64, xmm (move low lane of xmm to 64-bit)
  movq_r64_xmm(gpr, xmm) {
    this.emit(0x66);
    this.rex(1, xmm, 0, gpr);
    this.emit(0x0f, 0x7e, this.modrm(3, xmm & 7, gpr & 7));
  }

  // --- Control Flow & System ---
  // syscall
  syscall() {
    this.emit(0x0f, 0x05);
  }

  // rdtsc (reads timestamp counter into EDX:EAX)
  rdtsc() {
    this.emit(0x0f, 0x31);
  }

  // rdtscp (EDX:EAX = TSC, ECX = IA32_TSC_AUX / CPU id)
  rdtscp() {
    this.emit(0x0f, 0x01, 0xf9);
  }

  // rdpid r32 (F3 0F C7 /7) - current logical CPU id
  rdpid(dst) {
    if (dst >= 8) this.emit(0x41);
    this.emit(0xf3, 0x0f, 0xc7, this.modrm(3, 7, dst & 7));
  }

  // pause (spin-loop hint)
  pause() {
    this.emit(0xf3, 0x90);
  }

  // fences
  mfence() {
    this.emit(0x0f, 0xae, 0xf0);
  }
  lfence() {
    this.emit(0x0f, 0xae, 0xe8);
  }
  sfence() {
    this.emit(0x0f, 0xae, 0xf8);
  }

  // cpuid (clobbers EAX/EBX/ECX/EDX)
  cpuid() {
    this.emit(0x0f, 0xa2);
  }

  // push reg64
  push(reg) {
    if (reg >= 8) this.emit(0x41);
    this.emit(0x50 + (reg & 7));
  }

  // pop reg64
  pop(reg) {
    if (reg >= 8) this.emit(0x41);
    this.emit(0x58 + (reg & 7));
  }

  // ret
  ret() {
    this.emit(0xc3);
  }

  // nop
  nop() {
    this.emit(0x90);
  }

  // call *reg
  callReg(reg) {
    if (reg >= 8) this.emit(0x41);
    this.emit(0xff, this.modrm(3, 2, reg));
  }

  // jmp *reg
  jmpReg(reg) {
    if (reg >= 8) this.emit(0x41);
    this.emit(0xff, this.modrm(3, 4, reg));
  }

  // load16: movzx dst, word ptr [base + disp32]
  load16(dst, base, disp32 = 0) {
    this.rex(1, dst, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xb7, this.modrm(0, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x0f, 0xb7, this.modrm(0, dst, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xb7, this.modrm(1, dst, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x0f, 0xb7, this.modrm(1, dst, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xb7, this.modrm(2, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x0f, 0xb7, this.modrm(2, dst, base));
      }
      this.emitU32(disp32);
    }
  }

  // movsx16: movsx dst, word ptr [base + disp32]
  movsx16(dst, base, disp32 = 0) {
    this.rex(1, dst, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xbf, this.modrm(0, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x0f, 0xbf, this.modrm(0, dst, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xbf, this.modrm(1, dst, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x0f, 0xbf, this.modrm(1, dst, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xbf, this.modrm(2, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x0f, 0xbf, this.modrm(2, dst, base));
      }
      this.emitU32(disp32);
    }
  }

  // movsxd: movsxd dst64, dword ptr [base + disp32]
  movsx32(dst, base, disp32 = 0) {
    this.rex(1, dst, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x63, this.modrm(0, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x63, this.modrm(0, dst, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x63, this.modrm(1, dst, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x63, this.modrm(1, dst, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x63, this.modrm(2, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x63, this.modrm(2, dst, base));
      }
      this.emitU32(disp32);
    }
  }

  // load32: mov dst32, dword ptr [base + disp32] (zero-extends to 64 bits)
  load32(dst, base, disp32 = 0) {
    this.rex(0, dst, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x8b, this.modrm(0, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x8b, this.modrm(0, dst, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x8b, this.modrm(1, dst, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x8b, this.modrm(1, dst, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x8b, this.modrm(2, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x8b, this.modrm(2, dst, base));
      }
      this.emitU32(disp32);
    }
  }

  // load8: movzbq dst, byte ptr [base + disp32]
  load8(dst, base, disp32 = 0) {
    this.rex(1, dst, 0, base);
    if (disp32 === 0 && (base & 7) !== 5) {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xb6, this.modrm(0, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x0f, 0xb6, this.modrm(0, dst, base));
      }
    } else if (disp32 >= -128 && disp32 <= 127) {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xb6, this.modrm(1, dst, 4), this.sib(0, 4, 4), disp32 & 0xff);
      } else {
        this.emit(0x0f, 0xb6, this.modrm(1, dst, base), disp32 & 0xff);
      }
    } else {
      if ((base & 7) === 4) {
        this.emit(0x0f, 0xb6, this.modrm(2, dst, 4), this.sib(0, 4, 4));
      } else {
        this.emit(0x0f, 0xb6, this.modrm(2, dst, base));
      }
      this.emitU32(disp32);
    }
  }

  // load8Indexed: movzbq dst, byte ptr [base + index]
  load8Indexed(dst, base, index) {
    this.rex(1, dst, index, base);
    this.emit(0x0f, 0xb6, this.modrm(0, dst, 4), this.sib(0, index, base));
  }

  // load64Indexed: mov dst, [base + index * 8]
  load64Indexed(dst, base, index) {
    this.rex(1, dst, index, base);
    this.emit(0x8b, this.modrm(0, dst, 4), this.sib(3, index, base));
  }

  // store64Indexed: mov [base + index * 8], src
  store64Indexed(base, index, src) {
    this.rex(1, src, index, base);
    this.emit(0x89, this.modrm(0, src, 4), this.sib(3, index, base));
  }

  // cmpImm8: cmp r64, imm8 (sign-extended imm8)
  cmpImm8(reg, imm8) {
    this.rex(1, 0, 0, reg);
    this.emit(0x83, this.modrm(3, 7, reg), imm8 & 0xff);
  }

  // jmp label
  jmp(labelName) {
    this.emit(0xe9);
    this.fixups.push({
      type: 'rel32',
      offset: this.bytes.length,
      label: labelName,
      insnEnd: this.bytes.length + 4,
    });
    this.emitU32(0);
  }

  // jcc cond, label
  jcc(cond, labelName) {
    this.emit(0x0f, 0x80 | (cond & 0xf));
    this.fixups.push({
      type: 'rel32',
      offset: this.bytes.length,
      label: labelName,
      insnEnd: this.bytes.length + 4,
    });
    this.emitU32(0);
  }

  // call label
  call(labelName) {
    this.emit(0xe8);
    this.fixups.push({
      type: 'rel32',
      offset: this.bytes.length,
      label: labelName,
      insnEnd: this.bytes.length + 4,
    });
    this.emitU32(0);
  }

  // leaRspOffset: lea dst, [rsp + offset8]
  leaRspOffset(dst, offset8) {
    this.rex(1, dst, 0, REG.RSP);
    this.emit(0x8d, this.modrm(1, dst, 4), this.sib(0, 4, REG.RSP), offset8 & 0xff);
  }

  // emitLabelAddr64: emits a 64-bit absolute address resolved at assembly time
  emitLabelAddr64(labelName) {
    this.fixups.push({
      type: 'abs64',
      offset: this.bytes.length,
      label: labelName,
    });
    this.emitU64(0n);
  }

  // Assemble and resolve all fixups
  resolve() {
    const out = Buffer.from(this.bytes);
    for (const fix of this.fixups) {
      if (!this.labels.has(fix.label)) {
        throw new Error(`Unresolved label: ${fix.label}`);
      }
      const targetOffset = this.labels.get(fix.label);

      if (fix.type === 'rel32' || fix.type === 'rip_disp32') {
        const rel = targetOffset - fix.insnEnd;
        out.writeInt32LE(rel, fix.offset);
      } else if (fix.type === 'abs64') {
        const addr = BigInt(this.baseVaddr + targetOffset);
        out.writeBigUInt64LE(addr, fix.offset);
      } else {
        throw new Error(`Unknown fixup type: ${fix.type}`);
      }
    }
    return out;
  }
}
