#!/usr/bin/env node
// SPSC ring proof: one producer (main) and one consumer (pinned worker)
// exchange 1,000,000 u64 values through a cache-line-padded ring in shared
// bss. The consumer sums them and reports the sum. Validates cross-core
// publication, backpressure, and queue indexing.

import { Assembler, REG, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

const N = 1000000;
const RING_SIZE = 1024;
const RING_MASK = RING_SIZE - 1;

const HEAD_OFF = 0;
const TAIL_OFF = 64;
const RESULT_OFF = 128;
const DONE_OFF = 192;
const SLOTS_OFF = 256;
const SLOTS_BYTES = RING_SIZE * 8;
const STACKS_OFF = 0x4000;
const STACK_SIZE = 0x10000;
const BSS_SIZE = STACKS_OFF + STACK_SIZE;

const align = (n, a) => (n + a - 1) & ~(a - 1);
const hex = (n) => '0x' + n.toString(16);
const want = BigInt(N) * BigInt(N + 1) / 2n;

function build(bssBase) {
  const a = new Assembler(TEXT_BASE);
  const addr = (off) => hex(bssBase + off);
  a.label('entry');

  // ---- spawn consumer pinned to CPU 2 --------------------------------
  a.movImm32(REG.RBX, 0);
  a.movImm64(REG.RSI, hex(bssBase + STACKS_OFF + STACK_SIZE));
  a.movImm32(REG.RDI, 0x50f00);
  a.movImm32(REG.RAX, 56);
  a.xor(REG.RDX, REG.RDX);
  a.xor(REG.R10, REG.R10);
  a.xor(REG.R8, REG.R8);
  a.syscall();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'consumer');

  // ---- producer: head lives in R8, value in R11 ----------------------
  a.xor(REG.R8, REG.R8);       // head
  a.movImm32(REG.R11, 1);      // value 1..N
  a.label('prod_loop');
  a.movImm64(REG.RCX, addr(TAIL_OFF));
  a.load64(REG.R9, REG.RCX, 0);
  a.mov(REG.R10, REG.R8);
  a.sub(REG.R10, REG.R9);
  a.cmpImm32(REG.R10, RING_SIZE);
  a.jcc(COND.B, 'prod_space');
  a.pause();
  a.jmp('prod_loop');

  a.label('prod_space');
  a.mov(REG.R10, REG.R8);
  a.andImm32(REG.R10, RING_MASK);
  a.shlImm8(REG.R10, 3);
  a.movImm64(REG.RCX, addr(SLOTS_OFF));
  a.add(REG.RCX, REG.R10);
  a.store64(REG.RCX, REG.R11, 0);
  a.inc(REG.R8);
  a.movImm64(REG.RCX, addr(HEAD_OFF));
  a.store64(REG.RCX, REG.R8, 0);

  a.inc(REG.R11);
  a.cmpImm32(REG.R11, N + 1);
  a.jcc(COND.B, 'prod_loop');

  // ---- wait for the consumer ----------------------------------------
  a.movImm64(REG.RCX, addr(DONE_OFF));
  a.label('wait_done');
  a.load8(REG.RAX, REG.RCX, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'write_result');
  a.pause();
  a.jmp('wait_done');

  // write(1, &result, 8)
  a.label('write_result');
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.movImm64(REG.RSI, addr(RESULT_OFF));
  a.movImm32(REG.RDX, 8);
  a.syscall();

  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  // ---- consumer ------------------------------------------------------
  a.label('consumer');
  // pin to CPU 2
  a.subImm32(REG.RSP, 16);
  a.movImm32(REG.RDX, 1 << 2);
  a.store64(REG.RSP, REG.RDX, 0);
  a.movImm32(REG.RAX, 203);
  a.xor(REG.RDI, REG.RDI);
  a.movImm32(REG.RSI, 8);
  a.mov(REG.RDX, REG.RSP);
  a.syscall();
  a.addImm32(REG.RSP, 16);

  a.xor(REG.R8, REG.R8);       // tail
  a.xor(REG.R9, REG.R9);       // sum
  a.xor(REG.R12, REG.R12);     // count

  a.label('cons_loop');
  a.movImm64(REG.RCX, addr(HEAD_OFF));
  a.load64(REG.R10, REG.RCX, 0);
  a.cmp(REG.R10, REG.R8);
  a.jcc(COND.NE, 'cons_data');
  a.pause();
  a.jmp('cons_loop');

  a.label('cons_data');
  a.mov(REG.R11, REG.R8);
  a.andImm32(REG.R11, RING_MASK);
  a.shlImm8(REG.R11, 3);
  a.movImm64(REG.RCX, addr(SLOTS_OFF));
  a.add(REG.RCX, REG.R11);
  a.load64(REG.RDX, REG.RCX, 0);
  a.add(REG.R9, REG.RDX);
  a.inc(REG.R8);
  a.movImm64(REG.RCX, addr(TAIL_OFF));
  a.store64(REG.RCX, REG.R8, 0);

  a.inc(REG.R12);
  a.cmpImm32(REG.R12, N);
  a.jcc(COND.B, 'cons_loop');

  a.movImm64(REG.RCX, addr(RESULT_OFF));
  a.store64(REG.RCX, REG.R9, 0);
  a.movImm64(REG.RCX, addr(DONE_OFF));
  a.movImm32(REG.RDX, 1);
  a.store8(REG.RCX, REG.RDX, 0);

  a.movImm32(REG.RAX, 60);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  return a.resolve();
}

const probe = build(0x1000000);
const bssBase = 0x400000 + align(0x1000 + probe.length, 0x1000);
const text = build(bssBase);
const elf = buildStaticElf64({ text, bssSize: BSS_SIZE, entry: TEXT_BASE });
const path = '/tmp/kzero_spsc';
fs.writeFileSync(path, elf, { mode: 0o755 });

const t0 = process.hrtime.bigint();
let out;
try {
  out = execFileSync(path, [], { timeout: 10000 });
} catch (e) {
  console.error(`FAIL: exit ${e.status}`);
  process.exit(1);
}
const t1 = process.hrtime.bigint();

const got = out.readBigUInt64LE(0);
if (got !== want) {
  console.error(`FAIL: sum ${got}, want ${want}`);
  process.exit(1);
}
const ms = Number(t1 - t0) / 1e6;
const mps = N / (ms / 1000) / 1e6;
console.log(`PASS: ${N.toLocaleString()} messages, sum ${got}`);
console.log(`      ${ms.toFixed(1)} ms end-to-end (${mps.toFixed(2)} M msg/s)`);
