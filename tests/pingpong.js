#!/usr/bin/env node
// Cross-core round-trip latency probe.
//
// Builds a tiny static ELF that pins the dispatcher to CPU 0 and a responder
// to CPU 2 (a different physical core on this machine), then ping-pongs a
// sequence counter through two cache-line-padded shared words in BSS. Both
// sides spin with `pause`; there are no syscalls or futex wakeups in the hot
// path. The printed number is the lower bound, in nanoseconds, for one
// request/response hop between cores — i.e. the unavoidable cost of handing a
// function call to another core and getting the result back.
//
// Usage: node tests/pingpong.js [rounds]

import fs from 'node:fs';
import { Assembler, REG, COND } from '../asm.js';
import { emitPinCpu, emitCloneWorker, CACHE_LINE } from '../pipeline.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';

const ROUNDS = BigInt(process.argv[2] ?? 1000000);
const WARMUP = 10000n;
const PARENT_CPU = 0;
const CHILD_CPU = 2;

const BSS_SIZE = 0x20000;
const REQ = 0;              // parent writes, child reads
const ACK = CACHE_LINE;     // child writes, parent reads
const STACK = 2 * CACHE_LINE;
const STACK_SIZE = 0x10000;
const STACK_TOP = STACK + STACK_SIZE;

const align = (n, a) => (n + a - 1) & ~(a - 1);

function build(bssBase) {
  const a = new Assembler(TEXT_BASE);
  const REQ_ADDR = '0x' + (bssBase + REQ).toString(16);
  const ACK_ADDR = '0x' + (bssBase + ACK).toString(16);

  a.label('entry');
  a.mov(REG.RBP, REG.RSP);
  emitPinCpu(a, PARENT_CPU);
  emitCloneWorker(a, {
    stackTop: bssBase + STACK_TOP,
    index: 0,
    childLabel: 'child',
  });

  // Parent: request/response loop.
  a.movImm64(REG.R8, REQ_ADDR);
  a.movImm64(REG.R9, ACK_ADDR);
  a.xor(REG.R14, REG.R14);          // sequence
  a.movImm64(REG.R15, WARMUP);      // warm up the child and both cache lines

  a.label('warm_send');
  a.inc(REG.R14);
  a.store64(REG.R8, REG.R14, 0);
  a.label('warm_wait');
  a.load64(REG.RAX, REG.R9, 0);
  a.cmp(REG.RAX, REG.R14);
  a.jcc(COND.NE, 'warm_wait');
  a.cmp(REG.R14, REG.R15);
  a.jcc(COND.B, 'warm_send');

  // Time ROUNDS round trips with clock_gettime(CLOCK_MONOTONIC).
  a.subImm32(REG.RSP, 32);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RSP);
  a.movImm32(REG.RAX, 228);
  a.syscall();

  a.movImm64(REG.R15, ROUNDS);
  a.label('pp_send');
  a.inc(REG.R14);
  a.store64(REG.R8, REG.R14, 0);
  a.label('pp_wait');
  a.load64(REG.RAX, REG.R9, 0);
  a.cmp(REG.RAX, REG.R14);
  a.jcc(COND.NE, 'pp_wait');
  a.cmp(REG.R14, REG.R15);
  a.jcc(COND.B, 'pp_send');

  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RSP);
  a.addImm32(REG.RSI, 16);
  a.movImm32(REG.RAX, 228);
  a.syscall();

  // elapsed_ns = (sec1 - sec0) * 1e9 + (nsec1 - nsec0)
  a.load64(REG.RAX, REG.RSP, 16);
  a.load64(REG.RCX, REG.RSP, 0);
  a.sub(REG.RAX, REG.RCX);
  a.movImm64(REG.RCX, 1000000000);
  a.imul(REG.RAX, REG.RCX);
  a.load64(REG.R8, REG.RSP, 24);
  a.load64(REG.R9, REG.RSP, 8);
  a.sub(REG.R8, REG.R9);
  a.add(REG.RAX, REG.R8);

  // ns per round trip
  a.xor(REG.RDX, REG.RDX);
  a.movImm64(REG.RCX, ROUNDS);
  a.divReg(REG.RCX);
  a.jmp('print_u64');

  // Responder: publish ACK = REQ, spin for the next request.
  a.label('child');
  emitPinCpu(a, CHILD_CPU);
  a.movImm64(REG.R8, REQ_ADDR);
  a.movImm64(REG.R9, ACK_ADDR);
  a.xor(REG.R14, REG.R14);
  a.label('child_wait');
  a.load64(REG.RAX, REG.R8, 0);
  a.cmp(REG.RAX, REG.R14);
  a.jcc(COND.NE, 'child_ack');
  a.pause();
  a.jmp('child_wait');
  a.label('child_ack');
  a.mov(REG.R14, REG.RAX);
  a.store64(REG.R9, REG.R14, 0);
  a.jmp('child_wait');

  // Print RAX as unsigned decimal + newline, then exit.
  a.label('print_u64');
  a.mov(REG.RBX, REG.RSP);
  a.subImm32(REG.RBX, 64);
  a.mov(REG.R8, REG.RBX);
  a.addImm32(REG.R8, 64);
  a.mov(REG.R9, REG.R8);
  a.movImm32(REG.R10, 10);
  a.label('pu_loop');
  a.xor(REG.RDX, REG.RDX);
  a.divReg(REG.R10);
  a.addImm32(REG.RDX, 48);
  a.dec(REG.R9);
  a.store8(REG.R9, REG.RDX, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'pu_loop');
  a.dec(REG.R9);
  a.movImm32(REG.RDX, 10);
  a.store8(REG.R9, REG.RDX, 0);
  a.mov(REG.RDX, REG.R8);
  a.sub(REG.RDX, REG.R9);
  a.mov(REG.RSI, REG.R9);
  a.movImm32(REG.RDI, 1);
  a.movImm32(REG.RAX, 1);
  a.syscall();
  a.movImm32(REG.RAX, 231);       // exit_group: stop the responder thread too
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  return a.resolve();
}

const probe = build(0x1000000);
const bssBase = TEXT_BASE - 0x1000 + align(0x1000 + probe.length, 0x1000);
const text = build(bssBase);
const elf = buildStaticElf64({ text, bssSize: BSS_SIZE, entry: TEXT_BASE });
const path = '/tmp/opencode/pingpong.elf';
fs.writeFileSync(path, elf, { mode: 0o755 });
console.log(`[pingpong] wrote ${path} (${elf.length} bytes), ${ROUNDS} rounds`);
