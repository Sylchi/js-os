#!/usr/bin/env node
// Test register values by checking them and setting exit code
// Forward-only: build result -> cmp -> set exit code -> exit

import { Assembler, REG, XMM, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

function test(name, builder) {
  const a = new Assembler(TEXT_BASE);
  a.label('entry');
  
  builder(a);
  
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  
  const elf = buildStaticElf64({ text: a.resolve(), entry: TEXT_BASE });
  const path = `/tmp/test_${Date.now()}.bin`;
  fs.writeFileSync(path, elf, { mode: 0o755 });
  
  try {
    execFileSync(path, [], { timeout: 100 });
    console.log(`✓ ${name} - exit 0`);
    return true;
  } catch (e) {
    if (e.status === null) {
      console.log(`✗ ${name} - TIMEOUT`);
    } else if (e.signal) {
      console.log(`✗ ${name} - ${e.signal}`);
    } else {
      console.log(`✗ ${name} - exit ${e.status}`);
    }
    return false;
  } finally {
    try { fs.unlinkSync(path); } catch {}
  }
}

console.log('=== Forward-Only Register Tests ===\n');

// Each test: compute something, compare, exit with code
// exit 0 = match, exit 1 = mismatch

test('movImm32 -1 is 0xFF...FF', (a) => {
  a.movImm32(REG.RAX, -1);
  a.cmpImm8(REG.RAX, 0xFF); // low byte should be 0xFF
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 1);
  a.syscall();
});

test('mov chain preserves value', (a) => {
  a.movImm32(REG.RAX, 42);
  a.mov(REG.RBX, REG.RAX);
  a.mov(REG.RCX, REG.RBX);
  a.mov(REG.RDX, REG.RCX);
  a.cmpImm8(REG.RDX, 42);
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 2);
  a.syscall();
});

test('xmm movq roundtrip', (a) => {
  a.movImm32(REG.RAX, 99);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  a.cmp(REG.RAX, REG.RBX);
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 3);
  a.syscall();
});

test('XMM registers independent', (a) => {
  a.movImm32(REG.RAX, 11);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 22);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.movImm32(REG.RAX, 33);
  a.movq_xmm_r64(XMM.XMM2, REG.RAX);
  
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  a.cmpImm8(REG.RBX, 11);
  a.jcc(COND.NE, 'fail');
  
  a.movq_r64_xmm(REG.RBX, XMM.XMM1);
  a.cmpImm8(REG.RBX, 22);
  a.jcc(COND.NE, 'fail');
  
  a.movq_r64_xmm(REG.RBX, XMM.XMM2);
  a.cmpImm8(REG.RBX, 33);
  a.jcc(COND.NE, 'fail');
  
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 4);
  a.syscall();
});

test('add works', (a) => {
  a.movImm32(REG.RAX, 10);
  a.movImm32(REG.RBX, 20);
  a.add(REG.RAX, REG.RBX);
  a.cmpImm8(REG.RAX, 30);
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 5);
  a.syscall();
});

test('xor self = 0', (a) => {
  a.movImm32(REG.RAX, 0x12345678);
  a.xor(REG.RAX, REG.RAX);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 6);
  a.syscall();
});

test('paddq adds XMM values', (a) => {
  a.movImm32(REG.RAX, 100);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 50);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.paddq(XMM.XMM0, XMM.XMM1);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  a.cmpImm32(REG.RBX, 150);
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 7);
  a.syscall();
});

test('pxor self = 0', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.pxor(XMM.XMM0, XMM.XMM0);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.NZ, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 8);
  a.syscall();
});

test('high XMM8-15 work', (a) => {
  a.movImm32(REG.RAX, 777);
  a.movq_xmm_r64(XMM.XMM8, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM8);
  a.cmpImm32(REG.RBX, 777);
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 9);
  a.syscall();
});

test('imul two-operand', (a) => {
  a.movImm32(REG.RAX, 7);
  a.movImm32(REG.RBX, 6);
  a.imul(REG.RAX, REG.RBX);
  a.cmpImm8(REG.RAX, 42);
  a.jcc(COND.NE, 'fail');
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('fail');
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, 10);
  a.syscall();
});
