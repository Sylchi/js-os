#!/usr/bin/env node
/**
 * UEFI capability probe.
 *
 * Standalone PE32+ application that reports what the running firmware
 * exposes, before the reg-runtime interpreter is brought over:
 *
 *   - firmware vendor/revision and Boot Services revision
 *   - memory map size / descriptor size / descriptor count
 *   - every EFI configuration table (GUID + address), with ACPI/SMBIOS named
 *   - ACPI RSDP fields, then XSDT/RSDT table signatures and lengths
 *   - presence and handle count for the protocols the web APIs will need
 *   - CPUID leaf 1/7/0xD, CR4 and XCR0
 *
 * It is intentionally plain: no allocator, no AVX, no libc. The only writable
 * storage is the entry stack; all globals live in a fixed frame.
 *
 * Usage: node probe.js [out.efi]
 */

import fs from 'node:fs';
import path from 'node:path';
import { Assembler, REG, COND } from './asm.js';
import { buildUefiImage, TEXT_BASE } from './uefi.js';

const outPath = path.resolve(process.argv[2] ?? 'probe.efi');
const a = new Assembler(TEXT_BASE);

// ---------------------------------------------------------------- EFI layout
const SYS_FW_VENDOR = 24;
const SYS_FW_REV = 32;
const SYS_CON_OUT = 64;
const SYS_RUNTIME = 88;
const SYS_BOOT = 96;
const SYS_NUM_TABLES = 104;
const SYS_TABLES = 112;

const BS_ALLOCATE_PAGES = 40;
const BS_GET_MEMORY_MAP = 56;
const BS_ALLOCATE_POOL = 64;
const BS_FREE_POOL = 72;
const BS_HANDLE_PROTOCOL = 152;
const BS_LOCATE_HANDLE_BUFFER = 312;
const BS_LOCATE_PROTOCOL = 320;
const RT_RESET_SYSTEM = 104;

const EFI_BY_PROTOCOL = 2;
const EFI_LOADER_DATA = 2;
const EFI_RESET_SHUTDOWN = 2;

// Entry stack frame slots (all relative to RSP after `sub rsp, FRAME`).
const L_COUNT = 0x00;
const L_BUF = 0x08;
const L_KEY = 0x10;
const L_DESC_SIZE = 0x18;
const L_MAP_SIZE = 0x20;
const L_DESC_VER = 0x28;
const L_MP_NUM = 0x30;
const L_MP_EN = 0x38;
const L_IFACE = 0x40;
const L_CHILD = 0x48;
const L_IFACE2 = 0x50;
const L_SCRATCH = 0x60; // 64 bytes: hex/ASCII output buffer
const L_CPUID = 0xa0; // 32 bytes
const L_VENDOR = 0xc0; // 16 bytes
const L_ACPI2 = 0xd0;
const L_ACPI1 = 0xd8;
const L_SMBIOS3 = 0xe0;
const L_SMBIOS = 0xe8;
const L_SD = 0xf0;
const L_ENTRY_SIZE = 0xf8;
const L_TABLE_COUNT = 0x100;
const L_AVX_IN = 0x120; // 64 bytes
const L_AVX_OUT = 0x160; // 64 bytes
const L_CR4_OLD = 0x1a0;
const L_XCR0_MASK = 0x1a8;
const L_IP4INFO = 0x400; // 512-byte EFI_IP4_CONFIG2_INTERFACE_INFO
const L_IP4SIZE = 0x600;
const L_IP4GWA = 0x620; // gateway / DNS address arrays
const L_IP4STATUS = 0x640;
const FRAME = 0x1000;

// ------------------------------------------------------------- deferred data
const data = [];
let strId = 0;
let uid = 0;

function dataLabel(name, bytes) {
  data.push({ name, bytes });
  return name;
}
function str(text) {
  return dataLabel(`str_${strId++}`,
    Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.alloc(2)]));
}
function defGuid(name, hex) {
  return dataLabel(`guid_${name}`, Buffer.from(hex, 'hex'));
}

const NL = str('\r\n');
const TWO = str('  ');
const NO = str('none\r\n');
const NO_LINE = str('no\r\n');
const DASH = str('-');
const DOT = str('.');
const HEX_DIGITS = 'hex_digits';

// ------------------------------------------------------------------ helpers
function leaRsp(dst, off) {
  a.mov(dst, REG.RSP);
  if (off) a.addImm32(dst, off);
}

// RAX = firmware function, RCX/RDX/R8/R9 (+R10) = Microsoft ABI arguments.
function uefiCall() {
  a.call('uefi_call');
}
function uefiCall5() {
  a.call('uefi_call5');
}

// RDX already points at a NUL-terminated UTF-16 string.
function conOut() {
  a.mov(REG.RCX, REG.R14);
  a.load64(REG.RAX, REG.R14, 8);
  uefiCall();
}
function print(label) {
  a.leaRip(REG.RDX, label);
  conOut();
}
function printPtr(ptrReg) {
  a.mov(REG.RDX, ptrReg);
  conOut();
}

