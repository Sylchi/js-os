#!/usr/bin/env node
/**
 * UEFI network inventory probe.
 *
 * LocateProtocol returns only the first Simple Network instance; on OVMF there
 * are several, and the first can be a placeholder with a zero MAC and no
 * media. This tool walks every handle that publishes SNP and prints the mode
 * state, media state, MAC, and the PCI part of the device path, so we can see
 * which handle is the real NIC.
 *
 *   node net_probe.js out.efi
 */

import fs from 'node:fs';
import path from 'node:path';
import { Assembler, REG, COND } from './asm.js';
import { buildUefiImage, TEXT_BASE } from './uefi.js';

const outPath = path.resolve(process.argv[2] ?? 'net_probe.efi');
const a = new Assembler(TEXT_BASE);

const SYS_CON_OUT = 64;
const SYS_RUNTIME = 88;
const SYS_BOOT = 96;

const BS_FREE_POOL = 72;
const BS_HANDLE_PROTOCOL = 152;
const BS_LOCATE_HANDLE_BUFFER = 312;
const RT_RESET_SYSTEM = 104;

const EFI_BY_PROTOCOL = 2;
const EFI_RESET_SHUTDOWN = 2;

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
const SP = str(' ');
const DOT = str('.');
const COLON = str(':');
const HEX_DIGITS = 'hex_digits';

defGuid('snp', 'b93298a125acd3119a2d0090273fc14d');
defGuid('devpath', '09576e916d3f11d28e3900a0c969723b');
defGuid('pciio', '00b2f54cb868a54c9eecb23e3f50029a');

const L_COUNT = 0x00;
const L_BUF = 0x08;
const L_IDX = 0x10;
const L_HANDLE = 0x18;
const L_IFACE = 0x20;
const L_DP = 0x28;
const L_U16 = 0x100;
const FRAME = 0x400;

// ------------------------------------------------------------------ helpers
function leaRsp(dst, off) {
  a.mov(dst, REG.RSP);
  if (off) a.addImm32(dst, off);
}
function uefiCall() {
  a.call('uefi_call');
}
function uefiCall5() {
  a.call('uefi_call5');
}
function conOut() {
  a.mov(REG.RCX, REG.R14);
  a.load64(REG.RAX, REG.R14, 8);
  uefiCall();
}
function print(label) {
  a.leaRip(REG.RDX, label);
  conOut();
}
function hexN(reg, digits) {
  const loop = `hx_${uid++}`;
  a.mov(REG.RAX, reg); // never rotate the caller's argument register in place
  leaRsp(REG.RDI, L_U16);
  a.leaRip(REG.R11, HEX_DIGITS);
  a.movImm32(REG.RCX, digits);
  if (digits < 16) a.rolImm(REG.RAX, (16 - digits) * 4);
  a.label(loop);
  a.rolImm(REG.RAX, 4);
  a.mov(REG.RDX, REG.RAX);
  a.andImm32(REG.RDX, 15);
  a.load8Indexed(REG.RDX, REG.R11, REG.RDX);
  a.store16(REG.RDI, REG.RDX, 0);
  a.addImm32(REG.RDI, 2);
  a.dec(REG.RCX);
  a.jcc(COND.NZ, loop);
  a.xor(REG.RDX, REG.RDX);
  a.store16(REG.RDI, REG.RDX, 0);
  leaRsp(REG.RDX, L_U16);
  conOut();
}
function hex64(reg) { hexN(reg, 16); }
function hex4(reg) { hexN(reg, 4); }
function hex2(reg) { hexN(reg, 2); }

// -------------------------------------------------------------------- entry
a.label('entry');
a.mov(REG.R15, REG.RDX);
a.subImm32(REG.RSP, FRAME);
a.mov(REG.RDI, REG.RSP);
a.movImm32(REG.RCX, FRAME / 8);
a.xor(REG.RAX, REG.RAX);
const zero = `zero_${uid++}`;
a.label(zero);
a.store64(REG.RDI, REG.RAX, 0);
a.addImm32(REG.RDI, 8);
a.dec(REG.RCX);
a.jcc(COND.NZ, zero);

a.load64(REG.R13, REG.R15, SYS_BOOT);
a.load64(REG.R14, REG.R15, SYS_CON_OUT);

print(str('reg-runtime network inventory\r\n'));
print(str('----------------------------\r\n'));

a.movImm32(REG.RCX, EFI_BY_PROTOCOL);
a.leaRip(REG.RDX, 'guid_snp');
a.xor(REG.R8, REG.R8);
leaRsp(REG.R9, L_COUNT);
leaRsp(REG.R10, L_BUF);
a.load64(REG.RAX, REG.R13, BS_LOCATE_HANDLE_BUFFER);
uefiCall5();
const fail = `fail_${uid++}`;
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, fail);

