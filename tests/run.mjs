#!/usr/bin/env node
// reg-runtime smoke runner.
//
// Executes the pure-kz smoke scripts in tests/kz/ through the built ./kzero
// binary and reports pass/fail. A script passes when it exits 0; if a matching
// <name>.expected file exists, stdout must match it as well. Usage:
//   node tests/run.mjs            # run all smoke scripts
//   node tests/run.mjs <name>     # run a single smoke (e.g. test_minimal)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const kzero = path.resolve(here, '..', 'kzero');
const kzDir = path.join(here, 'kz');
const tmpDir = '/tmp/opencode';

const only = process.argv[2] ?? null;
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');

const scripts = fs
  .readdirSync(kzDir)
  .filter((f) => f.endsWith('.js'))
  .sort();

const results = [];
for (const f of scripts) {
  if (only && f !== only) continue;
  const src = fs.readFileSync(path.join(kzDir, f), 'utf8');
  const tmp = path.join(tmpDir, `reg_smoke_${f}`);
  fs.writeFileSync(tmp, src);
  const expPath = path.join(kzDir, f.replace(/\.js$/, '.expected'));
  const expected = fs.existsSync(expPath) ? fs.readFileSync(expPath, 'utf8') : null;
  const r = spawnSync(kzero, [tmp], { encoding: 'utf8', timeout: 10000 });
  const outputOk = expected === null || norm(r.stdout ?? '') === norm(expected);
  results.push({
    name: f,
    ok: r.status === 0 && outputOk,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    expected: outputOk ? null : expected,
  });
}

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`✓ ${r.name}`);
  } else {
    failed++;
    console.log(`✗ ${r.name} (exit ${r.status})`);
    if (r.stderr) console.log(`    ${r.stderr.split('\n')[0].substring(0, 120)}`);
    if (r.expected !== null) {
      console.log('    output mismatch:');
      console.log(`      expected: ${JSON.stringify(norm(r.expected))}`);
      console.log(`      actual:   ${JSON.stringify(norm(r.stdout ?? ''))}`);
    }
  }
  if (r.stdout) {
    for (const line of r.stdout.split('\n')) console.log(`    | ${line}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} smoke scripts passed`);
process.exit(failed > 0 ? 1 : 0);