// Print the low `digits` hex digits of `reg` (destroys reg).
// The digit-table pointer goes in R11: using RAX here would destroy the value
// whenever the caller passed RAX, silently printing zeros.
function hexN(reg, digits) {
  const loop = `hx_${uid++}`;
  leaRsp(REG.RDI, L_SCRATCH);
  a.leaRip(REG.R11, HEX_DIGITS);
  a.movImm32(REG.RCX, digits);
  // For a partial width, rotate the wanted low nibbles up to the top first.
  if (digits < 16) a.rolImm(reg, (16 - digits) * 4);
  a.label(loop);
  a.rolImm(reg, 4);
  a.mov(REG.RDX, reg);
  a.andImm32(REG.RDX, 15);
  a.load8Indexed(REG.RDX, REG.R11, REG.RDX);
  a.store16(REG.RDI, REG.RDX, 0);
  a.addImm32(REG.RDI, 2);
  a.dec(REG.RCX);
  a.jcc(COND.NZ, loop);
  a.xor(REG.RDX, REG.RDX);
  a.store16(REG.RDI, REG.RDX, 0);
  leaRsp(REG.RDX, L_SCRATCH);
  conOut();
}
function hex64(reg) {
  hexN(reg, 16);
}
function hex2(reg) {
  hexN(reg, 2);
}

// Copy `len` bytes at [ptr] to the scratch buffer as UTF-16 and print them.
function printBytes(ptrReg, len) {
  leaRsp(REG.RDI, L_SCRATCH);
  for (let i = 0; i < len; i++) {
    a.load8(REG.RAX, ptrReg, i);
    a.store16(REG.RDI, REG.RAX, i * 2);
  }
  a.xor(REG.RAX, REG.RAX);
  a.store16(REG.RDI, REG.RAX, len * 2);
  leaRsp(REG.RDX, L_SCRATCH);
  conOut();
}

function showSlot(label, slot, bits = 64) {
  print(label);
  a.load64(REG.RAX, REG.RSP, slot);
  if (bits === 32) {
    a.movImm64(REG.RCX, 0xffffffff);
    a.and(REG.RAX, REG.RCX);
  }
  hex64(REG.RAX);
  print(NL);
}

function showPointer(label, slot) {
  const yes = `sp_yes_${uid++}`;
  const done = `sp_done_${uid++}`;
  print(label);
  a.load64(REG.RAX, REG.RSP, slot);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, yes);
  print(NO_LINE);
  a.jmp(done);
  a.label(yes);
  hex64(REG.RAX);
  print(NL);
  a.label(done);
}

function showNamed(label, slot) {
  const yes = `sn_yes_${uid++}`;
  const done = `sn_done_${uid++}`;
  print(label);
  a.load64(REG.RAX, REG.RSP, slot);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, yes);
  print(NO_LINE);
  a.jmp(done);
  a.label(yes);
  hex64(REG.RAX);
  print(NL);
  a.label(done);
}

function guidHalves(hex) {
  const b = Buffer.from(hex, 'hex');
  return [b.readBigUInt64LE(0), b.readBigUInt64LE(8)];
}

// If the 24-byte config entry at [RBP] matches `hex`, store its table pointer.
function matchConfig(hex, slot) {
  const [lo, hi] = guidHalves(hex);
  const skip = `mc_${uid++}`;
  a.load64(REG.RAX, REG.RBP, 0);
  a.movImm64(REG.RCX, '0x' + lo.toString(16));
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.NE, skip);
  a.load64(REG.RAX, REG.RBP, 8);
  a.movImm64(REG.RCX, '0x' + hi.toString(16));
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.NE, skip);
  a.load64(REG.RAX, REG.RBP, 16);
  a.store64(REG.RSP, REG.RAX, slot);
  a.label(skip);
}

// Print a config-table GUID as canonical text (first three fields are
// little-endian in memory).
const GUID_ORDER = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
function printGuidBytes() {
  GUID_ORDER.forEach((idx, pos) => {
    if (pos === 4 || pos === 6 || pos === 8 || pos === 10) print(DASH);
    a.load8(REG.RSI, REG.RBP, idx);
    hex2(REG.RSI);
  });
}

