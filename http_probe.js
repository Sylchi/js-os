#!/usr/bin/env node
/**
 * UEFI firmware-HTTP probe.
 *
 * Proves the whole "no software TLS stack" ladder end to end:
 *
 *   IP4Config2 (policy = DHCP) -> DHCP4 lease
 *     -> EFI_HTTP_SERVICE_BINDING_PROTOCOL CreateChild
 *     -> EFI_HTTP_PROTOCOL Configure / Request / Response
 *     -> body printed through ConOut
 *
 * The firmware does DHCP, DNS, TCP and (for https URLs) TLS. This file only
 * marshals protocol structs, which is the same amount of work the runtime's
 * fetch binding will do.
 *
 * Usage:
 *   node http_probe.js out.efi
 *   KZERO_HTTP_URL=https://example.com/ node http_probe.js out.efi
 */

import fs from 'node:fs';
import path from 'node:path';
import { Assembler, REG, COND } from './asm.js';
import { buildUefiImage, TEXT_BASE } from './uefi.js';

const outPath = path.resolve(process.argv[2] ?? 'http_probe.efi');
const url = process.env.KZERO_HTTP_URL ?? 'http://example.com/';
const a = new Assembler(TEXT_BASE);

// ---------------------------------------------------------------- EFI layout
const SYS_CON_OUT = 64;
const SYS_RUNTIME = 88;
const SYS_BOOT = 96;

const BS_ALLOCATE_POOL = 64;
const BS_FREE_POOL = 72;
const BS_CREATE_EVENT = 80;
const BS_SET_TIMER = 88;
const BS_WAIT_FOR_EVENT = 96;
const BS_CHECK_EVENT = 120;
const BS_HANDLE_PROTOCOL = 152;
const BS_LOCATE_PROTOCOL = 320;
const RT_RESET_SYSTEM = 104;

const EFI_LOADER_DATA = 2;
const EFI_RESET_SHUTDOWN = 2;

const EFI_SUCCESS = 0;
const EFI_ERR = 0x8000000000000000n;

// EFI_HTTP_PROTOCOL method offsets.
const HTTP_CONFIGURE = 8;
const HTTP_REQUEST = 16;
const HTTP_RESPONSE = 32;

// EFI_IP4_CONFIG2_PROTOCOL method offsets.
const IP4CFG_SET_DATA = 0;
const IP4CFG_GET_DATA = 8;

const IP4CFG_TYPE_INTERFACE_INFO = 0;
const IP4CFG_TYPE_POLICY = 1;
const IP4CFG_TYPE_MANUAL_ADDRESS = 2;
const IP4CFG_TYPE_GATEWAY = 3;
const IP4CFG_TYPE_DNS = 4;
const IP4CFG_POLICY_STATIC = 0;
const IP4CFG_POLICY_DHCP = 1;

const EVT_TIMER = 0x80000000;
const TPL_CALLBACK = 8;
const TIMER_PERIODIC = 2;
const TIMER_100NS_PER_10MS = 100000;

const BODY_CAP = 64 * 1024;

// Entry stack frame slots.
const L_IFACE = 0x00;
const L_CHILD = 0x08;
const L_HTTP = 0x10;
const L_EVENT = 0x18;
const L_TOKEN = 0x20; // EFI_HTTP_TOKEN: Event, Status, Message
const L_REQ = 0x40; // EFI_HTTP_REQUEST_DATA: Method, Url
const L_RESP = 0x50; // EFI_HTTP_RESPONSE_DATA: StatusCode
const L_MSG = 0x60; // EFI_HTTP_MESSAGE
const L_CFG = 0x90; // EFI_HTTP_CONFIG_DATA
const L_AP = 0xb0; // EFI_HTTPv4_ACCESS_POINT
const L_HDR = 0xc0; // EFI_HTTP_HEADER[2]
const L_BODYBUF = 0xe0;
const L_TOTAL = 0xe8;
const L_COUNT = 0xf0;
const L_IP4SIZE = 0xf8;
const L_POLICY = 0x100;
const L_IDX = 0x108;
const L_TIMER = 0x110;
const L_IP4INFO = 0x120; // EFI_IP4_CONFIG2_INTERFACE_INFO (512 bytes)
const L_U16 = 0x350; // widening buffer for ConOut
const FRAME = 0x800;