print(str('handles: 0x'));
hex64(REG.RAX);
print(NL);

const loop = `loop_${uid++}`;
const next = `next_${uid++}`;
const done = `done_${uid++}`;
const noSnp = `nosnp_${uid++}`;
const dpDoneAll = `dp_done_${uid++}`;
const shutdown = `shutdown_${uid++}`;

// Re-load the count: hex64 clobbers caller-saved registers.
a.load64(REG.RBX, REG.RSP, L_COUNT);
print(str('count=0x'));
a.mov(REG.RSI, REG.RBX);
hex64(REG.RSI);
print(NL);

a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_IDX);

a.label(loop);
a.load64(REG.RBX, REG.RSP, L_IDX);
a.load64(REG.RBX, REG.RSP, L_COUNT);
a.load64(REG.RCX, REG.RSP, L_IDX);
a.cmp(REG.RCX, REG.RBX);
a.jcc(COND.AE, done);
a.load64(REG.RBX, REG.RSP, L_IDX);
a.load64(REG.RCX, REG.RSP, L_BUF);
a.load64Indexed(REG.RCX, REG.RCX, REG.RBX);
a.store64(REG.RSP, REG.RCX, L_HANDLE);

print(str('#'));
a.load64(REG.RSI, REG.RSP, L_IDX);
hex64(REG.RSI);
print(str(' h=0x'));
a.load64(REG.RSI, REG.RSP, L_HANDLE);
hex64(REG.RSI);
print(SP);

a.load64(REG.RCX, REG.RSP, L_HANDLE);
a.leaRip(REG.RDX, 'guid_snp');
leaRsp(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_HANDLE_PROTOCOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, noSnp);

a.load64(REG.RCX, REG.RSP, L_IFACE);
a.load64(REG.RSI, REG.RCX, 0);
print(str('rev='));
hex64(REG.RSI);
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.load64(REG.R12, REG.RCX, 120); // Snp->Mode; R12 survives ConOut calls
a.test(REG.R12, REG.R12);
a.jcc(COND.Z, noSnp);
a.load32(REG.RSI, REG.R12, 4);
print(str(' hw='));
hex64(REG.RSI);
a.load32(REG.RSI, REG.R12, 0);
print(str(' state='));
hex2(REG.RSI);
a.load8(REG.RSI, REG.R12, 652);
print(str(' media='));
hex2(REG.RSI);
print(str(' mac='));
for (let i = 0; i < 6; i++) {
  if (i) print(COLON);
  a.load8(REG.RSI, REG.R12, 552 + i);
  hex2(REG.RSI);
}
a.jmp(next);

a.label(noSnp);
print(str('no SNP interface'));
a.jmp(next);

// Device path of this handle: dump PCI nodes as hex type:subtype:len.
a.label(next);
print(str(' dp='));
a.load64(REG.RCX, REG.RSP, L_HANDLE);
a.leaRip(REG.RDX, 'guid_devpath');
leaRsp(REG.R8, L_DP);
a.load64(REG.RAX, REG.R13, BS_HANDLE_PROTOCOL);
uefiCall();
const noDp = `nodp_${uid++}`;
const dpLoop = `dploop_${uid++}`;
const dpDone = `dpdone_${uid++}`;
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, noDp);
a.load64(REG.R12, REG.RSP, L_DP);
a.label(dpLoop);
a.load8(REG.RAX, REG.R12, 0); // Type
a.test(REG.RAX, REG.RAX);
a.jcc(COND.Z, dpDone);
a.load8(REG.RSI, REG.R12, 0);
hex2(REG.RSI);
print(COLON);
a.load8(REG.RSI, REG.R12, 1);
hex2(REG.RSI);
print(COLON);
a.load16(REG.RSI, REG.R12, 2); // Length
a.mov(REG.RBP, REG.RSI);
hex64(REG.RSI);
print(SP);
a.add(REG.R12, REG.RBP);
a.jmp(dpLoop);
a.label(dpDone);
a.jmp(dpDoneAll);

a.label(noDp);
print(str('none'));
a.label(dpDoneAll);
print(NL);

a.load64(REG.RCX, REG.RSP, L_IDX);
a.addImm32(REG.RCX, 1);
a.store64(REG.RSP, REG.RCX, L_IDX);
a.jmp(loop);

a.label(done);
a.load64(REG.RCX, REG.RSP, L_BUF);
a.load64(REG.RAX, REG.R13, BS_FREE_POOL);
uefiCall();