// ------------------------------------------------------------- protocol GUIDs
const GUID = {
  sfs: '225b4e965964d2118e3900a0c969723b',
  loadedImage: 'a1311b5b6295d2118e3f00a0c969723b',
  devicePath: '916e57093f6dd2118e3900a0c969723b',
  tcp4: 'c70b536559a30f41b0105aadc7ec2b62',
  tcp4sb: '65067200eb67994abaf7d3c33a1c7cc9',
  udp4: '29dfd93a01458d47b1f87f7fe70e50f3',
  udp4sb: '6414f083bd99e545b383af6305d8e9e6',
  ip4: 'd24cd941b6355a458258d4e51334aadd',
  ip4config2: 'd16e445b0be3aa4f871a3654eca36080',
  dns4: 'cc283dae5be0a14fa0117eb55a3f1401',
  dns4sb: '86b125b663e0f74489056a74dc6f52b4',
  dhcp4: '1897218af54e614791c8c0f04bda9e56',
  dhcp4sb: 'd8399a9d42bd734aa4d58ee94be11380',
  tls: '9f95ca00fa6cb14d95bce46c47514390',
  tlssb: '95b72c9536ffcf48a2494df486d6ab8d',
  http: '9bb2597a0b9171418242a85a0df25b5b',
  httpsb: 'afe6c8bdbcd97943a72ae0c4e75dae1c',
  httpUtils: '63c1353e7440dd45431e23989dd86b32',
  hash2: '34d7b155e1c5db499647b16afb0e305b',
  hash2sb: '8d6f83da7f21a04c99c21ca4e16077ea',
  pkcs7: 'b29f884771d6ab4fa0cadf0e44df70d6',
  tcg2: '6c767f605574be42930be4d76db2720f',
  supplicant: '3ec4fc5489aa33439a85cdea24051e9e',
  supplicantsb: '8ed9bc45ad5974419546344a07485898',
  eap: 'db969f5d31e7aa4ca00d72e187cd7762',
  wifi: 'c95ba50df845b44b87195224f18a4d45',
  snp: 'b93298a125acd3119a2d0090273fc14d',
  arp: 'bb27b4f421ba164fbc4e43e416ab619c',
  rng: 'a5bc5231deea3d43862ec01cdc291f44',
  mp: '05a6dd3f6ea7464fad2912f4531b3d08',
  pci: '00b2f54cb868a54c9eecb23e3f50029a',
  bthc: '710593b3babec54f92039427242e6a43',
  btcfg: 'f30c9662ff406342a77cdfdebd191b4b',
  serial: '6fcf25bbd4f1d2119a0c0090273fc1fd',
  gop: 'dea94290dc23384a96fb7aded080516a',
  acpiTable: 'dd6be0ff0761a6467bb25a9c7ec5275c',
};
const CFG_GUID = {
  acpi1: '302d9deb882dd3119a160090273fc14d',
  acpi2: '71e86888f1e4d311bc220080c73c8881',
  smbios: '312d9deb882dd3119a160090273fc14d',
  smbios3: '4415fdf294972c4a992ee5bbcf20e394',
};

for (const [name, hex] of Object.entries(GUID)) defGuid(name, hex);

// ---------------------------------------------------------------- entry code
a.label('entry');
a.mov(REG.R15, REG.RDX); // system table
a.subImm32(REG.RSP, FRAME);

// Firmware does not promise a zeroed stack; the "table found" slots and the
// handle buffers must start at 0 so an absent table is not reported as a
// random pointer.
a.mov(REG.RDI, REG.RSP);
a.movImm32(REG.RCX, FRAME / 8);
a.xor(REG.RAX, REG.RAX);
const zeroLoop = `zero_${uid++}`;
a.label(zeroLoop);
a.store64(REG.RDI, REG.RAX, 0);
a.addImm32(REG.RDI, 8);
a.dec(REG.RCX);
a.jcc(COND.NZ, zeroLoop);

a.load64(REG.R13, REG.R15, SYS_BOOT); // Boot Services
a.load64(REG.R14, REG.R15, SYS_CON_OUT); // ConOut

print(str('reg-runtime UEFI capability probe\r\n'));
print(str('--------------------------------\r\n'));

// ---------------------------------------------------------- firmware identity
print(str('firmware: '));
a.load64(REG.RDX, REG.R15, SYS_FW_VENDOR);
conOut();
print(NL);

print(str('firmware revision: 0x'));
a.load64(REG.RAX, REG.R15, SYS_FW_REV);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RAX, REG.RCX);
hex64(REG.RAX);
print(NL);

print(str('boot services revision: 0x'));
a.load64(REG.RAX, REG.R13, 8);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RAX, REG.RCX);
hex64(REG.RAX);
print(NL);
print(NL);

// ---------------------------------------------------------------- memory map
print(str('memory map:'));
print(NL);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_MAP_SIZE);
leaRsp(REG.RCX, L_MAP_SIZE);
a.xor(REG.RDX, REG.RDX);
leaRsp(REG.R8, L_KEY);
leaRsp(REG.R9, L_DESC_SIZE);
leaRsp(REG.R10, L_DESC_VER);
a.load64(REG.RAX, REG.R13, BS_GET_MEMORY_MAP);
uefiCall5();

const mapSkip = `map_skip_${uid++}`;
const mapDone = `map_done_${uid++}`;
a.load64(REG.RDX, REG.RSP, L_MAP_SIZE);
a.test(REG.RDX, REG.RDX);
a.jcc(COND.Z, mapSkip);

a.movImm32(REG.RCX, EFI_LOADER_DATA);
leaRsp(REG.R8, L_BUF);
a.load64(REG.RAX, REG.R13, BS_ALLOCATE_POOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, mapSkip);

leaRsp(REG.RCX, L_MAP_SIZE);
a.load64(REG.RDX, REG.RSP, L_BUF);
leaRsp(REG.R8, L_KEY);
leaRsp(REG.R9, L_DESC_SIZE);
leaRsp(REG.R10, L_DESC_VER);
a.load64(REG.RAX, REG.R13, BS_GET_MEMORY_MAP);
uefiCall5();

showSlot(str('  map bytes: 0x'), L_MAP_SIZE);
showSlot(str('  descriptor size: 0x'), L_DESC_SIZE, 32);
a.load64(REG.RAX, REG.RSP, L_MAP_SIZE);
a.load64(REG.RCX, REG.RSP, L_DESC_SIZE);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.RCX);
a.mov(REG.RBX, REG.RAX); // print() uses RAX
print(str('  descriptor count: 0x'));
a.mov(REG.RSI, REG.RBX);
hex64(REG.RSI);
print(NL);
a.jmp(mapDone);

