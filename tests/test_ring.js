#!/usr/bin/env node
// Verify the ZMM register-file: lane independence, high registers, and
// 64-bit values. Exits with a distinct code per failing case.

import { Assembler, REG, COND } from '../asm.js';
import { buildStaticElf64, TEXT_BASE } from '../elf.js';
import { emitStoreSlot, emitLoadSlot, emitZeroRing } from '../ring.js';
import fs from 'fs';
import { execFileSync } from 'child_process';

const a = new Assembler(TEXT_BASE);
a.jmp('entry');

a.label('store_slot');
emitStoreSlot(a, 'ss');

a.label('load_slot');
emitLoadSlot(a, 'll');

a.label('entry');
emitZeroRing(a);

const cases = [
  [0, 0x11],
  [1, 0x22],
  [2, 0x33],
  [3, 0x44],
  [4, 0x55],
  [5, 0x66],
  [6, 0x77],
  [7, 0x88],
  [8, 0x99],
  [16, 0xaaaa],
  [80, 0xbbbb],
  [160, 0xcccc],
  [240, 0xdddd],
  [247, 0xeeee],
  [100, 0x1122334455667788n],
];

for (const [slot, val] of cases) {
  a.movImm64(REG.RAX, '0x' + BigInt(val).toString(16));
  a.movImm32(REG.RCX, slot);
  a.call('store_slot');
}

let failCode = 1;
for (const [slot, val] of cases) {
  a.movImm32(REG.RCX, slot);
  a.call('load_slot');
  a.movImm64(REG.RBX, '0x' + BigInt(val).toString(16));
  a.cmp(REG.RAX, REG.RBX);
  a.jcc(COND.NE, `fail${failCode}`);
  failCode++;
}

a.movImm32(REG.RAX, 231);
a.xor(REG.RDI, REG.RDI);
a.syscall();

for (let i = 1; i < failCode; i++) {
  a.label(`fail${i}`);
  a.movImm32(REG.RAX, 231);
  a.movImm32(REG.RDI, i);
  a.syscall();
}

const elf = buildStaticElf64({ text: a.resolve(), entry: TEXT_BASE });
const path = '/tmp/kzero_ring_test';
fs.writeFileSync(path, elf, { mode: 0o755 });

try {
  execFileSync(path, [], { timeout: 1000 });
  console.log(`PASS: ${cases.length} ring slots across ${new Set(cases.map(([s]) => s >> 3)).size} ZMM registers`);
} catch (e) {
  console.log(`FAIL: exit ${e.status} (case index ${e.status})`);
  process.exitCode = 1;
}
