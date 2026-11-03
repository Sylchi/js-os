// ZMM register file / ring buffer.
//
// 31 ZMM registers x 8 lanes = 248 tagged 64-bit value slots, held entirely
// in registers. ZMM7 is reserved as the blend/broadcast scratch, so the ring
// uses ZMM0-6 and ZMM8-31.
//
// A slot is addressed by an integer 0..247:
//   zmm index = slot >> 3   (0..30, mapped through RING_REGS)
//   lane      = slot & 7
//
// Load: compress the masked lane to lane 0 of the scratch, move it to a GPR.
// Store: broadcast the GPR across the scratch, blend the masked lane back.

import { REG, COND } from './asm.js';

export const RING_SCRATCH = 7; // ZMM7
export const RING_REGS = Array.from({ length: 32 }, (_, i) => i).filter((i) => i !== RING_SCRATCH);
export const RING_SLOTS = RING_REGS.length * 8; // 248

// Clamp a hash-derived byte into 0..247. Caller has hash in a register.
export function emitSlotIndex(a, hashReg, slotReg, prefix = 'rslot') {
  a.mov(slotReg, hashReg);
  a.andImm32(slotReg, 0xff); // imm8 0xff sign-extends to -1, so use imm32
  a.cmpImm32(slotReg, RING_SLOTS);
  a.jcc(COND.L, `${prefix}_ok`);
  a.subImm32(slotReg, 8);
  a.label(`${prefix}_ok`);
}

// Emit the body of a subroutine. RCX = slot, RAX = value (store) / result
// (load). Caller supplies unique label prefixes.
export function emitLoadSlot(a, prefix = 'rload') {
  a.mov(REG.R10, REG.RCX);
  a.andImm8(REG.RCX, 7);
  a.movImm32(REG.R9, 1);
  a.shlCl(REG.R9);
  a.kmovq(1, REG.R9);
  a.shrImm8(REG.R10, 3);

  for (let i = 0; i < RING_REGS.length; i++) {
    a.cmpImm32(REG.R10, i);
    a.jcc(COND.E, `${prefix}_r${i}`);
  }
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  for (let i = 0; i < RING_REGS.length; i++) {
    a.label(`${prefix}_r${i}`);
    a.vpcompressq(RING_SCRATCH, RING_REGS[i], 1);
    a.vmovq_gpr_xmm(REG.RAX, RING_SCRATCH);
    a.ret();
  }
}

export function emitStoreSlot(a, prefix = 'rstore') {
  a.mov(REG.R10, REG.RCX);
  a.andImm8(REG.RCX, 7);
  a.movImm32(REG.R9, 1);
  a.shlCl(REG.R9);
  a.kmovq(1, REG.R9);
  a.shrImm8(REG.R10, 3);
  a.vpbroadcastq(RING_SCRATCH, REG.RAX);

  for (let i = 0; i < RING_REGS.length; i++) {
    a.cmpImm32(REG.R10, i);
    a.jcc(COND.E, `${prefix}_r${i}`);
  }
  a.ret();

  for (let i = 0; i < RING_REGS.length; i++) {
    a.label(`${prefix}_r${i}`);
    a.vpblendmq(RING_REGS[i], RING_REGS[i], RING_SCRATCH, 1);
    a.ret();
  }
}

// Zero every ring register (and the scratch).
export function emitZeroRing(a) {
  for (const r of RING_REGS) {
    a.vpxorq(r, r, r);
  }
  a.vpxorq(RING_SCRATCH, RING_SCRATCH, RING_SCRATCH);
}
