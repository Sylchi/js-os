#!/usr/bin/env node
/**
 * UEFI display + input probe.
 *
 * This is the first slice of the platform surface, named after the Web APIs it
 * will expose to JavaScript:
 *
 *   canvas / window      -> EFI_GRAPHICS_OUTPUT_PROTOCOL (linear framebuffer)
 *   keyboard events      -> EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL
 *   pointer events       -> EFI_SIMPLE_POINTER_PROTOCOL / ABSOLUTE_POINTER
 *   navigator.wifi       -> EFI_WIRELESS_MAC_CONNECTION + Supplicant
 *   navigator.bluetooth  -> EFI_BLUETOOTH_HC / EFI_BLUETOOTH_CONFIG
 *   File / Blob          -> EFI_SIMPLE_FILE_SYSTEM_PROTOCOL
 *
 * There is no console text on screen: everything below is painted into the
 * framebuffer exactly the way `canvas.getContext('2d')` will paint it. The
 * result is dumped to \shot.tga on the boot volume so it can be inspected
 * without a display attached.
 *
 *   node ui_probe.js out.efi
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Assembler, REG, COND } from './asm.js';
import { buildUefiImage, TEXT_BASE } from './uefi.js';
import { TABLES, ATLAS_WIDTH, ATLAS_HEIGHT, ICONS } from './assets/fontdata.js';

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');

const outPath = path.resolve(process.argv[2] ?? 'ui_probe.efi');
const a = new Assembler(TEXT_BASE);

// ------------------------------------------------------------ Boot Services
const SYS_CON_OUT = 64;
const SYS_RUNTIME = 88;
const SYS_BOOT = 96;
const SYS_CON_IN = 48;

const BS_ALLOCATE_POOL = 64;
const BS_FREE_POOL = 72;
const BS_HANDLE_PROTOCOL = 152;
const BS_CREATE_EVENT = 80;
const BS_SET_TIMER = 88;
const BS_WAIT_FOR_EVENT = 96;
const BS_STALL = 248;
const BS_LOCATE_HANDLE_BUFFER = 312;
const BS_LOCATE_PROTOCOL = 320;
const RT_RESET_SYSTEM = 104;

const EFI_BY_PROTOCOL = 2;
const EFI_RESET_SHUTDOWN = 2;
const EFI_NOT_FOUND = 14;
const EFI_LOADER_DATA = 2;

// --------------------------------------------------------- protocol layout
const GOP_MODE = 24;                       // EFI_GRAPHICS_OUTPUT_PROTOCOL.Mode
const MODE_INFO = 8;                       // Mode->Info
const MODE_FB = 24;                        // Mode->FrameBufferBase
const INFO_HRES = 4;
const INFO_VRES = 8;
const INFO_FMT = 12;
const INFO_PPSL = 32;

const SFSP_OPEN_VOLUME = 8;
const FILE_OPEN = 8;
const FILE_CLOSE = 16;
const FILE_WRITE = 40;

// -------------------------------------------------------------- data
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
const COLON = str(':');
const HEX_DIGITS = 'hex_digits';

// memory-byte order GUIDs
defGuid('gop', 'dea94290dc23384a96fb7aded080516a');
defGuid('sfsp', '225b4e965964d2118e3900a0c969723b');
defGuid('li', 'a1311b5b6295d2118e3f00a0c969723b');
defGuid('pointer', '878c8731750bd5119a4f0090273fc14d');
defGuid('absptr', '2bd3598d55c6e94a9b15f25904992a43');
defGuid('kbd', '34759edd627798468c14f58517a625aa');
defGuid('wifi', 'c95ba50df845b44b87195224f18a4d45');
defGuid('supp', '8ed9bc45ad5974419546344a07485898');
defGuid('bthc', '710593b3babec54f92039427242e6a43');
defGuid('btcfg', 'f30c9662ff406342a77cdfdebd191b4b');

const FNAME = dataLabel('fname',
  Buffer.concat([Buffer.from('shot.tga', 'utf16le'), Buffer.alloc(2)]));
const FNAME2 = dataLabel('fname2',
  Buffer.concat([Buffer.from('\\shot.tga', 'utf16le'), Buffer.alloc(2)]));

// ---------------------------------------------------------------- font data
// Text, emoji and icons are baked at build time by font/bake.js:
//
//   Inter Variable  -> proportional UI text at 13 px and 19 px
//   Noto Emoji      -> monochrome emoji
//   Tabler Icons    -> line icons, mapped into the private use area
//
// They share one 8-bit coverage atlas, so the runtime needs no font parser and
// no SVG parser. Blitting is exactly what a browser does with a texture atlas.
const ATLAS = dataLabel('atlas', fs.readFileSync(path.join(ASSET_DIR, 'atlas.bin')));

function tableBlob(table) {
  const buf = Buffer.alloc(16 + table.glyphs.length * 32);
  buf.writeUInt32LE(table.glyphs.length, 0);
  buf.writeInt16LE(table.ascent, 4);
  buf.writeInt16LE(table.lineHeight ?? table.ascent + 4, 6);
  table.glyphs.forEach((g, i) => {
    const at = 16 + i * 32;
    buf.writeUInt32LE(g[0], at);
    buf.writeUInt16LE(g[1], at + 4);
    buf.writeUInt16LE(g[2], at + 6);
    buf[at + 8] = g[3];
    buf[at + 9] = g[4];
    buf.writeInt16LE(g[5], at + 10);
    buf.writeInt16LE(g[6], at + 12);
    buf.writeInt16LE(g[7], at + 14);
  });
  return buf;
}

const T_TEXT13 = dataLabel('t_text13', tableBlob(TABLES.text13));
const T_TEXT19 = dataLabel('t_text19', tableBlob(TABLES.text19));
const T_EMOJI19 = dataLabel('t_emoji19', tableBlob(TABLES.emoji19));
const T_ICONS = dataLabel('t_icons', tableBlob(TABLES.icons));

const S_URL_SCHEME = str('https://');
const S_PLACEHOLDER = str('Type a URL');
const S_HEAD1 = str('REG-RUNTIME');
const S_HEAD2 = str('6 KB of UEFI. No kernel, no browser.');
const S_HEAD3 = str('JS emits PE32+. Firmware provides the rest.');
const S_HEAD4 = str('Inter Variable \u2022 Noto Emoji \u2022 Tabler Icons');

// Icons are glyphs in the private use area, so they travel through the same
// string and text path as everything else.
const S_ICON_WORLD = str(String.fromCodePoint(ICONS.world));
const S_ICON_LOCK = str(String.fromCodePoint(ICONS.lock));
const S_ICON_REFRESH = str(String.fromCodePoint(ICONS.refresh));
const S_ICON_MENU = str(String.fromCodePoint(ICONS.settings));
const S_ICON_CURSOR = str(String.fromCodePoint(ICONS.pointer));
const S_HEAD_ROCKET = str('\u{1F680}');
const S_TITLE = str('canvas \u2022 gop');
const S_HINT = str('type into the address bar  \u2022  esc exits');

function measure(table, text) {
  let pen = 0;
  for (const ch of text) {
    const g = table.glyphs.find((e) => e[0] === ch.codePointAt(0));
    pen += g ? g[5] : 6;
  }
  return pen;
}
// Where the URL text starts, derived from the real scheme width.
const URL_TEXT_X = 128 + measure(TABLES.text13, 'https://') + 8;

// --------------------------------------------------------------- frame
const L_FB = 0x00;
const L_STRIDE = 0x08;
const L_W = 0x10;
const L_H = 0x18;
const L_FMT = 0x20;
const L_COL = 0x28;
const L_CNT = 0x30;
const L_BUF = 0x38;
const L_SFSP = 0x40;
const L_ROOT = 0x48;
const L_FILE = 0x50;
const L_SIZE = 0x58;
const L_IFACE = 0x60;
const L_HANDLE = 0x68;
const L_X = 0x70;
const L_Y = 0x78;
const L_HDR = 0x80;
const L_T1 = 0xa0;
const L_T2 = 0xa8;
const L_T3 = 0xb0;
const L_T4 = 0xb8;
const L_T5 = 0xc0;
const L_T6 = 0xc8;
const L_T7 = 0xd0;
const L_T8 = 0xd8;
const L_GOPMODE = 0x120;
const L_INFO = 0x128;
const L_D1 = 0x130;
const L_D2 = 0x138;
const L_D3 = 0x140;
const L_D4 = 0x148;
const L_D5 = 0x150;
const L_D6 = 0x158;
const L_IMG = 0x160;
const L_ST = 0x168;                       // status across prints
const L_G1 = 0x170;
const L_G2 = 0x178;
const L_G3 = 0x180;
const L_G4 = 0x188;
const L_G5 = 0x190;
const L_G6 = 0x198;
const L_G7 = 0x1a0;
const L_G8 = 0x1a8;
const L_H1 = 0x1c0;
const L_H2 = 0x1c8;
const L_H3 = 0x1d0;
const L_H4 = 0x1d8;
const L_H5 = 0x1e0;
const L_H6 = 0x1e8;
const L_H7 = 0x1f0;
const L_H8 = 0x1f8;
const L_J1 = 0x280;
const L_J2 = 0x288;
const L_J3 = 0x290;
const L_J4 = 0x298;
const L_J5 = 0x2a0;
const L_J6 = 0x2a8;
const L_J7 = 0x2b0;
const L_IBLEN = 0x1b0;
const L_KEYBUF = 0x1b8;
const L_TIMER = 0x2c0;
const L_KD = 0x2c8;                       // EFI_KEY_DATA (12 bytes)
const L_TICK = 0x2d8;
const L_KEYPROT = 0x2f0;
const L_PTRPROT = 0x2e0;                  // EFI_SIMPLE_POINTER_PROTOCOL
// The mouse only ever reports relative deltas. The pointer position below is
// runtime state: it is integrated from those deltas over time, clamped to the
// display, and is what the cursor is painted from. Input is not position.
const L_MX = 0x2e8;                       // pointer hotspot, screen pixels
const L_MY = 0x2f8;
const L_PSTATE = 0x320;                   // EFI_SIMPLE_POINTER_STATE (16 bytes)
const L_CBUF = 0x330;                     // save-under buffer
const L_MDRAWN = 0x338;
const L_CX = 0x340;                       // box origin of the saved pixels
const L_CY = 0x348;
const L_TGA = 0x350;                      // 18-byte TGA header
const L_PDX = 0x2b8;                      // last integrated delta, device units
const L_PDY = 0x360;
const L_PBTN = 0x368;                     // button mask, bit0 left bit1 right
const L_PMOVED = 0x370;                   // pointer state changed this tick
const L_NOW = 0x3b8;                      // monotonic milliseconds
const L_EV = 0x380;                       // input event being pushed (32 bytes)
const L_EVBUF = 0x3a0;                    // ring buffer, pool allocated
const L_EVN = 0x3a8;                      // queued event count
const L_EVHEAD = 0x3b0;                   // next write index
const EV_SLOTS = 64;                      // power of two, 2 KiB ring
const EV_BYTES = 32;
const L_IB = 0x200;                       // 64 UTF-16 code units
const L_U16 = 0x300;
const FRAME = 0x400;
const CURSOR_W = 24;                      // 20 px icon + 2 px pad each side
const CURSOR_H = 24;
const CURSOR_PAD = 2;
const CURSOR_HOT_X = 5;                   // ink tip inside the box
const CURSOR_HOT_Y = 4;
const CURSOR_BYTES = CURSOR_W * CURSOR_H * 4;

// ------------------------------------------------------------- helpers
function leaFrame(dst, off) {
  a.mov(dst, REG.RBP);
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
  a.mov(REG.RAX, reg);
  leaFrame(REG.RDI, L_U16);
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
  leaFrame(REG.RDX, L_U16);
  conOut();
}
function hex64(reg) { hexN(reg, 16); }
function hex4(reg) { hexN(reg, 4); }
function hex2(reg) { hexN(reg, 2); }

// canvas primitives ---------------------------------------------------------
// fill(x, y, w, h, argb) -> cv_fill(RDI, RSI, RDX, RCX, R8)
function fillImm(x, y, w, h, color) {
  a.movImm32(REG.RDI, x);
  a.movImm32(REG.RSI, y);
  a.movImm32(REG.RDX, w);
  a.movImm32(REG.RCX, h);
  a.movImm64(REG.R8, BigInt(color >>> 0));
  a.call('cv_fill');
}
function fillSlot(x, y, w, h, color) {
  a.load64(REG.RDI, REG.RBP, x);
  a.load64(REG.RSI, REG.RBP, y);
  a.load64(REG.RDX, REG.RBP, w);
  a.load64(REG.RCX, REG.RBP, h);
  a.movImm64(REG.R8, BigInt(color >>> 0));
  a.call('cv_fill');
}
function storeSlot(slot, value) {
  a.movImm64(REG.RAX, BigInt(value >>> 0));
  a.store64(REG.RBP, REG.RAX, slot);
}
function discSlot(cx, cy, r, color) {
  a.load64(REG.RDI, REG.RBP, cx);
  a.load64(REG.RSI, REG.RBP, cy);
  a.load64(REG.RDX, REG.RBP, r);
  a.movImm64(REG.RCX, BigInt(color >>> 0));
  a.call('cv_disc');
}
function textAt(xSlot, xOff, ySlot, yOff, label, color, table) {
  a.load64(REG.RDI, REG.RBP, xSlot);
  if (xOff) a.addImm32(REG.RDI, xOff);
  a.load64(REG.RSI, REG.RBP, ySlot);
  if (yOff) a.addImm32(REG.RSI, yOff);
  a.leaRip(REG.RDX, label);
  a.movImm64(REG.RCX, BigInt(color >>> 0));
  a.leaRip(REG.R8, table ?? T_TEXT13);
  a.call('cv_text');
}
function textStr(xSlot, xOff, ySlot, yOff, label, color, table) {
  textAt(xSlot, xOff, ySlot, yOff, label, color, table);
}
// Address bar: background, world icon, scheme, typed text or placeholder,
// caret, then right-hand chrome. Caret colour lives in L_T6 so the blink loop
// can vary it without repainting the whole bar.
function emitAddressBar() {
  a.load64(REG.RDI, REG.RBP, L_T3);
  a.addImm32(REG.RDI, 96);
  a.load64(REG.RSI, REG.RBP, L_T4);
  a.addImm32(REG.RSI, 11);
  a.load64(REG.RDX, REG.RBP, L_T1);
  a.subImm32(REG.RDX, 120);
  a.movImm32(REG.RCX, 34);
  a.movImm64(REG.R8, 0xff1b1e26n);
  a.call('cv_fill');

  textAt(L_T3, 104, L_T4, 18, S_ICON_WORLD, 0xff7f8ba3, T_ICONS);
  textAt(L_T3, 128, L_T4, 20, S_URL_SCHEME, 0xff7f8ba3, T_TEXT13);

  // Typed text. cv_text returns the pen position, so the caret lands exactly
  // where the next glyph would go: proportional widths, not a fixed pitch.
  a.load64(REG.RDI, REG.RBP, L_T3);
  a.addImm32(REG.RDI, URL_TEXT_X);
  a.load64(REG.RSI, REG.RBP, L_T4);
  a.addImm32(REG.RSI, 20);
  leaFrame(REG.RDX, L_IB);
  a.movImm64(REG.RCX, 0xffe8ecf4n);
  a.leaRip(REG.R8, T_TEXT13);
  a.call('cv_text');
  a.store64(REG.RBP, REG.RAX, L_J1);

  const phDone = `phdone_${uid++}`;
  a.load64(REG.RAX, REG.RBP, L_IBLEN);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, phDone);
  textAt(L_T3, URL_TEXT_X, L_T4, 20, S_PLACEHOLDER, 0xff4a5264, T_TEXT13);
  a.load64(REG.RAX, REG.RBP, L_T3);
  a.addImm32(REG.RAX, URL_TEXT_X);
  a.store64(REG.RBP, REG.RAX, L_J1);
  a.label(phDone);

  const noCaret = `nocaret_${uid++}`;
  a.load64(REG.R8, REG.RBP, L_T6);
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, noCaret);
  a.load64(REG.RDI, REG.RBP, L_J1);
  a.load64(REG.RSI, REG.RBP, L_T4);
  a.addImm32(REG.RSI, 19);
  a.movImm32(REG.RDX, 2);
  a.movImm32(REG.RCX, 16);
  a.call('cv_fill');
  a.label(noCaret);

  // Right-hand chrome, laid out from the bar's right edge.
  const rightIcons = [
    [S_ICON_LOCK, -92],
    [S_ICON_REFRESH, -58],
    [S_ICON_MENU, -24],
  ];
  for (const [label, offset] of rightIcons) {
    a.load64(REG.RDI, REG.RBP, L_T3);
    a.load64(REG.R10, REG.RBP, L_T1);
    a.add(REG.RDI, REG.R10);
    a.addImm32(REG.RDI, offset);
    a.load64(REG.RSI, REG.RBP, L_T4);
    a.addImm32(REG.RSI, 18);
    a.leaRip(REG.RDX, label);
    a.movImm64(REG.RCX, 0xff7f8ba3n);
    a.leaRip(REG.R8, T_ICONS);
    a.call('cv_text');
  }
}

// ------------------------------------------------------------- entry
a.label('entry');
a.mov(REG.R15, REG.RDX);
a.subImm32(REG.RSP, FRAME);
a.mov(REG.RBP, REG.RSP);
a.store64(REG.RBP, REG.RCX, L_IMG);       // ImageHandle
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

print(str('reg-runtime display probe\r\n'));
print(str('------------------------\r\n'));

// ------------------------------------------------------------------- GOP
a.leaRip(REG.RCX, 'guid_gop');
a.xor(REG.RDX, REG.RDX);
leaFrame(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
const noGop = `nogop_${uid++}`;
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, noGop);

a.load64(REG.R12, REG.RBP, L_IFACE);      // GOP
a.load64(REG.R9, REG.R12, GOP_MODE);
a.store64(REG.RBP, REG.R9, L_GOPMODE);
a.load64(REG.R10, REG.R9, MODE_INFO);
a.store64(REG.RBP, REG.R10, L_INFO);

function loadInfo32(slot, disp) {
  a.load64(REG.R10, REG.RBP, L_INFO);
  a.load32(REG.RSI, REG.R10, disp);
  a.mov(REG.RAX, REG.RSI);
  a.store64(REG.RBP, REG.RAX, slot);
}
loadInfo32(L_W, INFO_HRES);
print(str('width='));
hex64(REG.RSI);
loadInfo32(L_H, INFO_VRES);
print(str(' height='));
hex64(REG.RSI);
loadInfo32(L_FMT, INFO_FMT);
print(str(' format='));
hex64(REG.RSI);
loadInfo32(L_STRIDE, INFO_PPSL);
print(str(' stride='));
hex64(REG.RSI);
print(NL);

a.load64(REG.R9, REG.RBP, L_GOPMODE);
a.load64(REG.RSI, REG.R9, MODE_FB);
a.mov(REG.RAX, REG.RSI);
a.store64(REG.RBP, REG.RAX, L_FB);
print(str('framebuffer=0x'));
hex64(REG.RSI);
a.load64(REG.R9, REG.RBP, L_GOPMODE);
a.load64(REG.RSI, REG.R9, 32);            // FrameBufferSize
print(str(' bytes=0x'));
hex64(REG.RSI);
print(NL);

// ------------------------------------------------------- input / radios
function reportCount(label, guid) {
  print(str(label));
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBP, REG.RAX, L_HANDLE);
  a.store64(REG.RBP, REG.RAX, L_CNT);
  a.movImm32(REG.RCX, EFI_BY_PROTOCOL);
  a.leaRip(REG.RDX, guid);
  a.xor(REG.R8, REG.R8);
  leaFrame(REG.R9, L_CNT);
  leaFrame(REG.R10, L_HANDLE);
  a.load64(REG.RAX, REG.R13, BS_LOCATE_HANDLE_BUFFER);
  uefiCall5();
  const fin = `cntfin_${uid++}`;
  a.load64(REG.RSI, REG.RBP, L_CNT);
  hex64(REG.RSI);
  print(SP);
  a.load64(REG.RCX, REG.RBP, L_HANDLE);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, fin);
  a.load64(REG.RAX, REG.R13, BS_FREE_POOL);
  uefiCall();
  a.label(fin);
}

print(str('\r\nprotocols: '));
reportCount('pointer=', 'guid_pointer');
reportCount('absptr=', 'guid_absptr');
reportCount('keyboard=', 'guid_kbd');
reportCount('wifi=', 'guid_wifi');
reportCount('supplicant=', 'guid_supp');
reportCount('bluetooth=', 'guid_bthc');
reportCount('btconfig=', 'guid_btcfg');
print(NL);
print(NL);

// ------------------------------------------------------------- wallpaper
// Vertical gradient computed on the fly; exercises imul/div in the runtime.
const band = `band_${uid++}`;
const bandDone = `banddone_${uid++}`;
storeSlot(L_T5, 0);
a.label(band);
a.load64(REG.R8, REG.RBP, L_T5);          // y
a.load64(REG.RCX, REG.RBP, L_H);
a.cmp(REG.R8, REG.RCX);
a.jcc(COND.AE, bandDone);

a.mov(REG.RAX, REG.R8);
a.movImm32(REG.R10, 40);
a.imul(REG.RAX, REG.R10);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.RCX);
a.addImm32(REG.RAX, 12);
a.shlImm8(REG.RAX, 16);
a.store64(REG.RBP, REG.RAX, L_T4);

a.mov(REG.RAX, REG.R8);
a.movImm32(REG.R10, 52);
a.imul(REG.RAX, REG.R10);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.RCX);
a.addImm32(REG.RAX, 14);
a.shlImm8(REG.RAX, 8);
a.load64(REG.R9, REG.RBP, L_T4);
a.or(REG.R9, REG.RAX);
a.store64(REG.RBP, REG.R9, L_T4);

a.mov(REG.RAX, REG.R8);
a.movImm32(REG.R10, 96);
a.imul(REG.RAX, REG.R10);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.RCX);
a.addImm32(REG.RAX, 32);
a.load64(REG.R9, REG.RBP, L_T4);
a.or(REG.R9, REG.RAX);
a.movImm64(REG.RAX, 0xff000000n);
a.or(REG.R9, REG.RAX);
a.store64(REG.RBP, REG.R9, L_T4);

a.xor(REG.RDI, REG.RDI);
a.mov(REG.RSI, REG.R8);
a.load64(REG.RDX, REG.RBP, L_W);
a.movImm32(REG.RCX, 8);
a.load64(REG.R8, REG.RBP, L_T4);
a.call('cv_fill');

a.load64(REG.RAX, REG.RBP, L_T5);
a.addImm32(REG.RAX, 8);
a.store64(REG.RBP, REG.RAX, L_T5);
a.jmp(band);
a.label(bandDone);

// ---------------------------------------------------------------- window
a.load64(REG.RAX, REG.RBP, L_W);
a.movImm32(REG.R10, 240);
a.sub(REG.RAX, REG.R10);
a.store64(REG.RBP, REG.RAX, L_T1);        // win width
a.load64(REG.RAX, REG.RBP, L_H);
a.movImm32(REG.R10, 192);
a.sub(REG.RAX, REG.R10);
a.store64(REG.RBP, REG.RAX, L_T2);        // win height
storeSlot(L_T3, 120);                     // win x
storeSlot(L_T4, 96);                      // win y

// shadow, body, title bar
storeSlot(L_T5, 8);
storeSlot(L_T6, 10);
a.load64(REG.RDI, REG.RBP, L_T3);
a.addImm32(REG.RDI, 8);
a.load64(REG.RSI, REG.RBP, L_T4);
a.addImm32(REG.RSI, 10);
a.load64(REG.RDX, REG.RBP, L_T1);
a.load64(REG.RCX, REG.RBP, L_T2);
a.movImm64(REG.R8, 0xff14161an);
a.call('cv_fill');

fillSlot(L_T3, L_T4, L_T1, L_T2, 0xff23262e);
storeSlot(L_T5, 46);
fillSlot(L_T3, L_T4, L_T1, L_T5, 0xff2c303a);

// traffic lights
function discAt(dx, dy, r, color) {
  a.load64(REG.RDI, REG.RBP, L_T3);
  a.addImm32(REG.RDI, dx);
  a.load64(REG.RSI, REG.RBP, L_T4);
  a.addImm32(REG.RSI, dy);
  a.movImm32(REG.RDX, r);
  a.movImm64(REG.RCX, BigInt(color >>> 0));
  a.call('cv_disc');
}
discAt(22, 23, 8, 0xffff5f57);
discAt(48, 23, 8, 0xfffebc2e);
discAt(74, 23, 8, 0xff28c840);

// window title, using the small text face
textAt(L_T3, 100, L_T4, 15, S_TITLE, 0xffb9c1d1, T_TEXT13);

// content text
textAt(L_T3, 40, L_T4, 80, S_HEAD1, 0xffeef1f7, T_TEXT19);
textAt(L_T3, 40 + measure(TABLES.text19, 'REG-RUNTIME') + 12, L_T4, 80,
  S_HEAD_ROCKET, 0xfff7c948, T_EMOJI19);
textAt(L_T3, 40, L_T4, 112, S_HEAD2, 0xff9aa3b5, T_TEXT13);
textAt(L_T3, 40, L_T4, 132, S_HEAD3, 0xff9aa3b5, T_TEXT13);
textAt(L_T3, 40, L_T4, 152, S_HEAD4, 0xff6f7a90, T_TEXT13);

fillImm(160, 182, 640, 1, 0xff2c303a);

// Icon strip: each one is a private-use codepoint from the same atlas, so it
// goes through cv_text exactly like a letter.
const STRIP = ['terminal', 'world', 'wifi', 'bluetooth', 'keyboard', 'cpu', 'rocket', 'heart'];
STRIP.forEach((name, i) => {
  textAt(L_T3, 40 + i * 40, L_T4, 202,
    str(String.fromCodePoint(ICONS[name])), 0xff7f8ba3, T_ICONS);
});

const EMOJI_LINE =
  '\u{1F600}\u{1F680}\u{1F525}\u2728\u{1F4BB}\u{1F50C}\u{1F30D}\u{1F510}\u{1F9E0}';
textAt(L_T3, 40, L_T4, 250, str(EMOJI_LINE), 0xffb9c1d1, T_EMOJI19);

textAt(L_T3, 40, L_T4, 310, S_HINT, 0xff6f7a90, T_TEXT13);

// Paint the initial address bar into the captured frame.
storeSlot(L_T6, 0xff6ea8fe);
emitAddressBar();

// ------------------------------------------------------------- pointer
// Mouse is the firmware's simple pointer protocol. Motion is relative, so the
// runtime owns the cursor position and composites the cursor itself.
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_PTRPROT);
a.leaRip(REG.RCX, 'guid_pointer');
a.xor(REG.RDX, REG.RDX);
leaFrame(REG.R8, L_PTRPROT);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();

a.movImm32(REG.RCX, EFI_LOADER_DATA);
a.movImm32(REG.RDX, CURSOR_BYTES);
leaFrame(REG.R8, L_CBUF);
a.load64(REG.RAX, REG.R13, BS_ALLOCATE_POOL);
uefiCall();
storeSlot(L_MDRAWN, 0);

// One queue for everything the human does. Firmware protocols are polled;
// these events are the input side of the runtime's event loop.
a.movImm32(REG.RCX, EFI_LOADER_DATA);
a.movImm32(REG.RDX, EV_SLOTS * EV_BYTES);
leaFrame(REG.R8, L_EVBUF);
a.load64(REG.RAX, REG.R13, BS_ALLOCATE_POOL);
uefiCall();
storeSlot(L_EVN, 0);
storeSlot(L_EVHEAD, 0);

a.load64(REG.RAX, REG.RBP, L_W);
a.movImm32(REG.R10, 2);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.R10);
a.store64(REG.RBP, REG.RAX, L_MX);
a.load64(REG.RAX, REG.RBP, L_H);
a.movImm32(REG.R10, 2);
a.xor(REG.RDX, REG.RDX);
a.divReg(REG.R10);
a.store64(REG.RBP, REG.RAX, L_MY);
a.call('cursor_paint');

// ------------------------------------------------------------- screenshot
// The framebuffer is already the canvas, so a screenshot is just a repack:
// BGRx -> 24-bit TGA, top-left origin. Written through the file protocol,
// not a host syscall.
print(str('writing screenshot...\r\n'));
a.call('shot_write');
const afterShot = `aftershot_${uid++}`;
a.jmp(afterShot);

// Repack the live framebuffer into a 24-bit TGA on the boot volume. Called
// once at startup and again whenever Enter is pressed.
a.label('shot_write');

function showStatus(label) {
  print(str(label));
  a.load64(REG.RSI, REG.RBP, L_ST);
  hex64(REG.RSI);
  print(NL);
}

a.leaRip(REG.RCX, 'guid_sfsp');
a.xor(REG.RDX, REG.RDX);
leaFrame(REG.R8, L_IFACE);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();
a.store64(REG.RBP, REG.RAX, L_ST);
const noFs = `nofs_${uid++}`;
a.load64(REG.RAX, REG.RBP, L_ST);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, noFs);
a.load64(REG.RCX, REG.RBP, L_IFACE);
a.store64(REG.RBP, REG.RCX, L_SFSP);
leaFrame(REG.RDX, L_ROOT);
a.load64(REG.RAX, REG.RCX, SFSP_OPEN_VOLUME);
uefiCall();
a.store64(REG.RBP, REG.RAX, L_ST);
showStatus('openvol=0x');
const noVol = `novol_${uid++}`;
a.load64(REG.RAX, REG.RBP, L_ST);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, noVol);
a.load64(REG.RCX, REG.RBP, L_ROOT);
a.test(REG.RCX, REG.RCX);
a.jcc(COND.Z, noVol);

function emitOpen(fnameLabel) {
  a.load64(REG.RCX, REG.RBP, L_ROOT);
  leaFrame(REG.RDX, L_FILE);
  a.leaRip(REG.R8, fnameLabel);
  a.movImm64(REG.R9, 0x8000000000000003n);   // CREATE | READ | WRITE
  a.xor(REG.R10, REG.R10);                   // attributes
  a.load64(REG.RAX, REG.RCX, FILE_OPEN);
  uefiCall5();
  a.store64(REG.RBP, REG.RAX, L_ST);
}

const shotGo = `shotgo_${uid++}`;
emitOpen(FNAME);
a.load64(REG.RAX, REG.RBP, L_ST);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.Z, shotGo);
emitOpen(FNAME2);
a.load64(REG.RAX, REG.RBP, L_ST);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.Z, shotGo);
showStatus('open=0x');
a.jmp(noVol);

a.label(shotGo);
// Convert stride-padded BGRx rows into a packed 24-bit image.
a.load64(REG.RAX, REG.RBP, L_W);
a.load64(REG.RDX, REG.RBP, L_H);
a.imul(REG.RAX, REG.RDX);
a.movImm32(REG.RDX, 3);
a.imul(REG.RAX, REG.RDX);
a.store64(REG.RBP, REG.RAX, L_SIZE);
a.mov(REG.RDX, REG.RAX);
a.movImm32(REG.RCX, EFI_LOADER_DATA);
leaFrame(REG.R8, L_BUF);
a.load64(REG.RAX, REG.R13, BS_ALLOCATE_POOL);
uefiCall();
a.store64(REG.RBP, REG.RAX, L_ST);
const allocFail = `allocfail_${uid++}`;
a.load64(REG.RAX, REG.RBP, L_ST);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, allocFail);

a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_G1);           // y
a.load64(REG.R10, REG.RBP, L_FB);
a.store64(REG.RBP, REG.R10, L_G2);           // source row
a.load64(REG.R10, REG.RBP, L_BUF);
a.store64(REG.RBP, REG.R10, L_G3);           // destination cursor

const rowLoop = `rowloop_${uid++}`;
const rowDone = `rowdone_${uid++}`;
const colLoop = `colloop_${uid++}`;
const colDone = `coldone_${uid++}`;
const noSwap = `noswap_${uid++}`;
a.label(rowLoop);
a.load64(REG.RAX, REG.RBP, L_G1);
a.load64(REG.R10, REG.RBP, L_H);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, rowDone);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_G4);           // x
a.load64(REG.R10, REG.RBP, L_G2);
a.store64(REG.RBP, REG.R10, L_G6);           // source pixel
a.label(colLoop);
a.load64(REG.RAX, REG.RBP, L_G4);
a.load64(REG.R10, REG.RBP, L_W);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, colDone);
a.load64(REG.R9, REG.RBP, L_G6);
a.load64(REG.RDI, REG.RBP, L_G3);
a.load8(REG.RAX, REG.R9, 0);
a.store8(REG.RDI, REG.RAX, 0);
a.load8(REG.RAX, REG.R9, 1);
a.store8(REG.RDI, REG.RAX, 1);
a.load8(REG.RAX, REG.R9, 2);
a.store8(REG.RDI, REG.RAX, 2);
a.load64(REG.R10, REG.RBP, L_FMT);
a.test(REG.R10, REG.R10);
a.jcc(COND.NZ, noSwap);
a.load8(REG.RAX, REG.RDI, 0);                // RGBx -> TGA wants BGR
a.load8(REG.R10, REG.RDI, 2);
a.store8(REG.RDI, REG.R10, 0);
a.store8(REG.RDI, REG.RAX, 2);
a.label(noSwap);
a.addImm32(REG.R9, 4);
a.store64(REG.RBP, REG.R9, L_G6);
a.addImm32(REG.RDI, 3);
a.store64(REG.RBP, REG.RDI, L_G3);
a.load64(REG.RAX, REG.RBP, L_G4);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_G4);
a.jmp(colLoop);
a.label(colDone);
a.load64(REG.R10, REG.RBP, L_G2);
a.load64(REG.R11, REG.RBP, L_STRIDE);
a.shlImm8(REG.R11, 2);
a.add(REG.R10, REG.R11);
a.store64(REG.RBP, REG.R10, L_G2);
a.load64(REG.RAX, REG.RBP, L_G1);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_G1);
a.jmp(rowLoop);
a.label(rowDone);

// TGA header in frame scratch, then two writes.
leaFrame(REG.RDI, L_TGA);
a.xor(REG.RAX, REG.RAX);
a.movImm32(REG.RCX, 18);
const hdrZero = `hdrzero_${uid++}`;
a.label(hdrZero);
a.store8(REG.RDI, REG.RAX, 0);
a.addImm32(REG.RDI, 1);
a.dec(REG.RCX);
a.jcc(COND.NZ, hdrZero);
leaFrame(REG.RDI, L_TGA);
a.movImm32(REG.RAX, 2);                      // uncompressed truecolor
a.store8(REG.RDI, REG.RAX, 2);
a.load64(REG.RAX, REG.RBP, L_W);
a.store16(REG.RDI, REG.RAX, 12);
a.load64(REG.RAX, REG.RBP, L_H);
a.store16(REG.RDI, REG.RAX, 14);
a.movImm32(REG.RAX, 24);
a.store8(REG.RDI, REG.RAX, 16);
a.movImm32(REG.RAX, 0x20);                   // top-left origin
a.store8(REG.RDI, REG.RAX, 17);

a.movImm32(REG.RAX, 18);
a.store64(REG.RBP, REG.RAX, L_G7);
a.load64(REG.RCX, REG.RBP, L_FILE);
leaFrame(REG.RDX, L_G7);
leaFrame(REG.R8, L_TGA);
a.load64(REG.RAX, REG.RCX, FILE_WRITE);
uefiCall();
a.store64(REG.RBP, REG.RAX, L_ST);

a.load64(REG.RAX, REG.RBP, L_SIZE);
a.store64(REG.RBP, REG.RAX, L_G7);
a.load64(REG.RCX, REG.RBP, L_FILE);
leaFrame(REG.RDX, L_G7);
a.load64(REG.R8, REG.RBP, L_BUF);
a.load64(REG.RAX, REG.RCX, FILE_WRITE);
uefiCall();
a.store64(REG.RBP, REG.RAX, L_ST);

a.load64(REG.RCX, REG.RBP, L_FILE);
a.load64(REG.RAX, REG.RCX, FILE_CLOSE);
uefiCall();
print(str('wrote shot.tga\r\n'));

// Release the conversion buffer; the volume, not the pool, owns the bytes now.
a.load64(REG.RCX, REG.RBP, L_BUF);
a.load64(REG.RAX, REG.R13, BS_FREE_POOL);
uefiCall();
a.jmp(noFs);

a.label(allocFail);
showStatus('alloc=0x');
a.label(noVol);
a.label(noFs);
a.ret();
a.label(afterShot);

// ------------------------------------------------------------- event loop
// One periodic firmware timer paces the loop; the keyboard protocol produces
// input events. There is no host clock and no syscall here.
a.movImm32(REG.RCX, 0x80000000);             // EVT_TIMER
a.xor(REG.RDX, REG.RDX);
a.xor(REG.R8, REG.R8);
leaFrame(REG.R9, L_TIMER);
a.load64(REG.RAX, REG.R13, BS_CREATE_EVENT);
uefiCall();
a.load64(REG.RCX, REG.RBP, L_TIMER);
a.movImm32(REG.RDX, 1);                      // TimerPeriodic
a.movImm32(REG.R8, 160000);                  // 16 ms
a.load64(REG.RAX, REG.R13, BS_SET_TIMER);
uefiCall();

a.leaRip(REG.RCX, 'guid_kbd');
a.xor(REG.RDX, REG.RDX);
leaFrame(REG.R8, L_KEYPROT);
a.load64(REG.RAX, REG.R13, BS_LOCATE_PROTOCOL);
uefiCall();

storeSlot(L_T6, 0xff6ea8fe);
storeSlot(L_TICK, 0);
print(str('ready\r\n'));

a.label('loop');
a.movImm32(REG.RCX, 1);
leaFrame(REG.RDX, L_TIMER);
leaFrame(REG.R8, L_KEYBUF);
a.load64(REG.RAX, REG.R13, BS_WAIT_FOR_EVENT);
uefiCall();

a.load64(REG.RCX, REG.RBP, L_KEYPROT);
a.test(REG.RCX, REG.RCX);
a.jcc(COND.Z, 'tick');
leaFrame(REG.RDX, L_KD);
a.load64(REG.RAX, REG.RCX, 8);               // ReadKeyStrokeEx
uefiCall();
a.store64(REG.RBP, REG.RAX, L_ST);
a.load64(REG.RAX, REG.RBP, L_ST);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, 'tick');

// Temporary input trace: proves keys are arriving from firmware.
a.load16(REG.RAX, REG.RBP, L_KD + 2);
a.store64(REG.RBP, REG.RAX, L_G8);
print(str('key=0x'));
a.load64(REG.RSI, REG.RBP, L_G8);
hex4(REG.RSI);
print(NL);
a.load64(REG.RAX, REG.RBP, L_G8);

a.load16(REG.RAX, REG.RBP, L_KD + 2);        // UnicodeChar
const notBs = `notbs_${uid++}`;
a.cmpImm32(REG.RAX, 0x1b);                   // Esc
a.jcc(COND.E, 'done');
a.cmpImm32(REG.RAX, 0x0d);                   // Enter: re-capture the frame
const notEnter = `notenter_${uid++}`;
a.jcc(COND.NZ, notEnter);
a.call('shot_write');
a.jmp('repaint');
a.label(notEnter);
a.cmpImm32(REG.RAX, 0x08);                   // Backspace
a.jcc(COND.NZ, notBs);
a.load64(REG.RAX, REG.RBP, L_IBLEN);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.Z, 'repaint');
a.subImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_IBLEN);
a.shlImm8(REG.RAX, 1);
leaFrame(REG.RDI, L_IB);
a.add(REG.RDI, REG.RAX);
a.xor(REG.RDX, REG.RDX);
a.store16(REG.RDI, REG.RDX, 0);
a.jmp('repaint');

a.label(notBs);
a.cmpImm32(REG.RAX, 0x20);
a.jcc(COND.B, 'tick');
a.cmpImm32(REG.RAX, 0x7f);
a.jcc(COND.E, 'tick');
a.load64(REG.R10, REG.RBP, L_IBLEN);
a.cmpImm32(REG.R10, 60);
a.jcc(COND.AE, 'repaint');
a.mov(REG.R11, REG.R10);
a.shlImm8(REG.R11, 1);
leaFrame(REG.RDI, L_IB);
a.add(REG.RDI, REG.R11);
a.store16(REG.RDI, REG.RAX, 0);
a.addImm32(REG.R10, 1);
a.store64(REG.RBP, REG.R10, L_IBLEN);
a.mov(REG.R11, REG.R10);
a.shlImm8(REG.R11, 1);
leaFrame(REG.RDI, L_IB);
a.add(REG.RDI, REG.R11);
a.xor(REG.RDX, REG.RDX);
a.store16(REG.RDI, REG.RDX, 0);

a.label('repaint');
a.call('cursor_restore');
storeSlot(L_T6, 0xff6ea8fe);
emitAddressBar();
a.call('cursor_paint');
storeSlot(L_TICK, 0);
a.jmp('loop');

a.label('tick');
// Pointer motion is polled every firmware timer tick; the cursor is a real
// 24x24 save-under composite of the Tabler pointer glyph.
a.load64(REG.RCX, REG.RBP, L_PTRPROT);
a.test(REG.RCX, REG.RCX);
const noPtr = `noptr_${uid++}`;
a.jcc(COND.Z, noPtr);
leaFrame(REG.RDX, L_PSTATE);
a.load64(REG.RAX, REG.RCX, 8);               // GetState
uefiCall();
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, noPtr);
a.movsx32(REG.RAX, REG.RBP, L_PSTATE);       // RelativeMovementX
a.load64(REG.R10, REG.RBP, L_MX);
a.add(REG.R10, REG.RAX);
a.store64(REG.RBP, REG.R10, L_MX);
a.movsx32(REG.RAX, REG.RBP, L_PSTATE + 4);   // RelativeMovementY
a.load64(REG.R10, REG.RBP, L_MY);
a.add(REG.R10, REG.RAX);
a.store64(REG.RBP, REG.R10, L_MY);
a.label(noPtr);
a.call('cursor_paint');

a.load64(REG.RAX, REG.RBP, L_TICK);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_TICK);
a.andImm32(REG.RAX, 15);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NZ, 'loop');
a.load64(REG.RAX, REG.RBP, L_T6);
a.test(REG.RAX, REG.RAX);
const blinkOff = `blinkoff_${uid++}`;
const blinkDone = `blinkdone_${uid++}`;
a.jcc(COND.NZ, blinkOff);
storeSlot(L_T6, 0xff6ea8fe);
a.jmp(blinkDone);
a.label(blinkOff);
storeSlot(L_T6, 0);
a.label(blinkDone);
a.call('cursor_restore');
emitAddressBar();
a.call('cursor_paint');
a.jmp('loop');

a.label('done');
a.load64(REG.RCX, REG.RBP, L_TIMER);
a.movImm32(REG.RDX, 0);                      // TimerCancel
a.xor(REG.R8, REG.R8);
a.load64(REG.RAX, REG.R13, BS_SET_TIMER);
uefiCall();
a.mov(REG.RSP, REG.RBP);
a.addImm32(REG.RSP, FRAME);
a.xor(REG.RAX, REG.RAX);
a.ret();

// --------------------------------------------------------------- cv_fill
// fill(x, y, w, h, argb). Pixels are 32-bit; 0xAARRGGBB stored little-endian
// is BB GG RR AA, which is exactly BGRx.
a.label('cv_fill');
a.store64(REG.RBP, REG.RDI, L_G1);
a.store64(REG.RBP, REG.RSI, L_G2);
a.store64(REG.RBP, REG.RDX, L_G3);
a.store64(REG.RBP, REG.RCX, L_G4);
a.store64(REG.RBP, REG.R8, L_G5);

const fxOk = `fxok_${uid++}`;
const fyOk = `fyok_${uid++}`;
const fDone = `fdone_${uid++}`;
const fRow = `frow_${uid++}`;
const fRowNext = `frownext_${uid++}`;
const fCol = `fcol_${uid++}`;
const fColNext = `fcolnext_${uid++}`;
const fSwap = `fswap_${uid++}`;

a.load64(REG.RAX, REG.RBP, L_G1);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NS, fxOk);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_G1);
a.label(fxOk);
a.load64(REG.RAX, REG.RBP, L_G2);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NS, fyOk);
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_G2);
a.label(fyOk);

a.load64(REG.RAX, REG.RBP, L_G1);
a.load64(REG.R10, REG.RBP, L_W);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, fDone);
a.load64(REG.RAX, REG.RBP, L_G2);
a.load64(REG.R10, REG.RBP, L_H);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, fDone);

// clamp w and h to the framebuffer
const fwOk = `fwok_${uid++}`;
const fhOk = `fhok_${uid++}`;
a.load64(REG.RAX, REG.RBP, L_W);
a.load64(REG.R10, REG.RBP, L_G1);
a.sub(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G3);
a.cmp(REG.R10, REG.RAX);
a.jcc(COND.BE, fwOk);
a.store64(REG.RBP, REG.RAX, L_G3);
a.label(fwOk);
a.load64(REG.RAX, REG.RBP, L_H);
a.load64(REG.R10, REG.RBP, L_G2);
a.sub(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G4);
a.cmp(REG.R10, REG.RAX);
a.jcc(COND.BE, fhOk);
a.store64(REG.RBP, REG.RAX, L_G4);
a.label(fhOk);

// RGBx framebuffers need R and B swapped once.
a.load64(REG.R10, REG.RBP, L_FMT);
a.test(REG.R10, REG.R10);
a.jcc(COND.NZ, fSwap);
a.load64(REG.RAX, REG.RBP, L_G5);
a.mov(REG.R10, REG.RAX);
a.shrImm8(REG.RAX, 16);
a.andImm32(REG.RAX, 0xff);
a.andImm32(REG.R10, 0xff);
a.shlImm8(REG.R10, 16);
a.or(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G5);
a.andImm32(REG.R10, 0xff00);
a.or(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G5);
a.andImm32(REG.R10, 0xff000000);
a.or(REG.RAX, REG.R10);
a.store64(REG.RBP, REG.RAX, L_G5);
a.label(fSwap);

a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_G6);           // y
a.label(fRow);
a.load64(REG.RAX, REG.RBP, L_G6);
a.load64(REG.R10, REG.RBP, L_G4);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, fDone);
a.load64(REG.RAX, REG.RBP, L_G6);
a.load64(REG.R10, REG.RBP, L_G2);
a.add(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_STRIDE);
a.imul(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G1);
a.add(REG.RAX, REG.R10);
a.shlImm8(REG.RAX, 2);
a.load64(REG.R10, REG.RBP, L_FB);
a.add(REG.RAX, REG.R10);
a.store64(REG.RBP, REG.RAX, L_G8);           // row pointer
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_G7);           // x
a.label(fCol);
a.load64(REG.RAX, REG.RBP, L_G7);
a.load64(REG.R10, REG.RBP, L_G3);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, fRowNext);
a.load64(REG.RDI, REG.RBP, L_G8);
a.load64(REG.RAX, REG.RBP, L_G5);
a.store32(REG.RDI, REG.RAX, 0);
a.addImm32(REG.RDI, 4);
a.store64(REG.RBP, REG.RDI, L_G8);
a.load64(REG.RAX, REG.RBP, L_G7);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_G7);
a.jmp(fCol);
a.label(fRowNext);
a.load64(REG.RAX, REG.RBP, L_G6);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_G6);
a.jmp(fRow);
a.label(fDone);
a.ret();

// --------------------------------------------------------------- cv_disc
// disc(cx, cy, r, argb) = { (x,y) : (x-cx)^2 + (y-cy)^2 <= r^2 }.
a.label('cv_disc');
a.store64(REG.RBP, REG.RDI, L_G1);           // cx
a.store64(REG.RBP, REG.RSI, L_G2);           // cy
a.store64(REG.RBP, REG.RDX, L_G3);           // r
a.store64(REG.RBP, REG.RCX, L_G4);           // colour
a.mov(REG.RAX, REG.RDX);
a.imul(REG.RAX, REG.RDX);
a.store64(REG.RBP, REG.RAX, L_G7);           // r*r

const dyOk = `dyok_${uid++}`;
a.load64(REG.RAX, REG.RBP, L_G2);
a.sub(REG.RAX, REG.RDX);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NS, dyOk);
a.xor(REG.RAX, REG.RAX);
a.label(dyOk);
a.store64(REG.RBP, REG.RAX, L_G5);           // y

const dRow = `drow_${uid++}`;
const dRowNext = `drownext_${uid++}`;
const dCol = `dcol_${uid++}`;
const dColNext = `dcolnext_${uid++}`;
const dSkip = `dskip_${uid++}`;
const dDone = `ddone_${uid++}`;

a.label(dRow);
a.load64(REG.RAX, REG.RBP, L_G1);
a.load64(REG.R10, REG.RBP, L_G3);
a.add(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G5);
a.cmp(REG.R10, REG.RAX);
a.jcc(COND.A, dDone);
a.load64(REG.RAX, REG.RBP, L_G5);
a.load64(REG.R10, REG.RBP, L_H);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, dDone);

const dxOk = `dxok_${uid++}`;
a.load64(REG.RAX, REG.RBP, L_G1);
a.load64(REG.R10, REG.RBP, L_G3);
a.sub(REG.RAX, REG.R10);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.NS, dxOk);
a.xor(REG.RAX, REG.RAX);
a.label(dxOk);
a.store64(REG.RBP, REG.RAX, L_G6);           // x

a.label(dCol);
a.load64(REG.RAX, REG.RBP, L_G1);
a.load64(REG.R10, REG.RBP, L_G3);
a.add(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G6);
a.cmp(REG.R10, REG.RAX);
a.jcc(COND.A, dRowNext);
a.load64(REG.RAX, REG.RBP, L_G6);
a.load64(REG.R10, REG.RBP, L_W);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, dRowNext);

a.load64(REG.RAX, REG.RBP, L_G6);
a.load64(REG.R10, REG.RBP, L_G1);
a.sub(REG.RAX, REG.R10);
a.imul(REG.RAX, REG.RAX);
a.load64(REG.R10, REG.RBP, L_G5);
a.load64(REG.R11, REG.RBP, L_G2);
a.sub(REG.R10, REG.R11);
a.imul(REG.R10, REG.R10);
a.add(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G7);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.A, dSkip);

a.load64(REG.RAX, REG.RBP, L_G5);
a.load64(REG.R10, REG.RBP, L_STRIDE);
a.imul(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G6);
a.add(REG.RAX, REG.R10);
a.shlImm8(REG.RAX, 2);
a.load64(REG.R10, REG.RBP, L_FB);
a.add(REG.RAX, REG.R10);
a.load64(REG.R10, REG.RBP, L_G4);
a.store32(REG.RAX, REG.R10, 0);
a.label(dSkip);
a.load64(REG.RAX, REG.RBP, L_G6);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_G6);
a.jmp(dCol);
a.label(dRowNext);
a.load64(REG.RAX, REG.RBP, L_G5);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_G5);
a.jmp(dRow);
a.label(dDone);
a.ret();

// --------------------------------------------------------------- cv_text
// RDI=x, RSI=y (top of line box), RDX=UTF-16 string, RCX=0xAARRGGBB,
// R8=table. Glyphs come from the baked coverage atlas and are alpha-blended,
// the same operation as compositing a glyph texture in a browser.
a.label('cv_text');
a.store64(REG.RBP, REG.RDI, L_G1);        // pen x
a.store64(REG.RBP, REG.RDX, L_G3);        // string cursor
a.store64(REG.RBP, REG.RCX, L_G4);        // colour, framebuffer order
a.store64(REG.RBP, REG.R8, L_G5);         // table
a.load16(REG.R9, REG.R8, 4);              // ascent
a.add(REG.RSI, REG.R9);
a.store64(REG.RBP, REG.RSI, L_G2);        // baseline y

const txtNoSwap = `txtnoswap_${uid++}`;
a.load64(REG.R10, REG.RBP, L_FMT);
a.test(REG.R10, REG.R10);
a.jcc(COND.NZ, txtNoSwap);
a.mov(REG.RAX, REG.RCX);                  // swap R and B once for the run
a.shrImm8(REG.RAX, 16);
a.andImm32(REG.RAX, 0xff);
a.mov(REG.RDX, REG.RCX);
a.andImm32(REG.RDX, 0xff);
a.shlImm8(REG.RDX, 16);
a.or(REG.RAX, REG.RDX);
a.mov(REG.RDX, REG.RCX);
a.andImm32(REG.RDX, 0xff00);
a.or(REG.RAX, REG.RDX);
a.mov(REG.RDX, REG.RCX);
a.andImm32(REG.RDX, 0xff000000);
a.or(REG.RAX, REG.RDX);
a.store64(REG.RBP, REG.RAX, L_G4);
a.label(txtNoSwap);

const tChar = `tchar_${uid++}`;
const tAdv = `tadv_${uid++}`;
const tRow = `trow_${uid++}`;
const tRowNext = `trownext_${uid++}`;
const tCol = `tcol_${uid++}`;
const tDone = `tdone_${uid++}`;
const tHaveCp = `thavecp_${uid++}`;
const tHit = `thit_${uid++}`;
const tLo = `tlo_${uid++}`;
const tLo2 = `tlo2_${uid++}`;
const tPix = `tpix_${uid++}`;
const tSkip = `tskip_${uid++}`;
const tNoGlyph = `tnoglyph_${uid++}`;

a.label(tChar);
a.load64(REG.R11, REG.RBP, L_G3);
a.load16(REG.RAX, REG.R11, 0);
a.test(REG.RAX, REG.RAX);
a.jcc(COND.Z, tDone);

// Decode a surrogate pair so emoji are ordinary string content.
a.cmpImm32(REG.RAX, 0xd800);
a.jcc(COND.B, tHaveCp);
a.cmpImm32(REG.RAX, 0xdbff);
a.jcc(COND.A, tHaveCp);
a.load16(REG.R10, REG.R11, 2);
a.cmpImm32(REG.R10, 0xdc00);
a.jcc(COND.B, tHaveCp);
a.cmpImm32(REG.R10, 0xdfff);
a.jcc(COND.A, tHaveCp);
a.subImm32(REG.RAX, 0xd800);
a.shlImm8(REG.RAX, 10);
a.subImm32(REG.R10, 0xdc00);
a.add(REG.RAX, REG.R10);
a.addImm32(REG.RAX, 0x10000);
a.addImm32(REG.R11, 2);
a.store64(REG.RBP, REG.R11, L_G3);
a.label(tHaveCp);
a.addImm32(REG.R11, 2);
a.store64(REG.RBP, REG.R11, L_G3);
a.store64(REG.RBP, REG.RAX, L_H1);        // codepoint

// Binary search: u32 count at +0, entries from +16, 32 bytes each, sorted by cp.
a.load64(REG.R9, REG.RBP, L_G5);
a.load32(REG.R10, REG.R9, 0);
a.store64(REG.RBP, REG.R10, L_H2);        // hi
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_H3);        // lo
a.label(tLo);
a.load64(REG.RAX, REG.RBP, L_H3);
a.load64(REG.R10, REG.RBP, L_H2);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, tNoGlyph);
a.add(REG.RAX, REG.R10);
a.shrImm8(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_H4);        // mid
a.shlImm8(REG.RAX, 5);
a.addImm32(REG.RAX, 16);
a.load64(REG.R10, REG.RBP, L_G5);
a.add(REG.RAX, REG.R10);
a.store64(REG.RBP, REG.RAX, L_H5);        // entry pointer
a.load32(REG.R10, REG.RAX, 0);
a.load64(REG.R11, REG.RBP, L_H1);
a.cmp(REG.R10, REG.R11);
a.jcc(COND.E, tHit);
a.jcc(COND.B, tLo2);
a.load64(REG.RAX, REG.RBP, L_H4);         // mid.cp > cp -> hi = mid
a.store64(REG.RBP, REG.RAX, L_H2);
a.jmp(tLo);
a.label(tLo2);
a.load64(REG.RAX, REG.RBP, L_H4);         // mid.cp < cp -> lo = mid + 1
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_H3);
a.jmp(tLo);

a.label(tNoGlyph);
a.load64(REG.RAX, REG.RBP, L_G1);
a.addImm32(REG.RAX, 6);                   // missing glyph: advance a little
a.store64(REG.RBP, REG.RAX, L_G1);
a.jmp(tChar);

a.label(tHit);
a.load64(REG.R9, REG.RBP, L_H5);
a.load16(REG.RAX, REG.R9, 4);
a.store64(REG.RBP, REG.RAX, L_H6);        // atlas x
a.load16(REG.RAX, REG.R9, 6);
a.store64(REG.RBP, REG.RAX, L_H7);        // atlas y
a.load16(REG.RAX, REG.R9, 10);
a.store64(REG.RBP, REG.RAX, L_H8);        // advance
a.load8(REG.RAX, REG.R9, 8);
a.store64(REG.RBP, REG.RAX, L_J1);        // w
a.load8(REG.RAX, REG.R9, 9);
a.store64(REG.RBP, REG.RAX, L_J2);        // h
a.movsx16(REG.RAX, REG.R9, 12);
a.load64(REG.R10, REG.RBP, L_G1);
a.add(REG.R10, REG.RAX);
a.store64(REG.RBP, REG.R10, L_J3);        // pen + bearingX
a.movsx16(REG.RAX, REG.R9, 14);
a.load64(REG.R10, REG.RBP, L_G2);
a.sub(REG.R10, REG.RAX);
a.store64(REG.RBP, REG.R10, L_J4);        // baseline - bearingY
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_J5);        // row

a.label(tRow);
a.load64(REG.RAX, REG.RBP, L_J5);
a.load64(REG.R10, REG.RBP, L_J2);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, tAdv);
a.load64(REG.R10, REG.RBP, L_H7);
a.add(REG.R10, REG.RAX);
a.movImm32(REG.R11, ATLAS_WIDTH);
a.imul(REG.R10, REG.R11);
a.load64(REG.R9, REG.RBP, L_H6);
a.add(REG.R10, REG.R9);
a.leaRip(REG.R11, ATLAS);
a.add(REG.R10, REG.R11);
a.store64(REG.RBP, REG.R10, L_J7);        // atlas row cursor
a.xor(REG.RAX, REG.RAX);
a.store64(REG.RBP, REG.RAX, L_J6);        // col

a.label(tCol);
a.load64(REG.RAX, REG.RBP, L_J6);
a.load64(REG.R10, REG.RBP, L_J1);
a.cmp(REG.RAX, REG.R10);
a.jcc(COND.AE, tRowNext);
a.load64(REG.R10, REG.RBP, L_J7);
a.load8(REG.R11, REG.R10, 0);
a.test(REG.R11, REG.R11);
a.jcc(COND.NZ, tPix);
a.load64(REG.RAX, REG.RBP, L_J6);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_J6);
a.load64(REG.R10, REG.RBP, L_J7);
a.addImm32(REG.R10, 1);
a.store64(REG.RBP, REG.R10, L_J7);
a.jmp(tCol);

// Blend one coverage sample over the framebuffer pixel.
a.label(tPix);
a.load64(REG.RDI, REG.RBP, L_J6);
a.load64(REG.R10, REG.RBP, L_J3);
a.add(REG.RDI, REG.R10);                  // x
a.load64(REG.R9, REG.RBP, L_J5);
a.load64(REG.R10, REG.RBP, L_J4);
a.add(REG.R9, REG.R10);                   // y
a.load64(REG.R10, REG.RBP, L_W);
a.cmp(REG.RDI, REG.R10);
a.jcc(COND.AE, tSkip);
a.load64(REG.R10, REG.RBP, L_H);
a.cmp(REG.R9, REG.R10);
a.jcc(COND.AE, tSkip);
a.load64(REG.R10, REG.RBP, L_STRIDE);
a.imul(REG.R9, REG.R10);
a.add(REG.R9, REG.RDI);
a.shlImm8(REG.R9, 2);
a.load64(REG.R10, REG.RBP, L_FB);
a.add(REG.R9, REG.R10);                   // dst pointer

a.load64(REG.R8, REG.RBP, L_G4);          // colour
a.mov(REG.R10, REG.R11);
a.neg(REG.R10);
a.addImm32(REG.R10, 255);                 // 255 - coverage
a.load8(REG.RAX, REG.R9, 0);
a.imul(REG.RAX, REG.R10);
a.mov(REG.RDX, REG.R8);
a.andImm32(REG.RDX, 0xff);
a.imul(REG.RDX, REG.R11);
a.add(REG.RAX, REG.RDX);
a.shrImm8(REG.RAX, 8);
a.store8(REG.R9, REG.RAX, 0);
a.load8(REG.RAX, REG.R9, 1);
a.imul(REG.RAX, REG.R10);
a.mov(REG.RDX, REG.R8);
a.shrImm8(REG.RDX, 8);
a.andImm32(REG.RDX, 0xff);
a.imul(REG.RDX, REG.R11);
a.add(REG.RAX, REG.RDX);
a.shrImm8(REG.RAX, 8);
a.store8(REG.R9, REG.RAX, 1);
a.load8(REG.RAX, REG.R9, 2);
a.imul(REG.RAX, REG.R10);
a.mov(REG.RDX, REG.R8);
a.shrImm8(REG.RDX, 16);
a.andImm32(REG.RDX, 0xff);
a.imul(REG.RDX, REG.R11);
a.add(REG.RAX, REG.RDX);
a.shrImm8(REG.RAX, 8);
a.store8(REG.R9, REG.RAX, 2);

a.label(tSkip);
a.load64(REG.RAX, REG.RBP, L_J6);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_J6);
a.load64(REG.R10, REG.RBP, L_J7);
a.addImm32(REG.R10, 1);
a.store64(REG.RBP, REG.R10, L_J7);
a.jmp(tCol);

a.label(tRowNext);
a.load64(REG.RAX, REG.RBP, L_J5);
a.addImm32(REG.RAX, 1);
a.store64(REG.RBP, REG.RAX, L_J5);
a.jmp(tRow);

a.label(tAdv);
a.load64(REG.RAX, REG.RBP, L_G1);
a.load64(REG.R10, REG.RBP, L_H8);
a.add(REG.RAX, REG.R10);
a.store64(REG.RBP, REG.RAX, L_G1);
a.jmp(tChar);

a.label(tDone);
a.load64(REG.RAX, REG.RBP, L_G1);         // return pen position
a.ret();

// ---------------------------------------------------------------- cursor
// Save-under compositor. The cursor is a Tabler glyph, so it uses the same
// coverage atlas and alpha blend as text; only the 24x24 pixels behind it are
// copied out and put back.
function clampAxis(slot, dimSlot) {
  const lo = `clo_${uid++}`;
  const hi = `chi_${uid++}`;
  a.load64(REG.RAX, REG.RBP, slot);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NS, lo);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBP, REG.RAX, slot);
  a.label(lo);
  a.load64(REG.RAX, REG.RBP, slot);
  a.load64(REG.R10, REG.RBP, dimSlot);
  a.subImm32(REG.R10, CURSOR_W);
  a.cmp(REG.RAX, REG.R10);
  a.jcc(COND.BE, hi);
  a.store64(REG.RBP, REG.R10, slot);
  a.label(hi);
}

function emitCursorCopy(save) {
  // save ? framebuffer -> buffer : buffer -> framebuffer
  const row = `cpr_${uid++}`;
  const rowDone = `cpd_${uid++}`;
  const col = `cpc_${uid++}`;
  const colDone = `cpx_${uid++}`;

  a.load64(REG.R10, REG.RBP, L_CY);
  a.load64(REG.R11, REG.RBP, L_STRIDE);
  a.imul(REG.R10, REG.R11);
  a.load64(REG.R11, REG.RBP, L_CX);
  a.add(REG.R10, REG.R11);
  a.shlImm8(REG.R10, 2);
  a.load64(REG.R11, REG.RBP, L_FB);
  a.add(REG.R10, REG.R11);
  a.load64(REG.R9, REG.RBP, L_CBUF);
  if (save) {
    a.store64(REG.RBP, REG.R9, L_H2);        // dst = save buffer
    a.store64(REG.RBP, REG.R10, L_H3);       // src = framebuffer
  } else {
    a.store64(REG.RBP, REG.R10, L_H2);       // dst = framebuffer
    a.store64(REG.RBP, REG.R9, L_H3);        // src = save buffer
  }
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBP, REG.RAX, L_H1);         // row

  a.label(row);
  a.load64(REG.RAX, REG.RBP, L_H1);
  a.cmpImm32(REG.RAX, CURSOR_H);
  a.jcc(COND.AE, rowDone);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBP, REG.RAX, L_H4);         // byte within row
  a.label(col);
  a.load64(REG.RAX, REG.RBP, L_H4);
  a.cmpImm32(REG.RAX, CURSOR_W * 4);
  a.jcc(COND.AE, colDone);
  a.load64(REG.R9, REG.RBP, L_H3);
  a.load8(REG.RDX, REG.R9, 0);
  a.load64(REG.R10, REG.RBP, L_H2);
  a.store8(REG.R10, REG.RDX, 0);
  a.addImm32(REG.R9, 1);
  a.store64(REG.RBP, REG.R9, L_H3);
  a.addImm32(REG.R10, 1);
  a.store64(REG.RBP, REG.R10, L_H2);
  a.load64(REG.RAX, REG.RBP, L_H4);
  a.addImm32(REG.RAX, 1);
  a.store64(REG.RBP, REG.RAX, L_H4);
  a.jmp(col);
  a.label(colDone);
  // Rewind the strided row cursor and step to the next scanline. The packed
  // buffer side already advanced by one row (96 bytes).
  {
    const strided = save ? L_H3 : L_H2;
    a.load64(REG.R10, REG.RBP, strided);
    a.subImm32(REG.R10, CURSOR_W * 4);
    a.load64(REG.R11, REG.RBP, L_STRIDE);
    a.shlImm8(REG.R11, 2);
    a.add(REG.R10, REG.R11);
    a.store64(REG.RBP, REG.R10, strided);
  }
  a.load64(REG.RAX, REG.RBP, L_H1);
  a.addImm32(REG.RAX, 1);
  a.store64(REG.RBP, REG.RAX, L_H1);
  a.jmp(row);
  a.label(rowDone);
}

a.label('cursor_restore');
{
  const done = `crr_${uid++}`;
  a.load64(REG.RAX, REG.RBP, L_MDRAWN);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, done);
  a.load64(REG.RAX, REG.RBP, L_CBUF);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, done);
  emitCursorCopy(false);
  storeSlot(L_MDRAWN, 0);
  a.label(done);
  a.ret();
}

a.label('cursor_save');
emitCursorCopy(true);
a.ret();

a.label('cursor_paint');
{
  const done = `cp_${uid++}`;
  a.load64(REG.RAX, REG.RBP, L_PTRPROT);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, done);
  a.load64(REG.RAX, REG.RBP, L_CBUF);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, done);

  a.call('cursor_restore');
  clampAxis(L_MX, L_W);
  clampAxis(L_MY, L_H);
  a.call('cursor_save');
  a.load64(REG.RAX, REG.RBP, L_MX);
  a.store64(REG.RBP, REG.RAX, L_CX);
  a.load64(REG.RAX, REG.RBP, L_MY);
  a.store64(REG.RBP, REG.RAX, L_CY);
  storeSlot(L_MDRAWN, 1);

  // Drop shadow first, then the white cursor glyph on top.
  a.load64(REG.RDI, REG.RBP, L_MX);
  a.addImm32(REG.RDI, CURSOR_PAD + 1);
  a.load64(REG.RSI, REG.RBP, L_MY);
  a.addImm32(REG.RSI, CURSOR_PAD + 1);
  a.leaRip(REG.RDX, S_ICON_CURSOR);
  a.movImm64(REG.RCX, 0x99000000n);
  a.leaRip(REG.R8, T_ICONS);
  a.call('cv_text');

  a.load64(REG.RDI, REG.RBP, L_MX);
  a.addImm32(REG.RDI, CURSOR_PAD);
  a.load64(REG.RSI, REG.RBP, L_MY);
  a.addImm32(REG.RSI, CURSOR_PAD);
  a.leaRip(REG.RDX, S_ICON_CURSOR);
  a.movImm64(REG.RCX, 0xfff2f4f8n);
  a.leaRip(REG.R8, T_ICONS);
  a.call('cv_text');
  a.label(done);
  a.ret();
}

// ---------------------------------------------------------------- trampoline
a.label(noGop);
print(str('no GOP\r\n'));
a.mov(REG.RSP, REG.RBP);
a.addImm32(REG.RSP, FRAME);
a.movImm32(REG.RAX, 1);
a.ret();

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
a.store64(REG.RSP, REG.R10, 32);          // 5th argument
a.callReg(REG.RAX);
a.load64(REG.R11, REG.RSP, 40);
a.mov(REG.RSP, REG.R11);
a.pop(REG.R11);
a.ret();

// -------------------------------------------------------------------- data
for (const { name, bytes } of data) {
  a.label(name);
  a.emitBytes(bytes);
}
a.label(HEX_DIGITS);
a.emitBytes(Buffer.from('0123456789abcdef', 'ascii'));

const text = a.resolve();
const image = buildUefiImage({ text, entryOffset: 0 });
fs.writeFileSync(outPath, image, { mode: 0o755 });
console.log(`[ui-probe] ${outPath} (${image.length} bytes)`);