// ------------------------------------------------------------- deferred data
const data = [];
let strId = 0;
let uid = 0;

// Cross-section labels get fixed names so a later `uid++` cannot move them.
const LBL_IP4_FAIL = `ip4_fail_${uid++}`;
const LBL_IP4_READY = `ip4_ready_${uid++}`;
const LBL_HTTP_FAIL = `http_fail_${uid++}`;
const LBL_HTTP_DONE = `http_done_${uid++}`;
const LBL_REQ_FAIL = `req_fail_${uid++}`;
const LBL_RESP_DONE = `resp_done_${uid++}`;
const LBL_SPIN = `spin_${uid++}`;
const LBL_NO_BUFFER = `nobuf_${uid++}`;

function dataLabel(name, bytes) {
  data.push({ name, bytes });
  return name;
}
function str(text) {
  return dataLabel(`str_${strId++}`,
    Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.alloc(2)]));
}
function ascii(name, text) {
  return dataLabel(name, Buffer.concat([Buffer.from(text, 'ascii'), Buffer.alloc(1)]));
}
function defGuid(name, hex) {
  return dataLabel(`guid_${name}`, Buffer.from(hex, 'hex'));
}

const NL = str('\r\n');
const DOT = str('.');
const HEX_DIGITS = 'hex_digits';

// ---------------------------------------------------------- request payload
const hostMatch = /^[a-z]+:\/\/([^/]+)/i.exec(url);
const hostHeader = hostMatch ? hostMatch[1] : 'example.com';

defGuid('httpsb', 'afe6c8bdbcd97943a72ae0c4e75dae1c');
defGuid('http', '9bb2597a0b9171418242a85a0df25b5b');
defGuid('ip4config2', 'd16e445b0be3aa4f871a3654eca36080');
defGuid('snp', 'b93298a125acd3119a2d0090273fc14d');
// QEMU slirp defaults: guest 10.0.2.15/24, gateway 10.0.2.2, DNS 10.0.2.3.
dataLabel('static_addr', Buffer.from([10, 0, 2, 15, 255, 255, 255, 0]));
dataLabel('static_gw', Buffer.from([10, 0, 2, 2]));
dataLabel('static_dns', Buffer.from([10, 0, 2, 3]));
dataLabel('url_u16', Buffer.concat([Buffer.from(url, 'utf16le'), Buffer.alloc(2)]));
ascii('host_name', 'Host');
ascii('host_value', hostHeader);
ascii('conn_name', 'Connection');
ascii('conn_value', 'close');

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
function printReg(reg) {
  a.mov(REG.RDX, reg);
  conOut();
}

function hexN(reg, digits) {
  const loop = `hx_${uid++}`;
  a.mov(REG.RAX, reg);
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
function hex64(reg) {
  hexN(reg, 16);
}
function hex2(reg) {
  hexN(reg, 2);
}

function printIpv4At(slot, off) {
  for (let i = 0; i < 4; i++) {
    if (i) print(DOT);
    a.load8(REG.RSI, REG.RSP, slot + off + i);
    hex2(REG.RSI);
  }
}

// Print R12 bytes of ASCII at R12 through ConOut in 100-byte chunks.
function printAsciiChunks() {
  const loop = `pa_loop_${uid++}`;
  const chunk = `pa_chunk_${uid++}`;
  const copy = `pa_copy_${uid++}`;
  const emit = `pa_emit_${uid++}`;
  const done = `pa_done_${uid++}`;
  a.label(loop);
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.Z, done);
  a.mov(REG.RBP, REG.RBX);
  a.cmpImm32(REG.RBP, 100);
  a.jcc(COND.LE, chunk);
  a.movImm32(REG.RBP, 100);
  a.label(chunk);
  leaRsp(REG.RDI, L_U16);
  a.mov(REG.R10, REG.RBP);
  a.label(copy);
  a.load8(REG.RAX, REG.R12, 0);
  a.store16(REG.RDI, REG.RAX, 0);
  a.inc(REG.R12);
  a.addImm32(REG.RDI, 2);
  a.dec(REG.R10);
  a.jcc(COND.NZ, copy);
  a.label(emit);
  a.xor(REG.RAX, REG.RAX);
  a.store16(REG.RDI, REG.RAX, 0);
  leaRsp(REG.RDX, L_U16);
  conOut();
  a.sub(REG.RBX, REG.RBP);
  a.jmp(loop);
  a.label(done);
}