a.label(mapSkip);
print(str('  unavailable\r\n'));
a.label(mapDone);
const noFree = `map_nofree_${uid++}`;
a.load64(REG.RCX, REG.RSP, L_BUF);
a.test(REG.RCX, REG.RCX);
a.jcc(COND.Z, noFree);
a.load64(REG.RAX, REG.R13, BS_FREE_POOL);
uefiCall();
a.label(noFree);
print(NL);

// ------------------------------------------------------- configuration tables
print(str('configuration tables:\r\n'));
a.load64(REG.RBX, REG.R15, SYS_NUM_TABLES);
a.load64(REG.RBP, REG.R15, SYS_TABLES);
print(TWO);
hex64(REG.RBX);
print(str(' entries\r\n'));

const cfgLoop = `cfg_loop_${uid++}`;
const cfgDone = `cfg_done_${uid++}`;
a.label(cfgLoop);
a.test(REG.RBX, REG.RBX);
a.jcc(COND.Z, cfgDone);
print(TWO);
printGuidBytes();
print(str('  '));
a.load64(REG.RSI, REG.RBP, 16);
hex64(REG.RSI);
print(NL);
matchConfig(CFG_GUID.acpi2, L_ACPI2);
matchConfig(CFG_GUID.acpi1, L_ACPI1);
matchConfig(CFG_GUID.smbios3, L_SMBIOS3);
matchConfig(CFG_GUID.smbios, L_SMBIOS);
a.addImm32(REG.RBP, 24);
a.dec(REG.RBX);
a.jmp(cfgLoop);
a.label(cfgDone);
print(NL);

showNamed(str('ACPI 2.0 table: '), L_ACPI2);
showNamed(str('ACPI 1.0 table: '), L_ACPI1);
showNamed(str('SMBIOS table: '), L_SMBIOS);
showNamed(str('SMBIOS3 table: '), L_SMBIOS3);
print(NL);

// ------------------------------------------------------------- ACPI RSDP/XSDT
const acpiSkip = `acpi_skip_${uid++}`;
const acpiHave = `acpi_have_${uid++}`;
const acpiSd = `acpi_sd_${uid++}`;
const acpiLoop = `acpi_loop_${uid++}`;
const acpiNext = `acpi_next_${uid++}`;
const acpiDone = `acpi_done_${uid++}`;
const acpiNoMask = `acpi_nomask_${uid++}`;
const acpiCap = `acpi_cap_${uid++}`;

a.load64(REG.R12, REG.RSP, L_ACPI2);
a.test(REG.R12, REG.R12);
a.jcc(COND.NZ, acpiHave);
a.load64(REG.R12, REG.RSP, L_ACPI1);
a.test(REG.R12, REG.R12);
a.jcc(COND.Z, acpiSkip);
a.label(acpiHave);

print(str('ACPI RSDP:\r\n'));
print(str('  revision: 0x'));
a.load8(REG.RAX, REG.R12, 15);
hex2(REG.RAX);
print(NL);
print(str('  OEMID: '));
a.mov(REG.RBX, REG.R12);
a.addImm32(REG.RBX, 9);
printBytes(REG.RBX, 6);
print(NL);
print(str('  XSDT: 0x'));
a.load64(REG.RAX, REG.R12, 24);
hex64(REG.RAX);
print(NL);
print(str('  RSDT: 0x'));
a.load64(REG.RAX, REG.R12, 16);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RAX, REG.RCX);
hex64(REG.RAX);
print(NL);

// Pick XSDT for ACPI >= 2.0, otherwise RSDT.
a.load64(REG.RBP, REG.R12, 24);
a.load8(REG.RAX, REG.R12, 15);
a.cmpImm32(REG.RAX, 2);
a.jcc(COND.AE, acpiSd);
a.load64(REG.RBP, REG.R12, 16);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RBP, REG.RCX);
a.movImm32(REG.R12, 4);
a.jmp(`acpi_have_sd_${uid}`);
a.label(acpiSd);
a.movImm32(REG.R12, 8);
a.label(`acpi_have_sd_${uid}`);

a.test(REG.RBP, REG.RBP);
a.jcc(COND.Z, acpiSkip);

print(str('  table directory: '));
printBytes(REG.RBP, 4);
print(NL);

// count = (length - 36) / entrySize
a.load64(REG.RAX, REG.RBP, 4);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RAX, REG.RCX);
a.subImm32(REG.RAX, 36);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.R12);
a.mov(REG.RBX, REG.RAX);
print(str('  ACPI tables: 0x'));
a.mov(REG.RSI, REG.RBX);
hex64(REG.RSI);
print(NL);
a.cmpImm32(REG.RBX, 64);
a.jcc(COND.BE, acpiCap);
a.movImm32(REG.RBX, 64);
a.label(acpiCap);
a.addImm32(REG.RBP, 36);

a.label(acpiLoop);
a.test(REG.RBX, REG.RBX);
a.jcc(COND.Z, acpiDone);
a.load64(REG.RSI, REG.RBP, 0);
a.cmpImm32(REG.R12, 8);
a.jcc(COND.E, acpiNoMask);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RSI, REG.RCX);
a.label(acpiNoMask);
a.test(REG.RSI, REG.RSI);
a.jcc(COND.Z, acpiNext);
print(TWO);
printBytes(REG.RSI, 4);
print(str('  length 0x'));
a.load64(REG.RAX, REG.RSI, 4);
a.movImm64(REG.RCX, 0xffffffff);
a.and(REG.RAX, REG.RCX);
hex64(REG.RAX);
print(NL);
a.label(acpiNext);
a.add(REG.RBP, REG.R12);
a.dec(REG.RBX);
a.jmp(acpiLoop);
a.label(acpiDone);
print(NL);
a.jmp(`acpi_end_${uid}`);

