#!/usr/bin/env node
// x86-64 instruction test suite - observe actual CPU behavior
// Generates test executables that perform operations and exit cleanly

import { Assembler, REG, XMM, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { spawn } from 'child_process';

function createTest(name, builder) {
  const a = new Assembler(TEXT_BASE);
  a.label('entry');
  
  try {
    builder(a);
  } catch (e) {
    console.log(`✗ ${name.padEnd(30)} BUILD ERROR: ${e.message}`);
    return null;
  }
  
  // Exit cleanly
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  
  return { name, bytes: a.resolve() };
}

function runTest(test) {
  if (!test) return Promise.resolve(null);
  
  const filename = `/tmp/test_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
  const elf = buildStaticElf64({ text: test.bytes, entry: TEXT_BASE });
  fs.writeFileSync(filename, elf, { mode: 0o755 });
  
  return new Promise((resolve) => {
    const proc = spawn(filename, [], { timeout: 1000 });
    let stdout = '', stderr = '';
    
    proc.stdout.on('data', (d) => stdout += d);
    proc.stderr.on('data', (d) => stderr += d);
    
    proc.on('close', (code, signal) => {
      fs.unlinkSync(filename);
      resolve({ name: test.name, code, signal, stdout, stderr });
    });
    
    proc.on('error', (err) => {
      resolve({ name: test.name, code: null, signal: null, stdout: '', stderr: err.message });
    });
  });
}

// Test cases - each performs operations and exits
const tests = [];

// Test 1: Basic GPR mov
tests.push(createTest('gpr_mov_chain', (a) => {
  a.movImm32(REG.RAX, 42);
  a.mov(REG.RBX, REG.RAX);
  a.mov(REG.RCX, REG.RBX);
  a.mov(REG.RDX, REG.RCX);
  // RAX-RDX should all be 42
}));

// Test 2: XMM movq (64-bit)
tests.push(createTest('xmm_movq_64', (a) => {
  a.movImm32(REG.RAX, 99);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  // RBX should be 99
}));

// Test 3: Multiple XMM registers
tests.push(createTest('xmm_multiple_regs', (a) => {
  a.movImm32(REG.RAX, 11);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 22);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.movImm32(REG.RAX, 33);
  a.movq_xmm_r64(XMM.XMM2, REG.RAX);
  
  a.movq_r64_xmm(REG.RBX, XMM.XMM1);
  // RBX should be 22
}));

// Test 4: Stack push/pop
tests.push(createTest('stack_push_pop', (a) => {
  a.movImm32(REG.RAX, 77);
  a.push(REG.RAX);
  a.movImm32(REG.RAX, 88);
  a.pop(REG.RBX);
  // RBX should be 77, RAX is now 88
}));

// Test 5: Memory store/load
tests.push(createTest('memory_store_load', (a) => {
  a.subImm32(REG.RSP, 64);
  a.movImm32(REG.RAX, 55);
  a.store64(REG.RSP, REG.RAX, 0);
  a.load64(REG.RBX, REG.RSP, 0);
  a.addImm32(REG.RSP, 64);
  // RBX should be 55
}));

// Test 6: Arithmetic add
tests.push(createTest('arithmetic_add', (a) => {
  a.movImm32(REG.RAX, 10);
  a.movImm32(REG.RBX, 20);
  a.add(REG.RAX, REG.RBX);
  // RAX should be 30
}));

// Test 7: Arithmetic sub
tests.push(createTest('arithmetic_sub', (a) => {
  a.movImm32(REG.RAX, 50);
  a.movImm32(REG.RBX, 15);
  a.sub(REG.RAX, REG.RBX);
  // RAX should be 35
}));

// Test 8: Bitwise AND
tests.push(createTest('bitwise_and', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.movImm32(REG.RBX, 0x0F);
  a.and(REG.RAX, REG.RBX);
  // RAX should be 0x0F (15)
}));

// Test 9: Bitwise OR
tests.push(createTest('bitwise_or', (a) => {
  a.movImm32(REG.RAX, 0xF0);
  a.movImm32(REG.RBX, 0x0F);
  a.or(REG.RAX, REG.RBX);
  // RAX should be 0xFF (255)
}));

// Test 10: Bitwise XOR
tests.push(createTest('bitwise_xor', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.xor(REG.RAX, REG.RAX);
  // RAX should be 0
}));

// Test 11: Immediate add
tests.push(createTest('immediate_add', (a) => {
  a.movImm32(REG.RAX, 10);
  a.addImm32(REG.RAX, 5);
  // RAX should be 15
}));

// Test 12: Shift left
tests.push(createTest('shift_left', (a) => {
  a.movImm32(REG.RAX, 1);
  a.mov(REG.RCX, 3);
  a.shlCl(REG.RAX);
  // RAX should be 8 (1 << 3)
}));

// Test 13: Shift right
tests.push(createTest('shift_right', (a) => {
  a.movImm32(REG.RAX, 16);
  a.mov(REG.RCX, 2);
  a.shrCl(REG.RAX);
  // RAX should be 4 (16 >> 2)
}));

// Test 14: Compare and conditional
tests.push(createTest('compare_less', (a) => {
  a.movImm32(REG.RAX, 5);
  a.movImm32(REG.RBX, 10);
  a.cmp(REG.RAX, REG.RBX);
  a.jcc(COND.L, 'skip');
  a.movImm32(REG.RAX, 99);
  a.label('skip');
  a.label('done');
  // RAX should still be 5 (jump taken, skip the 99 assignment)
}));

// Test 15: Compare and no jump
tests.push(createTest('compare_not_equal', (a) => {
  a.movImm32(REG.RAX, 5);
  a.movImm32(REG.RBX, 5);
  a.cmp(REG.RAX, REG.RBX);
  a.jcc(COND.NE, 'skip');
  a.movImm32(REG.RAX, 99);
  a.label('skip');
  a.label('done');
  // RAX should be 99 (jump not taken, falls through)
}));

// Test 16: Call and return
tests.push(createTest('call_return', (a) => {
  a.call('func');
  a.mov(REG.RBX, REG.RAX); // RBX should be 55 (returned from func); landing + exit path
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  a.label('func');
  a.movImm32(REG.RAX, 55);
  a.ret();
  // RBX should be 55
}));

// Test 17: Large immediate (64-bit)
tests.push(createTest('large_immediate_64', (a) => {
  a.movImm64(REG.RAX, 0x123456789ABCDEFn);
  // RAX should be 0x123456789ABCDEF
}));

// Test 18: Negative immediate
tests.push(createTest('negative_immediate', (a) => {
  a.movImm32(REG.RAX, -1);
  // RAX should be -1 (0xFFFFFFFFFFFFFFFF)
}));

// Test 19: XMM to XMM operations (if available)
tests.push(createTest('xmm_paddq', (a) => {
  a.movImm32(REG.RAX, 100);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 50);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.paddq(XMM.XMM0, XMM.XMM1);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  // RBX should be 150
}));

// Test 20: XMM bitwise
tests.push(createTest('xmm_pxor', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.pxor(XMM.XMM0, XMM.XMM0);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  // RBX should be 0
}));

// Test 21: Memory with offset
tests.push(createTest('memory_offset', (a) => {
  a.subImm32(REG.RSP, 128);
  a.movImm32(REG.RAX, 111);
  a.store64(REG.RSP, REG.RAX, 8);  // Store at offset 8
  a.movImm32(REG.RAX, 222);
  a.store64(REG.RSP, REG.RAX, 16); // Store at offset 16
  a.load64(REG.RBX, REG.RSP, 8);   // Load from offset 8
  a.addImm32(REG.RSP, 128);
  // RBX should be 111
}));

// Test 22: Register high (R8-R15)
tests.push(createTest('high_registers', (a) => {
  a.movImm32(REG.R8, 1);
  a.movImm32(REG.R9, 2);
  a.movImm32(REG.R10, 3);
  a.movImm32(REG.R11, 4);
  a.mov(REG.R12, REG.R8);
  a.add(REG.R12, REG.R9);
  a.add(REG.R12, REG.R10);
  a.add(REG.R12, REG.R11);
  // R12 should be 10 (1+2+3+4)
}));

// Test 23: XMM high (XMM8-XMM15)
tests.push(createTest('xmm_high_registers', (a) => {
  a.movImm32(REG.RAX, 777);
  a.movq_xmm_r64(XMM.XMM8, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM8);
  // RBX should be 777
}));

// Test 24: Multiple operations chain
tests.push(createTest('operation_chain', (a) => {
  a.movImm32(REG.RAX, 10);
  a.addImm32(REG.RAX, 5);  // 15
  a.addImm32(REG.RAX, 5);  // 20
  a.subImm32(REG.RAX, 3);  // 17
  a.addImm32(REG.RAX, 3);  // 20
  // RAX should be 20
}));

// Test 25: Stack alignment
tests.push(createTest('stack_alignment', (a) => {
  a.mov(REG.RAX, REG.RSP);
  a.and(REG.RAX, 0xF);
  // RAX should be 0 (stack aligned to 16 bytes)
}));

async function runAllTests() {
  console.log('=== x86-64 Instruction Test Suite ===\n');
  console.log('Running', tests.filter(t => t).length, 'tests...\n');
  
  const results = await Promise.all(tests.map(runTest));
  
  const summary = {
    success: 0,
    crash: 0,
    signal: 0,
    error: 0
  };
  
  for (const result of results) {
    if (!result) {
      summary.error++;
      continue;
    }
    
    const status = result.code === 0 ? '✓' : 
                   result.signal ? `✗ SIG${result.signal}` : 
                   `✗ EXIT(${result.code})`;
    
    console.log(`${result.name.padEnd(30)} ${status}`);
    
    if (result.code === 0) summary.success++;
    else if (result.signal) summary.signal++;
    else summary.crash++;
    
    if (result.stderr && result.code !== 0) {
      console.log(`  ${result.stderr.split('\n')[0].substring(0, 70)}`);
    }
  }
  
  console.log('\n=== Summary ===');
  console.log('✓ Success:', summary.success);
  console.log('✗ Crash:', summary.crash);
  console.log('✗ Signal:', summary.signal);
  console.log('✗ Build error:', summary.error);
}

runAllTests().catch(console.error);