// ---------------------------------------------------------------- entry code
a.label('entry');
a.mov(REG.R15, REG.RDX); // system table
a.subImm32(REG.RSP, FRAME);

// Firmware does not promise a zeroed stack.
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

print(str('reg-runtime firmware HTTP probe\r\n'));
print(str('-------------------------------\r\n'));
print(str('url: '));
a.leaRip(REG.RDX, 'url_u16');
conOut();
print(NL);
print(NL);

// ------------------------------------------------------------- body buffer
a.movImm32(REG.RCX, EFI_LOADER_DATA);
a.movImm64(REG.RDX, BODY_CAP);
leaRsp(REG.R8, L_BODYBUF);
a.load64(REG.RAX, REG.R13, BS_ALLOCATE_POOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_NO_BUFFER);

// ------------------------------------------------------- NIC / IPv4 bring-up
// Report what the firmware NIC driver thinks the link is doing. This is the
// only place the probe peeks below IP4; the runtime will not need it.
print(str('NIC: '));
a.leaRip(REG.RCX, 'guid_snp');
a.xor(REG.RDX, REG.RDX);
leaRsp(REG.R8, L_CHILD);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
const nicSkip = `nic_skip_${uid++}`;
const nicDone = `nic_done_${uid++}`;
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, nicSkip);
a.load64(REG.RCX, REG.RSP, L_CHILD);
a.load64(REG.RCX, REG.RCX, 120); // Snp->Mode
a.load32(REG.RSI, REG.RCX, 0);
print(str('state='));
hex2(REG.RSI);
a.load8(REG.RSI, REG.RCX, 652); // Mode->MediaPresent
print(str(' media='));
hex2(REG.RSI);
print(str(' mac='));
for (let i = 0; i < 6; i++) {
  if (i) print(str(':'));
  a.load8(REG.RSI, REG.RCX, 552 + i); // Mode->CurrentAddress
  hex2(REG.RSI);
}
a.jmp(nicDone);
a.label(nicSkip);
print(str('unavailable'));
a.label(nicDone);
print(NL);
print(NL);

// Poll Ip4Config2 until a station address appears. The periodic timer is the
// wait primitive; the DHCP/IP4 state machines run from their firmware timers,
// which keep firing while WaitForEvent sleeps.
function emitIp4Poll(ticks, okLabel, timeoutLabel) {
  const poll = `ip4_poll_${uid++}`;
  const wait = `ip4_wait_${uid++}`;
  a.movImm64(REG.RAX, ticks);
  a.store64(REG.RSP, REG.RAX, L_COUNT);
  a.label(poll);
  a.movImm64(REG.RAX, 512);
  a.store64(REG.RSP, REG.RAX, L_IP4SIZE);
  a.load64(REG.RCX, REG.RSP, L_IFACE);
  a.movImm32(REG.RDX, IP4CFG_TYPE_INTERFACE_INFO);
  leaRsp(REG.R8, L_IP4SIZE);
  leaRsp(REG.R9, L_IP4INFO);
  a.load64(REG.RAX, REG.RCX, IP4CFG_GET_DATA);
  uefiCall();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, wait);
  a.load32(REG.RAX, REG.RSP, L_IP4INFO + 104);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, okLabel);
  a.label(wait);
  a.load64(REG.RCX, REG.RSP, L_COUNT);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, timeoutLabel);
  a.dec(REG.RCX);
  a.store64(REG.RSP, REG.RCX, L_COUNT);
  a.movImm32(REG.RCX, 1);
  leaRsp(REG.RDX, L_EVENT);
  leaRsp(REG.R8, L_IDX);
  a.load64(REG.RAX, REG.R13, BS_WAIT_FOR_EVENT);
  uefiCall();
  a.load64(REG.RCX, REG.RSP, L_EVENT);
  a.load64(REG.RAX, REG.R13, BS_CHECK_EVENT);
  uefiCall();
  a.jmp(poll);
}