a.label(acpiSkip);
print(str('ACPI: not present\r\n\r\n'));
a.label(`acpi_end_${uid}`);

// ------------------------------------------------------------ protocol presence
print(str('protocols:\r\n'));

function probeProtocol(name, guidName) {
  const fail = `pp_fail_${uid++}`;
  const zero = `pp_zero_${uid++}`;
  const done = `pp_done_${uid++}`;
  print(str(`  ${name}: `));
  a.movImm32(REG.RCX, EFI_BY_PROTOCOL);
  a.leaRip(REG.RDX, `guid_${guidName}`);
  a.xor(REG.R8, REG.R8);
  leaRsp(REG.R9, L_COUNT);
  leaRsp(REG.R10, L_BUF);
  a.load64(REG.RAX, REG.R13, BS_LOCATE_HANDLE_BUFFER);
  uefiCall5();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, fail);
  a.load64(REG.RBX, REG.RSP, L_COUNT);
  a.mov(REG.RSI, REG.RBX);
  hex64(REG.RSI);
  print(NL);
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.Z, zero);
  a.load64(REG.RCX, REG.RSP, L_BUF);
  a.load64(REG.RAX, REG.R13, BS_FREE_POOL);
  uefiCall();
  a.label(zero);
  a.jmp(done);
  a.label(fail);
  print(NO);
  a.label(done);
}

probeProtocol('Simple File System', 'sfs');
probeProtocol('Loaded Image', 'loadedImage');
probeProtocol('Device Path', 'devicePath');
probeProtocol('Simple Network', 'snp');
probeProtocol('ARP', 'arp');
probeProtocol('IPv4', 'ip4');
probeProtocol('IP4 Config2', 'ip4config2');
probeProtocol('TCP4', 'tcp4');
probeProtocol('TCP4 service binding', 'tcp4sb');
probeProtocol('UDP4', 'udp4');
probeProtocol('UDP4 service binding', 'udp4sb');
probeProtocol('DNS4', 'dns4');
probeProtocol('DNS4 service binding', 'dns4sb');
probeProtocol('DHCP4', 'dhcp4');
probeProtocol('DHCP4 service binding', 'dhcp4sb');
probeProtocol('TLS', 'tls');
probeProtocol('TLS service binding', 'tlssb');
probeProtocol('HTTP', 'http');
probeProtocol('HTTP service binding', 'httpsb');
probeProtocol('HTTP utilities', 'httpUtils');
probeProtocol('Hash2', 'hash2');
probeProtocol('Hash2 service binding', 'hash2sb');
probeProtocol('PKCS7 verify', 'pkcs7');
probeProtocol('TCG2', 'tcg2');
probeProtocol('Supplicant', 'supplicant');
probeProtocol('Supplicant service binding', 'supplicantsb');
probeProtocol('EAP', 'eap');
probeProtocol('WiFi MAC connection', 'wifi');
probeProtocol('RNG', 'rng');
probeProtocol('MP Services', 'mp');
probeProtocol('PCI I/O', 'pci');
probeProtocol('Bluetooth HC', 'bthc');
probeProtocol('Bluetooth Config', 'btcfg');
probeProtocol('Serial I/O', 'serial');
probeProtocol('Graphics Output', 'gop');
probeProtocol('ACPI Table', 'acpiTable');
print(NL);

// -------------------------------------------------- service-binding bring-up
// A service-binding protocol is installed on its own handle; the protocol it
// manages only appears on a child handle after CreateChild(). Counting TLS or
// HTTP handles therefore reports 0 even when the firmware driver is loaded.
print(str('service binding bring-up:\r\n'));

function probeChild(name, sbGuid, protoGuid) {
  const fail = `pc_fail_${uid++}`;
  const noProto = `pc_nop_${uid++}`;
  const skipDestroy = `pc_skip_${uid++}`;
  const done = `pc_done_${uid++}`;
  print(str(`  ${name}: `));

  a.leaRip(REG.RCX, `guid_${sbGuid}`);
  a.xor(REG.RDX, REG.RDX);
  leaRsp(REG.R8, L_IFACE);
  a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
  uefiCall();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, fail);

  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RSP, REG.RAX, L_CHILD);
  a.load64(REG.RCX, REG.RSP, L_IFACE);
  leaRsp(REG.RDX, L_CHILD);
  a.load64(REG.RAX, REG.RCX, 0); // CreateChild
  uefiCall();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, fail);

  a.load64(REG.RCX, REG.RSP, L_CHILD);
  a.leaRip(REG.RDX, `guid_${protoGuid}`);
  leaRsp(REG.R8, L_IFACE2);
  a.load64(REG.RAX, REG.R13, BS_HANDLE_PROTOCOL);
  uefiCall();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, noProto);

  print(str('ok'));
  a.jmp(done);
  a.label(noProto);
  print(str('created, protocol missing'));
  a.jmp(done);
  a.label(fail);
  print(str('unavailable'));
  a.label(done);

  a.load64(REG.RDX, REG.RSP, L_CHILD);
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, skipDestroy);
  a.load64(REG.RCX, REG.RSP, L_IFACE);
  a.load64(REG.RAX, REG.RCX, 8); // DestroyChild
  uefiCall();
  a.label(skipDestroy);
  print(NL);
}