// ------------------------------------------------------------- PCI devices
print(str('\r\nPCI devices:\r\n'));
a.movImm32(REG.RCX, EFI_BY_PROTOCOL);
a.leaRip(REG.RDX, 'guid_pciio');
a.xor(REG.R8, REG.R8);
leaRsp(REG.R9, L_COUNT);
leaRsp(REG.R10, L_BUF);
a.load64(REG.RAX, REG.R13, BS_LOCATE_HANDLE_BUFFER);
uefiCall5();
const pciFail = `pcifail_${uid++}`;
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, pciFail);

a.load64(REG.RBX, REG.RSP, L_COUNT);
print(str('count=0x'));
a.mov(REG.RSI, REG.RBX);
hex64(REG.RSI);
print(NL);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_IDX);

const pciLoop = `pciloop_${uid++}`;
const pciNo = `pcino_${uid++}`;
const pciDone = `pcidone_${uid++}`;

a.label(pciLoop);
a.load64(REG.RBX, REG.RSP, L_IDX);
a.load64(REG.RCX, REG.RSP, L_COUNT);
a.cmp(REG.RBX, REG.RCX);
a.jcc(COND.AE, pciDone);
a.load64(REG.RCX, REG.RSP, L_BUF);
a.load64Indexed(REG.RCX, REG.RCX, REG.RBX);
a.store64(REG.RSP, REG.RCX, L_HANDLE);

print(str('#'));
a.load64(REG.RSI, REG.RSP, L_IDX);
hex64(REG.RSI);
print(SP);

a.load64(REG.RCX, REG.RSP, L_HANDLE);
a.leaRip(REG.RDX, 'guid_pciio');
leaRsp(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_HANDLE_PROTOCOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, pciNo);

// vendor (low 16) : device (high 16), config offset 0
a.movImm64(REG.RAX, 0x1111222233334444n);
a.store64(REG.RSP, REG.RAX, L_DP);
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, 2); // EfiPciIoWidthUint32
a.xor(REG.R8, REG.R8);
a.movImm32(REG.R9, 1);
leaRsp(REG.R10, L_DP);
a.load64(REG.RAX, REG.RCX, 32); // PciIo->Pci.Read
uefiCall5();
print(str(' st=0x'));
a.mov(REG.RSI, REG.RAX);
hex64(REG.RSI);
a.load32(REG.RSI, REG.RSP, L_DP);
a.mov(REG.RDI, REG.RSI);
a.andImm32(REG.RSI, 0xffff);
hex4(REG.RSI);
print(COLON);
a.shrImm8(REG.RDI, 16);
a.andImm32(REG.RDI, 0xffff);
hex4(REG.RDI);

// class : subclass : prog-if, config offset 8
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, 2);
a.movImm32(REG.R8, 8);
a.movImm32(REG.R9, 1);
leaRsp(REG.R10, L_DP);
a.load64(REG.RAX, REG.RCX, 32);
uefiCall5();
a.load32(REG.RSI, REG.RSP, L_DP);
print(str(' class='));
a.mov(REG.RDI, REG.RSI);
a.shrImm8(REG.RDI, 24);
hex2(REG.RDI);
print(COLON);
a.mov(REG.RDI, REG.RSI);
a.shrImm8(REG.RDI, 16);
a.andImm32(REG.RDI, 0xff);
hex2(REG.RDI);
print(COLON);
a.mov(REG.RDI, REG.RSI);
a.shrImm8(REG.RDI, 8);
a.andImm32(REG.RDI, 0xff);
hex2(REG.RDI);
print(NL);
a.jmp(pciDone);

a.label(pciNo);
print(str('no PciIo'));
print(NL);
a.jmp(pciDone);

a.label(pciDone);
a.load64(REG.RCX, REG.RSP, L_BUF);
a.load64(REG.RAX, REG.R13, BS_FREE_POOL);
uefiCall();
a.jmp(shutdown);

a.label(pciFail);
print(str('LocateHandleBuffer(PciIo) failed\r\n'));
a.jmp(shutdown);

a.label(fail);
print(str('LocateHandleBuffer(SNP) failed\r\n'));

a.label(shutdown);
print(str('done; shutting down\r\n'));
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

// ---------------------------------------------------------------- trampoline
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

for (const { name, bytes } of data) {
  a.label(name);
  a.emitBytes(bytes);
}
a.label(HEX_DIGITS);
a.emitBytes(Buffer.from('0123456789abcdef', 'ascii'));

const text = a.resolve();
const image = buildUefiImage({ text, entryOffset: 0 });
fs.writeFileSync(outPath, image, { mode: 0o755 });
console.log(`[net-probe] ${outPath} (${image.length} bytes)`);