print(str('IPv4: '));
a.leaRip(REG.RCX, 'guid_ip4config2');
a.xor(REG.RDX, REG.RDX);
leaRsp(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_IP4_FAIL);

// One periodic 10 ms timer reused by every poll below.
a.movImm32(REG.RCX, EVT_TIMER);
a.movImm32(REG.RDX, TPL_CALLBACK);
a.xor(REG.R8, REG.R8);
a.xor(REG.R9, REG.R9);
leaRsp(REG.R10, L_EVENT);
a.load64(REG.RAX, REG.R13, BS_CREATE_EVENT);
uefiCall5();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_IP4_FAIL);
a.load64(REG.RCX, REG.RSP, L_EVENT);
a.movImm32(REG.RDX, TIMER_PERIODIC);
a.movImm64(REG.R8, TIMER_100NS_PER_10MS);
a.load64(REG.RAX, REG.R13, BS_SET_TIMER);
uefiCall();

// OVMF leaves the interface at 0.0.0.0 until something asks for a lease.
// Ip4Config2 owns the DHCP4 child; flipping the policy starts it.
a.movImm32(REG.RAX, IP4CFG_POLICY_DHCP);
a.store32(REG.RSP, REG.RAX, L_POLICY);
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, IP4CFG_TYPE_POLICY);
a.movImm32(REG.R8, 4);
leaRsp(REG.R9, L_POLICY);
a.load64(REG.RAX, REG.RCX, IP4CFG_SET_DATA);
uefiCall();

const ip4DhcpOk = `ip4_dhcp_ok_${uid++}`;
const ip4DhcpNo = `ip4_dhcp_no_${uid++}`;
const ip4StaticOk = `ip4_static_ok_${uid++}`;
const ip4Have = `ip4_have_${uid++}`;
emitIp4Poll(150, ip4DhcpOk, ip4DhcpNo);
a.label(ip4DhcpOk);
print(str('dhcp'));
a.jmp(ip4Have);

// DHCP did not produce a lease. Fall back to QEMU's slirp subnet; this also
// proves the rest of the stack independently of the DHCP client.
a.label(ip4DhcpNo);
print(str('no dhcp, static '));
a.movImm32(REG.RAX, IP4CFG_POLICY_STATIC);
a.store32(REG.RSP, REG.RAX, L_POLICY);
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, IP4CFG_TYPE_POLICY);
a.movImm32(REG.R8, 4);
leaRsp(REG.R9, L_POLICY);
a.load64(REG.RAX, REG.RCX, IP4CFG_SET_DATA);
uefiCall();

a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, IP4CFG_TYPE_MANUAL_ADDRESS);
a.movImm32(REG.R8, 8);
a.leaRip(REG.R9, 'static_addr');
a.load64(REG.RAX, REG.RCX, IP4CFG_SET_DATA);
uefiCall();
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, IP4CFG_TYPE_GATEWAY);
a.movImm32(REG.R8, 4);
a.leaRip(REG.R9, 'static_gw');
a.load64(REG.RAX, REG.RCX, IP4CFG_SET_DATA);
uefiCall();
a.load64(REG.RCX, REG.RSP, L_IFACE);
a.movImm32(REG.RDX, IP4CFG_TYPE_DNS);
a.movImm32(REG.R8, 4);
a.leaRip(REG.R9, 'static_dns');
a.load64(REG.RAX, REG.RCX, IP4CFG_SET_DATA);
uefiCall();

