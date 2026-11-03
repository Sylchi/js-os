#!/usr/bin/env node
// Multicore bootstrap proof: spawn one worker per physical core, pin each with
// sched_setaffinity, read the logical CPU with rdpid, and report it back
// through shared bss. This validates clone(CLONE_VM|...), per-thread bss
// stacks, affinity, and cross-core visibility without libc.

import { Assembler, REG, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

const N = 5;
const CPUS = [0, 2, 4, 6, 8]; // one thread per physical Zen 4 core
const DONE_OFF = 0;
const RESULTS_OFF = 64;
const STACKS_OFF = 4096;
const STACK_SIZE = 0x10000; // 64 KiB per worker
const BSS_SIZE = STACKS_OFF + N * STACK_SIZE;

const align = (n, a) => (n + a - 1) & ~(a - 1);
const hex = (n) => '0x' + n.toString(16);

function build(bssBase) {
  const a = new Assembler(TEXT_BASE);
  a.label('entry');

  // ---- spawn N workers, one at a time -------------------------------
  for (let i = 0; i < N; i++) {
    const stackTop = bssBase + STACKS_OFF + (i + 1) * STACK_SIZE;
    a.movImm64(REG.RBX, hex(i));       // context index, preserved across clone
    a.movImm64(REG.RSI, hex(stackTop)); // child stack top
    a.movImm32(REG.RDI, 0x50f00);      // CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM
    a.movImm32(REG.RAX, 56);           // clone
    a.xor(REG.RDX, REG.RDX);
    a.xor(REG.R10, REG.R10);
    a.xor(REG.R8, REG.R8);
    a.syscall();
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'thread_entry');     // child lands here with RAX = 0
  }

  // ---- parent waits for every worker ---------------------------------
  for (let i = 0; i < N; i++) {
    a.movImm64(REG.RCX, hex(bssBase + DONE_OFF + i));
    a.label(`wait_${i}`);
    a.load8(REG.RAX, REG.RCX, 0);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, `wait_next_${i}`);
    a.pause();
    a.jmp(`wait_${i}`);
    a.label(`wait_next_${i}`);
  }

  // write(1, results, N)
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.movImm64(REG.RSI, hex(bssBase + RESULTS_OFF));
  a.movImm32(REG.RDX, N);
  a.syscall();

  a.movImm32(REG.RAX, 231); // exit_group
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  // ---- child entry ---------------------------------------------------
  a.label('thread_entry');
  // mask = 1 << (index * 2)
  a.mov(REG.RCX, REG.RBX);
  a.shlImm8(REG.RCX, 1);
  a.movImm32(REG.RDX, 1);
  a.shlCl(REG.RDX);
  a.subImm32(REG.RSP, 16);
  a.store64(REG.RSP, REG.RDX, 0);
  a.movImm32(REG.RAX, 203); // sched_setaffinity(0, 8, &mask)
  a.xor(REG.RDI, REG.RDI);
  a.movImm32(REG.RSI, 8);
  a.mov(REG.RDX, REG.RSP);
  a.syscall();
  a.addImm32(REG.RSP, 16);

  a.rdpid(REG.RAX);
  a.movImm64(REG.RCX, hex(bssBase + RESULTS_OFF));
  a.add(REG.RCX, REG.RBX);
  a.store8(REG.RCX, REG.RAX, 0);

  a.movImm64(REG.RCX, hex(bssBase + DONE_OFF));
  a.add(REG.RCX, REG.RBX);
  a.movImm32(REG.RDX, 1);
  a.store8(REG.RCX, REG.RDX, 0);

  a.movImm32(REG.RAX, 60); // exit (this thread only)
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  return a.resolve();
}

const probe = build(0x1000000);
const bssBase = 0x400000 + align(0x1000 + probe.length, 0x1000);
const text = build(bssBase);
const elf = buildStaticElf64({ text, bssSize: BSS_SIZE, entry: TEXT_BASE });
const path = '/tmp/kzero_threads';
fs.writeFileSync(path, elf, { mode: 0o755 });

let out;
try {
  out = execFileSync(path, [], { timeout: 3000 });
} catch (e) {
  console.error(`FAIL: exit ${e.status}`);
  process.exit(1);
}

const got = [...out];
const want = CPUS;
console.log(`bss base: ${hex(bssBase)}, text: ${text.length} bytes`);
console.log(`cpu ids: ${got.join(', ')} (wanted ${want.join(', ')})`);
const ok = got.length === want.length && got.every((v, i) => v === want[i]);
if (!ok) {
  console.error('FAIL: affinity or cross-core visibility mismatch');
  process.exit(1);
}
console.log(`PASS: ${N} workers pinned to physical cores ${want.join(', ')}`);
