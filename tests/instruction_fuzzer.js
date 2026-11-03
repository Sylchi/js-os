#!/usr/bin/env node
// x86-64 instruction fuzzer - generate test executables to understand CPU behavior

import { Assembler, REG, XMM, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import fs from 'fs';
import { spawn } from 'child_process';

function generateTest(name, instructions) {
  const a = new Assembler(TEXT_BASE);
  
  // Entry point
  a.label('entry');
  
  // Execute instructions
  instructions(a);
  
  // Exit successfully
  a.movImm32(REG.RAX, 231); // sys_exit_group
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  
  return { name, bytes: a.resolve() };
}

function runTest(test) {
  const filename = `/tmp/test_${test.name}.bin`;
  const elf = buildStaticElf64({ text: test.bytes, entry: TEXT_BASE });
  fs.writeFileSync(filename, elf, { mode: 0o755 });
  
  return new Promise((resolve) => {
    const proc = spawn(filename, [], { timeout: 1000 });
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => stdout += data);
    proc.stderr.on('data', (data) => stderr += data);
    
    proc.on('close', (code, signal) => {
      resolve({
        name: test.name,
        exitCode: code,
        signal: signal,
        stdout: stdout,
        stderr: stderr
      });
    });
    
    proc.on('error', (err) => {
      resolve({
        name: test.name,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: err.message
      });
    });
  });
}

// Test generators
const tests = [];

// Test 1: Basic register operations
tests.push(generateTest('basic_mov', (a) => {
  a.movImm32(REG.RAX, 42);
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1); // write
  a.movImm32(REG.RDI, 1); // stdout
  a.mov(REG.RSI, REG.RBX); // this will crash but let's see
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 2: XMM register basics
tests.push(generateTest('xmm_movq', (a) => {
  a.movImm32(REG.RAX, 99);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  // Try to write RBX as pointer (will crash)
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 3: Multiple XMM registers
tests.push(generateTest('xmm_multiple', (a) => {
  a.movImm32(REG.RAX, 11);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 22);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  a.movImm32(REG.RAX, 33);
  a.movq_xmm_r64(XMM.XMM2, REG.RAX);
  
  a.movq_r64_xmm(REG.RBX, XMM.XMM1); // Should be 22
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 4: Stack operations
tests.push(generateTest('stack_push_pop', (a) => {
  a.movImm32(REG.RAX, 77);
  a.push(REG.RAX);
  a.pop(REG.RBX);
  a.mov(REG.RAX, REG.RBX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 5: Memory store/load
tests.push(generateTest('memory_store_load', (a) => {
  a.subImm32(REG.RSP, 64);
  a.movImm32(REG.RAX, 88);
  a.store64(REG.RSP, REG.RAX, 0);
  a.load64(REG.RBX, REG.RSP, 0);
  a.add(REG.RSP, 64);
  a.mov(REG.RAX, REG.RBX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 6: Invalid instruction - try to movq to invalid register
tests.push(generateTest('xmm_invalid_reg', (a) => {
  try {
    a.movq_xmm_r64(XMM.XMM0, 99); // Invalid - 99 is not a register
  } catch (e) {
    // Expected
  }
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
}));

// Test 7: Arithmetic operations
tests.push(generateTest('arithmetic_add', (a) => {
  a.movImm32(REG.RAX, 10);
  a.movImm32(REG.RBX, 20);
  a.add(REG.RAX, REG.RBX); // RAX = 30
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 8: Division
tests.push(generateTest('division', (a) => {
  a.movImm32(REG.RAX, 100);
  a.mov(REG.RBX, REG.RAX);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RCX, 10);
  a.divReg(REG.RCX); // RAX = 10, RDX = 0
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 9: Conditional jump
tests.push(generateTest('conditional_jump', (a) => {
  a.movImm32(REG.RAX, 5);
  a.movImm32(REG.RBX, 10);
  a.cmp(REG.RAX, REG.RBX);
  a.jcc(COND.L, 'skip');
  a.movImm32(REG.RBX, 99); // Should be skipped
  a.label('skip');
  a.label('done');
  a.mov(REG.RAX, REG.RBX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 10: Call and return
tests.push(generateTest('call_return', (a) => {
  a.label('main');
  a.call('func');
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 231);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();
  
  a.label('func');
  a.movImm32(REG.RAX, 55);
  a.ret();
}));

// Test 11: XMM arithmetic (if available)
tests.push(generateTest('xmm_arithmetic', (a) => {
  a.movImm32(REG.RAX, 5);
  a.movq_xmm_r64(XMM.XMM0, REG.RAX);
  a.movImm32(REG.RAX, 3);
  a.movq_xmm_r64(XMM.XMM1, REG.RAX);
  // Try to add - this might not exist or work differently
  try {
    a.addps(XMM.XMM0, XMM.XMM1);
  } catch (e) {
    // May not be implemented
  }
  a.movq_r64_xmm(REG.RBX, XMM.XMM0);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 12: Large immediate
tests.push(generateTest('large_immediate', (a) => {
  a.movImm64(REG.RAX, 0x1234567890ABCDEFn);
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 13: Negative numbers
tests.push(generateTest('negative_numbers', (a) => {
  a.movImm32(REG.RAX, -1);
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 14: Bitwise operations
tests.push(generateTest('bitwise_and', (a) => {
  a.movImm32(REG.RAX, 0xFF);
  a.movImm32(REG.RBX, 0x0F);
  a.and(REG.RAX, REG.RBX); // Should be 0x0F
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Test 15: Shift operations
tests.push(generateTest('shift_left', (a) => {
  a.movImm32(REG.RAX, 1);
  a.mov(REG.RCX, 3);
  a.shl(REG.RAX, REG.RCX); // Should be 8
  a.mov(REG.RBX, REG.RAX);
  a.movImm32(REG.RAX, 1);
  a.movImm32(REG.RDI, 1);
  a.mov(REG.RSI, REG.RBX);
  a.movImm32(REG.RDX, 8);
  a.syscall();
}));

// Run all tests
async function runAllTests() {
  console.log('Running', tests.length, 'tests...\n');
  
  const results = await Promise.all(tests.map(runTest));
  
  const summary = {
    success: 0,
    crash: 0,
    signal: 0,
    unexpected: 0
  };
  
  for (const result of results) {
    const status = result.exitCode === 0 ? '✓ OK' : 
                   result.signal ? `✗ ${result.signal}` : 
                   `✗ EXIT(${result.exitCode})`;
    
    console.log(`${result.name.padEnd(25)} ${status}`);
    
    if (result.exitCode === 0) summary.success++;
    else if (result.signal) summary.signal++;
    else summary.crash++;
    
    if (result.stdout) {
      console.log(`  stdout: ${result.stdout.substring(0, 100)}`);
    }
    if (result.stderr) {
      console.log(`  stderr: ${result.stderr.substring(0, 100)}`);
    }
  }
  
  console.log('\n=== Summary ===');
  console.log('Success:', summary.success);
  console.log('Crash:', summary.crash);
  console.log('Signal:', summary.signal);
}

runAllTests().catch(console.error);
