#!/usr/bin/env node
// Advanced instruction tests - verify actual register values and edge cases

import { Assembler, REG, XMM, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

function test(name, builder, validator) {
  try {
    const a = new Assembler(TEXT_BASE);
    a.label('entry');
    
    // Reserve space for register dump
    a.subImm32(REG.RSP, 256);
    
    // Execute test
    builder(a);
    
    // Dump registers to stack
    const dumpStart = 0;
    a.store64(REG.RSP, REG.RAX, dumpStart);
    a.store64(REG.RSP, REG.RBX, dumpStart + 8);
    a.store64(REG.RSP, REG.RCX, dumpStart + 16);
    a.store64(REG.RSP, REG.RDX, dumpStart + 24);
    a.store64(REG.RSP, REG.RSI, dumpStart + 32);
    a.store64(REG.RSP, REG.RDI, dumpStart + 40);
    a.store64(REG.RSP, REG.R8, dumpStart + 48);
    a.store64(REG.RSP, REG.R9, dumpStart + 56);
    a.store64(REG.RSP, REG.R10, dumpStart + 64);
    a.store64(REG.RSP, REG.R11, dumpStart + 72);
    a.store64(REG.RSP, REG.R12, dumpStart + 80);
    a.store64(REG.RSP, REG.R13, dumpStart + 88);
    a.store64(REG.RSP, REG.R14, dumpStart + 96);
    a.store64(REG.RSP, REG.R15, dumpStart + 104);
    
    // Write to file for inspection
    const dumpFile = `/tmp/regdump_${Date.now()}.bin`;
    a.movImm32(REG.RAX, 2); // open
    a.leaRip(REG.RDI, 'filename');
    a.movImm32(REG.RSI, 0x241); // O_WRONLY|O_CREAT|O_TRUNC
    a.movImm32(REG.RDX, 0o644);
    a.syscall();
    
    a.mov(REG.R12, REG.RAX); // save fd
    a.movImm32(REG.RAX, 1); // write
    a.mov(REG.RDI, REG.R12);
    a.mov(REG.RSI, REG.RSP);
    a.movImm32(REG.RDX, 112); // 14 registers * 8 bytes
    a.syscall();
    
    a.movImm32(REG.RAX, 3); // close
    a.mov(REG.RDI, REG.R12);
    a.syscall();
    
    // Add filename string
    a.label('filename');
    const fname = Buffer.from(dumpFile + '\0');
    for (let i = 0; i < fname.length; i++) {
      a.emit(fname[i]);
    }
    
    a.addImm32(REG.RSP, 256);
    
    // Exit
    a.movImm32(REG.RAX, 231);
    a.xor(REG.RDI, REG.RDI);
    a.syscall();
    
    const elf = buildStaticElf64({ text: a.resolve(), entry: TEXT_BASE });
    const path = `/tmp/test_${Date.now()}.bin`;
    fs.writeFileSync(path, elf, { mode: 0o755 });
    
    try {
      execFileSync(path, [], { timeout: 100 });
      
      // Read register dump
      const dump = fs.readFileSync(dumpFile);
      const regs = {
        RAX: dump.readBigInt64LE(0),
        RBX: dump.readBigInt64LE(8),
        RCX: dump.readBigInt64LE(16),
        RDX: dump.readBigInt64LE(24),
        RSI: dump.readBigInt64LE(32),
        RDI: dump.readBigInt64LE(40),
        R8: dump.readBigInt64LE(48),
        R9: dump.readBigInt64LE(56),
        R10: dump.readBigInt64LE(64),
        R11: dump.readBigInt64LE(72),
        R12: dump.readBigInt64LE(80),
        R13: dump.readBigInt64LE(88),
        R14: dump.readBigInt64LE(96),
        R15: dump.readBigInt64LE(104)
      };
      
      const result = validator(regs);
      if (result === true) {
        console.log(`✓ ${name}`);
        return true;
      } else {
        console.log(`✗ ${name} - ${result}`);
        console.log('  Registers:', Object.entries(regs).map(([k,v]) => `${k}=0x${v.toString(16)}`).join(', '));
        return false;
      }
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
      try { fs.unlinkSync(dumpFile); } catch {}
    }
  } catch (e) {
    console.log(`✗ ${name} - BUILD: ${e.message}`);
    return false;
  }
}

console.log('=== Advanced x86-64 Instruction Tests ===\n');

let pass = 0, fail = 0;

function run(name, builder, validator) {
  if (test(name, builder, validator)) pass++;
  else fail++;
}

// Test 1: Verify movImm32 actually sets the full 64-bit value
run('movImm32 sign extends', 
  (a) => { a.movImm32(REG.RAX, -1); },
  (regs) => regs.RAX === 0xFFFFFFFFFFFFFFFFn ? true : `RAX=${regs.RAX.toString(16)} (expected ffffffffffffffff)`
);

// Test 2: Verify add with overflow
run('add overflow wraps',
  (a) => {
    a.movImm64(REG.RAX, 0xFFFFFFFFFFFFFFFFn);
    a.addImm32(REG.RAX, 1);
  },
  (regs) => regs.RAX === 0n ? true : `RAX=${regs.RAX.toString(16)} (expected 0)`
);

// Test 3: Verify sub underflow
run('sub underflow wraps',
  (a) => {
    a.movImm32(REG.RAX, 0);
    a.subImm32(REG.RAX, 1);
  },
  (regs) => regs.RAX === 0xFFFFFFFFFFFFFFFFn ? true : `RAX=${regs.RAX.toString(16)} (expected ffffffffffffffff)`
);

// Test 4: Verify shift amounts
run('shift by 0 is no-op',
  (a) => {
    a.movImm32(REG.RAX, 42);
    a.mov(REG.RCX, 0);
    a.shlCl(REG.RAX);
  },
  (regs) => regs.RAX === 42n ? true : `RAX=${regs.RAX.toString(16)} (expected 2a)`
);

// Test 5: Shift by 64
run('shift by 64 is undefined',
  (a) => {
    a.movImm32(REG.RAX, 1);
    a.mov(REG.RCX, 64);
    a.shlCl(REG.RAX);
  },
  (regs) => `RAX=${regs.RAX.toString(16)} (result: ${regs.RAX === 1n ? 'unchanged' : regs.RAX === 0n ? 'zeroed' : 'other'})`
);

// Test 6: XOR self clears
run('xor self = 0',
  (a) => {
    a.movImm32(REG.RAX, 0x12345678);
    a.xor(REG.RAX, REG.RAX);
  },
  (regs) => regs.RAX === 0n ? true : `RAX=${regs.RAX.toString(16)} (expected 0)`
);

// Test 7: AND with mask
run('AND mask extracts bits',
  (a) => {
    a.movImm64(REG.RAX, 0xABCDEF1234567890n);
    a.movImm64(REG.RBX, 0x00000000FFFFFFFFn);
    a.and(REG.RAX, REG.RBX);
  },
  (regs) => regs.RAX === 0x34567890n ? true : `RAX=${regs.RAX.toString(16)} (expected 34567890)`
);

// Test 8: OR combines bits
run('OR combines bits',
  (a) => {
    a.movImm64(REG.RAX, 0xF0F0F0F0n);
    a.movImm64(REG.RBX, 0x0F0F0F0Fn);
    a.or(REG.RAX, REG.RBX);
  },
  (regs) => regs.RAX === 0xFFFFFFFFn ? true : `RAX=${regs.RAX.toString(16)} (expected ffffffff)`
);

// Test 9: Push/pop preserves order
run('push/pop LIFO',
  (a) => {
    a.movImm32(REG.RAX, 1);
    a.push(REG.RAX);
    a.movImm32(REG.RAX, 2);
    a.push(REG.RAX);
    a.movImm32(REG.RAX, 3);
    a.push(REG.RAX);
    a.pop(REG.RBX);
    a.pop(REG.RCX);
    a.pop(REG.RDX);
  },
  (regs) => {
    if (regs.RBX !== 3n) return `RBX=${regs.RBX.toString(16)} (expected 3)`;
    if (regs.RCX !== 2n) return `RCX=${regs.RCX.toString(16)} (expected 2)`;
    if (regs.RDX !== 1n) return `RDX=${regs.RDX.toString(16)} (expected 1)`;
    return true;
  }
);

// Test 10: Memory store/load
run('memory store/load',
  (a) => {
    a.subImm32(REG.RSP, 64);
    a.movImm64(REG.RAX, 0x123456789ABCDEFn);
    a.store64(REG.RSP, REG.RAX, 0);
    a.load64(REG.RBX, REG.RSP, 0);
    a.addImm32(REG.RSP, 64);
  },
  (regs) => regs.RBX === 0x123456789ABCDEFn ? true : `RBX=${regs.RBX.toString(16)} (expected 123456789abcdef)`
);

// Test 11: XMM movq roundtrip
run('XMM movq preserves 64-bit',
  (a) => {
    a.movImm64(REG.RAX, 0xFEDCBA9876543210n);
    a.movq_xmm_r64(XMM.XMM0, REG.RAX);
    a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  },
  (regs) => regs.RBX === 0xFEDCBA9876543210n ? true : `RBX=${regs.RBX.toString(16)} (expected fedcba9876543210)`
);

// Test 12: Multiple XMM registers
run('XMM registers independent',
  (a) => {
    a.movImm32(REG.RAX, 111);
    a.movq_xmm_r64(XMM.XMM0, REG.RAX);
    a.movImm32(REG.RAX, 222);
    a.movq_xmm_r64(XMM.XMM1, REG.RAX);
    a.movImm32(REG.RAX, 333);
    a.movq_xmm_r64(XMM.XMM2, REG.RAX);
    a.movq_r64_xmm(REG.RBX, XMM.XMM0);
    a.movq_r64_xmm(REG.RCX, XMM.XMM1);
    a.movq_r64_xmm(REG.RDX, XMM.XMM2);
  },
  (regs) => {
    if (regs.RBX !== 111n) return `RBX=${regs.RBX.toString(16)} (expected 6f)`;
    if (regs.RCX !== 222n) return `RCX=${regs.RCX.toString(16)} (expected de)`;
    if (regs.RDX !== 333n) return `RDX=${regs.RDX.toString(16)} (expected 14d)`;
    return true;
  }
);

// Test 13: paddq adds packed quads
run('paddq adds 64-bit values',
  (a) => {
    a.movImm32(REG.RAX, 100);
    a.movq_xmm_r64(XMM.XMM0, REG.RAX);
    a.movImm32(REG.RAX, 50);
    a.movq_xmm_r64(XMM.XMM1, REG.RAX);
    a.paddq(XMM.XMM0, XMM.XMM1);
    a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  },
  (regs) => regs.RBX === 150n ? true : `RBX=${regs.RBX.toString(16)} (expected 96)`
);

// Test 14: Call/ret preserves caller state
run('call/ret preserves registers',
  (a) => {
    a.movImm32(REG.RBX, 999);
    a.call('func');
    a.label('func');
    a.movImm32(REG.RAX, 55);
    a.ret();
    a.label('end');
  },
  (regs) => regs.RBX === 999n ? true : `RBX=${regs.RBX.toString(16)} (expected 3e7)`
);

// Test 15: High registers work
run('R8-R15 accessible',
  (a) => {
    a.movImm32(REG.R8, 8);
    a.movImm32(REG.R9, 9);
    a.movImm32(REG.R10, 10);
    a.movImm32(REG.R11, 11);
    a.movImm32(REG.R12, 12);
    a.movImm32(REG.R13, 13);
    a.movImm32(REG.R14, 14);
    a.movImm32(REG.R15, 15);
  },
  (regs) => {
    if (regs.R8 !== 8n) return `R8=${regs.R8}`;
    if (regs.R9 !== 9n) return `R9=${regs.R9}`;
    if (regs.R10 !== 10n) return `R10=${regs.R10}`;
    if (regs.R11 !== 11n) return `R11=${regs.R11}`;
    if (regs.R12 !== 12n) return `R12=${regs.R12}`;
    if (regs.R13 !== 13n) return `R13=${regs.R13}`;
    if (regs.R14 !== 14n) return `R14=${regs.R14}`;
    if (regs.R15 !== 15n) return `R15=${regs.R15}`;
    return true;
  }
);

// Test 16: imul with two operands
run('imul dst, src',
  (a) => {
    a.movImm32(REG.RAX, 7);
    a.movImm32(REG.RBX, 6);
    a.imul(REG.RAX, REG.RBX);
  },
  (regs) => regs.RAX === 42n ? true : `RAX=${regs.RAX.toString(16)} (expected 2a)`
);

// Test 17: Memory with displacement
run('memory with offset',
  (a) => {
    a.subImm32(REG.RSP, 128);
    a.movImm64(REG.RAX, 111);
    a.store64(REG.RSP, REG.RAX, 8);
    a.movImm64(REG.RAX, 222);
    a.store64(REG.RSP, REG.RAX, 16);
    a.load64(REG.RBX, REG.RSP, 8);
    a.load64(REG.RCX, REG.RSP, 16);
    a.addImm32(REG.RSP, 128);
  },
  (regs) => {
    if (regs.RBX !== 111n) return `RBX=${regs.RBX.toString(16)} (expected 6f)`;
    if (regs.RCX !== 222n) return `RCX=${regs.RCX.toString(16)} (expected de)`;
    return true;
  }
);

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
