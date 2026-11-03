#!/usr/bin/env node
// Generate a script with many variables whose hashes land in distinct ring
// slots, run it through kzero, and verify every value round-trips. This
// exercises >8 slots, lane independence, and the high ZMM registers.

import fs from 'fs';
import { execFileSync } from 'child_process';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function hash(s) {
  let h = FNV_OFFSET;
  for (const ch of Buffer.from(s)) {
    h ^= BigInt(ch);
    h = (h * FNV_PRIME) & 0xffffffffffffffffn;
  }
  return h;
}

function slotOf(name) {
  let s = Number(hash(name) & 0xffn);
  if (s >= 248) s -= 8;
  return s;
}

const TARGET = 180;
const used = new Map(); // slot -> name
const chosen = [];
for (let i = 0; chosen.length < TARGET; i++) {
  const name = `v${i}`;
  const slot = slotOf(name);
  if (used.has(slot)) continue;
  used.set(slot, name);
  chosen.push({ name, slot, value: 100000 + i });
}

const zmmSet = new Set(chosen.map((c) => c.slot >> 3));
const lines = chosen.map((c) => `let ${c.name} = ${c.value}`);
lines.push(...chosen.map((c) => `console.log(${c.name})`));
const src = lines.join('\n') + '\n';

const srcPath = '/tmp/kzero_many_src.js';
fs.writeFileSync(srcPath, src);

let out;
try {
  out = execFileSync('/home/ken/build/reg-runtime/kzero', [srcPath], {
    encoding: 'utf8',
    timeout: 10000,
  });
} catch (e) {
  console.error(`FAIL: runtime exited ${e.status}`);
  process.exit(1);
}

const got = out.trim().split('\n').map(Number);
const want = chosen.map((c) => c.value);
let bad = 0;
for (let i = 0; i < want.length; i++) {
  if (got[i] !== want[i]) {
    if (bad < 10) console.error(`  slot ${chosen[i].slot} (${chosen[i].name}): want ${want[i]} got ${got[i]}`);
    bad++;
  }
}

if (got.length !== want.length) {
  console.error(`FAIL: ${got.length} output lines, want ${want.length}`);
  process.exit(1);
}
if (bad) {
  console.error(`FAIL: ${bad}/${want.length} mismatches`);
  process.exit(1);
}

console.log(`PASS: ${chosen.length} variables, ${used.size} distinct slots, ${zmmSet.size} ZMM registers`);