emitIp4Poll(100, ip4StaticOk, LBL_IP4_FAIL);
a.label(ip4StaticOk);
print(str('ok'));
a.label(ip4Have);

// Stop the poll timer.
a.load64(REG.RCX, REG.RSP, L_EVENT);
a.load64(REG.RAX, REG.R13, BS_SET_TIMER);
a.xor(REG.RDX, REG.RDX); // TimerCancel
a.xor(REG.R8, REG.R8);
uefiCall();

print(str(' name '));
leaRsp(REG.RDX, L_IP4INFO);
conOut();
print(str(' station '));
printIpv4At(L_IP4INFO, 104);
print(str(' mask '));
printIpv4At(L_IP4INFO, 108);
print(NL);
a.jmp(LBL_IP4_READY);

a.label(LBL_IP4_FAIL);
print(str('unavailable\r\n'));
a.jmp(LBL_HTTP_DONE);

a.label(LBL_IP4_READY);
print(NL);

// ------------------------------------------------------------- HTTP child
const respLoop = `resp_loop_${uid++}`;

print(str('HTTP child: '));
a.leaRip(REG.RCX, 'guid_httpsb');
a.xor(REG.RDX, REG.RDX);
leaRsp(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_HTTP_FAIL);

a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_CHILD);
a.load64(REG.RCX, REG.RSP, L_IFACE);
leaRsp(REG.RDX, L_CHILD);
a.load64(REG.RAX, REG.RCX, 0); // CreateChild
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_HTTP_FAIL);

a.load64(REG.RCX, REG.RSP, L_CHILD);
a.leaRip(REG.RDX, 'guid_http');
leaRsp(REG.R8, L_HTTP);
a.load64(REG.RAX, REG.R13, BS_HANDLE_PROTOCOL);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_HTTP_FAIL);
print(str('ok\r\n'));

// EFI_HTTP_CONFIG_DATA { HttpVersion, TimeOutMillisec, LocalAddressIsIPv6,
//                        AccessPoint }
a.movImm32(REG.RAX, 1); // HttpVersion11
a.store32(REG.RSP, REG.RAX, L_CFG + 0);
a.movImm32(REG.RAX, 5000);
a.store32(REG.RSP, REG.RAX, L_CFG + 4);
a.movImm64(REG.RAX, 1); // UseDefaultAddress
a.store8(REG.RSP, REG.RAX, L_AP + 0);
a.mov(REG.RAX, REG.RSP);
a.addImm32(REG.RAX, L_AP);
a.store64(REG.RSP, REG.RAX, L_CFG + 16);

// EFI_HTTP_HEADER[2] = Host + Connection: close.
a.leaRip(REG.RAX, 'host_name');
a.store64(REG.RSP, REG.RAX, L_HDR + 0);
a.leaRip(REG.RAX, 'host_value');
a.store64(REG.RSP, REG.RAX, L_HDR + 8);
a.leaRip(REG.RAX, 'conn_name');
a.store64(REG.RSP, REG.RAX, L_HDR + 16);
a.leaRip(REG.RAX, 'conn_value');
a.store64(REG.RSP, REG.RAX, L_HDR + 24);

// EFI_HTTP_REQUEST_DATA { Method = GET, Url }
a.movImm32(REG.RAX, 0);
a.store32(REG.RSP, REG.RAX, L_REQ + 0);
a.leaRip(REG.RAX, 'url_u16');
a.store64(REG.RSP, REG.RAX, L_REQ + 8);

a.load64(REG.RCX, REG.RSP, L_HTTP);
leaRsp(REG.RDX, L_CFG);
a.load64(REG.RAX, REG.RCX, HTTP_CONFIGURE);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_HTTP_FAIL);

