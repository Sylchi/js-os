#!/usr/bin/env node
/**
 * Pure JavaScript Runtime Builder
 *
 * Assembles the register-machine runtime into a native image. The default
 * target is a UEFI application (PE32+); KZERO_PLATFORM=linux (or --linux)
 * emits the old static ELF64 binary for comparison.
 *
 * Zero external dependencies: no GCC, no Clang, no NASM, no ld.
 *
 * Usage:
 *   node build.js                     Emit ./kzero.efi      (UEFI)
 *   node build.js out.efi             Emit to a custom path
 *   node build.js --out out.efi       Emit to a custom path (preferred)
 *   node build.js --source app.kz     Embed app.kz as the default script
 *   node build.js app.kz              Shorthand for --source app.kz
 *   node build.js --linux             Emit a Linux ELF64 binary instead
 *
 * Environment:
 *   KZERO_SOURCE         Embed a script instead of loading one at runtime
 *   KZERO_PLATFORM       "linux" selects the legacy ELF target
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function flagValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

// A bare argument is the output path. Skip flag values so
// `--source app.kz` does not accidentally overwrite the script.
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--source' || arg === '--out') {
    i++;
    continue;
  }
  if (arg.startsWith('--')) continue;
  positional.push(arg);
}

if (args.includes('--linux')) process.env.KZERO_PLATFORM = 'linux';
const platform = process.env.KZERO_PLATFORM === 'linux' ? 'linux' : 'uefi';
const defaultOut = platform === 'uefi' ? 'kzero.efi' : 'kzero';

// A positional .js/.kz path is almost always meant as the script, not the
// output. Treating it as the output used to overwrite test scripts in place.
let positionalOut = positional[0] ?? null;
let positionalSource = null;
if (positionalOut && /\.(?:js|kz)$/i.test(positionalOut)) {
  positionalSource = positionalOut;
  positionalOut = null;
}

const outPath = path.resolve(flagValue('--out') ?? positionalOut ?? defaultOut);
const source = flagValue('--source') ?? positionalSource;
const singleCore = args.includes('--single-core') || process.env.KZERO_SINGLE_CORE === '1';

if (source) {
  if (path.resolve(source) === outPath) {
    console.error(`[build] refusing to overwrite the source script: ${outPath}`);
    process.exit(1);
  }
  // KZERO_SOURCE carries the script text, not its path: the engine embeds it
  // verbatim as the input buffer.
  process.env.KZERO_SOURCE = fs.readFileSync(source, 'utf8');
}
if (singleCore) process.env.KZERO_SINGLE_CORE = '1';

// Import after the environment is final: engine.js snapshots the platform at
// module load time.
const { generateRuntimeAssembly, BSS_SIZE, UEFI_HEAP_BASE } = await import('./engine.js');
const { buildStaticElf64, TEXT_BASE: ELF_TEXT_BASE } = await import('./elf.js');
const { buildUefiImage, TEXT_BASE: UEFI_TEXT_BASE } = await import('./uefi.js');

console.log(`[build] target: ${platform}`);
console.log('[build] assembling streaming register runtime (x86-64)...');
const textBytes = generateRuntimeAssembly();
console.log(`[build] text segment assembled: ${textBytes.length} bytes`);

let image;
if (platform === 'uefi') {
  console.log('[build] linking PE32+ UEFI application...');
  image = buildUefiImage({
    text: textBytes,
    entryOffset: 0,
    imageBase: UEFI_TEXT_BASE - 0x1000,
  });
} else {
  console.log('[build] linking static ELF64 executable...');
  image = buildStaticElf64({
    text: textBytes,
    bssSize: BSS_SIZE,
    entry: ELF_TEXT_BASE,
  });
}

fs.writeFileSync(outPath, image, { mode: 0o755 });
console.log(
  `[build] ${platform === 'uefi' ? 'EFI application' : 'executable'} emitted: ` +
  `${outPath} (${image.length} bytes, globals @ 0x${(platform === 'uefi' ? UEFI_HEAP_BASE : 0).toString(16)})`,
);
