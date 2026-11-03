#!/usr/bin/env node
// Assign a mix of inline (<=7 byte) and heap (>7 byte) strings to many
// distinct ring slots and verify each prints back exactly. This checks the
// inline value representation, heap fallback, and per-lane independence.

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

const TARGET = 160;
const used = new Map();
const chosen = [];
for (let i = 0; chosen.length < TARGET; i++) {
  const name = `w${i}`;
  const slot = slotOf(name);
  if (used.has(slot)) continue;
  used.set(slot, name);
  // Alternate inline and heap strings.
  const value = i % 2 === 0 ? `i${i}` : `heap_string_number_${i}`;
  chosen.push({ name, slot, value });
}

const lines = chosen.map((c) => `let ${c.name} = '${c.value}'`);
lines.push(...chosen.map((c) => `console.log(${c.name})`));
const src = lines.join('\n') + '\n';
const srcPath = '/tmp/kzero_strings_src.js';
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

const got = out.replace(/\n$/, '').split('\n');
const want = chosen.map((c) => c.value);
let bad = 0;
for (let i = 0; i < want.length; i++) {
  if (got[i] !== want[i]) {
    if (bad < 10) console.error(`  slot ${chosen[i].slot} (${chosen[i].name}): want ${JSON.stringify(want[i])} got ${JSON.stringify(got[i])}`);
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

const inline = chosen.filter((c) => c.value.length <= 7).length;
console.log(`PASS: ${chosen.length} string variables (${inline} inline, ${chosen.length - inline} heap), ${used.size} slots`);