probeChild('TLS', 'tlssb', 'tls');
probeChild('HTTP', 'httpsb', 'http');
probeChild('DNS4', 'dns4sb', 'dns4');
print(NL);

// ------------------------------------------------------ IPv4 configuration
// DHCP is asynchronous and may still be running, so report whatever the stack
// has at probe time. Station address sits at offset 104 of
// EFI_IP4_CONFIG2_INTERFACE_INFO (after Name[32], IfType, HwAddressSize,
// HwAddress); SubnetMask follows it.
function printIpv4At(slot, off) {
  for (let i = 0; i < 4; i++) {
    if (i) print(DOT);
    a.load8(REG.RSI, REG.RSP, slot + off + i);
    hex2(REG.RSI);
  }
}

print(str('IPv4 interface:\r\n'));
const ip4Skip = `ip4_skip_${uid++}`;
const ip4NoGw = `ip4_nogw_${uid++}`;
const ip4Done = `ip4_done_${uid++}`;
const ip4NoStat = `ip4_nostat_${uid++}`;
a.leaRip(REG.RCX, 'guid_ip4config2');
a.xor(REG.RDX, REG.RDX);
leaRsp(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
a.store64(REG.RSP, REG.RAX, L_IP4STATUS);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, ip4Skip);
a.movImm64(REG.RAX, 512);
a.store64(REG.RSP, REG.RAX, L_IP4SIZE);
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.xor(REG.RDX, REG.RDX); // Ip4Config2DataTypeInterfaceInfo
leaRsp(REG.R8, L_IP4SIZE);
leaRsp(REG.R9, L_IP4INFO);
a.load64(REG.RAX, REG.RCX, 8); // GetData
uefiCall();
a.store64(REG.RSP, REG.RAX, L_IP4STATUS);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, ip4Skip);
print(str('  name: '));
leaRsp(REG.RDX, L_IP4INFO);
conOut();
print(NL);
print(str('  station: '));
printIpv4At(L_IP4INFO, 104);
print(str('  mask: '));
printIpv4At(L_IP4INFO, 108);
print(NL);

// Gateway: DataType 3, array of EFI_IPv4_ADDRESS.
a.movImm64(REG.RAX, 16);
a.store64(REG.RSP, REG.RAX, L_IP4SIZE);
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, 3);
leaRsp(REG.R8, L_IP4SIZE);
leaRsp(REG.R9, L_IP4GWA);
a.load64(REG.RAX, REG.RCX, 8); // GetData
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, ip4NoGw);
print(str('  gateway: '));
printIpv4At(L_IP4GWA, 0);
print(NL);
a.label(ip4NoGw);
a.jmp(ip4Done);
a.label(ip4Skip);
a.load64(REG.RAX, REG.RSP, L_IP4STATUS);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.Z, ip4NoStat);
print(str('  unavailable, status: 0x'));
a.load64(REG.RSI, REG.RSP, L_IP4STATUS);
hex64(REG.RSI);
print(NL);
a.label(ip4NoStat);
a.label(ip4Done);
print(NL);

// MP Services processor count, if the protocol is present.
const mpFail = `mp_fail_${uid++}`;
const mpDone = `mp_done_${uid++}`;
print(str('processors: '));
a.leaRip(REG.RCX, `guid_mp`);
a.xor(REG.RDX, REG.RDX);
leaRsp(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, mpFail);
a.load64(REG.RCX, REG.RSP, L_IFACE);
leaRsp(REG.RDX, L_MP_NUM);
leaRsp(REG.R8, L_MP_EN);
a.load64(REG.RAX, REG.RCX, 0); // GetNumberOfProcessors
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, mpFail);
a.load64(REG.RSI, REG.RSP, L_MP_NUM);
hex64(REG.RSI);
print(str(' total, 0x'));
a.load64(REG.RSI, REG.RSP, L_MP_EN);
hex64(REG.RSI);
print(str(' enabled\r\n'));
a.jmp(mpDone);
a.label(mpFail);
print(NO);
a.label(mpDone);
print(NL);

// -------------------------------------------------------------- CPU identity
print(str('CPUID:\r\n'));
a.xor(REG.RCX, REG.RCX);
a.movImm32(REG.RAX, 0);
a.cpuid();
a.store32(REG.RSP, REG.RBX, L_VENDOR + 0);
a.store32(REG.RSP, REG.RDX, L_VENDOR + 4);
a.store32(REG.RSP, REG.RCX, L_VENDOR + 8);
a.xor(REG.RAX, REG.RAX);
a.store32(REG.RSP, REG.RAX, L_VENDOR + 12);
print(str('  vendor: '));
// CPUID gives ASCII; printBytes widens each byte to UTF-16 for ConOut.
leaRsp(REG.RBX, L_VENDOR);
printBytes(REG.RBX, 12);
print(NL);