// Plain event; the HTTP driver requires a non-NULL token event.
a.movImm32(REG.RCX, 0);
a.movImm32(REG.RDX, TPL_CALLBACK);
a.xor(REG.R8, REG.R8);
a.xor(REG.R9, REG.R9);
leaRsp(REG.R10, L_EVENT);
a.load64(REG.RAX, REG.R13, BS_CREATE_EVENT);
uefiCall5();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_HTTP_FAIL);

// EFI_HTTP_TOKEN + EFI_HTTP_MESSAGE for the request.
a.load64(REG.RAX, REG.RSP, L_EVENT);
a.store64(REG.RSP, REG.RAX, L_TOKEN + 0);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_TOKEN + 8);
a.mov(REG.RAX, REG.RSP);
a.addImm32(REG.RAX, L_MSG);
a.store64(REG.RSP, REG.RAX, L_TOKEN + 16);

a.mov(REG.RAX, REG.RSP);
a.addImm32(REG.RAX, L_REQ);
a.store64(REG.RSP, REG.RAX, L_MSG + 0); // Data.Request
a.movImm64(REG.RAX, 2);
a.store64(REG.RSP, REG.RAX, L_MSG + 8); // HeaderCount
a.mov(REG.RAX, REG.RSP);
a.addImm32(REG.RAX, L_HDR);
a.store64(REG.RSP, REG.RAX, L_MSG + 16); // Headers
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_MSG + 24); // BodyLength
a.store64(REG.RSP, REG.RAX, L_MSG + 32); // Body

print(str('request: '));
a.load64(REG.RCX, REG.RSP, L_HTTP);
leaRsp(REG.RDX, L_TOKEN);
a.load64(REG.RAX, REG.RCX, HTTP_REQUEST);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_REQ_FAIL);

a.movImm32(REG.RCX, 1);
leaRsp(REG.RDX, L_EVENT);
leaRsp(REG.R8, L_IDX);
a.load64(REG.RAX, REG.R13, BS_WAIT_FOR_EVENT);
uefiCall();
a.load64(REG.RCX, REG.RSP, L_EVENT);
a.load64(REG.RAX, REG.R13, BS_CHECK_EVENT);
uefiCall();
print(str('sent, token status 0x'));
a.load64(REG.RSI, REG.RSP, L_TOKEN + 8);
hex64(REG.RSI);
print(NL);

// ---------------------------------------------------------- read response
// First Response() call carries a response-data pointer and receives the
// headers plus up to BODY_CAP body bytes.
a.movImm32(REG.RAX, 0);
a.store32(REG.RSP, REG.RAX, L_RESP);
a.mov(REG.RAX, REG.RSP);
a.addImm32(REG.RAX, L_RESP);
a.store64(REG.RSP, REG.RAX, L_MSG + 0); // Data.Response
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_MSG + 8); // HeaderCount
a.store64(REG.RSP, REG.RAX, L_MSG + 16); // Headers
a.movImm64(REG.RAX, BODY_CAP);
a.store64(REG.RSP, REG.RAX, L_MSG + 24);
a.load64(REG.RAX, REG.RSP, L_BODYBUF);
a.store64(REG.RSP, REG.RAX, L_MSG + 32);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_TOKEN + 8);
a.store64(REG.RSP, REG.RAX, L_TOTAL);

a.load64(REG.RCX, REG.RSP, L_HTTP);
leaRsp(REG.RDX, L_TOKEN);
a.load64(REG.RAX, REG.RCX, HTTP_RESPONSE);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_REQ_FAIL);

a.movImm32(REG.RCX, 1);
leaRsp(REG.RDX, L_EVENT);
leaRsp(REG.R8, L_IDX);
a.load64(REG.RAX, REG.R13, BS_WAIT_FOR_EVENT);
uefiCall();
a.load64(REG.RCX, REG.RSP, L_EVENT);
a.load64(REG.RAX, REG.R13, BS_CHECK_EVENT);
uefiCall();

