#!/usr/bin/env node
// Simple instruction tests - run sequentially with clear output

import { Assembler, REG, XMM, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

function test(name, builder) {
  try {
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
      console.log(`✓ ${name}`);
      return true;
    } catch (e) {
      if (e.status === null) {
        console.log(`✗ ${name} - TIMEOUT/HANG`);
      } else if (e.signal) {
        console.log(`✗ ${name} - ${e.signal}`);
      } else {
        console.log(`✗ ${name} - exit ${e.status}`);
      }
      return false;
    } finally {
      try { fs.unlinkSync(path); } catch {}
    }
  } catch (e) {
    console.log(`✗ ${name} - BUILD: ${e.message}`);
    return false;
  }
}

console.log('=== Testing x86-64 Instructions ===\n');

let pass = 0, fail = 0;

function run(name, builder) {
  if (test(name, builder)) pass++;
  else fail++;
}

// Basic operations
run('mov chain', (a) => {
  a.movImm32(REG.RAX, 42);
  a.mov(REG.RBX, REG.RAX);
  a.mov(REG.RCX, REG.RBX);
});

run('xmm movq', (a) => {
  a.movImm32(REG.RAX, 99);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
});

run('xmm multiple', (a) => {
  a.movImm32(REG.RAX, 11);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 22);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM1);
});

run('stack push/pop', (a) => {
  a.movImm32(REG.RAX, 77);
  a.push(REG.RAX);
  a.pop(REG.RBX);
});

run('memory store/load', (a) => {
  a.subImm32(REG.RSP, 64);
  a.movImm32(REG.RAX, 55);
  a.store64(REG.RSP, REG.RAX, 0);
  a.load64(REG.RBX, REG.RSP, 0);
  a.addImm32(REG.RSP, 64);
});

run('add', (a) => {
  a.movImm32(REG.RAX, 10);
  a.movImm32(REG.RBX, 20);
  a.add(REG.RAX, REG.RBX);
});

run('sub', (a) => {
  a.movImm32(REG.RAX, 50);
  a.movImm32(REG.RBX, 15);
  a.sub(REG.RAX, REG.RBX);
});

run('and', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.movImm32(REG.RBX, 0x0F);
  a.and(REG.RAX, REG.RBX);
});

run('or', (a) => {
  a.movImm32(REG.RAX, 0xF0);
  a.movImm32(REG.RBX, 0x0F);
  a.or(REG.RAX, REG.RBX);
});

run('xor', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.xor(REG.RAX, REG.RAX);
});

run('addImm32', (a) => {
  a.movImm32(REG.RAX, 10);
  a.addImm32(REG.RAX, 5);
});

run('shlCl', (a) => {
  a.movImm32(REG.RAX, 1);
  a.mov(REG.RCX, 3);
  a.shlCl(REG.RAX);
});

run('shrCl', (a) => {
  a.movImm32(REG.RAX, 16);
  a.mov(REG.RCX, 2);
  a.shrCl(REG.RAX);
});

run('cmp + jump', (a) => {
  a.movImm32(REG.RAX, 5);
  a.movImm32(REG.RBX, 10);
  a.cmp(REG.RAX, REG.RBX);
  a.jcc(COND.L, 'done');
  a.movImm32(REG.RAX, 99);
  a.label('done');
});

run('call/ret', (a) => {
  a.call('func');
  a.jmp('end');
  a.label('func');
  a.movImm32(REG.RAX, 55);
  a.ret();
  a.label('end');
});

run('movImm64', (a) => {
  a.movImm64(REG.RAX, 0x123456789ABCDEFn);
});

run('negative imm', (a) => {
  a.movImm32(REG.RAX, -1);
});

run('paddq', (a) => {
  a.movImm32(REG.RAX, 100);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 50);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.paddq(XMM.XMM0, XMM.XMM1);
});

run('pxor', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.pxor(XMM.XMM0, XMM.XMM0);
});

run('memory offset', (a) => {
  a.subImm32(REG.RSP, 128);
  a.movImm32(REG.RAX, 111);
  a.store64(REG.RSP, REG.RAX, 8);
  a.load64(REG.RBX, REG.RSP, 8);
  a.addImm32(REG.RSP, 128);
});

run('high GPR', (a) => {
  a.movImm32(REG.R8, 1);
  a.movImm32(REG.R9, 2);
  a.mov(REG.R10, REG.R8);
  a.add(REG.R10, REG.R9);
});

run('high XMM', (a) => {
  a.movImm32(REG.RAX, 777);
  a.movq_xmm_r64(XMM.XMM8, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM8);
});

run('operation chain', (a) => {
  a.movImm32(REG.RAX, 10);
  a.addImm32(REG.RAX, 5);
  a.addImm32(REG.RAX, 5);
  a.subImm32(REG.RAX, 3);
});

run('stack alignment', (a) => {
  a.mov(REG.RAX, REG.RSP);
  a.and(REG.RAX, 0xF);
});

run('imul', (a) => {
  a.movImm32(REG.RAX, 7);
  a.movImm32(REG.RBX, 6);
  a.imul(REG.RAX, REG.RBX);
});

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