function cpuidRecord(leaf, subleaf, slots) {
  a.movImm32(REG.RAX, leaf);
  a.movImm32(REG.RCX, subleaf);
  a.cpuid();
  for (const [reg, slot] of slots) a.store32(REG.RSP, reg, slot);
}
function dumpCpuid(label, count) {
  print(label);
  for (let i = 0; i < count; i++) {
    if (i) print(str(' '));
    a.load64(REG.RAX, REG.RSP, L_CPUID + i * 4);
    a.movImm64(REG.RCX, 0xffffffff);
    a.and(REG.RAX, REG.RCX);
    hex64(REG.RAX);
  }
  print(NL);
}

cpuidRecord(1, 0, [[REG.RAX, L_CPUID + 0], [REG.RBX, L_CPUID + 4],
  [REG.RCX, L_CPUID + 8], [REG.RDX, L_CPUID + 12]]);
dumpCpuid(str('  1: '), 4);

cpuidRecord(7, 0, [[REG.RBX, L_CPUID + 0], [REG.RCX, L_CPUID + 4],
  [REG.RDX, L_CPUID + 8]]);
dumpCpuid(str('  7.0: '), 3);

cpuidRecord(0xd, 0, [[REG.RAX, L_CPUID + 0], [REG.RDX, L_CPUID + 4]]);
dumpCpuid(str('  d.0: '), 2);

print(str('  CR4: 0x'));
a.emit(0x0f, 0x20, 0xe0); // mov rax, cr4
a.store64(REG.RSP, REG.RAX, L_CPUID + 8);
hex64(REG.RAX);
print(NL);

const xcr0Skip = `xcr0_skip_${uid++}`;
a.load64(REG.RAX, REG.RSP, L_CPUID + 8);
a.btImm(REG.RAX, 18); // CR4.OSXSAVE
a.jcc(COND.NC, xcr0Skip);
print(str('  XCR0: 0x'));
a.xor(REG.RCX, REG.RCX);
a.emit(0x0f, 0x01, 0xd0); // xgetbv
a.store32(REG.RSP, REG.RAX, L_CPUID + 0);
a.store32(REG.RSP, REG.RDX, L_CPUID + 4);
dumpCpuid(str(''), 2);
a.label(xcr0Skip);
print(NL);

// ------------------------------------------------------- AVX-512 bring-up test
// Firmware may leave CR4.OSXSAVE clear even though the CPU supports AVX-512
// (OVMF under WHPX does). A boot-services app runs at CPL0, so it can enable
// the state itself and execute a real EVEX instruction.
print(str('AVX-512 bring-up:\r\n'));
const avxNoCpu = `avx_nocpu_${uid++}`;
const avxNo512 = `avx_no512_${uid++}`;
const avxNoOsxsave = `avx_noosxsave_${uid++}`;
const avxAlready = `avx_already_${uid++}`;
const avxFail = `avx_fail_${uid++}`;
const avxPass = `avx_pass_${uid++}`;
const avxDone = `avx_done_${uid++}`;

a.movImm32(REG.RAX, 1);
a.xor(REG.RCX, REG.RCX);
a.cpuid();
a.btImm(REG.RCX, 28); // AVX
a.jcc(COND.NC, avxNoCpu);
a.btImm(REG.RCX, 26); // XSAVE
a.jcc(COND.NC, avxNoCpu);

a.movImm32(REG.RAX, 7);
a.xor(REG.RCX, REG.RCX);
a.cpuid();
a.btImm(REG.RBX, 16); // AVX512F
a.jcc(COND.NC, avxNo512);

a.movImm32(REG.RAX, 0xd);
a.xor(REG.RCX, REG.RCX);
a.cpuid();
a.store64(REG.RSP, REG.RAX, L_XCR0_MASK);
a.movImm64(REG.RCX, 0xe7); // x87|SSE|AVX|opmask|ZMM_Hi256|Hi16_ZMM
a.mov(REG.RDX, REG.RAX);
a.and(REG.RDX, REG.RCX);
a.cmp(REG.RDX, REG.RCX);
a.jcc(COND.NE, avxNo512);

// If OSXSAVE is already on, keep the existing CR4.
a.emit(0x0f, 0x20, 0xe0); // mov rax, cr4
a.store64(REG.RSP, REG.RAX, L_CR4_OLD);
a.mov(REG.RBX, REG.RAX);
a.movImm64(REG.RCX, 0x40000); // CR4.OSXSAVE
a.test(REG.RBX, REG.RCX);
a.jcc(COND.NZ, avxAlready);
a.or(REG.RBX, REG.RCX);
a.mov(REG.RAX, REG.RBX);
a.emit(0x0f, 0x22, 0xe0); // mov cr4, rax
a.label(avxAlready);

a.emit(0x0f, 0x20, 0xe0); // mov rax, cr4
a.store64(REG.RSP, REG.RAX, L_CPUID + 8);
print(str('  CR4 now: 0x'));
a.load64(REG.RSI, REG.RSP, L_CPUID + 8);
hex64(REG.RSI);
print(NL);

a.xor(REG.RCX, REG.RCX);
a.movImm64(REG.RAX, 0xe7);
a.xor(REG.RDX, REG.RDX);
a.emit(0x0f, 0x01, 0xd1); // xsetbv
a.xor(REG.RCX, REG.RCX);
a.emit(0x0f, 0x01, 0xd0); // xgetbv
a.mov(REG.RBX, REG.RAX);
print(str('  XCR0 now: 0x'));
a.mov(REG.RSI, REG.RBX);
hex64(REG.RSI);
print(NL);