print(str('response: status 0x'));
a.load32(REG.RSI, REG.RSP, L_RESP);
hex64(REG.RSI);
print(str(' token 0x'));
a.load64(REG.RSI, REG.RSP, L_TOKEN + 8);
hex64(REG.RSI);
print(NL);

a.movImm32(REG.RCX, 12);
a.store64(REG.RSP, REG.RCX, L_COUNT);

a.label(respLoop);
a.load64(REG.RBX, REG.RSP, L_MSG + 24);
a.test(REG.RBX, REG.RBX);
a.jcc(COND.Z, LBL_RESP_DONE);
a.load64(REG.RCX, REG.RSP, L_TOTAL);
a.add(REG.RCX, REG.RBX);
a.store64(REG.RSP, REG.RCX, L_TOTAL);
a.load64(REG.R12, REG.RSP, L_BODYBUF);
printAsciiChunks();
print(NL);

// Body-only receive for the remainder.
a.movImm32(REG.RCX, 12);
a.load64(REG.RCX, REG.RSP, L_COUNT);
a.test(REG.RCX, REG.RCX);
a.jcc(COND.Z, LBL_RESP_DONE);
a.dec(REG.RCX);
a.store64(REG.RSP, REG.RCX, L_COUNT);

a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_MSG + 0); // Data.Response = NULL
a.store64(REG.RSP, REG.RAX, L_MSG + 8);
a.store64(REG.RSP, REG.RAX, L_MSG + 16);
a.movImm64(REG.RAX, BODY_CAP);
a.store64(REG.RSP, REG.RAX, L_MSG + 24);
a.load64(REG.RAX, REG.RSP, L_BODYBUF);
a.store64(REG.RSP, REG.RAX, L_MSG + 32);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RSP, REG.RAX, L_TOKEN + 8);

a.load64(REG.RCX, REG.RSP, L_HTTP);
leaRsp(REG.RDX, L_TOKEN);
a.load64(REG.RAX, REG.RCX, HTTP_RESPONSE);
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, LBL_RESP_DONE);

a.movImm32(REG.RCX, 1);
leaRsp(REG.RDX, L_EVENT);
leaRsp(REG.R8, L_IDX);
a.load64(REG.RAX, REG.R13, BS_WAIT_FOR_EVENT);
uefiCall();
a.load64(REG.RCX, REG.RSP, L_EVENT);
a.load64(REG.RAX, REG.R13, BS_CHECK_EVENT);
uefiCall();
a.jmp(respLoop);

a.label(LBL_RESP_DONE);
print(NL);
print(str('total body bytes: 0x'));
a.load64(REG.RSI, REG.RSP, L_TOTAL);
hex64(REG.RSI);
print(NL);
a.jmp(LBL_HTTP_DONE);

a.label(LBL_REQ_FAIL);
print(str('request failed\r\n'));
a.jmp(LBL_HTTP_DONE);

a.label(LBL_HTTP_FAIL);
print(str('unavailable\r\n'));

a.label(LBL_HTTP_DONE);
print(NL);

// --------------------------------------------------------------------- done
print(str('http probe complete; shutting down\r\n'));
a.load64(REG.RAX, REG.R15, SYS_RUNTIME);
a.load64(REG.RAX, REG.RAX, RT_RESET_SYSTEM);
a.movImm32(REG.RCX, EFI_RESET_SHUTDOWN);
a.xor(REG.RDX, REG.RDX);
a.xor(REG.R8, REG.R8);
a.xor(REG.R9, REG.R9);
uefiCall();
print(str('ResetSystem returned; halting\r\n'));
a.label(LBL_SPIN);
a.jmp(LBL_SPIN);

a.label(LBL_NO_BUFFER);
print(str('pool allocation failed\r\n'));
a.jmp(LBL_SPIN);

// --------------------------------------------------------------- trampoline
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
console.log(`[http-probe] ${outPath} (${image.length} bytes, url ${url})`);