// Build 64 bytes of 32-bit lanes 1..16, double them with vpaddd, read back.
for (let i = 0; i < 8; i++) {
  const lo = i * 2 + 1;
  const hi = lo + 1;
  a.movImm64(REG.RAX, (BigInt(hi) << 32n) | BigInt(lo));
  a.store64(REG.RSP, REG.RAX, L_AVX_IN + i * 8);
}
leaRsp(REG.RDX, L_AVX_IN);
leaRsp(REG.RCX, L_AVX_OUT);
a.emit(0x62, 0xf1, 0xfe, 0x48, 0x6f, 0x0a); // vmovdqu64 zmm1, [rdx]
a.emit(0x62, 0xf1, 0x75, 0x48, 0xfe, 0xd1); // vpaddd zmm2, zmm1, zmm1
a.emit(0x62, 0xf1, 0xfe, 0x48, 0x7f, 0x11); // vmovdqu64 [rcx], zmm2
a.emit(0xc5, 0xf8, 0x77); // vzeroupper
a.load64(REG.RAX, REG.RSP, L_AVX_OUT);
a.movImm64(REG.RCX, 0x0000000400000002n);
a.cmp(REG.RAX, REG.RCX);
a.jcc(COND.NE, avxFail);
print(str('  EVEX vpaddd test: pass\r\n'));

// Same computation with VEX/AVX2 (256-bit) for a lower baseline target.
leaRsp(REG.RDX, L_AVX_IN);
leaRsp(REG.RCX, L_AVX_OUT);
a.emit(0xc5, 0xfe, 0x6f, 0x0a); // vmovdqu ymm1, [rdx]
a.emit(0xc5, 0xf5, 0xfe, 0xd1); // vpaddd ymm2, ymm1, ymm1
a.emit(0xc5, 0xfe, 0x7f, 0x11); // vmovdqu [rcx], ymm2
a.emit(0xc5, 0xf8, 0x77); // vzeroupper
a.load64(REG.RAX, REG.RSP, L_AVX_OUT);
a.movImm64(REG.RCX, 0x0000000400000002n);
a.cmp(REG.RAX, REG.RCX);
a.jcc(COND.NE, avxFail);
print(str('  VEX vpaddd test: pass\r\n'));
a.jmp(avxDone);

a.label(avxNoCpu);
print(str('  CPU flags: no XSAVE/AVX\r\n'));
a.jmp(avxDone);
a.label(avxNo512);
print(str('  AVX-512: not exposed by CPUID/XCR0 mask\r\n'));
a.jmp(avxDone);
a.label(avxNoOsxsave);
print(str('  OSXSAVE could not be enabled\r\n'));
a.jmp(avxDone);
a.label(avxFail);
print(str('  EVEX vpaddd test: FAIL\r\n'));
a.label(avxDone);
print(NL);

// --------------------------------------------------------------------- done
print(str('probe complete; shutting down\r\n'));
a.load64(REG.RAX, REG.R15, SYS_RUNTIME);
a.load64(REG.RAX, REG.RAX, RT_RESET_SYSTEM);
a.movImm32(REG.RCX, EFI_RESET_SHUTDOWN);
a.xor(REG.RDX, REG.RDX);
a.xor(REG.R8, REG.R8);
a.xor(REG.R9, REG.R9);
uefiCall();
const spin = `spin_${uid++}`;
print(str('ResetSystem returned; halting\r\n'));
a.label(spin);
a.jmp(spin);

// The EFI call trampoline. The firmware is Microsoft x64 ABI: 32 bytes of
// shadow space, 16-byte alignment, volatile R10/R11. Save the caller's RSP in
// our own frame, above the shadow space, never in a volatile register.
a.label('uefi_call');
a.push(REG.R11);
a.mov(REG.R11, REG.RSP);
a.andImm32(REG.RSP, 0xfffffff0);
a.subImm32(REG.RSP, 0x40);
a.store64(REG.RSP, REG.R11, 40);
a.callReg(REG.RAX);
a.load64(REG.R11, REG.RSP, 40);
a.mov(REG.RSP, REG.R11);
a.pop(REG.R11);
a.ret();

a.label('uefi_call5');
a.push(REG.R11);
a.mov(REG.R11, REG.RSP);
a.andImm32(REG.RSP, 0xfffffff0);
a.subImm32(REG.RSP, 0x40);
a.store64(REG.RSP, REG.R11, 40);
a.store64(REG.RSP, REG.R10, 32);
a.callReg(REG.RAX);
a.load64(REG.R11, REG.RSP, 40);
a.mov(REG.RSP, REG.R11);
a.pop(REG.R11);
a.ret();

// -------------------------------------------------------------------- rodata
for (const { name, bytes } of data) {
  a.label(name);
  a.emitBytes(bytes);
}
a.label(HEX_DIGITS);
a.emitBytes(Buffer.from('0123456789abcdef', 'ascii'));

const text = a.resolve();
const image = buildUefiImage({ text, entryOffset: 0 });
fs.writeFileSync(outPath, image, { mode: 0o755 });
console.log(`[probe] ${outPath} (${image.length} bytes, text ${text.length})`);
