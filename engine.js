/**
 * Zero-Memory JS Runtime with AVX-512 ZMM State
 *
 * State lives in ZMM registers, not memory:
 * - ZMM0: Variables (8 x 64-bit slots)
 * - ZMM1: Array data
 * - ZMM2: Function table
 * - ZMM3-ZMM7: Scratch/temp
 *
 * Input streams through, transforms register state, outputs deterministically.
 *
 * This module is the single source of truth for the runtime: it emits the
 * complete streaming register-machine interpreter (dispatcher, worker stages,
 * parser, value model, syscalls) as raw x86-64 machine code via the Assembler.
 * The emitted image is linked into a static ELF64 executable by elf.js.
 */

import { Assembler, REG, COND } from './asm.js';
import { emitLoadSlot, emitStoreSlot, emitSlotIndex, emitZeroRing, RING_REGS, RING_SLOTS, RING_SCRATCH } from './ring.js';
import { queueLayout, emitEnqueue, emitIdle, emitPinCpu, emitCloneWorker, CACHE_LINE, ENTRY_SIZE } from './pipeline.js';
import { buildStaticElf64, TEXT_BASE } from './elf.js';

// FNV-1a 64-bit constants.
const FNV_OFFSET_STR = '0xcbf29ce484222325';
const FNV_PRIME_STR = '0x100000001b3';

// Pre-computed FNV-1a hashes for keywords / builtins.
const HASH_CONSOLE_STR = '0x8407807e8cea154a';
const HASH_LET_STR = '0x127284191dcc577a';
const HASH_CONST_STR = '0x65c9718e19e3df34';
const HASH_WHILE_STR = '0xce87a3885811296e';
const HASH_FOR_STR = '0xdcb27818fed9da90';
const HASH_IF_STR = '0x08b73007b55c3e26';
const HASH_ELSE_STR = '0x7f2b6c605332dd30';
const HASH_FUNCTION_STR = '0x02284cbb38b9cf89';
const HASH_RETURN_STR = '0xc5c7b983377cad5f';
const HASH_ARR_STR = '0xe756b1190570b338';
const HASH_REQUIRE_STR = '0x9336e4b8d1137564';
const HASH_FS_STR = '0x08984d07b541bede';
const HASH_READFILESYNC_STR = '0x4f9bff092a4413d4';
const HASH_WRITEFILESYNC_STR = '0xb2f182cfb8672901';
const HASH_EXISTSSYNC_STR = '0x0664cc72996ba632';
const HASH_NET_STR = '0x2138d2192571b218';
const HASH_FETCH_STR = '0x565a3fdfd862a0a3';
const HASH_CONNECT_STR = '0x54cb3aded715c1b9';
const HASH_WRITE_STR = '0xb93a12b0d06caefc';
const HASH_READ_STR = '0x4ce6531fbfddd605';
const HASH_SOCKET_CLOSE_STR = '0x9ec2699513c0f9c3';
const HASH_STATUS_STR = '0xc4d5696d6cc12c2f';
const HASH_BODY_STR = '0xcd4de79bc6c93295';
const HASH_TEXT_STR = '0xfa04f4ef1995407e';
const HASH_HEADERS_STR = '0x8cc1ca917bac9b49';
const HASH_OK_STR = '0x08b05d07b5566bef';
const HASH_LENGTH_STR = '0xea11573f1af59eb5';
const HASH_THEN_STR = '0x2579c7ef323d0d96';
const HASH_PUSH_STR = '0x6c80030e2762459d';
const HASH_POP_STR = '0x779b5819564f2f50';
const HASH_PROCESS_STR = '0x01dabe85903dc59a';
const HASH_EXIT_STR = '0xe79e4d608e807965';
const HASH_ERROR_STR = '0x9f7452dd75d54d31';
const HASH_WARN_STR = '0x5e39a0f62bea2e31';
const HASH_TRUE_STR = '0x5b5c98ef514dbfa5';
const HASH_FALSE_STR = '0xb5fae2c14238b978';
const HASH_VAR_STR = '0x690418194ed15d3e';
const HASH_WINDOW_STR = '0x71f304ea62c01cbd';
const HASH_SCREEN_STR = '0x8be4c62929b73271';
const HASH_NEW_STR = '0x2138d5192571b731';
const HASH_SETTIMEOUT_STR = '0x67f6074408609d0e';
const HASH_SETINTERVAL_STR = '0xd87e1f680a4f6b0a';
const HASH_CLEARTIMEOUT_STR = '0x77334a838b644215';
const HASH_CLEARINTERVAL_STR = '0x706e28957a4c54a7';
const HASH_WIDTH_STR = '0xdbdacd932fd1e9bf';
const HASH_HEIGHT_STR = '0x17720bf67d347222';
const HASH_SCALE_STR = '0x6aacb9fbb71a1d91';
const HASH_OPEN_STR = '0xf84f97b4633670e9';
const HASH_CREATE_STR = '0xf74e5feadea773fd';
const HASH_SHOW_STR = '0x46dc5f18e28e25bc';
const HASH_HIDE_STR = '0x736411cc9b3aa58d';
const HASH_SETTITLE_STR = '0xca950ce1393eabb3';
const HASH_FILL_STR = '0xaad01878f02a7608';
const HASH_CLEAR_STR = '0xf531f89544a910a2';
const HASH_WIN_CLOSE_STR = '0x9ec2699513c0f9c3';
const HASH_VISIBLE_STR = '0xef7ddd8b320ee821';
const HASH_MOVE_STR = '0x0d0f17a2c3f687b4';
const HASH_RECT_STR = '0x4cec6f1fbfe27147';
const HASH_BLIT_STR = '0xc56db19bc28cd9b6';
const HASH_DRAW_STR = '0xf180a666dcb87393';
const HASH_REQUESTANIMATIONFRAME_STR = '0xf612102ba926bbcd';
const HASH_SETPIXEL_STR = '0x6ca05c8a11932781';
const HASH_GETCONTEXT_STR = '0xc52af74c9a64a9fe';

// Value tags and masks.
const TAG_STRING_STR = '0xff00000000000000';
const TAG_BUFFER_STR = '0xfe00000000000000';
const TAG_SOCKET_STR = '0xfd00000000000000';
const TAG_NEG_STR = '0xfc00000000000000';   // negative integer: magnitude in low 56 bits
const TAG_ARRAY_STR = '0xfb00000000000000'; // pointer to [len][cap][elem0..]
const TAG_RESPONSE_STR = '0xfa00000000000000'; // [status][body][headers]
const TAG_WINDOW_STR = '0xf900000000000000';
const TAG_SCREEN_STR = '0xf800000000000000';
const VALUE_MASK_STR = '0x00ffffffffffffff';

const align = (n, a) => (n + a - 1) & ~(a - 1);

// Target platform. UEFI is the default; KZERO_PLATFORM=linux keeps the old
// Linux/ELF pipeline available for A/B comparison while the port settles.
export const PLATFORM = process.env.KZERO_PLATFORM === 'linux' ? 'linux' : 'uefi';
const UEFI = PLATFORM === 'uefi';

// Build-time UEFI bring-up trace: prints stage markers to ConOut so a hang can
// be localized when no debugger is attached. Off by default.
const UEFI_TRACE = UEFI && process.env.KZERO_UEFI_TRACE === '1';

// CPUID exits crash QEMU's WHPX backend on some Windows builds. Allow a test
// build to skip the capability probe and go straight to XCR0 setup.
const UEFI_CPUID_CHECK = UEFI && process.env.KZERO_UEFI_NO_CPUID !== '1';

// UEFI images are loaded at an arbitrary base, so the runtime's global state
// lives in pages reserved at this fixed address with AllocatePages(). Keep it
// away from the low firmware/DXE region and from typical PE load addresses.
export const UEFI_HEAP_BASE = 0x08000000; // 128 MiB

// Sizes (bytes).
const INPUT_CAP = 1 << 20;   // 1 MiB input script buffer
const READ_CAP = 1 << 20;    // 1 MiB per readFileSync
const HEAP_SIZE = 8 << 20;   // 8 MiB heap region (input buffer lives at its base)

// ---------------------------------------------------------------- pipeline
// Shared bss layout (offsets from the bss base):
//   [0, HEAP_SIZE)         input buffer + bump heap
//   OUT_QUEUE              dispatcher -> output worker ring
//   output stack           private 64 KiB stack for the output worker
//   output scratch         256-byte materialize_string spill area
//   output buffer          64 KiB line buffer
//   output done flag       set by the worker after the final flush
const OUT_QUEUE_CAP = 4096;
const OUT_QUEUE = queueLayout(HEAP_SIZE, OUT_QUEUE_CAP);
const OUT_STACK_SIZE = 0x10000;
const OUT_STACK_TOP = HEAP_SIZE + OUT_QUEUE.bytes + OUT_STACK_SIZE;
const OUT_SCRATCH = OUT_STACK_TOP;
const OUT_BUF = align(OUT_SCRATCH + 256, CACHE_LINE);
const OUT_BUF_CAP = 1 << 16;
const OUT_DONE = align(OUT_BUF + OUT_BUF_CAP, CACHE_LINE);

// UEFI console output is UTF-16. The formatter still produces bytes; this
// buffer is only used while handing a line to ConOut->OutputString.
const OUT_U16_CAP = OUT_BUF_CAP * 2 + 2;
const OUT_U16 = align(OUT_DONE + CACHE_LINE, CACHE_LINE);

// File worker: a 32-byte request ring, a private stack, a private bump heap
// for read results (shared memory, so buffers stay valid for the dispatcher),
// and a one-slot completion record for blocking requests.
const FILE_QUEUE_CAP = 1024;
const FILE_QUEUE = queueLayout(align(OUT_U16 + OUT_U16_CAP, CACHE_LINE), FILE_QUEUE_CAP, 32);
const FILE_STACK_SIZE = 0x10000;
const FILE_STACK_TOP = FILE_QUEUE.base + FILE_QUEUE.bytes + FILE_STACK_SIZE;
const FILE_SCRATCH = FILE_STACK_TOP;
const FILE_HEAP = align(FILE_SCRATCH + 256, CACHE_LINE);
const FILE_HEAP_SIZE = 8 << 20;
const FILE_SYNC = align(FILE_HEAP + FILE_HEAP_SIZE, CACHE_LINE);
const FILE_SEQ = FILE_SYNC;              // dispatcher's request counter
const FILE_COMPLETION = FILE_SYNC + CACHE_LINE; // [seq][value], worker writes
const FILE_COMPLETION_SEQ = FILE_COMPLETION;
const FILE_COMPLETION_VALUE = FILE_COMPLETION + 8;
const FILE_DONE = FILE_COMPLETION + CACHE_LINE;

// Network worker: same shape as the file worker, but a separate core, queue,
// stack, result heap, and completion record so file and net I/O overlap.
const NET_QUEUE_CAP = 256;
const NET_QUEUE = queueLayout(align(FILE_DONE + CACHE_LINE, CACHE_LINE), NET_QUEUE_CAP, 32);
const NET_STACK_SIZE = 0x10000;
const NET_STACK_TOP = NET_QUEUE.base + NET_QUEUE.bytes + NET_STACK_SIZE;
const NET_SCRATCH = NET_STACK_TOP;
const NET_URL_BUF = NET_SCRATCH + 256;      // parsed URL copy
const NET_URL_CAP = 4096;
const NET_HOST_BUF = NET_URL_BUF + NET_URL_CAP; // hostname copy
const NET_HOST_CAP = 256;
const NET_REQ_BUF = align(NET_HOST_BUF + NET_HOST_CAP, CACHE_LINE); // request text
const NET_REQ_CAP = 8192;
const NET_RESP_BUF = align(NET_REQ_BUF + NET_REQ_CAP, CACHE_LINE); // raw response
const NET_RESP_CAP = 1 << 20;
const NET_HEAP = align(NET_RESP_BUF + NET_RESP_CAP, CACHE_LINE);
const NET_HEAP_SIZE = 32 << 20;
const NET_SYNC = align(NET_HEAP + NET_HEAP_SIZE, CACHE_LINE);
const NET_SEQ = NET_SYNC;
const NET_COMPLETION = NET_SYNC + CACHE_LINE;
const NET_COMPLETION_SEQ = NET_COMPLETION;
const NET_COMPLETION_VALUE = NET_COMPLETION + 8;
const NET_DONE = NET_COMPLETION + CACHE_LINE;

// Input stage: the worker reads the script ahead into the input buffer and
// publishes a monotonic "safe" byte count, so the dispatcher can start parsing
// before the whole file has landed. A safe point is just past a '\n' or ';',
// which guarantees the dispatcher never sees a partial statement.
const IN_SYNC = align(NET_DONE + CACHE_LINE, CACHE_LINE);
const IN_FD = IN_SYNC;              // dispatcher stores the script fd
const IN_READY = IN_SYNC + 8;       // worker publishes the safe byte count
const IN_EOF = IN_SYNC + 16;        // worker publishes end-of-input
const IN_STACK_SIZE = 0x10000;
const IN_STACK_TOP = IN_SYNC + CACHE_LINE + IN_STACK_SIZE;

// Control-flow stack: one 24-byte frame per active block.
//   [type:u64][a:u64][b:u64]
// type 0 = loop:  a = conditionStart, b = stepStart (0 means a while loop)
// type 1 = if/else chain: a = chainEnd, b = 0
// type 2 = local function boundary
// type 3 = remote function boundary (compute worker only)
// A loop keeps its frame across iterations; an if branch pops its frame when
// the body closes and resumes at the pre-computed end of the whole chain.
//
// Every core owns a copy of the interpreter state below and addresses it
// through RBP. That lets the dispatcher and the compute worker run the same
// interpreter code at the same time without sharing call/control stacks.
const CONTROL_STACK_CAP = 1024;
const FUNC_STACK_CAP = 128;
const FUNC_SAVE_FRAME = 2048;   // 31 ring ZMM registers * 64 bytes, padded

const STATE_CONTROL_STACK = 0;
const STATE_CONTROL_DEPTH = CONTROL_STACK_CAP * 24;
const STATE_FUNC_DEPTH = STATE_CONTROL_DEPTH + 8;
const STATE_FUNC_RETVAL = STATE_FUNC_DEPTH + 8;
const STATE_FUNC_STACK = align(STATE_FUNC_RETVAL + 8, CACHE_LINE);
const STATE_FUNC_SAVE = align(STATE_FUNC_STACK + FUNC_STACK_CAP * 64, CACHE_LINE);
const STATE_CONSOLE_FD = STATE_FUNC_SAVE + FUNC_STACK_CAP * FUNC_SAVE_FRAME;
const STATE_CONSOLE_VALUE = STATE_CONSOLE_FD + 8; // console.log used as an expression
const STATE_REMOTE_OK = STATE_CONSOLE_VALUE + 8;
// UEFI platform state (unused on the Linux build).
const STATE_BOOT_SERVICES = STATE_REMOTE_OK + 8;
const STATE_SYSTEM_TABLE = STATE_BOOT_SERVICES + 8;
const STATE_CON_OUT = STATE_SYSTEM_TABLE + 8;
const STATE_IMAGE_HANDLE = STATE_CON_OUT + 8;
const STATE_SFS = STATE_IMAGE_HANDLE + 8;
const STATE_LOADED_IMAGE = STATE_SFS + 8;
const STATE_ROOT_DIR = STATE_LOADED_IMAGE + 8;
const STATE_SCRIPT_FILE = STATE_ROOT_DIR + 8;
const STATE_TIMER_EVENT = STATE_SCRIPT_FILE + 8;
const STATE_TIMER_NOW = STATE_TIMER_EVENT + 8;
const STATE_TIMER_NEXT_ID = STATE_TIMER_NOW + 8;
const STATE_TIMER_ACTIVE = STATE_TIMER_NEXT_ID + 8;
const STATE_CLOCK_TICKS = STATE_TIMER_ACTIVE + 8;
const CORE_STATE_SIZE = align(STATE_CLOCK_TICKS + 8, CACHE_LINE);

const DISPATCH_STATE = align(IN_STACK_TOP, CACHE_LINE);

// User-defined function registry. Each 192-byte entry is:
//   [nameHash][bodyStart][bodyEnd][paramCount][paramHash0..7]
//   [flags][spillMask][depCount][depSlot0..15]
// flags bit 0 = remote-eligible. spillMask selects the ZMM registers a local
// call must preserve. depSlots are ring slots the remote worker needs.
const FUNC_TABLE_CAP = 64;
const FUNC_TABLE_ENTRY = 192;
const FUNC_FLAGS = 96;
const FUNC_CALLBACK = 2;        // flags bit 1: synthetic .then callback
const FUNC_EXPR_BODY = 4;       // flags bit 2: body is a single expression
const FUNC_SPILL_MASK = 104;
const FUNC_DEP_COUNT = 112;
const FUNC_DEPS = 120;
const FUNC_TABLE = align(DISPATCH_STATE + CORE_STATE_SIZE, CACHE_LINE);
const FUNC_COUNT = FUNC_TABLE + FUNC_TABLE_CAP * FUNC_TABLE_ENTRY;

// Compute worker: one request block, one response line, a private stack, a
// private bump heap and a private interpreter state copy. The dispatcher
// writes request fields then publishes reqSeq; the worker writes the value
// then publishes respSeq. x86 store ordering makes the payload visible
// before the sequence word.
const COMP_REQ_SEQ = align(FUNC_COUNT + 8, CACHE_LINE);
const COMP_REQ = COMP_REQ_SEQ;
const COMP_REQ_ENTRY = COMP_REQ + 8;
const COMP_REQ_BODY_END = COMP_REQ + 16;
const COMP_REQ_ARGC = COMP_REQ + 24;
const COMP_REQ_ARGS = COMP_REQ + 32;       // 8 * 8
const COMP_REQ_DEPC = COMP_REQ + 96;
const COMP_REQ_DEP_SLOTS = COMP_REQ + 104; // 16 bytes
const COMP_REQ_DEP_VALUES = COMP_REQ + 120; // 16 * 8
// Field offsets relative to COMP_REQ, for code that already holds the request
// base in a register.
const REQ_ENTRY = COMP_REQ_ENTRY - COMP_REQ;
const REQ_BODY_END = COMP_REQ_BODY_END - COMP_REQ;
const REQ_ARGC = COMP_REQ_ARGC - COMP_REQ;
const REQ_ARGS = COMP_REQ_ARGS - COMP_REQ;
const REQ_DEPC = COMP_REQ_DEPC - COMP_REQ;
const REQ_DEP_SLOTS = COMP_REQ_DEP_SLOTS - COMP_REQ;
const REQ_DEP_VALUES = COMP_REQ_DEP_VALUES - COMP_REQ;
const COMP_RESP_SEQ = align(COMP_REQ + 256, CACHE_LINE);
const COMP_RESP_VALUE = COMP_RESP_SEQ + 8;
const COMP_STACK_SIZE = 0x20000;
const COMP_STACK_TOP = align(COMP_RESP_SEQ + CACHE_LINE, CACHE_LINE) + COMP_STACK_SIZE;
const COMP_HEAP = align(COMP_STACK_TOP, CACHE_LINE);
const COMP_HEAP_SIZE = 8 << 20;
const WORKER_STATE = align(COMP_HEAP + COMP_HEAP_SIZE, CACHE_LINE);

// Timer registry. Entry layout:
//   [id:u64][kind:u64][due:u64][interval:u64][funcEntry:u64]
// kind 0 = free, 1 = timeout, 2 = interval. `due` is in milliseconds on the
// runtime's software clock, which the UEFI event loop advances with Stall().
const TIMER_TABLE_CAP = 64;
const TIMER_ENTRY = 40;
const TIMER_TABLE = align(WORKER_STATE + CORE_STATE_SIZE, CACHE_LINE);
const TIMER_END = TIMER_TABLE + TIMER_TABLE_CAP * TIMER_ENTRY;

// UEFI script path (UTF-16) and a small read scratch area. The script itself
// is loaded straight into the input buffer at the bss base.
const SCRIPT_PATH_CAP = 1024; // bytes = 512 UTF-16 characters
const SCRIPT_PATH = align(TIMER_END, CACHE_LINE);
const UEFI_SCRATCH = SCRIPT_PATH + SCRIPT_PATH_CAP;

const BSS_SIZE = align(UEFI_SCRATCH + 256, 0x1000);

// Physical cores: dispatcher 0, input 2, file 4, net 6, output 8, compute 10.
// KZERO_SINGLE_CORE=1 collapses every stage onto core 0 for A/B measurement.
const SINGLE_CORE = process.env.KZERO_SINGLE_CORE === '1';
const CPU_DISPATCH = 0;
const CPU_INPUT = SINGLE_CORE ? 0 : 2;
const CPU_FILE = SINGLE_CORE ? 0 : 4;
const CPU_NET = SINGLE_CORE ? 0 : 6;
const CPU_OUTPUT = SINGLE_CORE ? 0 : 8;
const CPU_COMPUTE = SINGLE_CORE ? 0 : 10;

// Output queue entry kinds. Stderr variants are the stdout kind + OUT_KIND_ERR,
// so console_emit can route a whole argument list with a single add.
const OUT_KIND_VALUE = 0;   // value word + newline
const OUT_KIND_NL = 1;      // newline only
const OUT_KIND_EXIT = 2;    // drain and stop
const OUT_KIND_RAW = 3;     // value word, no newline
const OUT_KIND_SPACE = 4;   // a single space separator
const OUT_KIND_ERR = 5;     // + this to target fd 2

// File request operations.
const FILE_OP_READ = 1;     // path -> buffer value (blocking)
const FILE_OP_WRITE = 2;    // path, data -> fire-and-forget
const FILE_OP_EXISTS = 3;   // path -> 0/1 (blocking)
const FILE_OP_EXIT = 4;     // drain and stop

// Network request operations.
const NET_OP_CONNECT = 1;   // port, host -> socket value (blocking)
const NET_OP_WRITE = 2;     // fd, data -> fire-and-forget
const NET_OP_READ = 3;      // fd -> buffer value (blocking)
const NET_OP_CLOSE = 4;     // fd -> fire-and-forget
const NET_OP_EXIT = 5;      // drain and stop
const NET_OP_FETCH = 6;     // url value -> response object (blocking)

// If KZERO_SOURCE is set, embed it and skip runtime input loading.
const TEST_SOURCE = process.env.KZERO_SOURCE ?? null;

// Emit the native fetch transaction that runs on the network worker. The
// dispatcher hands over one URL value and blocks for the response object, so
// the whole HTTP exchange (URL parse, DNS, connect, request, read loop,
// status/header split) happens behind a single queue round trip.
function emitNetFetch(a, heapBase) {
  const URL_OFF = NET_URL_BUF - NET_SCRATCH;
  const HOST_OFF = NET_HOST_BUF - NET_SCRATCH;
  const REQ_OFF = NET_REQ_BUF - NET_SCRATCH;
  const RESP_OFF = NET_RESP_BUF - NET_SCRATCH;

  // Small state slots inside the 256-byte net scratch area.
  const S_HOSTLEN = 120;
  const S_PATHLEN = 128;
  const S_HTTPS = 136;
  const S_STATUS = 144;
  const S_ERR = 152;
  const S_OPTLEN = 160;
  const S_PORTPTR = 168;
  const S_PATHP = 176;
  const S_FD = 184;
  const S_HDRLEN = 208;
  const S_BODYLEN = 216;
  const S_RESPLEN = 232;
  const S_IP = 200;
  const S_DEFAULT_PATH = 240;
  const S_REDIR = 248;      // redirects followed so far
  const S_TMP_DIGITS = 192; // port digits for relative redirects
  const S_TMP_COUNT = 224;  // digit count / loop scratch
  const S_DNSSA = 64;
  const S_TARGETSA = 96;

  // HTTPS helper-pipe state (areas not used by any other scratch slot).
  const S_PIPE_REQ = 16;    // pipe2() writes two ints at +16/+20
  const S_PIPE_RESP = 24;   // pipe2() writes two ints at +24/+28
  const S_REQR = 32;
  const S_REQW = 40;
  const S_RESPR = 48;
  const S_RESPW = 56;
  const S_CHILD = 80;

  const TLS_CONNECT_OFF = 0;   // inside the URL buffer, after request build
  const TLS_ARGV_OFF = 512;    // 8 pointers

  a.label('nw_fetch');
  a.load64(REG.RAX, REG.R10, 16);   // URL value

  // Only strings are valid URLs; reject integers and objects before they are
  // materialized and dereferenced.
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xff);        // heap string
  a.jcc(COND.E, 'nf_type_ok');
  a.mov(REG.RDX, REG.RCX);
  a.andImm8(REG.RDX, 0xf8);
  a.cmpImm32(REG.RDX, 0xf0);        // inline string (0xf0..0xf7)
  a.jcc(COND.NE, 'nf_fail');
  a.label('nf_type_ok');

  a.mov(REG.R14, REG.R13);          // inline string spill area
  a.call('materialize_string');     // RAX = bytes, RDX = length
  a.mov(REG.R14, REG.R12);          // restore result allocator

  // Copy the URL into the parse buffer and NUL-terminate it.
  a.mov(REG.RSI, REG.RAX);
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, URL_OFF);
  a.mov(REG.RCX, REG.RDX);
  a.cmpImm32(REG.RCX, NET_URL_CAP - 1);
  a.jcc(COND.LE, 'nf_copy_len');
  a.movImm32(REG.RCX, NET_URL_CAP - 1);
  a.label('nf_copy_len');
  a.label('nf_copy_loop');
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'nf_copy_done');
  a.load8(REG.RAX, REG.RSI, 0);
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.RDI);
  a.dec(REG.RCX);
  a.jmp('nf_copy_loop');
  a.label('nf_copy_done');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 0);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_REDIR);
  a.store64(REG.R8, REG.RAX, 0);

  // Scheme: only http:// and https:// are understood.
  a.label('nf_reparse');
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, URL_OFF);
  a.load64(REG.RAX, REG.R11, 0);
  a.movImm64(REG.RDX, '0x00ffffffffffffff'); // compare 7 bytes: "http://"
  a.and(REG.RAX, REG.RDX);
  a.movImm64(REG.RCX, '0x002f2f3a70747468');
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.E, 'nf_scheme_http');
  a.load64(REG.RAX, REG.R11, 0);
  a.movImm64(REG.RCX, '0x2f2f3a7370747468'); // "https://"
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.E, 'nf_scheme_https');
  a.jmp('nf_fail');

  a.label('nf_scheme_http');
  a.mov(REG.R8, REG.R11);
  a.addImm32(REG.R8, 7);
  a.xor(REG.RAX, REG.RAX);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HTTPS);
  a.store64(REG.RCX, REG.RAX, 0);
  a.movImm32(REG.RDX, 80);
  a.jmp('nf_host_copy');

  a.label('nf_scheme_https');
  a.mov(REG.R8, REG.R11);
  a.addImm32(REG.R8, 8);
  a.movImm32(REG.RAX, 1);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HTTPS);
  a.store64(REG.RCX, REG.RAX, 0);
  a.movImm32(REG.RDX, 443);

  // Copy the hostname into its own buffer; parse ":" port and "/" path.
  a.label('nf_host_copy');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, HOST_OFF);
  a.xor(REG.RBX, REG.RBX);
  a.label('nf_host_loop');
  a.load8(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_host_end');
  a.cmpImm8(REG.RAX, 58);           // ':'
  a.jcc(COND.E, 'nf_host_port');
  a.cmpImm8(REG.RAX, 47);           // '/'
  a.jcc(COND.E, 'nf_host_path');
  a.cmpImm32(REG.RBX, NET_HOST_CAP - 1);
  a.jcc(COND.GE, 'nf_fail');
  a.store8(REG.R9, REG.RAX, 0);
  a.inc(REG.R9);
  a.inc(REG.RBX);
  a.inc(REG.R8);
  a.jmp('nf_host_loop');

  a.label('nf_host_end');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 0);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HOSTLEN);
  a.store64(REG.RCX, REG.RBX, 0);
  a.jmp('nf_default_path');

  a.label('nf_host_port');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 0);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HOSTLEN);
  a.store64(REG.RCX, REG.RBX, 0);
  a.inc(REG.R8);                    // skip ':'
  a.xor(REG.RDX, REG.RDX);
  a.label('nf_port_loop');
  a.load8(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_default_path');
  a.cmpImm8(REG.RAX, 47);           // '/'
  a.jcc(COND.E, 'nf_path_start');
  a.cmpImm8(REG.RAX, 48);
  a.jcc(COND.L, 'nf_fail');
  a.cmpImm8(REG.RAX, 57);
  a.jcc(COND.G, 'nf_fail');
  a.movImm32(REG.RCX, 10);
  a.imul(REG.RDX, REG.RCX);
  a.subImm32(REG.RAX, 48);
  a.add(REG.RDX, REG.RAX);
  a.inc(REG.R8);
  a.jmp('nf_port_loop');

  a.label('nf_host_path');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 0);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HOSTLEN);
  a.store64(REG.RCX, REG.RBX, 0);
  a.jmp('nf_path_start');

  a.label('nf_default_path');
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, S_DEFAULT_PATH);
  a.movImm32(REG.RAX, 47);          // '/'
  a.store8(REG.RSI, REG.RAX, 0);
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RSI, REG.RAX, 1);
  a.movImm32(REG.RCX, 1);
  a.jmp('nf_path_ready');

  a.label('nf_path_start');
  a.mov(REG.RSI, REG.R8);
  a.xor(REG.RCX, REG.RCX);
  a.label('nf_path_len');
  a.load8(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_path_ready');
  a.inc(REG.RCX);
  a.inc(REG.R8);
  a.jmp('nf_path_len');

  a.label('nf_path_ready');
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_PATHLEN);
  a.store64(REG.R8, REG.RCX, 0);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_PATHP);
  a.store64(REG.R8, REG.RSI, 0);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_PORTPTR);
  a.store64(REG.R8, REG.RDX, 0);

  // HTTPS is delegated to the external s_client helper, which resolves the
  // host itself, so skip the native resolver entirely.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_HTTPS);
  a.load64(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_tls');

  // Resolve the host into four address bytes at S_IP.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, HOST_OFF);
  a.load64(REG.RAX, REG.R8, 0);
  a.movImm64(REG.RCX, '0x736f686c61636f6c'); // "localhos"
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.NE, 'nf_check_ip');
  a.load8(REG.RAX, REG.R8, 8);
  a.cmpImm8(REG.RAX, 116);          // 't'
  a.jcc(COND.NE, 'nf_check_ip');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_IP);
  a.movImm32(REG.RAX, 127);
  a.store8(REG.R9, REG.RAX, 0);
  a.movImm32(REG.RAX, 1);
  a.store8(REG.R9, REG.RAX, 3);
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 1);
  a.store8(REG.R9, REG.RAX, 2);
  a.jmp('nf_ip_ready');

  a.label('nf_check_ip');
  a.load8(REG.RAX, REG.R8, 0);
  a.cmpImm8(REG.RAX, 48);
  a.jcc(COND.L, 'nf_dns');
  a.cmpImm8(REG.RAX, 57);
  a.jcc(COND.G, 'nf_dns');

  // Only treat the host as an IPv4 literal when every character is a digit or
  // a dot. Digit-leading names such as "1.example.com" fall through to DNS.
  a.mov(REG.RBX, REG.R8);
  a.label('nf_ipv4_scan');
  a.load8(REG.RAX, REG.RBX, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_ipv4_ok');
  a.cmpImm8(REG.RAX, 46);           // '.'
  a.jcc(COND.E, 'nf_ipv4_next');
  a.cmpImm8(REG.RAX, 48);
  a.jcc(COND.L, 'nf_dns');
  a.cmpImm8(REG.RAX, 57);
  a.jcc(COND.G, 'nf_dns');
  a.label('nf_ipv4_next');
  a.inc(REG.RBX);
  a.jmp('nf_ipv4_scan');
  a.label('nf_ipv4_ok');

  // Dotted IPv4 literal.
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_IP);
  a.xor(REG.RCX, REG.RCX);          // octet index
  a.xor(REG.RDX, REG.RDX);          // current octet
  a.label('nf_ip_loop');
  a.load8(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_ip_last');
  a.cmpImm8(REG.RAX, 46);           // '.'
  a.jcc(COND.E, 'nf_ip_store');
  a.cmpImm8(REG.RAX, 48);
  a.jcc(COND.L, 'nf_fail');
  a.cmpImm8(REG.RAX, 57);
  a.jcc(COND.G, 'nf_fail');
  a.movImm32(REG.RBX, 10);
  a.imul(REG.RDX, REG.RBX);
  a.subImm32(REG.RAX, 48);
  a.add(REG.RDX, REG.RAX);
  a.inc(REG.R8);
  a.jmp('nf_ip_loop');
  a.label('nf_ip_store');
  a.mov(REG.RBX, REG.R9);
  a.add(REG.RBX, REG.RCX);
  a.store8(REG.RBX, REG.RDX, 0);
  a.inc(REG.RCX);
  a.cmpImm32(REG.RCX, 4);
  a.jcc(COND.GE, 'nf_fail');
  a.xor(REG.RDX, REG.RDX);
  a.inc(REG.R8);
  a.jmp('nf_ip_loop');
  a.label('nf_ip_last');
  a.mov(REG.RBX, REG.R9);
  a.add(REG.RBX, REG.RCX);
  a.store8(REG.RBX, REG.RDX, 0);
  a.cmpImm32(REG.RCX, 3);
  a.jcc(COND.NE, 'nf_fail');
  a.jmp('nf_ip_ready');

  // Resolve a hostname through Cloudflare's public DNS (1.1.1.1:53).
  a.label('nf_dns');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, REQ_OFF);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RDI, REG.RAX, 0);
  a.store64(REG.RDI, REG.RAX, 8);
  a.movImm32(REG.RAX, 0x12);        // transaction id
  a.store8(REG.RDI, REG.RAX, 0);
  a.movImm32(REG.RAX, 0x34);
  a.store8(REG.RDI, REG.RAX, 1);
  a.movImm32(REG.RAX, 1);           // RD flag
  a.store8(REG.RDI, REG.RAX, 2);
  a.store8(REG.RDI, REG.RAX, 4);    // QDCOUNT = 1
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 3);
  a.store8(REG.RDI, REG.RAX, 5);

  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, HOST_OFF);
  a.mov(REG.R9, REG.RDI);
  a.addImm32(REG.R9, 12);           // qname cursor
  a.label('nf_dns_label');
  a.load8(REG.RAX, REG.RSI, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_dns_labels_done');
  a.mov(REG.RBX, REG.RSI);
  a.xor(REG.RCX, REG.RCX);
  a.label('nf_dns_label_scan');
  a.load8(REG.RAX, REG.RBX, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_dns_label_end');
  a.cmpImm8(REG.RAX, 46);           // '.'
  a.jcc(COND.E, 'nf_dns_label_end');
  a.inc(REG.RBX);
  a.inc(REG.RCX);
  a.jmp('nf_dns_label_scan');
  a.label('nf_dns_label_end');
  a.store8(REG.R9, REG.RCX, 0);
  a.inc(REG.R9);
  a.label('nf_dns_label_copy');
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'nf_dns_label_copied');
  a.load8(REG.RAX, REG.RSI, 0);
  a.store8(REG.R9, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.R9);
  a.dec(REG.RCX);
  a.jmp('nf_dns_label_copy');
  a.label('nf_dns_label_copied');
  a.load8(REG.RAX, REG.RSI, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_dns_labels_done');
  a.inc(REG.RSI);                   // skip '.'
  a.jmp('nf_dns_label');
  a.label('nf_dns_labels_done');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 0);     // root label
  a.inc(REG.R9);
  a.store8(REG.R9, REG.RAX, 0);     // QTYPE hi
  a.movImm32(REG.RAX, 1);
  a.store8(REG.R9, REG.RAX, 1);     // QTYPE lo = A
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 2);     // QCLASS hi
  a.movImm32(REG.RAX, 1);
  a.store8(REG.R9, REG.RAX, 3);     // QCLASS lo = IN
  a.addImm32(REG.R9, 4);

  // sockaddr_in for 1.1.1.1:53 at S_DNSSA.
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, S_DNSSA);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RSI, REG.RAX, 0);
  a.store64(REG.RSI, REG.RAX, 8);
  a.movImm32(REG.RAX, 2);
  a.store8(REG.RSI, REG.RAX, 0);    // AF_INET
  a.movImm32(REG.RAX, 53);
  a.store8(REG.RSI, REG.RAX, 3);    // port low byte (00 35)
  a.movImm32(REG.RAX, 1);
  a.store8(REG.RSI, REG.RAX, 4);
  a.store8(REG.RSI, REG.RAX, 5);
  a.store8(REG.RSI, REG.RAX, 6);
  a.store8(REG.RSI, REG.RAX, 7);

  a.movImm32(REG.RAX, 41);          // socket(AF_INET, SOCK_DGRAM, 0)
  a.movImm32(REG.RDI, 2);
  a.movImm32(REG.RSI, 2);
  a.xor(REG.RDX, REG.RDX);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_fail');
  a.mov(REG.RDI, REG.RAX);          // udp fd
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_FD);
  a.store64(REG.R8, REG.RDI, 0);

  a.movImm32(REG.RAX, 44);          // sendto
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, REQ_OFF);
  a.mov(REG.RDX, REG.R9);
  a.sub(REG.RDX, REG.RSI);          // query length
  a.xor(REG.R10, REG.R10);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_DNSSA);
  a.movImm32(REG.R9, 16);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_dns_close_fail');

  // poll(fd, POLLIN, 2000ms) so a blocked resolver cannot hang the process.
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, 224);
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.store64(REG.RSI, REG.RDI, 0);
  a.movImm32(REG.RAX, 1);
  a.store8(REG.RSI, REG.RAX, 4);    // events = POLLIN
  a.movImm32(REG.RAX, 7);           // poll
  a.mov(REG.RDI, REG.RSI);
  a.movImm32(REG.RSI, 1);
  a.movImm32(REG.RDX, 2000);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.LE, 'nf_dns_close_fail');

  a.movImm32(REG.RAX, 45);          // recvfrom
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, RESP_OFF);
  a.movImm32(REG.RDX, 512);
  a.xor(REG.R10, REG.R10);
  a.xor(REG.R8, REG.R8);
  a.xor(REG.R9, REG.R9);
  a.syscall();
  a.mov(REG.RBX, REG.RAX);          // dns response length

  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);           // close
  a.syscall();
  a.cmpImm32(REG.RBX, 12);
  a.jcc(COND.L, 'nf_fail');

  // Validate the transaction id and RCODE so a stray or error response cannot
  // be mistaken for an answer.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, RESP_OFF);
  a.load8(REG.RAX, REG.R8, 0);
  a.cmpImm8(REG.RAX, 0x12);
  a.jcc(COND.NE, 'nf_fail');
  a.load8(REG.RAX, REG.R8, 1);
  a.cmpImm8(REG.RAX, 0x34);
  a.jcc(COND.NE, 'nf_fail');
  a.load8(REG.RAX, REG.R8, 3);
  a.andImm32(REG.RAX, 0x0f);        // RCODE
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_fail');

  // Header: ANCOUNT at bytes 6..7.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, RESP_OFF);
  a.load8(REG.RAX, REG.R8, 6);
  a.mov(REG.R9, REG.RAX);
  a.shlImm8(REG.R9, 8);
  a.load8(REG.RAX, REG.R8, 7);
  a.or(REG.R9, REG.RAX);
  a.test(REG.R9, REG.R9);
  a.jcc(COND.Z, 'nf_fail');
  a.mov(REG.RDI, REG.R9);           // answer count

  a.mov(REG.RSI, REG.R8);
  a.addImm32(REG.RSI, 12);
  a.call('nf_skip_name');
  a.addImm32(REG.RSI, 4);           // skip QTYPE/QCLASS

  a.label('nf_dns_answer_loop');
  a.test(REG.RDI, REG.RDI);
  a.jcc(COND.Z, 'nf_fail');
  a.call('nf_skip_name');
  a.load8(REG.RAX, REG.RSI, 0);
  a.shlImm8(REG.RAX, 8);
  a.load8(REG.RCX, REG.RSI, 1);
  a.or(REG.RAX, REG.RCX);           // TYPE
  a.load8(REG.RCX, REG.RSI, 8);
  a.shlImm8(REG.RCX, 8);
  a.load8(REG.RDX, REG.RSI, 9);
  a.or(REG.RCX, REG.RDX);           // RDLENGTH
  a.cmpImm32(REG.RAX, 1);           // A record
  a.jcc(COND.NE, 'nf_dns_next');
  a.cmpImm32(REG.RCX, 4);
  a.jcc(COND.NE, 'nf_dns_next');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_IP);
  a.load8(REG.RAX, REG.RSI, 10);
  a.store8(REG.R9, REG.RAX, 0);
  a.load8(REG.RAX, REG.RSI, 11);
  a.store8(REG.R9, REG.RAX, 1);
  a.load8(REG.RAX, REG.RSI, 12);
  a.store8(REG.R9, REG.RAX, 2);
  a.load8(REG.RAX, REG.RSI, 13);
  a.store8(REG.R9, REG.RAX, 3);
  a.jmp('nf_ip_ready');
  a.label('nf_dns_next');
  a.addImm32(REG.RSI, 10);
  a.add(REG.RSI, REG.RCX);
  a.dec(REG.RDI);
  a.jmp('nf_dns_answer_loop');

  // HTTPS takes the helper path; plaintext is never sent for an HTTPS URL.
  a.label('nf_ip_ready');
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_HTTPS);
  a.load64(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_tls');

  // Target sockaddr_in at S_TARGETSA.
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, S_TARGETSA);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RSI, REG.RAX, 0);
  a.store64(REG.RSI, REG.RAX, 8);
  a.movImm32(REG.RAX, 2);
  a.store8(REG.RSI, REG.RAX, 0);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_PORTPTR);
  a.load64(REG.RDX, REG.RCX, 0);
  a.mov(REG.RAX, REG.RDX);
  a.shrImm8(REG.RAX, 8);
  a.store8(REG.RSI, REG.RAX, 2);
  a.mov(REG.RAX, REG.RDX);
  a.andImm32(REG.RAX, 0xff);
  a.store8(REG.RSI, REG.RAX, 3);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_IP);
  a.load8(REG.RAX, REG.R9, 0);
  a.store8(REG.RSI, REG.RAX, 4);
  a.load8(REG.RAX, REG.R9, 1);
  a.store8(REG.RSI, REG.RAX, 5);
  a.load8(REG.RAX, REG.R9, 2);
  a.store8(REG.RSI, REG.RAX, 6);
  a.load8(REG.RAX, REG.R9, 3);
  a.store8(REG.RSI, REG.RAX, 7);

  a.movImm32(REG.RAX, 41);          // socket(AF_INET, SOCK_STREAM, 0)
  a.movImm32(REG.RDI, 2);
  a.movImm32(REG.RSI, 1);
  a.xor(REG.RDX, REG.RDX);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_fail');
  a.mov(REG.RDI, REG.RAX);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_FD);
  a.store64(REG.R8, REG.RDI, 0);

  // Non-blocking connect with a bounded wait, so an unreachable or filtered
  // host cannot block the net worker forever.
  a.movImm32(REG.RAX, 72);          // fcntl(fd, F_SETFL, O_NONBLOCK)
  a.movImm32(REG.RSI, 4);
  a.movImm32(REG.RDX, 0x800);
  a.syscall();

  a.movImm32(REG.RAX, 42);          // connect
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, S_TARGETSA);
  a.movImm32(REG.RDX, 16);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.GE, 'nf_connect_done');
  a.cmpImm32(REG.RAX, -115);        // -EINPROGRESS
  a.jcc(COND.NE, 'nf_close_fail');

  // poll(fd, POLLOUT, 5000ms)
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, 224);
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.store64(REG.RSI, REG.RDI, 0);
  a.movImm32(REG.RAX, 4);           // POLLOUT
  a.store8(REG.RSI, REG.RAX, 4);
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RSI, REG.RAX, 6);    // revents = 0
  a.store8(REG.RSI, REG.RAX, 7);
  a.movImm32(REG.RAX, 7);           // poll
  a.mov(REG.RDI, REG.RSI);
  a.movImm32(REG.RSI, 1);
  a.movImm32(REG.RDX, 5000);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.LE, 'nf_close_fail');

  // getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &optlen)
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_ERR);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.R9, REG.RAX, 0);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_OPTLEN);
  a.movImm32(REG.RAX, 4);
  a.store64(REG.R9, REG.RAX, 0);
  a.movImm32(REG.RAX, 55);          // getsockopt
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RSI, 1);           // SOL_SOCKET
  a.movImm32(REG.RDX, 4);           // SO_ERROR
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_ERR);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_OPTLEN);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_close_fail');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_ERR);
  a.load64(REG.RAX, REG.R9, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_close_fail');

  a.label('nf_connect_done');
  // Restore blocking mode: the read loop relies on EOF semantics.
  a.movImm32(REG.RAX, 72);          // fcntl(fd, F_SETFL, 0)
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RSI, 4);
  a.xor(REG.RDX, REG.RDX);
  a.syscall();
  a.jmp('nf_request_build');

  // ---------------------------------------------------------------- HTTPS
  // Run `openssl s_client -quiet` behind two pipes: the parent writes the
  // plaintext HTTP request to the helper's stdin and reads the decrypted
  // response from its stdout. TLS and certificate validation live in OpenSSL;
  // the runtime never implements crypto and never sends HTTPS as plaintext.
  a.label('nf_tls');

  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_PIPE_REQ);
  a.xor(REG.RSI, REG.RSI);
  a.movImm32(REG.RAX, 293);         // pipe2
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_fail');

  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_PIPE_RESP);
  a.xor(REG.RSI, REG.RSI);
  a.movImm32(REG.RAX, 293);         // pipe2
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_fail');

  // Split the packed descriptor pairs into 64-bit scratch slots.
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_PIPE_REQ);
  a.load64(REG.RAX, REG.R9, 0);
  a.mov(REG.R10, REG.RAX);
  a.movImm64(REG.RDX, '0xffffffff');
  a.and(REG.R10, REG.RDX);
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, S_REQR);
  a.store64(REG.R11, REG.R10, 0);
  a.shrImm8(REG.RAX, 32);
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, S_REQW);
  a.store64(REG.R11, REG.RAX, 0);

  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_PIPE_RESP);
  a.load64(REG.RAX, REG.R9, 0);
  a.mov(REG.R10, REG.RAX);
  a.movImm64(REG.RDX, '0xffffffff');
  a.and(REG.R10, REG.RDX);
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, S_RESPR);
  a.store64(REG.R11, REG.R10, 0);
  a.shrImm8(REG.RAX, 32);
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, S_RESPW);
  a.store64(REG.R11, REG.RAX, 0);

  a.movImm32(REG.RAX, 57);          // fork
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_fail');
  a.jcc(COND.Z, 'nf_tls_child');

  // Parent: keep request-write and response-read; close the other ends.
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_CHILD);
  a.store64(REG.R9, REG.RAX, 0);
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_REQR);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_RESPW);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_REQW);
  a.load64(REG.RAX, REG.R9, 0);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_FD);
  a.store64(REG.R8, REG.RAX, 0);
  a.jmp('nf_request_build');

  // Child: wire stdin/stdout to the pipes, suppress diagnostics, exec.
  a.label('nf_tls_child');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_REQR);
  a.load64(REG.RDI, REG.RDI, 0);
  a.xor(REG.RSI, REG.RSI);
  a.movImm32(REG.RAX, 33);          // dup2(req read, 0)
  a.syscall();
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_RESPW);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RSI, 1);
  a.movImm32(REG.RAX, 33);          // dup2(resp write, 1)
  a.syscall();

  a.leaRip(REG.RDI, 'tls_devnull');
  a.movImm32(REG.RSI, 1);           // O_WRONLY
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, 2);           // open
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nf_tls_child_exec');
  a.mov(REG.RDI, REG.RAX);
  a.movImm32(REG.RSI, 2);
  a.movImm32(REG.RAX, 33);          // dup2(/dev/null, 2)
  a.syscall();
  a.movImm32(REG.RAX, 3);           // close(null fd); RDI still holds it
  a.syscall();

  a.label('nf_tls_child_exec');
  // Connect string "host:port" in the URL buffer.
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, URL_OFF + TLS_CONNECT_OFF);
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, HOST_OFF);
  a.label('nf_tls_host_copy');
  a.load8(REG.RAX, REG.RSI, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_tls_host_done');
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.RDI);
  a.jmp('nf_tls_host_copy');
  a.label('nf_tls_host_done');
  a.movImm32(REG.RAX, 58);          // ':'
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RDI);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_PORTPTR);
  a.load64(REG.RAX, REG.R9, 0);
  a.xor(REG.RBX, REG.RBX);
  a.label('nf_tls_port_digit');
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.R8, 10);
  a.divReg(REG.R8);
  a.push(REG.RDX);
  a.inc(REG.RBX);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_tls_port_digit');
  a.label('nf_tls_port_pop');
  a.pop(REG.RDX);
  a.addImm32(REG.RDX, 48);
  a.store8(REG.RDI, REG.RDX, 0);
  a.inc(REG.RDI);
  a.dec(REG.RBX);
  a.jcc(COND.NZ, 'nf_tls_port_pop');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 0);

  // argv = { "openssl", "s_client", "-quiet", "-connect", "host:port",
  //          "-servername", host, NULL }
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, URL_OFF + TLS_ARGV_OFF);
  a.leaRip(REG.RAX, 'tls_argv0');
  a.store64(REG.R9, REG.RAX, 0);
  a.leaRip(REG.RAX, 'tls_s_client');
  a.store64(REG.R9, REG.RAX, 8);
  a.leaRip(REG.RAX, 'tls_quiet');
  a.store64(REG.R9, REG.RAX, 16);
  a.leaRip(REG.RAX, 'tls_connect');
  a.store64(REG.R9, REG.RAX, 24);
  a.mov(REG.RAX, REG.R13);
  a.addImm32(REG.RAX, URL_OFF + TLS_CONNECT_OFF);
  a.store64(REG.R9, REG.RAX, 32);
  a.leaRip(REG.RAX, 'tls_servername');
  a.store64(REG.R9, REG.RAX, 40);
  a.mov(REG.RAX, REG.R13);
  a.addImm32(REG.RAX, HOST_OFF);
  a.store64(REG.R9, REG.RAX, 48);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.R9, REG.RAX, 56);

  a.leaRip(REG.RDI, 'tls_openssl');
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, URL_OFF + TLS_ARGV_OFF);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, 59);          // execve
  a.syscall();
  a.movImm32(REG.RDI, 1);
  a.movImm32(REG.RAX, 60);          // exit(1) if exec failed
  a.syscall();
  a.jmp('nf_fail');

  // Build the request: "GET <path> HTTP/1.0\r\nHost: <host>[:port]\r\n
  // Connection: close\r\n\r\n".
  a.label('nf_request_build');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, REQ_OFF);

  a.leaRip(REG.RSI, 'net_http_get');
  a.movImm32(REG.RCX, 4);
  a.call('nf_append');

  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_PATHP);
  a.load64(REG.RSI, REG.RCX, 0);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_PATHLEN);
  a.load64(REG.RCX, REG.RCX, 0);
  a.call('nf_append');

  a.leaRip(REG.RSI, 'net_http_mid');
  a.movImm32(REG.RCX, 17);
  a.call('nf_append');

  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, HOST_OFF);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HOSTLEN);
  a.load64(REG.RCX, REG.RCX, 0);
  a.call('nf_append');

  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_PORTPTR);
  a.load64(REG.RDX, REG.RCX, 0);
  a.cmpImm32(REG.RDX, 80);
  a.jcc(COND.E, 'nf_req_tail');
  a.movImm32(REG.RAX, 58);          // ':'
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RDI);
  a.mov(REG.RAX, REG.RDX);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.R8, 10);
  a.xor(REG.RBX, REG.RBX);          // digit count
  a.label('nf_port_digit');
  a.xor(REG.RDX, REG.RDX);
  a.divReg(REG.R8);
  a.push(REG.RDX);
  a.inc(REG.RBX);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_port_digit');
  a.label('nf_port_pop');
  a.pop(REG.RDX);
  a.addImm32(REG.RDX, 48);
  a.store8(REG.RDI, REG.RDX, 0);
  a.inc(REG.RDI);
  a.dec(REG.RBX);
  a.jcc(COND.NZ, 'nf_port_pop');

  a.label('nf_req_tail');
  a.leaRip(REG.RSI, 'net_http_tail');
  a.movImm32(REG.RCX, 23);
  a.call('nf_append');

  a.mov(REG.RBX, REG.RDI);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, REQ_OFF);
  a.sub(REG.RBX, REG.RCX);          // request length

  // Write the whole request, handling short writes.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, REQ_OFF);
  a.label('nf_write_loop');
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.Z, 'nf_write_done');
  a.movImm32(REG.RAX, 1);           // write
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.mov(REG.RSI, REG.R8);
  a.mov(REG.RDX, REG.RBX);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.LE, 'nf_close_fail');
  a.add(REG.R8, REG.RAX);
  a.sub(REG.RBX, REG.RAX);
  a.jmp('nf_write_loop');
  a.label('nf_write_done');

  // HTTPS: the request now lives in the helper's stdin buffer. Close the
  // write end so s_client sees EOF, then read the decrypted bytes from the
  // response pipe.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_HTTPS);
  a.load64(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_read_start');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);           // close(req write)
  a.syscall();
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_RESPR);
  a.load64(REG.RAX, REG.R9, 0);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_FD);
  a.store64(REG.R8, REG.RAX, 0);

  // Read until EOF (Connection: close) or the response buffer is full.
  a.label('nf_read_start');
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, RESP_OFF);
  a.movImm32(REG.RBX, NET_RESP_CAP);
  a.label('nf_read_loop');
  a.movImm32(REG.RAX, 0);           // read
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.mov(REG.RSI, REG.R8);
  a.mov(REG.RDX, REG.RBX);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.LE, 'nf_read_done');
  a.add(REG.R8, REG.RAX);
  a.sub(REG.RBX, REG.RAX);
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.Z, 'nf_read_done');
  a.jmp('nf_read_loop');
  a.label('nf_read_done');

  // Persist the response length before the HTTPS reaper clobbers R8.
  a.mov(REG.RBX, REG.R8);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, RESP_OFF);
  a.sub(REG.RBX, REG.RCX);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_RESPLEN);
  a.store64(REG.R9, REG.RBX, 0);

  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);           // close
  a.syscall();

  // Reap the HTTPS helper so repeated fetches do not accumulate zombies.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_HTTPS);
  a.load64(REG.RAX, REG.R8, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_parse_start');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_CHILD);
  a.load64(REG.RDI, REG.R9, 0);
  a.xor(REG.RSI, REG.RSI);
  a.xor(REG.RDX, REG.RDX);
  a.xor(REG.R10, REG.R10);
  a.movImm32(REG.RAX, 61);          // wait4
  a.syscall();
  a.label('nf_parse_start');

  // Response length.
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_RESPLEN);
  a.load64(REG.RBX, REG.R9, 0);

  // Status code: after the first space in the status line.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, RESP_OFF);
  a.mov(REG.RCX, REG.RBX);
  a.label('nf_status_scan');
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'nf_fail');
  a.load8(REG.RAX, REG.R8, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.E, 'nf_status_digits');
  a.inc(REG.R8);
  a.dec(REG.RCX);
  a.jmp('nf_status_scan');
  a.label('nf_status_digits');
  a.cmpImm32(REG.RCX, 4);          // space + three status digits
  a.jcc(COND.L, 'nf_fail');
  a.inc(REG.R8);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RBX, 3);
  a.label('nf_status_digit_loop');
  a.load8(REG.RAX, REG.R8, 0);
  a.subImm32(REG.RAX, 48);
  a.cmpImm32(REG.RAX, 9);
  a.jcc(COND.G, 'nf_fail');
  a.movImm32(REG.RCX, 10);
  a.imul(REG.RDX, REG.RCX);
  a.add(REG.RDX, REG.RAX);
  a.inc(REG.R8);
  a.dec(REG.RBX);
  a.jcc(COND.NZ, 'nf_status_digit_loop');
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_STATUS);
  a.store64(REG.RCX, REG.RDX, 0);

  // Header/body split at \r\n\r\n.
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, RESP_OFF);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_RESPLEN);
  a.load64(REG.RCX, REG.RCX, 0);
  a.label('nf_hdr_scan');
  a.cmpImm32(REG.RCX, 4);
  a.jcc(COND.L, 'nf_fail');
  a.load8(REG.RAX, REG.R8, 0);
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.NE, 'nf_hdr_next');
  a.load8(REG.RAX, REG.R8, 1);
  a.cmpImm8(REG.RAX, 10);
  a.jcc(COND.NE, 'nf_hdr_next');
  a.load8(REG.RAX, REG.R8, 2);
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.NE, 'nf_hdr_next');
  a.load8(REG.RAX, REG.R8, 3);
  a.cmpImm8(REG.RAX, 10);
  a.jcc(COND.E, 'nf_hdr_found');
  a.label('nf_hdr_next');
  a.inc(REG.R8);
  a.dec(REG.RCX);
  a.jmp('nf_hdr_scan');

  a.label('nf_hdr_found');
  a.mov(REG.R9, REG.R8);
  a.mov(REG.RDX, REG.R13);
  a.addImm32(REG.RDX, RESP_OFF);
  a.sub(REG.R9, REG.RDX);
  a.addImm32(REG.R9, 4);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HDRLEN);
  a.store64(REG.RCX, REG.R9, 0);
  a.addImm32(REG.R8, 4);            // body start
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_PATHP);
  a.store64(REG.R9, REG.R8, 0);     // survives the redirect scan

  // Follow up to five 3xx redirects that carry an absolute Location.
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_STATUS);
  a.load64(REG.RCX, REG.R9, 0);
  a.cmpImm32(REG.RCX, 300);
  a.jcc(COND.L, 'nf_hdr_body');
  a.cmpImm32(REG.RCX, 400);
  a.jcc(COND.GE, 'nf_hdr_body');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_REDIR);
  a.load64(REG.RCX, REG.R9, 0);
  a.cmpImm32(REG.RCX, 5);
  a.jcc(COND.GE, 'nf_hdr_body');
  a.inc(REG.RCX);
  a.store64(REG.R9, REG.RCX, 0);

  // Scan the header block for "\r\nLocation:" (case-insensitive).
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, RESP_OFF);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HDRLEN);
  a.load64(REG.RCX, REG.RCX, 0);
  a.mov(REG.R11, REG.R8);
  a.add(REG.R11, REG.RCX);          // header block end

  a.label('nf_loc_scan');
  a.cmpImm32(REG.RCX, 11);
  a.jcc(COND.L, 'nf_hdr_body');
  a.load8(REG.RAX, REG.R8, 0);
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.R8, 1);
  a.cmpImm8(REG.RAX, 10);
  a.jcc(COND.NE, 'nf_loc_next');
  a.mov(REG.RBX, REG.R8);
  a.addImm32(REG.RBX, 2);
  a.load8(REG.RAX, REG.RBX, 0);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 76);           // 'L'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 1);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 79);           // 'O'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 2);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 67);           // 'C'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 3);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 65);           // 'A'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 4);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 84);           // 'T'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 5);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 73);           // 'I'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 6);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 79);           // 'O'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 7);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 78);           // 'N'
  a.jcc(COND.NE, 'nf_loc_next');
  a.load8(REG.RAX, REG.RBX, 8);
  a.cmpImm8(REG.RAX, 58);           // ':'
  a.jcc(COND.NE, 'nf_loc_next');
  a.addImm32(REG.RBX, 9);

  // Skip spaces after the colon, then copy up to end of line.
  a.label('nf_loc_skip');
  a.cmp(REG.RBX, REG.R11);
  a.jcc(COND.GE, 'nf_hdr_body');
  a.load8(REG.RAX, REG.RBX, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.NE, 'nf_loc_copy_start');
  a.inc(REG.RBX);
  a.jmp('nf_loc_skip');

  a.label('nf_loc_copy_start');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, URL_OFF);
  a.xor(REG.RCX, REG.RCX);
  a.label('nf_loc_copy');
  a.cmp(REG.RBX, REG.R11);
  a.jcc(COND.GE, 'nf_loc_done');
  a.cmpImm32(REG.RCX, NET_URL_CAP - 2);
  a.jcc(COND.GE, 'nf_loc_done');
  a.load8(REG.RAX, REG.RBX, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_loc_done');
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.E, 'nf_loc_done');
  a.cmpImm8(REG.RAX, 10);
  a.jcc(COND.E, 'nf_loc_done');
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RDI);
  a.inc(REG.RBX);
  a.inc(REG.RCX);
  a.jmp('nf_loc_copy');
  a.label('nf_loc_done');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 0);

  // Classify the Location value: absolute, scheme-relative or path-relative.
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, URL_OFF);
  a.load8(REG.RAX, REG.R9, 0);
  a.andImm32(REG.RAX, 0xdf);
  a.cmpImm8(REG.RAX, 72);           // 'H'
  a.jcc(COND.E, 'nf_reparse');
  a.load8(REG.RAX, REG.R9, 0);
  a.cmpImm8(REG.RAX, 47);           // '/'
  a.jcc(COND.NE, 'nf_hdr_body');

  // Save the copied length (RCX) before scratch use.
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_OPTLEN);
  a.store64(REG.R10, REG.RCX, 0);

  a.load8(REG.RAX, REG.R9, 1);
  a.cmpImm8(REG.RAX, 47);           // "//": inherit the scheme only
  a.jcc(COND.E, 'nf_rel_scheme_only');

  // Path-relative: prefix = scheme + host + ":" + port. Convert the port to
  // digits in scratch (backwards), then shift the path right and prepend.
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_PORTPTR);
  a.load64(REG.RAX, REG.R10, 0);
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_TMP_DIGITS + 5);
  a.xor(REG.RCX, REG.RCX);
  a.label('nf_rel_digit');
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.R10, 10);
  a.divReg(REG.R10);
  a.addImm32(REG.RDX, 48);
  a.dec(REG.R8);
  a.store8(REG.R8, REG.RDX, 0);
  a.inc(REG.RCX);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'nf_rel_digit');
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_TMP_COUNT);
  a.store64(REG.R10, REG.RCX, 0);

  // prefix = scheme_len + hostlen + 1 + digit_count
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, S_HTTPS);
  a.load64(REG.R11, REG.R11, 0);
  a.test(REG.R11, REG.R11);
  a.movImm32(REG.R11, 7);           // "http://"
  a.jcc(COND.Z, 'nf_rel_plen');
  a.movImm32(REG.R11, 8);           // "https://"
  a.label('nf_rel_plen');
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_HOSTLEN);
  a.load64(REG.R10, REG.R10, 0);
  a.add(REG.R11, REG.R10);
  a.addImm32(REG.R11, 1);
  a.add(REG.R11, REG.RCX);

  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_OPTLEN);
  a.load64(REG.R10, REG.R10, 0);
  a.mov(REG.RBX, REG.R10);
  a.add(REG.RBX, REG.R11);
  a.cmpImm32(REG.RBX, NET_URL_CAP - 1);
  a.jcc(COND.GE, 'nf_hdr_body');

  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, URL_OFF);
  a.inc(REG.R10);                   // include the NUL terminator
  a.label('nf_rel_shift');
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'nf_rel_shift_done');
  a.dec(REG.R10);
  a.load8Indexed(REG.RAX, REG.R9, REG.R10);
  a.mov(REG.RBX, REG.R9);
  a.add(REG.RBX, REG.R11);
  a.add(REG.RBX, REG.R10);
  a.store8(REG.RBX, REG.RAX, 0);
  a.jmp('nf_rel_shift');
  a.label('nf_rel_shift_done');

  a.mov(REG.RDI, REG.R9);
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_HTTPS);
  a.load64(REG.R10, REG.R10, 0);
  a.test(REG.R10, REG.R10);
  a.jcc(COND.NZ, 'nf_rel_write_https');
  a.leaRip(REG.RSI, 'scheme_http');
  a.movImm32(REG.RCX, 7);
  a.jmp('nf_rel_write_scheme');
  a.label('nf_rel_write_https');
  a.leaRip(REG.RSI, 'scheme_https');
  a.movImm32(REG.RCX, 8);
  a.label('nf_rel_write_scheme');
  a.call('nf_append');

  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, HOST_OFF);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_HOSTLEN);
  a.load64(REG.RCX, REG.RCX, 0);
  a.call('nf_append');

  a.movImm32(REG.RAX, 58);          // ':'
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RDI);

  a.mov(REG.RSI, REG.R8);
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_TMP_COUNT);
  a.load64(REG.RCX, REG.RCX, 0);
  a.call('nf_append');
  a.jmp('nf_reparse');

  // Scheme-relative "//host/path": prepend http: or https:.
  a.label('nf_rel_scheme_only');
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_OPTLEN);
  a.load64(REG.R10, REG.R10, 0);
  a.mov(REG.R11, REG.R13);
  a.addImm32(REG.R11, S_HTTPS);
  a.load64(REG.R11, REG.R11, 0);
  a.test(REG.R11, REG.R11);
  a.movImm32(REG.R11, 5);           // "http:"
  a.jcc(COND.Z, 'nf_rel_scheme_plen');
  a.movImm32(REG.R11, 6);           // "https:"
  a.label('nf_rel_scheme_plen');
  a.mov(REG.RBX, REG.R10);
  a.add(REG.RBX, REG.R11);
  a.cmpImm32(REG.RBX, NET_URL_CAP - 1);
  a.jcc(COND.GE, 'nf_hdr_body');
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, URL_OFF);
  a.inc(REG.R10);
  a.label('nf_rel_scheme_shift');
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'nf_rel_scheme_shift_done');
  a.dec(REG.R10);
  a.load8Indexed(REG.RAX, REG.R9, REG.R10);
  a.mov(REG.RBX, REG.R9);
  a.add(REG.RBX, REG.R11);
  a.add(REG.RBX, REG.R10);
  a.store8(REG.RBX, REG.RAX, 0);
  a.jmp('nf_rel_scheme_shift');
  a.label('nf_rel_scheme_shift_done');
  a.mov(REG.RDI, REG.R9);
  a.mov(REG.R10, REG.R13);
  a.addImm32(REG.R10, S_HTTPS);
  a.load64(REG.R10, REG.R10, 0);
  a.test(REG.R10, REG.R10);
  a.jcc(COND.NZ, 'nf_rel_scheme_https_write');
  a.leaRip(REG.RSI, 'scheme_http');
  a.movImm32(REG.RCX, 5);
  a.jmp('nf_rel_scheme_write');
  a.label('nf_rel_scheme_https_write');
  a.leaRip(REG.RSI, 'scheme_https');
  a.movImm32(REG.RCX, 6);
  a.label('nf_rel_scheme_write');
  a.call('nf_append');
  a.jmp('nf_reparse');

  a.label('nf_loc_next');
  a.inc(REG.R8);
  a.dec(REG.RCX);
  a.jmp('nf_loc_scan');

  a.label('nf_hdr_body');
  a.mov(REG.R8, REG.R13);
  a.addImm32(REG.R8, S_PATHP);
  a.load64(REG.R8, REG.R8, 0);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_RESPLEN);
  a.load64(REG.R9, REG.R9, 0);
  a.mov(REG.RDX, REG.R13);
  a.addImm32(REG.RDX, RESP_OFF);
  a.add(REG.R9, REG.RDX);
  a.sub(REG.R9, REG.R8);            // body length
  a.mov(REG.RCX, REG.R13);
  a.addImm32(REG.RCX, S_BODYLEN);
  a.store64(REG.RCX, REG.R9, 0);

  // Allocate the body string: [len:u64][bytes][NUL].
  a.mov(REG.R11, REG.R14);          // body object
  a.store64(REG.R11, REG.R9, 0);
  a.mov(REG.R10, REG.R14);
  a.addImm32(REG.R10, 8);
  a.mov(REG.RSI, REG.R8);
  a.mov(REG.RDI, REG.R10);
  a.mov(REG.RCX, REG.R9);
  a.call('nf_append');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 0);
  a.mov(REG.RAX, REG.R9);
  a.addImm32(REG.RAX, 9);
  a.add(REG.R14, REG.RAX);
  a.movImm64(REG.RCX, TAG_STRING_STR);
  a.or(REG.R11, REG.RCX);
  a.push(REG.R11);                  // body value survives header alloc

  // Allocate the raw header block string.
  a.mov(REG.R11, REG.R14);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_HDRLEN);
  a.load64(REG.R9, REG.R9, 0);
  a.store64(REG.R11, REG.R9, 0);
  a.mov(REG.R10, REG.R14);
  a.addImm32(REG.R10, 8);
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, RESP_OFF);
  a.mov(REG.RDI, REG.R10);
  a.mov(REG.RCX, REG.R9);
  a.call('nf_append');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 0);
  a.mov(REG.RAX, REG.R9);
  a.addImm32(REG.RAX, 9);
  a.add(REG.R14, REG.RAX);
  a.movImm64(REG.RCX, TAG_STRING_STR);
  a.or(REG.R11, REG.RCX);
  a.pop(REG.RCX);                   // body value

  // Response object: [status][body][headers].
  a.mov(REG.R8, REG.R14);
  a.mov(REG.R9, REG.R13);
  a.addImm32(REG.R9, S_STATUS);
  a.load64(REG.R9, REG.R9, 0);
  a.store64(REG.R8, REG.R9, 0);
  a.store64(REG.R8, REG.RCX, 8);
  a.store64(REG.R8, REG.R11, 16);
  a.addImm32(REG.R14, 24);
  a.mov(REG.RAX, REG.R8);
  a.movImm64(REG.RCX, TAG_RESPONSE_STR);
  a.or(REG.RAX, REG.RCX);
  a.mov(REG.R12, REG.R14);          // publish the advanced net-heap cursor
  a.jmp('nw_complete');

  a.label('nf_close_fail');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.jmp('nf_fail');

  a.label('nf_dns_close_fail');
  a.mov(REG.RDI, REG.R13);
  a.addImm32(REG.RDI, S_FD);
  a.load64(REG.RDI, REG.RDI, 0);
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.jmp('nf_fail');

  a.label('nf_fail');
  a.xor(REG.RAX, REG.RAX);
  a.mov(REG.R12, REG.R14);          // keep any partial allocation
  a.jmp('nw_complete');

  // Copy RCX bytes from RSI to RDI, advancing both pointers.
  a.label('nf_append');
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'nf_append_done');
  a.label('nf_append_loop');
  a.load8(REG.RAX, REG.RSI, 0);
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.RDI);
  a.dec(REG.RCX);
  a.jcc(COND.NZ, 'nf_append_loop');
  a.label('nf_append_done');
  a.ret();

  // Skip a DNS name in RSI, leaving RSI just past it. Handles compression
  // pointers and ordinary length-prefixed labels.
  a.label('nf_skip_name');
  a.label('nf_skip_name_loop');
  a.load8(REG.RAX, REG.RSI, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'nf_skip_name_done');
  a.mov(REG.RCX, REG.RAX);
  a.andImm32(REG.RCX, 0xc0);
  a.cmpImm32(REG.RCX, 0xc0);
  a.jcc(COND.E, 'nf_skip_name_ptr');
  a.inc(REG.RSI);
  a.add(REG.RSI, REG.RAX);
  a.jmp('nf_skip_name_loop');
  a.label('nf_skip_name_ptr');
  a.addImm32(REG.RSI, 2);
  a.ret();
  a.label('nf_skip_name_done');
  a.inc(REG.RSI);
  a.ret();
}

// Print a UTF-16 stage marker through ConOut. Requires RBP = dispatch state.
function emitUefiTrace(a, label) {
  if (!UEFI_TRACE) return;
  a.load64(REG.RCX, REG.RBP, STATE_CON_OUT);
  a.leaRip(REG.RDX, label);
  a.load64(REG.RAX, REG.RCX, 8);      // OutputString
  a.call('uefi_call');
}

function emitUefiCall(a) {  // RAX = function pointer, RCX/RDX/R8/R9 = arguments. Returns EFI_STATUS in
  // RAX. The firmware uses the Microsoft x64 ABI, which requires 32 bytes of
  // shadow space and 16-byte stack alignment at the call. All of R10/R11 are
  // volatile, so the saved stack pointer has to live in our own frame (above
  // the shadow space) rather than in a register the firmware may clobber.
  // Layout below the adjusted RSP: [0,32) shadow space, [32] fifth argument,
  // [40] saved RSP.
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

  // Same, with a fifth argument in R10 (placed at [rsp+32]).
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
}

function emitUefiShutdown(a, heapBase) {
  // RuntimeServices->ResetSystem(ResetType, ResetStatus, DataSize, ResetData).
  // ResetSystem is a runtime service: unlike a protocol method it takes no
  // "This" pointer, so RCX is the reset type, not RuntimeServices.
  a.label('uefi_shutdown');
  a.movImm64(REG.RCX, '0x' + (heapBase + DISPATCH_STATE).toString(16));
  a.load64(REG.RCX, REG.RCX, STATE_SYSTEM_TABLE);
  a.load64(REG.RCX, REG.RCX, 88);          // RuntimeServices
  a.load64(REG.RAX, REG.RCX, 104);         // ResetSystem
  a.movImm32(REG.RCX, 2);                  // EfiResetShutdown
  a.xor(REG.RDX, REG.RDX);
  a.xor(REG.R8, REG.R8);
  a.xor(REG.R9, REG.R9);
  a.call('uefi_call');
  a.ret();
}

function emitUefiStall(a, heapBase) {
  // RAX = microseconds. Uses BootServices->Stall.
  a.label('uefi_stall');
  a.mov(REG.RCX, REG.RAX);
  a.movImm64(REG.R11, '0x' + (heapBase + DISPATCH_STATE).toString(16));
  a.load64(REG.R11, REG.R11, STATE_BOOT_SERVICES);
  a.load64(REG.RAX, REG.R11, 248);         // Stall
  a.call('uefi_call');
  a.ret();
}

function buildRuntime(heapBase) {
  const a = new Assembler(TEXT_BASE);
  const HEAP_BASE_STR = '0x' + heapBase.toString(16);
  const SPILL_RING = process.env.KZERO_NO_SPILL !== '1';
  const FULL_SPILL = process.env.KZERO_FULL_SPILL === '1';
  const REMOTE_CALLS = process.env.KZERO_REMOTE === '1' && process.env.KZERO_NO_REMOTE !== '1';
  // KZERO_NO_SPILL is a diagnostic build knob: it omits the caller-ring
  // spill/restore so the spill cost can be measured directly. It is NOT a
  // valid runtime mode — function calls no longer isolate the caller's state.
  // KZERO_FULL_SPILL forces the old spill-every-register path. By default a
  // local call saves only the registers named in the body (plus parameters).
  // KZERO_REMOTE=1 opt-in dispatches eligible calls to the compute worker;
  // KZERO_NO_REMOTE=1 (or a single-core build) forces every call local. Remote
  // execution is off by default because the synchronous cross-core round trip
  // costs more per call than the local selective spill on measured workloads.

  // ---------------------------------------------------------------- entry
  a.label('entry');
  if (UEFI) {
    // UEFI x64 entry: RCX = ImageHandle, RDX = SystemTable.
    a.mov(REG.R15, REG.RDX);          // system table
    a.mov(REG.R14, REG.RCX);          // image handle
    a.load64(REG.R13, REG.R15, 96);   // BootServices

    // Reserve the fixed global region. The generated code addresses it with
    // absolute immediates, so it must live at the linked address.
    a.subImm32(REG.RSP, 16);
    a.movImm64(REG.RAX, HEAP_BASE_STR);
    a.store64(REG.RSP, REG.RAX, 0);
    a.movImm32(REG.RCX, 2);           // AllocateAddress
    a.movImm32(REG.RDX, 2);           // EfiLoaderData
    a.movImm32(REG.R8, BSS_SIZE >> 12);
    a.mov(REG.R9, REG.RSP);
    a.load64(REG.RAX, REG.R13, 40);   // AllocatePages
    a.call('uefi_call');
    a.addImm32(REG.RSP, 16);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, 'uefi_init_fail');

    // AllocatePages does not promise zeroed memory. Wipe the whole global
    // region (input buffer, worker rings, heaps and interpreter state).
    a.movImm64(REG.RDI, HEAP_BASE_STR);
    a.movImm64(REG.RCX, BSS_SIZE);
    a.xor(REG.RAX, REG.RAX);
    a.emit(0xfc);                     // cld
    a.emit(0xf3, 0xaa);               // rep stosb

    a.movImm64(REG.RBP, '0x' + (heapBase + DISPATCH_STATE).toString(16));
    a.store64(REG.RBP, REG.R13, STATE_BOOT_SERVICES);
    a.store64(REG.RBP, REG.R15, STATE_SYSTEM_TABLE);
    a.store64(REG.RBP, REG.R14, STATE_IMAGE_HANDLE);
    a.load64(REG.RAX, REG.R15, 64);   // ConOut
    a.store64(REG.RBP, REG.RAX, STATE_CON_OUT);
    emitUefiTrace(a, 'trace_state');

    // The ring interpreter is built on AVX-512. Check the firmware/CPU
    // exposes the required state before touching ZMM registers; a machine
    // without AVX-512 should get a clear message instead of an exception.
    if (UEFI_CPUID_CHECK) {
      a.movImm32(REG.RAX, 1);
      a.xor(REG.RCX, REG.RCX);
      a.cpuid();
      emitUefiTrace(a, 'trace_cpuid1');
      a.btImm(REG.RCX, 26);             // XSAVE
      a.jcc(COND.NC, 'uefi_no_avx512');
      a.btImm(REG.RCX, 28);             // AVX
      a.jcc(COND.NC, 'uefi_no_avx512');
      a.movImm32(REG.RAX, 7);
      a.xor(REG.RCX, REG.RCX);
      a.cpuid();
      emitUefiTrace(a, 'trace_cpuid7');
      a.btImm(REG.RBX, 16);             // AVX512F
      a.jcc(COND.NC, 'uefi_no_avx512');
      a.movImm32(REG.RAX, 0xd);
      a.xor(REG.RCX, REG.RCX);
      a.cpuid();                        // EAX = supported XCR0 low bits
      a.movImm64(REG.R9, 0xe7);         // x87|SSE|AVX|opmask|ZMM_Hi256|Hi16_ZMM
      a.and(REG.RAX, REG.R9);
      a.cmp(REG.RAX, REG.R9);
      a.jcc(COND.NE, 'uefi_no_avx512');
      emitUefiTrace(a, 'trace_cpuidd');
    }

    // Enable OSXSAVE and the AVX-512 state components. UEFI firmware does not
    // guarantee that CR4.OSXSAVE or XCR0 are set up for an application, and
    // every ring operation below uses ZMM registers. Skip the CR4 write when
    // firmware already enabled OSXSAVE: some hypervisors reject the write.
    a.emit(0x0f, 0x20, 0xe0);         // mov rax, cr4
    a.movImm64(REG.RCX, 0x40000);     // CR4.OSXSAVE
    a.test(REG.RAX, REG.RCX);
    a.jcc(COND.NZ, 'uefi_cr4_ok');
    a.or(REG.RAX, REG.RCX);
    a.emit(0x0f, 0x22, 0xe0);         // mov cr4, rax
    a.label('uefi_cr4_ok');
    emitUefiTrace(a, 'trace_cr4');
    a.emit(0x31, 0xc9);               // xor ecx, ecx
    a.emit(0x0f, 0x01, 0xd0);         // xgetbv
    a.emit(0x0d, 0xe7, 0, 0, 0);      // or eax, 0xe7 (x87|SSE|AVX|opmask|ZMM)
    a.emit(0x0f, 0x01, 0xd1);         // xsetbv
    emitUefiTrace(a, 'trace_avx');

    emitZeroRing(a);
    emitUefiTrace(a, 'trace_ring');
    a.movImm64(REG.R14, HEAP_BASE_STR);

    if (TEST_SOURCE !== null) {
      a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
      a.movImm64(REG.RDX, TEST_SOURCE.length);
      a.store64(REG.RCX, REG.RDX, 0);
      a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
      a.movImm32(REG.RDX, 1);
      a.store8(REG.RCX, REG.RDX, 0);
      a.leaRip(REG.R12, 'test_data');
      a.mov(REG.R13, REG.R12);
      a.addImm32(REG.R13, TEST_SOURCE.length);
      emitUefiTrace(a, 'trace_main');
      a.jmp('main_loop');
    } else {
      a.call('load_script_uefi');
      a.jmp('main_loop');
    }

    a.label('uefi_no_avx512');
    a.load64(REG.RCX, REG.RBP, STATE_CON_OUT);
    a.leaRip(REG.RDX, 'uefi_avx512_msg');
    a.load64(REG.RAX, REG.RCX, 8);     // OutputString
    a.call('uefi_call');
    a.movImm64(REG.RAX, '0x8000000000000003'); // EFI_UNSUPPORTED
    a.ret();

    a.label('uefi_init_fail');
    a.movImm64(REG.RAX, '0x8000000000000001'); // EFI_LOAD_ERROR
    a.ret();

    emitUefiCall(a);
    emitUefiShutdown(a, heapBase);
    emitUefiStall(a, heapBase);
  } else {
  emitPinCpu(a, CPU_DISPATCH);       // dispatcher owns physical core 0

  // Ignore SIGPIPE so a peer or the HTTPS helper closing early turns into a
  // write error instead of killing the whole runtime.
  a.subImm32(REG.RSP, 32);
  a.movImm32(REG.RAX, 1);           // SIG_IGN
  a.store64(REG.RSP, REG.RAX, 0);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RSP, REG.RAX, 8);
  a.store64(REG.RSP, REG.RAX, 16);
  a.store64(REG.RSP, REG.RAX, 24);
  a.movImm32(REG.RDI, 13);          // SIGPIPE
  a.mov(REG.RSI, REG.RSP);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.R10, 8);           // sigsetsize
  a.movImm32(REG.RAX, 13);          // rt_sigaction
  a.syscall();
  a.addImm32(REG.RSP, 32);

  a.movImm64(REG.R14, HEAP_BASE_STR);
  emitZeroRing(a);
  // RBP is the per-core interpreter-state base for the rest of the program.
  a.movImm64(REG.RBP, '0x' + (heapBase + DISPATCH_STATE).toString(16));
  if (REMOTE_CALLS) {
    a.movImm32(REG.RDX, 1);
    a.store8(REG.RBP, REG.RDX, STATE_REMOTE_OK);
  }

  // Spawn the pipeline workers before any script text is processed, so their
  // cores are warm and the queues absorb work while the dispatcher runs.
  if (TEST_SOURCE === null) {
    // Pick the script source: argv[1] if it opens, else stdin. The descriptor
    // is handed to the input worker, which does all the reading on CPU 2.
    a.load64(REG.RAX, REG.RSP, 0);      // argc
    a.cmpImm32(REG.RAX, 2);
    a.jcc(COND.L, 'load_stdin');
    a.load64(REG.RDI, REG.RSP, 16);     // argv[1]
    a.movImm32(REG.RAX, 2);             // open
    a.xor(REG.RSI, REG.RSI);            // O_RDONLY
    a.xor(REG.RDX, REG.RDX);
    a.syscall();
    a.cmpImm32(REG.RAX, 0);
    a.jcc(COND.L, 'load_stdin');
    a.mov(REG.RDI, REG.RAX);            // fd
    a.jmp('load_do');

    a.label('load_stdin');
    a.xor(REG.RDI, REG.RDI);            // stdin

    a.label('load_do');
    a.movImm64(REG.RCX, '0x' + (heapBase + IN_FD).toString(16));
    a.store64(REG.RCX, REG.RDI, 0);
  }

  emitCloneWorker(a, {
    stackTop: heapBase + OUT_STACK_TOP,
    index: 0,
    childLabel: 'output_worker',
  });
  emitCloneWorker(a, {
    stackTop: heapBase + FILE_STACK_TOP,
    index: 1,
    childLabel: 'file_worker',
  });
  emitCloneWorker(a, {
    stackTop: heapBase + NET_STACK_TOP,
    index: 2,
    childLabel: 'net_worker',
  });
  if (REMOTE_CALLS && !SINGLE_CORE) {
    emitCloneWorker(a, {
      stackTop: heapBase + COMP_STACK_TOP,
      index: 4,
      childLabel: 'compute_worker',
    });
  }
  if (TEST_SOURCE === null) {
    emitCloneWorker(a, {
      stackTop: heapBase + IN_STACK_TOP,
      index: 3,
      childLabel: 'input_worker',
    });
  }

  if (TEST_SOURCE !== null) {
    // No input worker: mark the embedded source as already complete so the
    // end-of-buffer path terminates instead of waiting for a refill.
    a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
    a.movImm32(REG.RDX, 1);
    a.store8(REG.RCX, REG.RDX, 0);
    a.leaRip(REG.R12, 'test_data');
    a.mov(REG.R13, REG.R12);
    a.addImm32(REG.R13, TEST_SOURCE.length);
    a.jmp('main_loop');
  } else {
    a.movImm64(REG.R12, HEAP_BASE_STR); // input buffer = bss base
    a.addImm32(REG.R14, INPUT_CAP);     // heap starts after input buffer
    a.jmp('input_wait');
  }
  }

  // Wait for the input worker to publish a complete statement (or EOF), then
  // point R13 at the end of what is safe to parse.
  a.label('input_wait');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
  a.load64(REG.R8, REG.RCX, 0);
  a.test(REG.R8, REG.R8);
  a.jcc(COND.NZ, 'input_go');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
  a.load8(REG.R9, REG.RCX, 0);
  a.test(REG.R9, REG.R9);
  a.jcc(COND.NZ, 'input_go');
  emitIdle(a, SINGLE_CORE);
  a.jmp('input_wait');

  a.label('input_go');
  a.movImm64(REG.R13, HEAP_BASE_STR);
  a.add(REG.R13, REG.R8);
  a.jmp('main_loop');

  // The dispatcher consumed everything published so far. If more input is
  // coming, extend R13 (always at a statement boundary) and keep parsing.
  a.label('input_more');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
  a.load64(REG.R8, REG.RCX, 0);
  a.movImm64(REG.RCX, HEAP_BASE_STR);
  a.mov(REG.R9, REG.R13);
  a.sub(REG.R9, REG.RCX);             // consumed = R13 - base
  a.cmp(REG.R9, REG.R8);
  a.jcc(COND.B, 'input_more_go');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
  a.load8(REG.R9, REG.RCX, 0);
  a.test(REG.R9, REG.R9);
  a.jcc(COND.NZ, 'exit');
  emitIdle(a, SINGLE_CORE);
  a.jmp('input_more');

  a.label('input_more_go');
  a.movImm64(REG.R13, HEAP_BASE_STR);
  a.add(REG.R13, REG.R8);
  a.jmp('main_loop');

  // ------------------------------------------------------------ main loop
  // Read one byte. Whitespace is skipped. Anything else starts an
  // identifier token which is hashed until a delimiter is seen.
  a.label('main_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');

  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'main_loop_skip');
  a.cmpImm8(REG.RAX, 125);         // '}' -> loop body end
  a.jcc(COND.E, 'handle_block_end');
  a.cmpImm8(REG.RAX, 123);         // '{' -> block body start
  a.jcc(COND.E, 'main_loop_skip');

  a.movImm64(REG.RBX, FNV_OFFSET_STR);

  a.label('hash_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'hash_done');
  a.load8(REG.RCX, REG.R12, 0);

  a.cmpImm8(REG.RCX, 32);  // ' '
  a.jcc(COND.LE, 'hash_done');
  a.cmpImm8(REG.RCX, 46);  // '.'
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 41);  // ')'
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 61);  // '='
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 59);  // ';'
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 91);  // '[' -> indexed assignment target
  a.jcc(COND.E, 'hash_done');
  a.cmpImm8(REG.RCX, 123); // '{' -> loop / if body start
  a.jcc(COND.E, 'hash_done');
  a.xor(REG.RBX, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.RBX, REG.RDX);
  a.inc(REG.R12);
  a.jmp('hash_loop');

  a.label('main_loop_skip');
  a.inc(REG.R12);
  a.jmp('main_loop');

  // Dispatch on the identifier hash.
  a.label('hash_done');
  emitUefiTrace(a, 'trace_hash');
  a.movImm64(REG.RCX, HASH_CONSOLE_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_console');

  a.movImm64(REG.RCX, HASH_LET_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_let');

  a.movImm64(REG.RCX, HASH_CONST_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_let');

  a.movImm64(REG.RCX, HASH_WHILE_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_while');

  a.movImm64(REG.RCX, HASH_FOR_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_for');

  a.movImm64(REG.RCX, HASH_IF_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_if');

  a.movImm64(REG.RCX, HASH_ELSE_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_else');

  a.movImm64(REG.RCX, HASH_FUNCTION_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_function');

  a.movImm64(REG.RCX, HASH_RETURN_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_return');

  a.movImm64(REG.RCX, HASH_REQUIRE_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_require');

  a.movImm64(REG.RCX, HASH_FS_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_fs');

  a.movImm64(REG.RCX, HASH_NET_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_net');

  a.movImm64(REG.RCX, HASH_FETCH_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_fetch');

  a.movImm64(REG.RCX, HASH_ARR_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_array');

  a.movImm64(REG.RCX, HASH_PROCESS_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_process');

  a.movImm64(REG.RCX, HASH_WINDOW_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_window');

  a.movImm64(REG.RCX, HASH_SCREEN_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_screen');

  a.movImm64(REG.RCX, HASH_NEW_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_new');

  a.movImm64(REG.RCX, HASH_SETTIMEOUT_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_timeout');

  a.movImm64(REG.RCX, HASH_SETINTERVAL_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_timeout');

  a.movImm64(REG.RCX, HASH_CLEARTIMEOUT_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_cleartimeout');

  a.movImm64(REG.RCX, HASH_CLEARINTERVAL_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'handle_cleartimeout');

  // Unknown identifier: if a '.', '[' or '=' follows (after optional spaces),
  // treat it as a method call, indexed assignment, or plain assignment.
  a.label('unknown_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'unknown_check');
  a.cmpImm8(REG.RAX, 10);  // newline terminates a bare identifier
  a.jcc(COND.E, 'skip_to_end');
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.E, 'skip_to_end');
  a.inc(REG.R12);
  a.jmp('unknown_ws');
  a.label('unknown_check');
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'handle_object_method');
  a.cmpImm8(REG.RAX, 91);  // '[' -> indexed assignment
  a.jcc(COND.E, 'handle_index_assign');
  a.cmpImm8(REG.RAX, 61);  // '=' -> plain variable assignment
  a.jcc(COND.E, 'handle_var_assign');
  a.cmpImm8(REG.RAX, 40);  // '(' -> function call statement
  a.jcc(COND.E, 'handle_statement_call');
  a.jmp('skip_to_end');

  // ---------------------------------------------------- console.<method>(...)
  // R12 points at the '.' following "console". Hash the method name so
  // .log/.error/.warn can be routed to fd 1 or fd 2.
  a.label('handle_console');
  emitUefiTrace(a, 'trace_console');
  a.inc(REG.R12);                   // skip '.'
  a.movImm64(REG.R8, FNV_OFFSET_STR);

  a.label('console_method_hash');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 40);           // '('
  a.jcc(COND.E, 'console_method_done');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.G, 'console_method_char');
  a.inc(REG.R12);                   // tolerate spaces around the dot
  a.jmp('console_method_hash');
  a.label('console_method_char');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('console_method_hash');

  a.label('console_method_done');
  a.inc(REG.R12);                   // consume '('
  a.xor(REG.RAX, REG.RAX);          // 0 = stdout, 1 = stderr
  a.store64(REG.RBP, REG.RAX, STATE_CONSOLE_FD);
  a.movImm64(REG.RCX, HASH_ERROR_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'console_stderr');
  a.movImm64(REG.RCX, HASH_WARN_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'console_stderr');
  a.jmp('console_got_paren');

  a.label('console_stderr');
  a.movImm32(REG.RAX, 1);
  a.store64(REG.RBP, REG.RAX, STATE_CONSOLE_FD);

  a.label('console_got_paren');
  a.xor(REG.R15, REG.R15);          // arguments emitted so far

  a.label('console_skip_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'console_check_arg');
  a.inc(REG.R12);
  a.jmp('console_skip_ws');

  a.label('console_check_arg');
  a.cmpImm8(REG.RAX, 41);  // ')'
  a.jcc(COND.E, 'console_arg_empty');
  a.cmpImm8(REG.RAX, 40);  // '(' -> parenthesized expression
  a.jcc(COND.E, 'console_arg_group');
  a.cmpImm8(REG.RAX, 91);  // '[' -> array literal
  a.jcc(COND.E, 'console_arg_array');
  a.cmpImm8(REG.RAX, 39);  // '
  a.jcc(COND.E, 'console_arg_string');
  a.cmpImm8(REG.RAX, 34);  // "
  a.jcc(COND.E, 'console_arg_string');
  a.cmpImm8(REG.RAX, 45);  // '-'
  a.jcc(COND.E, 'console_arg_negative');
  a.cmpImm8(REG.RAX, 48);  // '0'
  a.jcc(COND.L, 'console_check_var');
  a.cmpImm8(REG.RAX, 57);  // '9'
  a.jcc(COND.G, 'console_check_var');

  // Number literal argument.
  a.xor(REG.RAX, REG.RAX);
  a.label('console_num_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'console_after_primary');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 48);
  a.jcc(COND.L, 'console_after_primary');
  a.cmpImm8(REG.RCX, 57);
  a.jcc(COND.G, 'console_after_primary');
  a.movImm32(REG.RDX, 10);
  a.imul(REG.RAX, REG.RDX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RAX, REG.RCX);
  a.inc(REG.R12);
  a.jmp('console_num_loop');

  // Negative integer literal: -123 -> TAG_NEG | magnitude.
  a.label('console_arg_negative');
  a.inc(REG.R12);
  a.xor(REG.RAX, REG.RAX);
  a.label('console_neg_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'console_neg_done');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 48);
  a.jcc(COND.L, 'console_neg_done');
  a.cmpImm8(REG.RCX, 57);
  a.jcc(COND.G, 'console_neg_done');
  a.movImm32(REG.RDX, 10);
  a.imul(REG.RAX, REG.RDX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RAX, REG.RCX);
  a.inc(REG.R12);
  a.jmp('console_neg_loop');
  a.label('console_neg_done');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'console_after_primary');
  a.movImm64(REG.RCX, TAG_NEG_STR);
  a.or(REG.RAX, REG.RCX);
  a.jmp('console_after_primary');

  a.label('console_arg_string');
  a.call('parse_string');
  a.jmp('console_after_primary');

  a.label('console_arg_array');
  a.call('parse_array');
  a.jmp('console_after_primary');

  a.label('console_arg_group');
  a.call('parse_group');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'console_after_primary');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 46);  // '.'
  a.jcc(COND.E, 'console_group_method');
  a.jmp('console_after_primary');
  a.label('console_group_method');
  a.call('object_method_value');
  a.jmp('console_after_primary');

  // Variable / call argument: hash the name, then load or invoke it.
  a.label('console_check_var');
  a.movImm64(REG.RBX, FNV_OFFSET_STR);

  a.label('console_var_hash_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 41);  // ')'
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 46);  // '.'
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 91);  // '['
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 93);  // ']'
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 44);  // ','
  a.jcc(COND.E, 'console_var_hash_done');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'console_var_hash_done');

  a.xor(REG.RBX, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.RBX, REG.RDX);
  a.inc(REG.R12);
  a.jmp('console_var_hash_loop');

  a.label('console_var_hash_done');
  a.movImm64(REG.RCX, HASH_FS_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_fs');

  a.movImm64(REG.RCX, HASH_REQUIRE_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_require');

  a.movImm64(REG.RCX, HASH_NET_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_net');

  a.movImm64(REG.RCX, HASH_FETCH_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_fetch');

  a.movImm64(REG.RCX, HASH_WINDOW_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_window');

  a.movImm64(REG.RCX, HASH_SCREEN_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_screen');

  a.movImm64(REG.RCX, HASH_SETTIMEOUT_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_timeout');

  a.movImm64(REG.RCX, HASH_SETINTERVAL_STR);
  a.cmp(REG.RBX, REG.RCX);
  a.jcc(COND.E, 'console_arg_timeout');

  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'console_slot');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'console_arg_object');
  a.cmpImm8(REG.RAX, 40);  // '(' -> function call value
  a.jcc(COND.E, 'console_arg_call');

  a.label('console_slot');
  emitSlotIndex(a, REG.RBX, REG.RCX, 'console_slot');
  a.call('load_slot');
  a.call('maybe_index');
  a.jmp('console_after_primary');

  a.label('console_arg_fs');
  a.call('call_fs_method');
  a.jmp('console_after_primary');

  a.label('console_arg_require');
  a.call('call_require');
  a.jmp('console_after_primary');

  a.label('console_arg_net');
  a.call('call_net_method');
  a.jmp('console_after_primary');

  a.label('console_arg_fetch');
  a.call('call_fetch');
  a.call('value_member');
  a.jmp('console_after_primary');

  a.label('console_arg_window');
  a.movImm64(REG.RAX, TAG_WINDOW_STR);
  a.call('value_member');
  a.jmp('console_after_primary');

  a.label('console_arg_screen');
  a.movImm64(REG.RAX, TAG_SCREEN_STR);
  a.call('value_member');
  a.jmp('console_after_primary');

  a.label('console_arg_timeout');
  a.mov(REG.R8, REG.RBX);           // setTimeout / setInterval hash
  a.call('parse_timer_call');
  a.call('value_member');
  a.jmp('console_after_primary');

  a.label('console_arg_object');
  a.mov(REG.R8, REG.RBX);
  a.call('call_object_method_h');
  a.call('value_member');
  a.jmp('console_after_primary');

  a.label('console_arg_call');
  a.mov(REG.R8, REG.RBX);         // name hash
  a.call('lookup_function');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'console_call_unknown');
  a.leaRip(REG.R10, 'console_after_call');
  a.jmp('call_function');
  a.label('console_call_unknown');
  a.call('skip_paren_group');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('console_after_call');

  // A call result can carry member/index accesses: mk()[2], str().length.
  a.label('console_after_call');
  a.call('value_member');
  a.jmp('console_after_primary');

  // console.log() with no arguments: just end the line.
  a.label('console_arg_empty');
  a.xor(REG.RAX, REG.RAX);
  a.movImm32(REG.RDX, OUT_KIND_NL);
  a.call('console_emit');
  a.jmp('console_stmt_done');

  // A primary value is in RAX. If a '+' follows, parse another primary and
  // concatenate/add, repeating for chains like a + b + c.
  a.label('console_after_primary');
  a.label('cap_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'console_arg_ready');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.NE, 'cap_check');       // only spaces, never a newline
  a.inc(REG.R12);
  a.jmp('cap_scan');

  a.label('cap_check');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'cap_plus');
  a.jmp('console_arg_ready');

  a.label('cap_plus');
  a.inc(REG.R12);
  a.push(REG.RAX);
  a.call('parse_value');
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RAX);
  a.call('concat_values');
  a.jmp('console_after_primary');

  // RAX holds a finished argument value. Peek at the next non-space byte to
  // decide whether another argument follows. Arguments are space-separated
  // exactly like Node's console.log.
  a.label('console_arg_ready');
  a.label('car_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'console_arg_last');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.G, 'car_check');
  a.inc(REG.R12);
  a.jmp('car_scan');

  a.label('car_check');
  a.cmpImm8(REG.RCX, 44);  // ','
  a.jcc(COND.E, 'console_arg_more');
  a.jmp('console_arg_last');

  a.label('console_arg_more');
  a.inc(REG.R12);                  // consume the comma
  a.push(REG.RAX);
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'cam_nospace');
  a.xor(REG.RAX, REG.RAX);
  a.movImm32(REG.RDX, OUT_KIND_SPACE);
  a.call('console_emit');
  a.label('cam_nospace');
  a.pop(REG.RAX);
  a.movImm32(REG.RDX, OUT_KIND_RAW);
  a.call('console_emit');
  a.inc(REG.R15);
  a.jmp('console_skip_ws');

  a.label('console_arg_last');
  a.push(REG.RAX);
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'cal_nospace');
  a.xor(REG.RAX, REG.RAX);
  a.movImm32(REG.RDX, OUT_KIND_SPACE);
  a.call('console_emit');
  a.label('cal_nospace');
  a.pop(REG.RAX);
  a.xor(REG.RDX, REG.RDX);          // value + newline
  a.call('console_emit');

  // Statement form consumes the closing ')' and continues with the next
  // statement. Expression form (console.log inside an arrow body) returns 0
  // to the caller with R12 just past the ')'.
  a.label('console_stmt_done');
  a.load64(REG.RCX, REG.RBP, STATE_CONSOLE_VALUE);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'console_stmt_skip');
  a.xor(REG.RCX, REG.RCX);
  a.store64(REG.RBP, REG.RCX, STATE_CONSOLE_VALUE);
  a.inc(REG.R12);                   // consume ')'
  a.xor(REG.RAX, REG.RAX);
  a.ret();
  a.label('console_stmt_skip');
  a.jmp('skip_to_close_paren');

  // --------------------------------------------------------------- let ...
  a.label('handle_let');
  // Skip whitespace between "let" and the variable name.
  a.label('let_skip_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'let_hash_var');
  a.inc(REG.R12);
  a.jmp('let_skip_ws');

  // Hash the variable name.
  a.label('let_hash_var');
  a.movImm64(REG.RBX, FNV_OFFSET_STR);

  a.label('let_var_hash_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 61);  // '='
  a.jcc(COND.E, 'let_found_eq');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'let_seek_eq');

  a.xor(REG.RBX, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.RBX, REG.RDX);
  a.inc(REG.R12);
  a.jmp('let_var_hash_loop');

  a.label('let_seek_eq');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 61);  // '='
  a.jcc(COND.E, 'let_found_eq');
  a.inc(REG.R12);
  a.jmp('let_seek_eq');

  a.label('let_found_eq');
  a.inc(REG.R12);

  a.label('let_skip_ws2');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'let_parse_value');
  a.inc(REG.R12);
  a.jmp('let_skip_ws2');

  // Parse the value expression into RAX.
  a.label('let_parse_value');
  a.cmpImm8(REG.RAX, 40);  // '(' -> parenthesized expression
  a.jcc(COND.E, 'let_value_group');
  a.cmpImm8(REG.RAX, 91);  // '[' -> array literal
  a.jcc(COND.E, 'let_value_array');
  a.cmpImm8(REG.RAX, 39);  // '
  a.jcc(COND.E, 'let_value_string');
  a.cmpImm8(REG.RAX, 34);  // "
  a.jcc(COND.E, 'let_value_string');
  a.cmpImm8(REG.RAX, 45);  // '-'
  a.jcc(COND.E, 'let_parse_negative');
  a.cmpImm8(REG.RAX, 65);  // 'A'
  a.jcc(COND.L, 'let_parse_number');
  a.cmpImm8(REG.RAX, 90);  // 'Z'
  a.jcc(COND.LE, 'let_value_ident');
  a.cmpImm8(REG.RAX, 97);  // 'a'
  a.jcc(COND.L, 'let_parse_number');
  a.cmpImm8(REG.RAX, 122); // 'z'
  a.jcc(COND.LE, 'let_value_ident');
  a.jmp('let_parse_number');

  a.label('let_value_string');
  a.call('parse_string');
  a.jmp('let_after_primary');

  a.label('let_value_array');
  a.call('parse_array');
  a.jmp('let_after_primary');

  a.label('let_value_group');
  a.call('parse_group');
  a.call('value_member');
  a.jmp('let_after_primary');

  a.label('let_value_ident');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('let_ident_loop');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 46);  // '.'
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 91);  // '['
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 93);  // ']'
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 41);  // ')'
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 59);  // ';'
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'let_ident_done');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'let_ident_done');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('let_ident_loop');

  a.label('let_ident_done');
  a.movImm64(REG.RCX, HASH_REQUIRE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_require');
  a.movImm64(REG.RCX, HASH_FS_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_fs');
  a.movImm64(REG.RCX, HASH_NET_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_net');
  a.movImm64(REG.RCX, HASH_FETCH_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_fetch');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'let_value_slot');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'let_value_object');
  a.movImm64(REG.RCX, HASH_SETTIMEOUT_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_call');
  a.movImm64(REG.RCX, HASH_SETINTERVAL_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_call');
  a.cmpImm8(REG.RAX, 40);  // '(' -> function call value
  a.jcc(COND.E, 'let_value_call');
  a.label('let_value_slot');
  emitSlotIndex(a, REG.R8, REG.RCX, 'let_load_slot');
  a.call('load_slot');
  a.call('maybe_index');
  a.jmp('let_after_primary');
  a.label('let_unsupported');
  a.xor(REG.RAX, REG.RAX);  // unsupported expression -> 0
  a.jmp('let_after_primary');

  a.label('let_value_require');
  a.call('call_require');
  a.jmp('let_after_primary');

  a.label('let_value_call');
  a.movImm64(REG.RCX, HASH_SETTIMEOUT_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_timer');
  a.movImm64(REG.RCX, HASH_SETINTERVAL_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'let_value_timer');
  a.call('lookup_function');      // R8 = name hash
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'let_call_unknown');
  a.leaRip(REG.R10, 'let_after_call');
  a.jmp('call_function');
  a.label('let_call_unknown');
  a.call('skip_paren_group');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('let_after_call');

  a.label('let_value_timer');
  a.push(REG.RBX);                  // let keeps the variable-name hash in RBX
  a.call('parse_timer_call');
  a.pop(REG.RBX);
  a.jmp('let_after_call');

  a.label('let_after_call');
  a.call('value_member');
  a.jmp('let_after_primary');

  a.label('let_value_fs');
  a.call('call_fs_method');
  a.jmp('let_after_primary');

  a.label('let_value_net');
  a.call('call_net_method');
  a.jmp('let_after_primary');

  a.label('let_value_fetch');
  a.call('call_fetch');
  a.call('value_member');
  a.jmp('let_after_primary');

  a.label('let_value_object');
  a.call('call_object_method_h');
  a.call('value_member');
  a.jmp('let_after_primary');

  // Parse a decimal integer into RAX.
  a.label('let_parse_number');
  a.xor(REG.RAX, REG.RAX);

  a.label('let_num_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'let_after_primary');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 48);
  a.jcc(COND.L, 'let_after_primary');
  a.cmpImm8(REG.RCX, 57);
  a.jcc(COND.G, 'let_after_primary');
  a.movImm32(REG.RDX, 10);
  a.imul(REG.RAX, REG.RDX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RAX, REG.RCX);
  a.inc(REG.R12);
  a.jmp('let_num_loop');

  // Negative integer literal: -123 -> TAG_NEG | magnitude.
  a.label('let_parse_negative');
  a.inc(REG.R12);
  a.xor(REG.RAX, REG.RAX);
  a.label('let_neg_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'let_neg_done');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 48);
  a.jcc(COND.L, 'let_neg_done');
  a.cmpImm8(REG.RCX, 57);
  a.jcc(COND.G, 'let_neg_done');
  a.movImm32(REG.RDX, 10);
  a.imul(REG.RAX, REG.RDX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RAX, REG.RCX);
  a.inc(REG.R12);
  a.jmp('let_neg_loop');
  a.label('let_neg_done');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'let_after_primary');
  a.movImm64(REG.RCX, TAG_NEG_STR);
  a.or(REG.RAX, REG.RCX);
  a.jmp('let_after_primary');

  // A primary value is in RAX. If a '+' follows, parse another primary and
  // concatenate/add, repeating for chains like a + b + c.
  a.label('let_after_primary');
  a.label('lap_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'let_store');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.NE, 'lap_check');       // only spaces, never a newline
  a.inc(REG.R12);
  a.jmp('lap_scan');

  a.label('lap_check');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'lap_plus');
  a.jmp('let_store');

  a.label('lap_plus');
  a.inc(REG.R12);
  a.push(REG.RAX);
  a.call('parse_value');
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RAX);
  a.call('concat_values');
  a.jmp('let_after_primary');

  // Store the value into the register-file slot selected by the name hash.
  a.label('let_store');
  emitSlotIndex(a, REG.RBX, REG.RCX, 'let_slot');
  a.call('store_slot');
  a.jmp('skip_to_end');

  // -------------------------------------------------------------- modules
  a.label('handle_require');
  a.call('call_require');
  a.jmp('skip_to_end');

  a.label('handle_fs');
  a.call('call_fs_method');
  a.jmp('skip_to_end');

  a.label('handle_net');
  a.call('call_net_method');
  a.jmp('skip_to_end');

  a.label('handle_fetch');
  a.call('call_fetch');
  a.call('value_member');
  a.jmp('skip_to_end');

  a.label('handle_object_method');
  a.call('call_object_method');
  a.call('value_member');
  a.jmp('skip_to_end');

  a.label('handle_array');
  // "arr" is a reserved dispatch token; if a '.', '[' or '=' follows, route
  // it like any other variable receiver so arr.push(...) and arr[i] = v work.
  a.label('ha_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'ha_check');
  a.cmpImm8(REG.RAX, 10);
  a.jcc(COND.E, 'skip_to_end');
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.E, 'skip_to_end');
  a.inc(REG.R12);
  a.jmp('ha_ws');
  a.label('ha_check');
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'handle_object_method');
  a.cmpImm8(REG.RAX, 91);  // '[' -> indexed assignment
  a.jcc(COND.E, 'handle_index_assign');
  a.cmpImm8(REG.RAX, 61);  // '=' -> plain variable assignment
  a.jcc(COND.E, 'handle_var_assign');
  a.cmpImm8(REG.RAX, 40);  // '(' -> function call statement
  a.jcc(COND.E, 'handle_statement_call');
  a.jmp('skip_to_end');

  // ---------------------------------------------------- indexed assignment
  // RBX = receiver name hash, R12 at '['. Parses a[i] = value and stores the
  // value into element i when the receiver is an array and i is in range.
  // Non-integer/negative indices, non-arrays, and out-of-range writes are
  // ignored (the expression is still parsed so parsing stays in sync).
  a.label('handle_index_assign');
  emitSlotIndex(a, REG.RBX, REG.RCX, 'hia_slot');
  a.call('load_slot');            // RAX = receiver
  a.push(REG.RAX);
  a.call('parse_index');          // RAX = index, R12 past ']'
  a.push(REG.RAX);
  a.label('hia_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'hia_fail');
  a.load8(REG.RCX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RCX, 61);         // '='
  a.jcc(COND.E, 'hia_value');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'hia_ws');
  a.jmp('hia_fail');

  a.label('hia_value');
  a.call('parse_value_line');
  a.label('hia_ready');
  a.pop(REG.RDX);                 // index
  a.pop(REG.R8);                  // receiver
  a.mov(REG.RCX, REG.RDX);
  a.shrImm8(REG.RCX, 56);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.NZ, 'hia_done');     // negative or non-integer index
  a.mov(REG.RCX, REG.R8);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xfb);
  a.jcc(COND.NE, 'hia_done');     // not an array
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);         // handle
  a.load64(REG.RCX, REG.R8, 0);   // len
  a.cmp(REG.RDX, REG.RCX);
  a.jcc(COND.GE, 'hia_done');     // out of range
  a.load64(REG.R8, REG.R8, 16);   // data buffer
  a.store64Indexed(REG.R8, REG.RDX, REG.RAX);
  a.label('hia_done');
  a.jmp('skip_to_end');

  a.label('hia_fail');
  a.addImm32(REG.RSP, 16);        // drop receiver and index
  a.jmp('skip_to_end');

  // ------------------------------------------------------ plain assignment
  // RBX = variable name hash, R12 at '='. Parses the value and rebinds the
  // variable's register-file slot.
  a.label('handle_var_assign');
  a.inc(REG.R12);                 // consume '='
  a.call('parse_value_line');
  emitSlotIndex(a, REG.RBX, REG.RCX, 'hva_slot');
  a.call('store_slot');
  a.jmp('skip_to_end');

  // ------------------------------------------------------------- loops
  // while (cond) { ... }
  // for (init; cond; step) { ... }
  //
  // A loop record [conditionStart][stepStart] is pushed when the loop body is
  // entered and popped when the condition is false. Closing '}' rewinds to
  // the condition (running the for-step first when present). Re-parsing the
  // condition from its original source position keeps the streaming parser
  // stateless apart from the small loop stack.
  a.label('handle_while');
  a.label('hw_seek_lparen');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);         // '('
  a.jcc(COND.E, 'hw_cond');
  a.jmp('hw_seek_lparen');
  a.label('hw_cond');
  a.mov(REG.RCX, REG.R12);        // conditionStart
  a.xor(REG.RDX, REG.RDX);        // no step
  a.xor(REG.R8, REG.R8);          // type 0: loop
  a.call('push_control');
  a.jmp('loop_repeat');

  a.label('handle_for');
  a.label('hf_seek_lparen');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);         // '('
  a.jcc(COND.E, 'hf_init');
  a.jmp('hf_seek_lparen');
  a.label('hf_init');
  a.call('exec_assign_expr');     // run the init expression once
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 59);         // ';'
  a.jcc(COND.NE, 'skip_to_end');
  a.inc(REG.R12);
  a.mov(REG.RCX, REG.R12);        // conditionStart
  a.label('hf_scan_semi');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 59);         // ';' before the step
  a.jcc(COND.E, 'hf_have_step');
  a.jmp('hf_scan_semi');
  a.label('hf_have_step');
  a.mov(REG.RDX, REG.R12);        // stepStart
  a.mov(REG.R12, REG.RCX);        // evaluate the condition first
  a.xor(REG.R8, REG.R8);          // type 0: loop
  a.call('push_control');
  a.jmp('loop_repeat');

  // Re-evaluate the innermost loop condition.
  a.label('loop_repeat');
  a.call('eval_condition');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'loop_exit');
  a.call('skip_to_body');
  a.jmp('main_loop');
  a.label('loop_exit');
  a.call('pop_control');
  a.call('skip_loop_end');
  a.jmp('main_loop');

  // R12 at a closing '}'.
  //  - loop frame: run the for-step (if any), then re-check the condition.
  //  - if-chain frame: jump directly to the end of the whole if/else chain.
  //  - no frame: just consume the brace.
  a.label('handle_block_end');
  a.call('load_top_control');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'hbe_plain');
  a.cmpImm32(REG.R8, 2);          // type 2: function boundary
  a.jcc(COND.E, 'hbe_function');
  a.cmpImm32(REG.R8, 3);          // type 3: remote function boundary
  a.jcc(COND.E, 'hbe_remote');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'hbe_loop');
  // if-chain: resume after the final else/if body in the chain
  a.mov(REG.R12, REG.RCX);
  a.call('pop_control');
  a.jmp('main_loop');
  a.label('hbe_function');
  a.call('pop_control');          // discard the function frame
  a.xor(REG.RAX, REG.RAX);        // implicit return value
  a.jmp('function_return');       // tail jump: it never returns here
  a.label('hbe_remote');
  a.call('pop_control');          // discard the remote frame
  a.xor(REG.RAX, REG.RAX);        // implicit return value
  a.jmp('remote_return');         // hand the value back to the dispatcher
  a.label('hbe_loop');
  a.inc(REG.R12);                 // consume '}'
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'hbe_while');
  a.push(REG.RCX);                // preserve conditionStart across the step
  a.mov(REG.R12, REG.RDX);        // stepStart
  a.call('exec_assign_expr');
  a.pop(REG.RCX);
  a.label('hbe_while');
  a.mov(REG.R12, REG.RCX);
  a.jmp('loop_repeat');
  a.label('hbe_plain');
  a.inc(REG.R12);
  a.jmp('main_loop');

  // ------------------------------------------------------------ if / else
  // The whole chain is treated like a switch: pre-scan once to find the
  // position just past the last clause, then evaluate conditions in order.
  // The first true body runs and its closing '}' resumes at chainEnd, so no
  // else-tracking is needed after a branch is taken.
  a.label('handle_if');
  a.mov(REG.RAX, REG.R12);        // first clause starts after "if"
  a.push(REG.RAX);
  a.call('find_chain_end');       // R12 = end of the whole chain
  a.mov(REG.RCX, REG.R12);
  a.pop(REG.R12);                 // restore the first clause
  a.push(REG.RCX);                // keep chainEnd on the stack

  a.label('hi_clause');
  a.label('hi_seek_lparen');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'hi_abort');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);         // '('
  a.jcc(COND.E, 'hi_cond');
  a.jmp('hi_seek_lparen');
  a.label('hi_cond');
  a.call('eval_condition');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'hi_take');

  // Clause failed: skip its body and look for else / else-if.
  a.call('skip_loop_end');
  a.call('match_else');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'hi_abort');
  a.call('match_if');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'hi_clause');

  // Plain else: execute it.
  a.pop(REG.RCX);                 // chainEnd
  a.movImm32(REG.R8, 1);          // type 1: if/else chain
  a.xor(REG.RDX, REG.RDX);
  a.call('push_control');
  a.call('skip_to_body');
  a.jmp('main_loop');

  a.label('hi_take');
  a.pop(REG.RCX);                 // chainEnd
  a.movImm32(REG.R8, 1);          // type 1: if/else chain
  a.xor(REG.RDX, REG.RDX);
  a.call('push_control');
  a.call('skip_to_body');
  a.jmp('main_loop');

  a.label('hi_abort');
  a.pop(REG.RCX);                 // chainEnd
  a.mov(REG.R12, REG.RCX);
  a.jmp('main_loop');

  // A stray top-level "else" means the preceding then-branch already ran;
  // skip the entire else clause.
  a.label('handle_else');
  a.call('match_if');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'he_if');
  a.call('skip_loop_end');
  a.jmp('main_loop');
  a.label('he_if');
  a.call('find_chain_end');
  a.jmp('main_loop');

  // Scan a whole if/else-if/else chain from just after the first "if" and
  // leave R12 at its end.
  a.label('find_chain_end');
  a.label('fce_loop');
  a.call('skip_loop_end');        // skip this clause's body
  a.call('match_else');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'fce_done');
  a.call('match_if');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'fce_loop');
  a.call('skip_loop_end');        // plain else body ends the chain
  a.label('fce_done');
  a.ret();

  // ------------------------------------------------- user-defined functions
  // function name(p0, p1, ...) { body }
  //
  // The engine is a continuation interpreter, so a call is not a hardware
  // call: it saves a continuation label and the caller's resume position in a
  // frame, spills the ring register file, binds parameters, then jumps back
  // into main_loop with R12 at the body start. A `return` (or the body's
  // closing '}') restores the frame and jumps to the stored continuation.
  a.label('handle_function');
  a.call('skip_ws_all');

  // Hash the function name into R8.
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('fndef_name_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 40);         // '('
  a.jcc(COND.E, 'fndef_name_done');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'fndef_name_done');
  a.xor(REG.R8, REG.RAX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('fndef_name_loop');

  a.label('fndef_name_done');
  // Reserve a 192-byte registry entry; RBX holds its pointer across the scan.
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R10, REG.R9, 0);
  a.cmpImm32(REG.R10, FUNC_TABLE_CAP);
  a.jcc(COND.GE, 'fndef_ignore');
  a.mov(REG.R11, REG.R10);
  a.shlImm8(REG.R11, 7);          // count * 128
  a.mov(REG.RBX, REG.R10);
  a.shlImm8(REG.RBX, 6);          // count * 64
  a.add(REG.R11, REG.RBX);        // count * 192
  a.movImm64(REG.RBX, '0x' + (heapBase + FUNC_TABLE).toString(16));
  a.add(REG.RBX, REG.R11);
  a.store64(REG.RBX, REG.R8, 0);  // name hash
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBX, REG.RAX, 24); // param count = 0
  a.store64(REG.RBX, REG.RAX, FUNC_FLAGS);
  a.store64(REG.RBX, REG.RAX, FUNC_SPILL_MASK);
  a.store64(REG.RBX, REG.RAX, FUNC_DEP_COUNT);

  // Skip to '('.
  a.label('fndef_seek_paren');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fndef_ignore');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);
  a.jcc(COND.E, 'fndef_params');
  a.jmp('fndef_seek_paren');

  a.label('fndef_params');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fndef_body');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);         // ')'
  a.jcc(COND.E, 'fndef_body');
  a.cmpImm8(REG.RAX, 44);         // ','
  a.jcc(COND.E, 'fndef_param_comma');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'fndef_param_ws');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('fndef_param_hash');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fndef_param_store');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 44);         // ','
  a.jcc(COND.E, 'fndef_param_store');
  a.cmpImm8(REG.RAX, 41);         // ')'
  a.jcc(COND.E, 'fndef_param_store');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'fndef_param_store');
  a.xor(REG.R8, REG.RAX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('fndef_param_hash');

  a.label('fndef_param_store');
  a.load64(REG.R10, REG.RBX, 24); // parameter count so far
  a.cmpImm32(REG.R10, 8);         // at most 8 named parameters
  a.jcc(COND.GE, 'fndef_params');
  a.mov(REG.R11, REG.R10);
  a.shlImm8(REG.R11, 3);
  a.add(REG.R11, REG.RBX);
  a.store64(REG.R11, REG.R8, 32);
  a.inc(REG.R10);
  a.store64(REG.RBX, REG.R10, 24);
  a.jmp('fndef_params');

  a.label('fndef_param_comma');
  a.inc(REG.R12);
  a.jmp('fndef_params');
  a.label('fndef_param_ws');
  a.inc(REG.R12);
  a.jmp('fndef_params');

  a.label('fndef_body');
  a.call('skip_to_body');         // consume the opening '{'
  a.store64(REG.RBX, REG.R12, 8); // body start
  a.call('scan_block_body');      // R12 just past the matching '}'
  a.store64(REG.RBX, REG.R12, 16);
  a.call('analyze_function');     // spill mask, deps, remote eligibility
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R10, REG.R9, 0);
  a.inc(REG.R10);
  a.store64(REG.R9, REG.R10, 0);
  a.jmp('main_loop');

  a.label('fndef_ignore');
  a.call('skip_to_body');
  a.call('scan_block_body');
  a.jmp('main_loop');

  // R12 just past a block's '{'. Scan to just past its matching '}', skipping
  // quoted strings. Preserves RBX and R12-R15; clobbers RAX, R8, R9.
  a.label('scan_block_body');
  a.movImm32(REG.R8, 1);
  a.label('scanbody_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'scanbody_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);         // '
  a.jcc(COND.E, 'scanbody_q1');
  a.cmpImm8(REG.RAX, 34);         // "
  a.jcc(COND.E, 'scanbody_q2');
  a.cmpImm8(REG.RAX, 123);        // '{'
  a.jcc(COND.E, 'scanbody_inc');
  a.cmpImm8(REG.RAX, 125);        // '}'
  a.jcc(COND.E, 'scanbody_dec');
  a.jmp('scanbody_loop');
  a.label('scanbody_inc');
  a.inc(REG.R8);
  a.jmp('scanbody_loop');
  a.label('scanbody_dec');
  a.dec(REG.R8);
  a.test(REG.R8, REG.R8);
  a.jcc(COND.NZ, 'scanbody_loop');
  a.ret();
  a.label('scanbody_q1');
  a.movImm32(REG.R9, 39);
  a.jmp('scanbody_qloop');
  a.label('scanbody_q2');
  a.movImm32(REG.R9, 34);
  a.label('scanbody_qloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'scanbody_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'scanbody_qloop');
  a.jmp('scanbody_loop');
  a.label('scanbody_ret');
  a.ret();

  // R12 at '('. Skip to just past the matching ')', including nesting and
  // quoted strings. Used for calls to unknown names. Preserves RBP; clobbers
  // RAX, R8, R9.
  a.label('skip_paren_group');
  a.xor(REG.R8, REG.R8);
  a.label('skipparen_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skipparen_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);         // '
  a.jcc(COND.E, 'skipparen_q1');
  a.cmpImm8(REG.RAX, 34);         // "
  a.jcc(COND.E, 'skipparen_q2');
  a.cmpImm8(REG.RAX, 40);         // '('
  a.jcc(COND.E, 'skipparen_open');
  a.cmpImm8(REG.RAX, 41);         // ')'
  a.jcc(COND.E, 'skipparen_close');
  a.jmp('skipparen_loop');
  a.label('skipparen_open');
  a.inc(REG.R8);
  a.jmp('skipparen_loop');
  a.label('skipparen_close');
  a.dec(REG.R8);
  a.test(REG.R8, REG.R8);
  a.jcc(COND.NZ, 'skipparen_loop');
  a.ret();
  a.label('skipparen_q1');
  a.movImm32(REG.R9, 39);
  a.jmp('skipparen_qloop');
  a.label('skipparen_q2');
  a.movImm32(REG.R9, 34);
  a.label('skipparen_qloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skipparen_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'skipparen_qloop');
  a.jmp('skipparen_loop');
  a.label('skipparen_ret');
  a.ret();

  // --------------------------------------------------- analyze_function
  // RBX = registry entry, body bounds already stored. Scans the body text and
  // records (a) the ZMM registers a local call must preserve, (b) up to 16
  // ring slots the remote worker needs, and (c) whether the body is simple
  // enough to run on the compute worker.
  //
  // Remote eligibility is deliberately conservative: any member access,
  // index, call, I/O builtin or nested function keeps the call local. The
  // scan only needs to be safe, not clever: a false negative costs a local
  // call, a false positive would be a correctness bug.
  //
  // Preserves R12/R13/R14/R15, clobbers RAX, RCX, RDX, R8-R11.
  a.label('analyze_function');
  a.push(REG.R12);
  a.push(REG.R13);
  a.push(REG.R14);
  a.load64(REG.R12, REG.RBX, 8);   // body start
  a.load64(REG.R13, REG.RBX, 16);  // body end
  a.movImm32(REG.RAX, 1);
  a.store64(REG.RBX, REG.RAX, FUNC_FLAGS);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBX, REG.RAX, FUNC_SPILL_MASK);
  a.store64(REG.RBX, REG.RAX, FUNC_DEP_COUNT);

  a.label('af_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'af_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'af_loop');       // whitespace / newlines
  a.cmpImm8(REG.RAX, 39);          // '
  a.jcc(COND.E, 'af_q1');
  a.cmpImm8(REG.RAX, 34);          // "
  a.jcc(COND.E, 'af_q2');
  a.cmpImm8(REG.RAX, 46);          // .
  a.jcc(COND.E, 'af_not_remote');
  a.cmpImm8(REG.RAX, 91);          // [
  a.jcc(COND.E, 'af_not_remote');
  a.cmpImm8(REG.RAX, 93);          // ]
  a.jcc(COND.E, 'af_not_remote');

  // Digits are skipped one at a time.
  a.cmpImm8(REG.RAX, 48);
  a.jcc(COND.L, 'af_not_digit');
  a.cmpImm8(REG.RAX, 57);
  a.jcc(COND.LE, 'af_loop');
  a.label('af_not_digit');

  // Identifier start: A-Z, a-z, '_' or '$'.
  a.cmpImm8(REG.RAX, 65);
  a.jcc(COND.L, 'af_not_upper');
  a.cmpImm8(REG.RAX, 90);
  a.jcc(COND.LE, 'af_ident_start');
  a.label('af_not_upper');
  a.cmpImm8(REG.RAX, 97);
  a.jcc(COND.L, 'af_not_lower');
  a.cmpImm8(REG.RAX, 122);
  a.jcc(COND.LE, 'af_ident_start');
  a.label('af_not_lower');
  a.cmpImm8(REG.RAX, 95);          // '_'
  a.jcc(COND.E, 'af_ident_start');
  a.cmpImm8(REG.RAX, 36);          // '$'
  a.jcc(COND.E, 'af_ident_start');
  a.jmp('af_loop');

  a.label('af_ident_start');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.xor(REG.R8, REG.RAX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);

  a.label('af_ident_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'af_ident_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 48);
  a.jcc(COND.L, 'af_ident_alpha');
  a.cmpImm8(REG.RAX, 57);
  a.jcc(COND.LE, 'af_ident_next');
  a.label('af_ident_alpha');
  a.cmpImm8(REG.RAX, 65);
  a.jcc(COND.L, 'af_ident_lower');
  a.cmpImm8(REG.RAX, 90);
  a.jcc(COND.LE, 'af_ident_next');
  a.label('af_ident_lower');
  a.cmpImm8(REG.RAX, 97);
  a.jcc(COND.L, 'af_ident_extra');
  a.cmpImm8(REG.RAX, 122);
  a.jcc(COND.LE, 'af_ident_next');
  a.label('af_ident_extra');
  a.cmpImm8(REG.RAX, 95);
  a.jcc(COND.E, 'af_ident_next');
  a.cmpImm8(REG.RAX, 36);
  a.jcc(COND.E, 'af_ident_next');
  a.jmp('af_ident_done');
  a.label('af_ident_next');
  a.xor(REG.R8, REG.RAX);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('af_ident_loop');

  a.label('af_ident_done');
  // Hard rejects: nested definitions and I/O builtins.
  a.movImm64(REG.RCX, HASH_FUNCTION_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');
  a.movImm64(REG.RCX, HASH_CONSOLE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');
  a.movImm64(REG.RCX, HASH_REQUIRE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');
  a.movImm64(REG.RCX, HASH_FS_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');
  a.movImm64(REG.RCX, HASH_NET_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');
  a.movImm64(REG.RCX, HASH_FETCH_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');
  a.movImm64(REG.RCX, HASH_PROCESS_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_not_remote');

  // Language keywords are not variable reads.
  a.movImm64(REG.RCX, HASH_LET_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_CONST_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_VAR_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_WHILE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_FOR_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_IF_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_ELSE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_RETURN_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_TRUE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');
  a.movImm64(REG.RCX, HASH_FALSE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'af_loop');

  // A regular identifier: add it to the dependency/spill set.
  a.call('af_add_dep');

  // If the next non-space token is '(' this is a call, so keep it local.
  a.label('af_peek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'af_loop');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 10);
  a.jcc(COND.E, 'af_loop');
  a.cmpImm8(REG.RAX, 13);
  a.jcc(COND.E, 'af_loop');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'af_peek_check');
  a.inc(REG.R12);
  a.jmp('af_peek');
  a.label('af_peek_check');
  a.cmpImm8(REG.RAX, 40);          // '('
  a.jcc(COND.E, 'af_not_remote');
  a.jmp('af_loop');

  // Skip a quoted literal so punctuation inside it cannot reject the body.
  a.label('af_q1');
  a.movImm32(REG.R11, 39);
  a.jmp('af_qloop');
  a.label('af_q2');
  a.movImm32(REG.R11, 34);
  a.label('af_qloop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'af_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R11);
  a.jcc(COND.NE, 'af_qloop');
  a.jmp('af_loop');

  a.label('af_not_remote');
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBX, REG.RAX, FUNC_FLAGS);
  a.jmp('af_loop');

  // R8 = identifier hash. Adds its ring slot to the dependency list
  // (deduped) and its ZMM register to the spill mask. A body that needs more
  // than the fixed dependency set stays local, because the worker could not
  // see every global it reads. Clobbers RAX, RCX, RDX, R9-R11.
  a.label('af_add_dep');
  a.load64(REG.R9, REG.RBX, FUNC_DEP_COUNT);
  a.mov(REG.R10, REG.R8);
  a.andImm32(REG.R10, 0xff);
  a.cmpImm32(REG.R10, RING_SLOTS);
  a.jcc(COND.L, 'af_slot_ok');
  a.subImm32(REG.R10, 8);
  a.label('af_slot_ok');
  a.mov(REG.RCX, REG.RBX);
  a.addImm32(REG.RCX, FUNC_DEPS);
  a.xor(REG.R11, REG.R11);
  a.label('af_dep_cmp');
  a.cmp(REG.R11, REG.R9);
  a.jcc(COND.GE, 'af_dep_add');
  a.load8Indexed(REG.RDX, REG.RCX, REG.R11);
  a.cmp(REG.RDX, REG.R10);
  a.jcc(COND.E, 'af_dep_ret');
  a.inc(REG.R11);
  a.jmp('af_dep_cmp');
  a.label('af_dep_add');
  a.cmpImm32(REG.R9, 16);
  a.jcc(COND.L, 'af_dep_room');
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBX, REG.RAX, FUNC_FLAGS);
  a.jmp('af_dep_ret');
  a.label('af_dep_room');
  a.add(REG.RCX, REG.R9);
  a.store8(REG.RCX, REG.R10);
  a.inc(REG.R9);
  a.store64(REG.RBX, REG.R9, FUNC_DEP_COUNT);
  a.call('af_add_mask');
  a.label('af_dep_ret');
  a.ret();

  // R8 = identifier hash. Sets the spill-mask bit for its ring register.
  // Clobbers RCX, RDX, R10; preserves R8, R9, R11.
  a.label('af_add_mask');
  a.mov(REG.R10, REG.R8);
  a.andImm32(REG.R10, 0xff);
  a.cmpImm32(REG.R10, RING_SLOTS);
  a.jcc(COND.L, 'afm_slot_ok');
  a.subImm32(REG.R10, 8);
  a.label('afm_slot_ok');
  a.shrImm8(REG.R10, 3);           // ring index 0..30 (index into RING_REGS)
  a.movImm32(REG.RDX, 1);
  a.mov(REG.RCX, REG.R10);
  a.shlCl(REG.RDX);
  a.load64(REG.RCX, REG.RBX, FUNC_SPILL_MASK);
  a.or(REG.RCX, REG.RDX);
  a.store64(REG.RBX, REG.RCX, FUNC_SPILL_MASK);
  a.ret();

  // Include every parameter slot: binding writes a parameter even when the
  // body never reads it, so the caller's colliding slot must be preserved.
  a.label('af_done');
  a.load64(REG.R14, REG.RBX, 24);  // parameter count
  a.xor(REG.R11, REG.R11);
  a.label('af_param_loop');
  a.cmp(REG.R11, REG.R14);
  a.jcc(COND.GE, 'af_param_done');
  a.mov(REG.RCX, REG.R11);
  a.shlImm8(REG.RCX, 3);
  a.add(REG.RCX, REG.RBX);
  a.load64(REG.R8, REG.RCX, 32);
  a.call('af_add_mask');
  a.inc(REG.R11);
  a.jmp('af_param_loop');
  a.label('af_param_done');
  a.pop(REG.R14);
  a.pop(REG.R13);
  a.pop(REG.R12);
  a.ret();

  // R8 = name hash. Returns RAX = registry entry pointer, or 0.
  // Scans newest-first so a redefinition shadows the earlier one.
  // Clobbers RAX, RCX, R9, R10, R11; preserves R8.
  a.label('lookup_function');
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R10, REG.R9, 0);
  a.mov(REG.R11, REG.R10);
  a.label('flookup_loop');
  a.test(REG.R11, REG.R11);
  a.jcc(COND.Z, 'flookup_none');
  a.dec(REG.R11);
  a.mov(REG.RAX, REG.R11);
  a.shlImm8(REG.RAX, 7);          // i * 128
  a.mov(REG.RCX, REG.R11);
  a.shlImm8(REG.RCX, 6);          // i * 64
  a.add(REG.RAX, REG.RCX);        // i * 192
  a.movImm64(REG.RCX, '0x' + (heapBase + FUNC_TABLE).toString(16));
  a.add(REG.RAX, REG.RCX);
  a.load64(REG.RCX, REG.RAX, 0);
  a.cmp(REG.RCX, REG.R8);
  a.jcc(COND.NE, 'flookup_loop');
  // Synthetic .then callbacks are not callable by name.
  a.load64(REG.RCX, REG.RAX, FUNC_FLAGS);
  a.btImm(REG.RCX, 1);             // FUNC_CALLBACK
  a.jcc(COND.C, 'flookup_loop');
  a.label('flookup_found');
  a.ret();
  a.label('flookup_none');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // ------------------------------------------------ invoke a known function
  // RBX = registry entry, R10 = continuation address, R15 = argc, argv already
  // pushed left-to-right on the CPU stack, R12 = resume position. Used by
  // .then() so a callback can be invoked without re-parsing an argument list.
  // Shares the frame layout and return path with call_function.
  a.label('invoke_function');
  a.push(REG.RBX);
  a.push(REG.RBP);
  a.push(REG.R15);

  a.load64(REG.R8, REG.RBP, STATE_FUNC_DEPTH);
  a.cmpImm32(REG.R8, FUNC_STACK_CAP);
  a.jcc(COND.GE, 'ifun_overflow');
  a.mov(REG.R11, REG.R8);
  a.shlImm8(REG.R11, 6);          // depth * 64
  a.mov(REG.RDX, REG.RBP);
  a.addImm32(REG.RDX, STATE_FUNC_STACK);
  a.add(REG.R11, REG.RDX);
  a.store64(REG.R11, REG.RBX, 56); // entry pointer
  a.store64(REG.R11, REG.R10, 8);  // continuation
  a.load64(REG.R9, REG.RBX, FUNC_SPILL_MASK);
  a.store64(REG.R11, REG.R9, 48);  // registers this call may clobber
  a.pop(REG.RAX);
  a.store64(REG.R11, REG.RAX, 32); // caller R15
  a.pop(REG.RAX);
  a.store64(REG.R11, REG.RAX, 24); // caller RBP (the state base)
  a.pop(REG.RAX);
  a.store64(REG.R11, REG.RAX, 16); // caller RBX
  a.mov(REG.RAX, REG.R8);
  a.inc(REG.RAX);
  a.store64(REG.RBP, REG.RAX, STATE_FUNC_DEPTH);
  a.store64(REG.R11, REG.R12, 0);  // retR12: resume position for the caller

  if (SPILL_RING) {
    a.load64(REG.R9, REG.R11, 48);  // spill mask saved in the call frame
    a.mov(REG.R10, REG.R8);
    a.shlImm8(REG.R10, 11);         // depth * 2048
    a.mov(REG.RDX, REG.RBP);
    a.addImm32(REG.RDX, STATE_FUNC_SAVE);
    a.add(REG.R10, REG.RDX);
    if (FULL_SPILL) {
      for (let j = 0; j < RING_REGS.length; j++) {
        a.vmovdqu64Store(REG.R10, j * 64, RING_REGS[j]);
      }
    } else {
      for (let j = 0; j < RING_REGS.length; j++) {
        a.btImm(REG.R9, j);
        a.jcc(COND.NC, `ifun_spill_skip_${j}`);
        a.vmovdqu64Store(REG.R10, j * 64, RING_REGS[j]);
        a.label(`ifun_spill_skip_${j}`);
      }
    }
  }

  a.call('bind_args');

  // Arrow callbacks may use an expression body. Evaluate it in place and
  // return the value through the normal function-return path.
  a.load64(REG.R8, REG.RBX, FUNC_FLAGS);
  a.btImm(REG.R8, 2);              // FUNC_EXPR_BODY
  a.jcc(COND.C, 'ifun_expr');
  a.movImm32(REG.R8, 2);           // type 2: function boundary
  a.xor(REG.RCX, REG.RCX);
  a.xor(REG.RDX, REG.RDX);
  a.call('push_control');
  a.load64(REG.R12, REG.RBX, 8);   // body start
  a.jmp('main_loop');

  a.label('ifun_expr');
  a.load64(REG.R12, REG.RBX, 8);   // expression start
  a.call('parse_expr');
  a.jmp('function_return');

  a.label('ifun_overflow');
  // Too deep: discard the saved registers and arguments, then continue with a
  // zero result. R10 still holds the continuation and R12 the resume point.
  a.pop(REG.RAX);
  a.pop(REG.RAX);
  a.pop(REG.RAX);
  a.label('ifun_overflow_args');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ifun_overflow_done');
  a.pop(REG.RAX);
  a.dec(REG.R15);
  a.jmp('ifun_overflow_args');
  a.label('ifun_overflow_done');
  a.xor(REG.RAX, REG.RAX);
  a.jmpReg(REG.R10);

  // RAX = registry entry, R10 = continuation address, R12 at '('.
  // Evaluates arguments left-to-right, binds parameters, then replays the
  // body. Arguments are evaluated in the caller's variable state; the ring is
  // spilled beforehand and restored on return, so locals are per-call.
  a.label('call_function');
  a.push(REG.RBX);
  a.push(REG.RBP);
  a.push(REG.R15);

  // Reserve a call frame at the current depth.
  a.load64(REG.R8, REG.RBP, STATE_FUNC_DEPTH);
  a.cmpImm32(REG.R8, FUNC_STACK_CAP);
  a.jcc(COND.GE, 'fcall_overflow');
  a.mov(REG.R11, REG.R8);
  a.shlImm8(REG.R11, 6);          // depth * 64
  a.mov(REG.RDX, REG.RBP);
  a.addImm32(REG.RDX, STATE_FUNC_STACK);
  a.add(REG.R11, REG.RDX);
  a.store64(REG.R11, REG.RAX, 56); // entry pointer
  a.store64(REG.R11, REG.R10, 8);  // continuation
  a.load64(REG.R9, REG.RAX, FUNC_SPILL_MASK);
  a.store64(REG.R11, REG.R9, 48);  // registers this call may clobber
  a.pop(REG.RAX);
  a.store64(REG.R11, REG.RAX, 32); // caller R15
  a.pop(REG.RAX);
  a.store64(REG.R11, REG.RAX, 24); // caller RBP (the state base)
  a.pop(REG.RAX);
  a.store64(REG.R11, REG.RAX, 16); // caller RBX
  a.mov(REG.RAX, REG.R8);
  a.inc(REG.RAX);
  a.store64(REG.RBP, REG.RAX, STATE_FUNC_DEPTH);

  // Parse arguments left-to-right, pushing each value on the CPU stack.
  a.inc(REG.R12);                 // consume '('
  a.xor(REG.R15, REG.R15);        // argc
  a.label('fcall_arg_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fcall_args_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);         // ')'
  a.jcc(COND.E, 'fcall_args_close');
  a.cmpImm8(REG.RAX, 44);         // ','
  a.jcc(COND.E, 'fcall_arg_comma');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'fcall_arg_ws');
  a.call('parse_expr');
  a.push(REG.RAX);
  a.inc(REG.R15);
  a.jmp('fcall_arg_loop');
  a.label('fcall_arg_comma');
  a.inc(REG.R12);
  a.jmp('fcall_arg_loop');
  a.label('fcall_arg_ws');
  a.inc(REG.R12);
  a.jmp('fcall_arg_loop');
  a.label('fcall_args_close');
  a.inc(REG.R12);                 // consume ')'
  a.label('fcall_args_done');

  // Recover the frame (nested argument calls have unwound by now).
  a.load64(REG.R8, REG.RBP, STATE_FUNC_DEPTH);
  a.dec(REG.R8);                  // frame index
  a.mov(REG.R11, REG.R8);
  a.shlImm8(REG.R11, 6);
  a.mov(REG.RDX, REG.RBP);
  a.addImm32(REG.RDX, STATE_FUNC_STACK);
  a.add(REG.R11, REG.RDX);
  a.store64(REG.R11, REG.R12, 0); // retR12: just past ')'
  a.load64(REG.RBX, REG.R11, 56); // entry pointer

  // If the callee is remote-eligible and this core is allowed to offload,
  // hand the call to the compute worker instead of replaying it here.
  if (REMOTE_CALLS && !SINGLE_CORE) {
    a.load8(REG.R9, REG.RBP, STATE_REMOTE_OK);
    a.test(REG.R9, REG.R9);
    a.jcc(COND.Z, 'fcall_local');
    a.load64(REG.R9, REG.RBX, FUNC_FLAGS);
    a.test(REG.R9, REG.R9);
    a.jcc(COND.Z, 'fcall_local');
    a.cmpImm32(REG.R15, 8);
    a.jcc(COND.G, 'fcall_local');
    a.jmp('dispatch_remote');
    a.label('fcall_local');
  }

  // Local call: spill the caller's variable state now that argument
  // evaluation is finished. Only the registers named in the callee body (plus
  // parameters) can be clobbered, so a full spill is unnecessary. Remote calls
  // skip this entirely; their frame mask is cleared before dispatch.
  if (SPILL_RING) {
    a.load64(REG.R9, REG.R11, 48);  // spill mask saved in the call frame
    a.mov(REG.R10, REG.R8);
    a.shlImm8(REG.R10, 11);         // depth * 2048
    a.mov(REG.RDX, REG.RBP);
    a.addImm32(REG.RDX, STATE_FUNC_SAVE);
    a.add(REG.R10, REG.RDX);
    if (FULL_SPILL) {
      for (let j = 0; j < RING_REGS.length; j++) {
        a.vmovdqu64Store(REG.R10, j * 64, RING_REGS[j]);
      }
    } else {
      for (let j = 0; j < RING_REGS.length; j++) {
        a.btImm(REG.R9, j);
        a.jcc(COND.NC, `fcall_spill_skip_${j}`);
        a.vmovdqu64Store(REG.R10, j * 64, RING_REGS[j]);
        a.label(`fcall_spill_skip_${j}`);
      }
    }
  }

  // Normalise the argument stack to exactly paramCount values, then bind
  // parameters from the last to the first (args were pushed left-to-right).
  a.call('bind_args');

  // Mark the function boundary, then replay the body.
  a.movImm32(REG.R8, 2);          // type 2: function boundary
  a.xor(REG.RCX, REG.RCX);
  a.xor(REG.RDX, REG.RDX);
  a.call('push_control');
  a.load64(REG.R12, REG.RBX, 8);  // body start
  a.jmp('main_loop');

  a.label('fcall_overflow');
  // Too deep: restore the caller's registers, skip the argument list, and
  // return 0 through the continuation.
  a.pop(REG.RAX);
  a.mov(REG.R15, REG.RAX);
  a.pop(REG.RAX);
  a.mov(REG.RBP, REG.RAX);
  a.pop(REG.RAX);
  a.mov(REG.RBX, REG.RAX);
  a.push(REG.R10);
  a.call('skip_paren_group');
  a.pop(REG.R10);
  a.xor(REG.RAX, REG.RAX);
  a.jmpReg(REG.R10);

  // ---------------------------------------------------------- dispatch_remote
  // RBX = registry entry, R15 = argc, argv values on the CPU stack. Copies the
  // request and its static dependency set into the compute worker's mailbox,
  // publishes the sequence number, then waits for the result. The caller's
  // ring is untouched by the worker, so the normal return path can restore
  // the selectively spilled registers and resume the continuation.
  a.label('dispatch_remote');
  a.movImm64(REG.R11, '0x' + (heapBase + COMP_REQ).toString(16));
  a.store64(REG.R11, REG.RBX, REQ_ENTRY);
  a.load64(REG.R8, REG.RBX, 16);
  a.store64(REG.R11, REG.R8, REQ_BODY_END);
  a.store64(REG.R11, REG.R15, REQ_ARGC);

  // Pop argv (pushed left-to-right) into the request, last argument first.
  a.label('dr_args');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'dr_args_done');
  a.dec(REG.R15);
  a.pop(REG.RAX);
  a.mov(REG.R9, REG.R15);
  a.shlImm8(REG.R9, 3);
  a.add(REG.R9, REG.R11);
  a.store64(REG.R9, REG.RAX, REQ_ARGS);
  a.jmp('dr_args');
  a.label('dr_args_done');

  // Snapshot the ring slots the worker will read. These are the caller's
  // current values, exactly what a local call would see when the body runs.
  a.load64(REG.R8, REG.RBX, FUNC_DEP_COUNT);
  a.store64(REG.R11, REG.R8, REQ_DEPC);
  a.xor(REG.R15, REG.R15);
  a.label('dr_dep_loop');
  a.cmp(REG.R15, REG.R8);
  a.jcc(COND.GE, 'dr_dep_done');
  a.mov(REG.R10, REG.RBX);
  a.addImm32(REG.R10, FUNC_DEPS);
  a.add(REG.R10, REG.R15);
  a.load8(REG.RAX, REG.R10, 0);    // ring slot
  a.mov(REG.R9, REG.R15);
  a.add(REG.R9, REG.R11);
  a.store8(REG.R9, REG.RAX, REQ_DEP_SLOTS);
  a.mov(REG.RCX, REG.RAX);
  a.call('load_slot');
  a.mov(REG.R9, REG.R15);
  a.shlImm8(REG.R9, 3);
  a.add(REG.R9, REG.R11);
  a.store64(REG.R9, REG.RAX, REQ_DEP_VALUES);
  a.inc(REG.R15);
  a.jmp('dr_dep_loop');
  a.label('dr_dep_done');

  // The worker runs in its own ring, so nothing needs restoring on return.
  // Clear the frame's spill mask; function_return will skip the ring restore.
  a.load64(REG.R9, REG.RBP, STATE_FUNC_DEPTH);
  a.dec(REG.R9);
  a.shlImm8(REG.R9, 6);
  a.mov(REG.R10, REG.RBP);
  a.addImm32(REG.R10, STATE_FUNC_STACK);
  a.add(REG.R9, REG.R10);
  a.xor(REG.R10, REG.R10);
  a.movImm32(REG.R10, 1);
  a.shlImm8(REG.R10, 63);          // sentinel: skip even a full-spill restore
  a.store64(REG.R9, REG.R10, 48);

  // Publish the request, then wait for the matching response sequence.
  a.load64(REG.R8, REG.R11, 0);
  a.inc(REG.R8);
  a.store64(REG.R11, REG.R8, 0);
  a.movImm64(REG.R10, '0x' + (heapBase + COMP_RESP_SEQ).toString(16));
  a.label('dr_wait');
  a.load64(REG.R9, REG.R10, 0);
  a.cmp(REG.R9, REG.R8);
  a.jcc(COND.E, 'dr_ready');
  emitIdle(a, SINGLE_CORE);
  a.jmp('dr_wait');
  a.label('dr_ready');
  a.load64(REG.RAX, REG.R10, 8);
  a.jmp('function_return');

  // RBX = registry entry, R15 = argc, argv values pushed on the CPU stack.
  // Pads or trims to paramCount, then binds parameters from last to first.
  // Called with the return address above argv, so stash it in R11 while the
  // argument pops run. Clobbers RAX, RCX, RDX, R8, R10, R15; preserves RBX,
  // RBP, R12-R14.
  a.label('bind_args');
  a.pop(REG.R11);                 // return address (argv sits below it)
  a.load64(REG.R8, REG.RBX, 24);  // paramCount
  a.cmp(REG.R15, REG.R8);
  a.jcc(COND.GE, 'ba_trim_extra');
  a.mov(REG.R10, REG.R8);
  a.sub(REG.R10, REG.R15);
  a.label('ba_pad_loop');
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'ba_pad_done');
  a.xor(REG.RAX, REG.RAX);
  a.push(REG.RAX);
  a.dec(REG.R10);
  a.jmp('ba_pad_loop');
  a.label('ba_pad_done');
  a.mov(REG.R15, REG.R8);
  a.jmp('ba_bind_loop');
  a.label('ba_trim_extra');
  a.sub(REG.R15, REG.R8);         // surplus argument count
  a.label('ba_trim_loop');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ba_trim_done');
  a.pop(REG.RAX);
  a.dec(REG.R15);
  a.jmp('ba_trim_loop');
  a.label('ba_trim_done');
  a.mov(REG.R15, REG.R8);

  a.label('ba_bind_loop');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ba_bind_done');
  a.dec(REG.R15);                 // parameter index, last to first
  a.pop(REG.RAX);
  a.mov(REG.RCX, REG.R15);
  a.shlImm8(REG.RCX, 3);
  a.add(REG.RCX, REG.RBX);
  a.load64(REG.RCX, REG.RCX, 32);
  emitSlotIndex(a, REG.RCX, REG.RCX, 'ba_slot');
  a.call('store_slot');
  a.jmp('ba_bind_loop');
  a.label('ba_bind_done');
  a.push(REG.R11);
  a.ret();

  // RAX = return value. Unwind one frame, restore the caller's ring state and
  // registers, then jump to the continuation address.
  a.label('function_return');
  a.load64(REG.R8, REG.RBP, STATE_FUNC_DEPTH);
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'fretn_none');
  a.dec(REG.R8);
  a.store64(REG.RBP, REG.R8, STATE_FUNC_DEPTH);
  a.mov(REG.R11, REG.R8);
  a.shlImm8(REG.R11, 6);
  a.mov(REG.RDX, REG.RBP);
  a.addImm32(REG.RDX, STATE_FUNC_STACK);
  a.add(REG.R11, REG.RDX);
  a.store64(REG.R11, REG.RAX, 40);

  if (SPILL_RING) {
    a.mov(REG.R10, REG.R8);
    a.shlImm8(REG.R10, 11);
    a.mov(REG.RDX, REG.RBP);
    a.addImm32(REG.RDX, STATE_FUNC_SAVE);
    a.add(REG.R10, REG.RDX);
    if (FULL_SPILL) {
      a.load64(REG.R9, REG.R11, 48);
      a.test(REG.R9, REG.R9);
      a.jcc(COND.S, 'fret_full_restore_done');
      for (let j = 0; j < RING_REGS.length; j++) {
        a.vmovdqu64Load(RING_REGS[j], REG.R10, j * 64);
      }
      a.label('fret_full_restore_done');
    } else {
      a.load64(REG.R9, REG.R11, 48);
      for (let j = 0; j < RING_REGS.length; j++) {
        a.btImm(REG.R9, j);
        a.jcc(COND.NC, `fret_restore_skip_${j}`);
        a.vmovdqu64Load(RING_REGS[j], REG.R10, j * 64);
        a.label(`fret_restore_skip_${j}`);
      }
    }
  }

  a.load64(REG.RAX, REG.R11, 40);
  a.load64(REG.R12, REG.R11, 0);
  a.load64(REG.RBX, REG.R11, 16);
  a.load64(REG.RBP, REG.R11, 24);
  a.load64(REG.R15, REG.R11, 32);
  a.load64(REG.R10, REG.R11, 8);
  a.jmpReg(REG.R10);
  a.label('fretn_none');
  a.jmp('main_loop');

  // return [expr];
  a.label('handle_return');
  a.call('skip_spaces');
  a.call('parse_value_line');
  a.store64(REG.RBP, REG.RAX, STATE_FUNC_RETVAL);
  a.label('fret_unwind');
  a.call('load_top_control');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'fret_toplevel');
  a.cmpImm32(REG.R8, 2);
  a.jcc(COND.E, 'fret_at_function');
  a.cmpImm32(REG.R8, 3);
  a.jcc(COND.E, 'fret_at_remote');
  a.call('pop_control');
  a.jmp('fret_unwind');
  a.label('fret_at_function');
  a.call('pop_control');
  a.load64(REG.RAX, REG.RBP, STATE_FUNC_RETVAL);
  a.jmp('function_return');
  a.label('fret_at_remote');
  a.call('pop_control');
  a.load64(REG.RAX, REG.RBP, STATE_FUNC_RETVAL);
  a.jmp('remote_return');
  a.label('fret_toplevel');
  a.jmp('skip_to_end');

  // foo(...) as a statement: R12 at '(', RBX = name hash.
  a.label('handle_statement_call');
  a.mov(REG.R8, REG.RBX);
  a.call('lookup_function');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'stmtcall_unknown');
  a.leaRip(REG.R10, 'skip_to_end');
  a.jmp('call_function');
  a.label('stmtcall_unknown');
  a.call('skip_paren_group');
  a.jmp('skip_to_end');

  // Skip spaces and tabs only (not newlines), for ASI-friendly return parsing.
  a.label('skip_spaces');
  a.label('ss_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ss_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.E, 'ss_inc');
  a.cmpImm8(REG.RAX, 9);
  a.jcc(COND.NE, 'ss_ret');
  a.label('ss_inc');
  a.inc(REG.R12);
  a.jmp('ss_loop');
  a.label('ss_ret');
  a.ret();

  // ----------------------------------------------------- control-stack helpers
  // R8 = frame type, RCX = a, RDX = b. Pushes one 24-byte frame.
  a.label('push_control');
  a.load64(REG.R10, REG.RBP, STATE_CONTROL_DEPTH);
  a.mov(REG.R11, REG.RBP);
  a.addImm32(REG.R11, STATE_CONTROL_STACK);
  a.mov(REG.RAX, REG.R10);
  a.shlImm8(REG.RAX, 1);          // index * 2
  a.add(REG.RAX, REG.R10);        // index * 3
  a.shlImm8(REG.RAX, 3);          // index * 24
  a.add(REG.R11, REG.RAX);
  a.store64(REG.R11, REG.R8, 0);
  a.store64(REG.R11, REG.RCX, 8);
  a.store64(REG.R11, REG.RDX, 16);
  a.inc(REG.R10);
  a.store64(REG.RBP, REG.R10, STATE_CONTROL_DEPTH);
  a.ret();

  a.label('pop_control');
  a.load64(REG.R10, REG.RBP, STATE_CONTROL_DEPTH);
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'pc_ret');
  a.dec(REG.R10);
  a.store64(REG.RBP, REG.R10, STATE_CONTROL_DEPTH);
  a.label('pc_ret');
  a.ret();

  // Returns RAX = 1 if a frame exists, with R8 = type, RCX = a, RDX = b.
  a.label('load_top_control');
  a.load64(REG.R10, REG.RBP, STATE_CONTROL_DEPTH);
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'ltc_empty');
  a.dec(REG.R10);
  a.mov(REG.RAX, REG.R10);
  a.shlImm8(REG.RAX, 1);          // index * 2
  a.add(REG.RAX, REG.R10);        // index * 3
  a.shlImm8(REG.RAX, 3);          // index * 24
  a.mov(REG.R11, REG.RBP);
  a.addImm32(REG.R11, STATE_CONTROL_STACK);
  a.add(REG.R11, REG.RAX);
  a.load64(REG.R8, REG.R11, 0);
  a.load64(REG.RCX, REG.R11, 8);
  a.load64(REG.RDX, REG.R11, 16);
  a.movImm32(REG.RAX, 1);
  a.ret();
  a.label('ltc_empty');
  a.xor(REG.R8, REG.R8);
  a.xor(REG.RCX, REG.RCX);
  a.xor(REG.RDX, REG.RDX);
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // Parse `[let] name = value` and store it. Used for for-init and for-step.
  // Returns at the next ';' or ')'. Allows an empty init/step.
  a.label('exec_assign_expr');
  a.label('eae_ws');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'eae_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 59);         // ';' -> empty
  a.jcc(COND.E, 'eae_ret');
  a.cmpImm8(REG.RAX, 41);         // ')' -> empty
  a.jcc(COND.E, 'eae_ret');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'eae_check_let');
  a.inc(REG.R12);
  a.jmp('eae_ws');

  a.label('eae_check_let');
  a.mov(REG.R9, REG.R12);
  a.addImm32(REG.R9, 3);
  a.cmp(REG.R9, REG.R13);
  a.jcc(COND.GE, 'eae_name');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 108);        // 'l'
  a.jcc(COND.NE, 'eae_name');
  a.load8(REG.RAX, REG.R12, 1);
  a.cmpImm8(REG.RAX, 101);        // 'e'
  a.jcc(COND.NE, 'eae_name');
  a.load8(REG.RAX, REG.R12, 2);
  a.cmpImm8(REG.RAX, 116);        // 't'
  a.jcc(COND.NE, 'eae_name');
  a.load8(REG.RAX, REG.R12, 3);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'eae_name');      // "letter..." is an identifier
  a.addImm32(REG.R12, 3);
  a.label('eae_let_ws');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'eae_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'eae_name');
  a.inc(REG.R12);
  a.jmp('eae_let_ws');

  a.label('eae_name');
  a.movImm64(REG.RBX, FNV_OFFSET_STR);
  a.label('eae_hash');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'eae_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 61);         // '='
  a.jcc(COND.E, 'eae_eq');
  a.cmpImm8(REG.RCX, 59);         // ';'
  a.jcc(COND.E, 'eae_ret');
  a.cmpImm8(REG.RCX, 41);         // ')'
  a.jcc(COND.E, 'eae_ret');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'eae_hash_done');
  a.xor(REG.RBX, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.RBX, REG.RDX);
  a.inc(REG.R12);
  a.jmp('eae_hash');

  a.label('eae_hash_done');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'eae_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'eae_check_eq');
  a.inc(REG.R12);
  a.jmp('eae_hash_done');
  a.label('eae_check_eq');
  a.cmpImm8(REG.RAX, 61);         // '='
  a.jcc(COND.NE, 'eae_ret');

  a.label('eae_eq');
  a.inc(REG.R12);
  a.call('parse_value_line');
  emitSlotIndex(a, REG.RBX, REG.RCX, 'eae_slot');
  a.call('store_slot');
  a.label('eae_ret');
  a.ret();

  // Scan forward from R12 to the loop/if body's '{' and consume it.
  a.label('skip_to_body');
  a.label('stb_scan');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'stb_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);         // '
  a.jcc(COND.E, 'stb_fq1');
  a.cmpImm8(REG.RAX, 34);         // "
  a.jcc(COND.E, 'stb_fq2');
  a.cmpImm8(REG.RAX, 123);        // '{'
  a.jcc(COND.E, 'stb_ret');
  a.jmp('stb_scan');
  a.label('stb_fq1');
  a.movImm32(REG.R9, 39);
  a.jmp('stb_fqloop');
  a.label('stb_fq2');
  a.movImm32(REG.R9, 34);
  a.label('stb_fqloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'stb_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'stb_fqloop');
  a.jmp('stb_scan');
  a.label('stb_ret');
  a.ret();

  // Skip the remainder of a loop body (used when the condition is false):
  // find the opening '{', then scan to its matching '}', ignoring braces in
  // quoted strings.
  a.label('skip_loop_end');
  a.label('sle_find');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'sle_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);         // '
  a.jcc(COND.E, 'sle_fq1');
  a.cmpImm8(REG.RAX, 34);         // "
  a.jcc(COND.E, 'sle_fq2');
  a.cmpImm8(REG.RAX, 123);        // '{'
  a.jcc(COND.E, 'sle_open');
  a.jmp('sle_find');
  a.label('sle_fq1');
  a.movImm32(REG.R9, 39);
  a.jmp('sle_fqloop');
  a.label('sle_fq2');
  a.movImm32(REG.R9, 34);
  a.label('sle_fqloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'sle_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'sle_fqloop');
  a.jmp('sle_find');
  a.label('sle_open');
  a.movImm32(REG.R8, 1);          // brace depth
  a.label('sle_scan');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'sle_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);         // '
  a.jcc(COND.E, 'sle_q1');
  a.cmpImm8(REG.RAX, 34);         // "
  a.jcc(COND.E, 'sle_q2');
  a.cmpImm8(REG.RAX, 123);        // '{'
  a.jcc(COND.E, 'sle_inc');
  a.cmpImm8(REG.RAX, 125);        // '}'
  a.jcc(COND.E, 'sle_dec');
  a.jmp('sle_scan');
  a.label('sle_inc');
  a.inc(REG.R8);
  a.jmp('sle_scan');
  a.label('sle_dec');
  a.dec(REG.R8);
  a.test(REG.R8, REG.R8);
  a.jcc(COND.NZ, 'sle_scan');
  a.ret();
  a.label('sle_q1');
  a.movImm32(REG.R9, 39);
  a.jmp('sle_qloop');
  a.label('sle_q2');
  a.movImm32(REG.R9, 34);
  a.label('sle_qloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'sle_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'sle_qloop');
  a.jmp('sle_scan');
  a.label('sle_ret');
  a.ret();

  // Skip all whitespace, including newlines. Leaves R12 at the next token or
  // at the current safe end. Used when looking for else / else-if.
  a.label('skip_ws_all');
  a.label('swa_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'swa_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'swa_ret');
  a.inc(REG.R12);
  a.jmp('swa_loop');
  a.label('swa_ret');
  a.ret();

  // If the next token is the keyword "else", consume it and return RAX=1.
  // Whitespace is skipped either way. Returns RAX=0 without consuming a token.
  a.label('match_else');
  a.call('skip_ws_all');
  a.mov(REG.R8, REG.R12);
  a.addImm32(REG.R8, 4);
  a.cmp(REG.R8, REG.R13);
  a.jcc(COND.G, 'me_no');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 101);        // 'e'
  a.jcc(COND.NE, 'me_no');
  a.load8(REG.RAX, REG.R12, 1);
  a.cmpImm8(REG.RAX, 108);        // 'l'
  a.jcc(COND.NE, 'me_no');
  a.load8(REG.RAX, REG.R12, 2);
  a.cmpImm8(REG.RAX, 115);        // 's'
  a.jcc(COND.NE, 'me_no');
  a.load8(REG.RAX, REG.R12, 3);
  a.cmpImm8(REG.RAX, 101);        // 'e'
  a.jcc(COND.NE, 'me_no');
  // Require a delimiter so "elsewhere" is not treated as "else".
  a.mov(REG.R8, REG.R12);
  a.addImm32(REG.R8, 4);
  a.cmp(REG.R8, REG.R13);
  a.jcc(COND.GE, 'me_yes');
  a.load8(REG.RAX, REG.R12, 4);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'me_yes');
  a.cmpImm8(REG.RAX, 123);        // '{'
  a.jcc(COND.E, 'me_yes');
  a.cmpImm8(REG.RAX, 59);         // ';'
  a.jcc(COND.E, 'me_yes');
  a.jmp('me_no');
  a.label('me_yes');
  a.addImm32(REG.R12, 4);
  a.movImm32(REG.RAX, 1);
  a.ret();
  a.label('me_no');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // If the next token is "if", consume it and return RAX=1. Otherwise RAX=0.
  a.label('match_if');
  a.call('skip_ws_all');
  a.mov(REG.R8, REG.R12);
  a.addImm32(REG.R8, 2);
  a.cmp(REG.R8, REG.R13);
  a.jcc(COND.G, 'mi_no');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 105);        // 'i'
  a.jcc(COND.NE, 'mi_no');
  a.load8(REG.RAX, REG.R12, 1);
  a.cmpImm8(REG.RAX, 102);        // 'f'
  a.jcc(COND.NE, 'mi_no');
  a.mov(REG.R8, REG.R12);
  a.addImm32(REG.R8, 2);
  a.cmp(REG.R8, REG.R13);
  a.jcc(COND.GE, 'mi_yes');
  a.load8(REG.RAX, REG.R12, 2);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'mi_yes');
  a.cmpImm8(REG.RAX, 40);         // '('
  a.jcc(COND.E, 'mi_yes');
  a.jmp('mi_no');
  a.label('mi_yes');
  a.addImm32(REG.R12, 2);
  a.movImm32(REG.RAX, 1);
  a.ret();
  a.label('mi_no');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // Evaluate `value [op value]` starting at R12. Returns 0/1 in RAX and
  // advances R12 past the condition expression. Operators: < > <= >= == !=.
  a.label('eval_condition');
  a.call('parse_value_line');
  a.push(REG.RAX);
  a.label('ec_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ec_plain');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.G, 'ec_op');
  a.inc(REG.R12);
  a.jmp('ec_ws');
  a.label('ec_op');
  a.cmpImm8(REG.RCX, 60);         // '<'
  a.jcc(COND.E, 'ec_lt');
  a.cmpImm8(REG.RCX, 62);         // '>'
  a.jcc(COND.E, 'ec_gt');
  a.cmpImm8(REG.RCX, 61);         // '='
  a.jcc(COND.E, 'ec_eq');
  a.cmpImm8(REG.RCX, 33);         // '!'
  a.jcc(COND.E, 'ec_ne');
  a.jmp('ec_plain');

  a.label('ec_lt');
  a.inc(REG.R12);
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ec_lt_do');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 61);
  a.jcc(COND.NE, 'ec_lt_do');
  a.inc(REG.R12);
  a.call('parse_value_line');
  a.pop(REG.RCX);
  a.cmp(REG.RCX, REG.RAX);
  a.jcc(COND.LE, 'ec_true');
  a.jmp('ec_false');
  a.label('ec_lt_do');
  a.call('parse_value_line');
  a.pop(REG.RCX);
  a.cmp(REG.RCX, REG.RAX);
  a.jcc(COND.L, 'ec_true');
  a.jmp('ec_false');

  a.label('ec_gt');
  a.inc(REG.R12);
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ec_gt_do');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 61);
  a.jcc(COND.NE, 'ec_gt_do');
  a.inc(REG.R12);
  a.call('parse_value_line');
  a.pop(REG.RCX);
  a.cmp(REG.RCX, REG.RAX);
  a.jcc(COND.GE, 'ec_true');
  a.jmp('ec_false');
  a.label('ec_gt_do');
  a.call('parse_value_line');
  a.pop(REG.RCX);
  a.cmp(REG.RCX, REG.RAX);
  a.jcc(COND.G, 'ec_true');
  a.jmp('ec_false');

  a.label('ec_eq');
  a.inc(REG.R12);
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ec_eq_do');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 61);
  a.jcc(COND.NE, 'ec_eq_do');
  a.inc(REG.R12);
  a.label('ec_eq_do');
  a.call('parse_value_line');
  a.pop(REG.RCX);
  a.cmp(REG.RCX, REG.RAX);
  a.jcc(COND.E, 'ec_true');
  a.jmp('ec_false');

  a.label('ec_ne');
  a.inc(REG.R12);
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ec_plain');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 61);
  a.jcc(COND.NE, 'ec_plain');
  a.inc(REG.R12);
  a.call('parse_value_line');
  a.pop(REG.RCX);
  a.cmp(REG.RCX, REG.RAX);
  a.jcc(COND.NE, 'ec_true');
  a.jmp('ec_false');

  a.label('ec_plain');
  a.pop(REG.RAX);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'ec_true');
  a.jmp('ec_false');
  a.label('ec_true');
  a.movImm32(REG.RAX, 1);
  a.ret();
  a.label('ec_false');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // Extend R13 when the dispatcher reaches the currently-published safe end.
  // Used by loop scanning so a body split across input chunks can be read
  // without unwinding to main_loop. Preserves RAX, RCX, RDX, R8-R11.
  a.label('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.B, 'ei_ret');
  a.push(REG.RAX);
  a.push(REG.RCX);
  a.push(REG.RDX);
  a.push(REG.R8);
  a.push(REG.R9);
  a.push(REG.R10);
  a.push(REG.R11);
  a.label('ei_wait');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
  a.load8(REG.R9, REG.RCX, 0);
  a.test(REG.R9, REG.R9);
  a.jcc(COND.NZ, 'ei_done');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
  a.load64(REG.R8, REG.RCX, 0);
  a.movImm64(REG.RCX, HEAP_BASE_STR);
  a.mov(REG.R9, REG.R12);
  a.sub(REG.R9, REG.RCX);             // consumed byte count
  a.cmp(REG.R9, REG.R8);
  a.jcc(COND.B, 'ei_extend');
  emitIdle(a, SINGLE_CORE);
  a.jmp('ei_wait');
  a.label('ei_extend');
  a.movImm64(REG.R13, HEAP_BASE_STR);
  a.add(REG.R13, REG.R8);
  a.label('ei_done');
  a.pop(REG.R11);
  a.pop(REG.R10);
  a.pop(REG.R9);
  a.pop(REG.R8);
  a.pop(REG.RDX);
  a.pop(REG.RCX);
  a.pop(REG.RAX);
  a.label('ei_ret');
  a.ret();

  // ----------------------------------------------------- process.exit(code)
  a.label('handle_process');
  a.label('hp_seek_dot');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'hp_hash');
  a.jmp('hp_seek_dot');

  a.label('hp_hash');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('hp_hash_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'hp_dispatch');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'hp_dispatch');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('hp_hash_loop');

  a.label('hp_dispatch');
  a.movImm64(REG.RCX, HASH_EXIT_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'hp_exit');
  a.jmp('skip_to_end');

  a.label('hp_exit');
  a.label('hp_seek_paren');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.E, 'hp_arg');
  a.jmp('hp_seek_paren');

  a.label('hp_arg');
  a.call('parse_expr');
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xfc);      // negative status -> two's complement
  a.jcc(COND.NE, 'hp_arg_ok');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.neg(REG.RAX);
  a.label('hp_arg_ok');
  a.mov(REG.R15, REG.RAX);        // status code survives the drain
  a.jmp('exit_with_code');

  // ----------------------------------------------------------- window/screen
  a.label('handle_window');
  a.mov(REG.R8, REG.RBX);
  a.call('call_object_method_h');
  a.call('value_member');
  a.jmp('skip_to_end');

  a.label('handle_screen');
  a.movImm64(REG.RAX, TAG_SCREEN_STR);
  a.call('value_member');
  a.jmp('skip_to_end');

  a.label('handle_new');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('handle_new_hash');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'skip_to_end');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 40);
  a.jcc(COND.E, 'handle_new_done');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.G, 'handle_new_char');
  a.inc(REG.R12);
  a.jmp('handle_new_hash');
  a.label('handle_new_char');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('handle_new_hash');
  a.label('handle_new_done');
  a.movImm64(REG.RCX, HASH_WINDOW_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'handle_new_window');
  a.jmp('skip_to_end');
  a.label('handle_new_window');
  a.inc(REG.R12);
  a.movImm64(REG.RAX, TAG_WINDOW_STR);
  a.call('value_member');
  a.jmp('skip_to_end');

  a.label('handle_timeout');
  a.mov(REG.R8, REG.RBX);           // setTimeout / setInterval name hash
  a.call('parse_timer_call');
  a.jmp('skip_to_end');

  a.label('handle_cleartimeout');
  a.call('parse_clear_timer');
  a.jmp('skip_to_end');

  // ------------------------------------------------------------- timers
  // parse_timer_call: R8 = setTimeout/setInterval hash, R12 at or before '('.
  // Parses the callback and delay, registers a timer, and returns its id in
  // RAX with R12 just past the closing ')'.
  a.label('parse_timer_call');
  a.push(REG.R8);                   // name hash
  a.label('tmc_seek_paren');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tmc_abort_hash');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);           // '('
  a.jcc(COND.E, 'tmc_open');
  a.jmp('tmc_seek_paren');

  a.label('tmc_open');
  a.call('parse_timer_callback');   // RBX = entry, R12 at ',' or ')'
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.Z, 'tmc_abort_hash');
  a.pop(REG.RCX);                   // name hash
  a.movImm32(REG.R8, 1);            // timeout
  a.movImm64(REG.RDX, HASH_SETINTERVAL_STR);
  a.cmp(REG.RCX, REG.RDX);
  a.jcc(COND.NE, 'tmc_kind_done');
  a.movImm32(REG.R8, 2);            // interval
  a.label('tmc_kind_done');
  a.push(REG.R8);                   // kind survives parse_expr

  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tmc_abort_kind');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 44);           // ','
  a.jcc(COND.NE, 'tmc_abort_kind');
  a.inc(REG.R12);
  a.call('parse_expr');             // RAX = delay value
  a.pop(REG.R8);                    // kind

  // Negative literals are tagged; treat the magnitude as the delay.
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xfc);
  a.jcc(COND.NE, 'tmc_delay_ok');
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RCX);
  a.label('tmc_delay_ok');
  a.call('timer_register');         // RAX = timer id

  // parse_expr stops at ')'; consume it if present. skip_ws_all clobbers RAX,
  // so keep the id across the trailing scan.
  a.push(REG.RAX);
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tmc_done');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 41);
  a.jcc(COND.NE, 'tmc_done');
  a.inc(REG.R12);
  a.label('tmc_done');
  a.pop(REG.RAX);
  a.ret();

  a.label('tmc_abort_kind');
  a.pop(REG.R8);
  a.label('tmc_abort_hash');
  a.pop(REG.RCX);
  a.call('skip_paren_group');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // Parse a timer callback: arrow function (single or parenthesised params)
  // or a named function reference. Leaves RBX = registry entry (or 0) and R12
  // at the ',' or ')' that follows it.
  a.label('parse_timer_callback');
  a.xor(REG.RBX, REG.RBX);
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 40);           // '(' -> parameter list
  a.jcc(COND.E, 'tcb_paren_params');

  // Single identifier: `x => ...` or a named function reference.
  a.call('ptc_hash_ident');         // R12 at delimiter, R8 = hash
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 61);           // '='
  a.jcc(COND.E, 'tcb_single_arrow');
  a.cmpImm8(REG.RAX, 44);           // ','
  a.jcc(COND.E, 'tcb_named_ref');
  a.cmpImm8(REG.RAX, 41);           // ')'
  a.jcc(COND.E, 'tcb_named_ref');
  a.jmp('tcb_fail');

  a.label('tcb_single_arrow');
  a.inc(REG.R12);                   // consume '='
  a.jmp('tcb_arrow_gt');

  a.label('tcb_named_ref');
  a.call('lookup_function');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'tcb_fail');
  a.mov(REG.RBX, REG.RAX);
  a.ret();

  a.label('tcb_paren_params');
  a.inc(REG.R12);                   // consume '('
  a.label('tcb_param_loop');
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);           // ')'
  a.jcc(COND.E, 'tcb_params_done');
  a.cmpImm8(REG.RAX, 44);           // ','
  a.jcc(COND.E, 'tcb_param_comma');
  a.label('tcb_param_char');
  a.inc(REG.R12);
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 44);
  a.jcc(COND.E, 'tcb_param_loop');
  a.cmpImm8(REG.RAX, 41);
  a.jcc(COND.E, 'tcb_params_done');
  a.jmp('tcb_param_char');
  a.label('tcb_param_comma');
  a.inc(REG.R12);
  a.jmp('tcb_param_loop');

  a.label('tcb_params_done');
  a.inc(REG.R12);                   // consume ')'
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 61);           // '='
  a.jcc(COND.NE, 'tcb_fail');
  a.inc(REG.R12);

  a.label('tcb_arrow_gt');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 62);           // '>'
  a.jcc(COND.NE, 'tcb_fail');
  a.inc(REG.R12);
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'tcb_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 123);          // '{' -> block body
  a.jcc(COND.E, 'tcb_block_body');

  // Expression body: scan to the ',' or ')' that ends this argument.
  a.mov(REG.RBX, REG.R12);
  a.call('scan_timer_expr_end');
  a.mov(REG.R10, REG.R12);
  a.movImm32(REG.R11, 1);
  a.jmp('tcb_register');

  a.label('tcb_block_body');
  a.inc(REG.R12);                   // consume '{'
  a.mov(REG.RBX, REG.R12);
  a.call('scan_block_body');        // R12 just past '}'
  a.mov(REG.R10, REG.R12);
  a.xor(REG.R11, REG.R11);
  a.jmp('tcb_register');

  a.label('tcb_register');
  // Reuse an entry for the same source position (timers registered in a loop
  // must not exhaust the 64-entry function table).
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R8, REG.R9, 0);
  a.label('tcb_find_loop');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'tcb_new_entry');
  a.dec(REG.R8);
  a.mov(REG.RCX, REG.R8);
  a.shlImm8(REG.RCX, 7);
  a.mov(REG.RDX, REG.R8);
  a.shlImm8(REG.RDX, 6);
  a.add(REG.RCX, REG.RDX);
  a.movImm64(REG.RDX, '0x' + (heapBase + FUNC_TABLE).toString(16));
  a.add(REG.RCX, REG.RDX);
  a.load64(REG.RDX, REG.RCX, 8);    // body start
  a.cmp(REG.RDX, REG.RBX);
  a.jcc(COND.NE, 'tcb_find_loop');
  a.load64(REG.RDX, REG.RCX, FUNC_FLAGS);
  a.btImm(REG.RDX, 1);              // FUNC_CALLBACK
  a.jcc(COND.NC, 'tcb_find_loop');
  a.mov(REG.RBX, REG.RCX);
  a.ret();

  a.label('tcb_new_entry');
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R8, REG.R9, 0);
  a.cmpImm32(REG.R8, FUNC_TABLE_CAP);
  a.jcc(COND.GE, 'tcb_fail');
  a.mov(REG.RAX, REG.R8);
  a.shlImm8(REG.RAX, 7);
  a.mov(REG.RCX, REG.R8);
  a.shlImm8(REG.RCX, 6);
  a.add(REG.RAX, REG.RCX);
  a.movImm64(REG.RCX, '0x' + (heapBase + FUNC_TABLE).toString(16));
  a.add(REG.RAX, REG.RCX);          // entry pointer
  a.xor(REG.RCX, REG.RCX);
  a.store64(REG.RAX, REG.RCX, 0);   // name hash
  a.store64(REG.RAX, REG.RBX, 8);   // body start
  a.store64(REG.RAX, REG.R10, 16);  // body end
  a.store64(REG.RAX, REG.RCX, 24);  // parameter count (callbacks take none)
  a.store64(REG.RAX, REG.RCX, FUNC_FLAGS);
  a.store64(REG.RAX, REG.RCX, FUNC_SPILL_MASK);
  a.store64(REG.RAX, REG.RCX, FUNC_DEP_COUNT);
  a.mov(REG.RBX, REG.RAX);
  a.mov(REG.R15, REG.R11);          // expression-body flag survives analyze
  a.call('analyze_function');
  a.load64(REG.RAX, REG.RBX, FUNC_FLAGS);
  a.movImm64(REG.RCX, FUNC_CALLBACK);
  a.or(REG.RAX, REG.RCX);
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'tcb_set_flags');
  a.movImm64(REG.RCX, FUNC_EXPR_BODY);
  a.or(REG.RAX, REG.RCX);
  a.label('tcb_set_flags');
  a.store64(REG.RBX, REG.RAX, FUNC_FLAGS);
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.RCX, REG.R9, 0);
  a.inc(REG.RCX);
  a.store64(REG.R9, REG.RCX, 0);
  a.ret();

  a.label('tcb_fail');
  a.xor(REG.RBX, REG.RBX);
  a.ret();

  // Scan an expression-bodied callback from R12 to the ',' or ')' at depth 0.
  a.label('scan_timer_expr_end');
  a.xor(REG.R8, REG.R8);            // nesting depth
  a.label('ste_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ste_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 39);           // '
  a.jcc(COND.E, 'ste_q1');
  a.cmpImm8(REG.RAX, 34);           // "
  a.jcc(COND.E, 'ste_q2');
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);           // '('
  a.jcc(COND.E, 'ste_open');
  a.cmpImm8(REG.RAX, 91);           // '['
  a.jcc(COND.E, 'ste_open');
  a.cmpImm8(REG.RAX, 123);          // '{'
  a.jcc(COND.E, 'ste_open');
  a.cmpImm8(REG.RAX, 41);           // ')'
  a.jcc(COND.E, 'ste_close');
  a.cmpImm8(REG.RAX, 93);           // ']'
  a.jcc(COND.E, 'ste_close');
  a.cmpImm8(REG.RAX, 125);          // '}'
  a.jcc(COND.E, 'ste_close');
  a.cmpImm8(REG.RAX, 44);           // ','
  a.jcc(COND.E, 'ste_comma');
  a.jmp('ste_loop');
  a.label('ste_open');
  a.inc(REG.R8);
  a.jmp('ste_loop');
  a.label('ste_close');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'ste_rewind');
  a.dec(REG.R8);
  a.jmp('ste_loop');
  a.label('ste_comma');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.NZ, 'ste_loop');
  a.label('ste_rewind');
  a.dec(REG.R12);                   // leave the terminator unconsumed
  a.label('ste_ret');
  a.ret();
  a.label('ste_q1');
  a.movImm32(REG.R9, 39);
  a.jmp('ste_qloop');
  a.label('ste_q2');
  a.movImm32(REG.R9, 34);
  a.label('ste_qloop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ste_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'ste_qloop');
  a.jmp('ste_loop');

  // R8 = kind (1 timeout, 2 interval), RBX = callback entry, RAX = delay ms.
  // Returns the new timer id in RAX, or 0 if the table is full.
  a.label('timer_register');
  a.movImm64(REG.R9, '0x' + (heapBase + TIMER_TABLE).toString(16));
  a.xor(REG.R10, REG.R10);
  a.movImm32(REG.R11, TIMER_TABLE_CAP);
  a.label('treg_find');
  a.cmp(REG.R10, REG.R11);
  a.jcc(COND.GE, 'treg_full');
  a.mov(REG.RCX, REG.R10);
  a.shlImm8(REG.RCX, 5);
  a.mov(REG.RDX, REG.R10);
  a.shlImm8(REG.RDX, 3);
  a.add(REG.RCX, REG.RDX);
  a.add(REG.RCX, REG.R9);           // entry pointer
  a.load64(REG.RDX, REG.RCX, 8);    // kind
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'treg_free');
  a.inc(REG.R10);
  a.jmp('treg_find');

  a.label('treg_full');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  a.label('treg_free');
  a.load64(REG.RDX, REG.RBP, STATE_TIMER_NEXT_ID);
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.NZ, 'treg_have_id');
  a.movImm32(REG.RDX, 1);
  a.label('treg_have_id');
  a.mov(REG.R11, REG.RDX);          // id (RCX still holds the entry pointer)
  a.store64(REG.RCX, REG.R11, 0);   // id
  a.inc(REG.RDX);
  a.store64(REG.RBP, REG.RDX, STATE_TIMER_NEXT_ID);
  a.store64(REG.RCX, REG.R8, 8);    // kind
  a.store64(REG.RCX, REG.RBX, 32);  // callback entry
  a.push(REG.RAX);                  // delay
  a.load64(REG.RAX, REG.RBP, STATE_CLOCK_TICKS);
  a.load64(REG.RDX, REG.RSP, 0);
  a.add(REG.RAX, REG.RDX);
  a.store64(REG.RCX, REG.RAX, 16);  // due
  a.store64(REG.RCX, REG.RDX, 24);  // interval
  a.pop(REG.RAX);
  a.load64(REG.RDX, REG.RBP, STATE_TIMER_ACTIVE);
  a.inc(REG.RDX);
  a.store64(REG.RBP, REG.RDX, STATE_TIMER_ACTIVE);
  a.mov(REG.RAX, REG.R11);          // return the id
  a.ret();

  // RAX = timer id (tagged value). Clears the matching timer.
  a.label('timer_clear');
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RCX);
  a.mov(REG.R10, REG.RAX);          // id
  a.movImm64(REG.R9, '0x' + (heapBase + TIMER_TABLE).toString(16));
  a.xor(REG.R8, REG.R8);
  a.movImm32(REG.R11, TIMER_TABLE_CAP);
  a.label('tcl_loop');
  a.cmp(REG.R8, REG.R11);
  a.jcc(COND.GE, 'tcl_none');
  a.mov(REG.RCX, REG.R8);
  a.shlImm8(REG.RCX, 5);
  a.mov(REG.RDX, REG.R8);
  a.shlImm8(REG.RDX, 3);
  a.add(REG.RCX, REG.RDX);
  a.add(REG.RCX, REG.R9);
  a.load64(REG.RDX, REG.RCX, 8);    // kind
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'tcl_next');
  a.load64(REG.RDX, REG.RCX, 0);    // id
  a.cmp(REG.RDX, REG.R10);
  a.jcc(COND.NE, 'tcl_next');
  a.xor(REG.RDX, REG.RDX);
  a.store64(REG.RCX, REG.RDX, 8);   // clear kind
  a.load64(REG.RDX, REG.RBP, STATE_TIMER_ACTIVE);
  a.dec(REG.RDX);
  a.store64(REG.RBP, REG.RDX, STATE_TIMER_ACTIVE);
  a.movImm32(REG.RAX, 1);
  a.ret();
  a.label('tcl_next');
  a.inc(REG.R8);
  a.jmp('tcl_loop');
  a.label('tcl_none');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // clearTimeout(id) / clearInterval(id)
  a.label('parse_clear_timer');
  a.label('pct_seek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pct_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);           // '('
  a.jcc(COND.E, 'pct_arg');
  a.jmp('pct_seek');
  a.label('pct_arg');
  a.call('parse_expr');
  a.call('timer_clear');
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pct_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);
  a.jcc(COND.NE, 'pct_done');
  a.inc(REG.R12);
  a.label('pct_done');
  a.ret();

  // ----------------------------------------------------- statement ends
  a.label('skip_to_close_paren');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);  // ')'
  a.jcc(COND.E, 'skip_to_end');
  a.inc(REG.R12);
  a.jmp('skip_to_close_paren');

  a.label('skip_to_end');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'input_more');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 125);  // '}' -> let the main loop close the loop body
  a.jcc(COND.E, 'main_loop');
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 59);  // ';'
  a.jcc(COND.E, 'main_loop');
  a.cmpImm8(REG.RAX, 10);  // '\n'
  a.jcc(COND.E, 'main_loop');
  a.jmp('skip_to_end');

  // ------------------------------------------------------------- require
  // R12 points at "require" (or anywhere before its '('). Parses
  // require('name'), sets module flags, and returns 1 in RAX.
  a.label('call_require');
  a.label('cr_seek_paren');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cr_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.E, 'cr_got_paren');
  a.jmp('cr_seek_paren');

  a.label('cr_got_paren');
  a.label('cr_skip_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cr_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'cr_arg');
  a.inc(REG.R12);
  a.jmp('cr_skip_ws');

  a.label('cr_arg');
  a.call('parse_string');       // module name (discarded)
  a.movImm32(REG.RAX, 1);
  a.jmp('fs_method_done');

  a.label('cr_fail');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // ------------------------------------------------------------- fs call
  // R12 points at "fs" or at the '.' after it. Parses .method(args) and
  // returns the method result in RAX.
  a.label('call_fs_method');
  a.label('cfs_seek_dot');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cfs_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'cfs_hash');
  a.jmp('cfs_seek_dot');

  a.label('cfs_hash');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('cfs_hash_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cfs_fail');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'cfs_dispatch');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'cfs_dispatch');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('cfs_hash_loop');

  a.label('cfs_dispatch');
  a.movImm64(REG.RCX, HASH_READFILESYNC_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'fs_read');
  a.movImm64(REG.RCX, HASH_WRITEFILESYNC_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'fs_write');
  a.movImm64(REG.RCX, HASH_EXISTSSYNC_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'fs_exists');

  a.label('cfs_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // Skip to the ')' that closes the current call, then return.
  a.label('fs_method_done');
  a.label('fsmd_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fsmd_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RCX, 41);  // ')'
  a.jcc(COND.E, 'fsmd_ret');
  a.jmp('fsmd_scan');

  a.label('fsmd_ret');
  a.ret();

  // ---------------------------------------------------- fs.readFileSync(p)
  a.label('fs_read');
  a.label('fsr_seek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fsr_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.NE, 'fsr_seek');

  a.label('fsr_arg');
  a.call('parse_expr');           // RAX = path value
  a.mov(REG.RCX, REG.RAX);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, FILE_OP_READ);
  a.call('file_request');         // blocks until the file worker replies
  a.jmp('fs_method_done');

  a.label('fsr_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // ------------------------------------------- fs.writeFileSync(path, data)
  // Fire-and-forget: the file worker's FIFO preserves ordering, and exit
  // drains the queue before the process leaves.
  a.label('fs_write');
  a.label('fsw_seek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fsw_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.NE, 'fsw_seek');

  a.label('fsw_arg');
  a.call('parse_expr');           // RAX = path value
  a.push(REG.RAX);

  // seek ','
  a.label('fsw_seek_comma');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fsw_fail_pop');
  a.load8(REG.RCX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RCX, 44);  // ','
  a.jcc(COND.NE, 'fsw_seek_comma');

  a.label('fsw_data');
  a.call('parse_expr');           // RAX = data value
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RCX);                 // path
  a.movImm32(REG.RAX, FILE_OP_WRITE);
  a.call('file_request');
  a.jmp('fs_method_done');

  a.label('fsw_fail_pop');
  a.pop(REG.RAX);
  a.label('fsw_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // ---------------------------------------------- fs.existsSync(path) -> 0/1
  a.label('fs_exists');
  a.label('fse_seek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'fse_no');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.NE, 'fse_seek');

  a.label('fse_arg');
  a.call('parse_expr');           // RAX = path value
  a.mov(REG.RCX, REG.RAX);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, FILE_OP_EXISTS);
  a.call('file_request');
  a.jmp('fs_method_done');

  a.label('fse_no');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // ------------------------------------------------------------- net module
  // R12 points at "net" or at the '.' after it. Parses .method(args) and
  // returns the result in RAX.
  a.label('call_net_method');
  a.label('cnm_seek_dot');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cnm_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 46);  // '.'
  a.jcc(COND.E, 'cnm_hash');
  a.jmp('cnm_seek_dot');

  a.label('cnm_hash');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('cnm_hash_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cnm_fail');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'cnm_dispatch');
  a.cmpImm8(REG.RCX, 41);  // ')'
  a.jcc(COND.E, 'cnm_dispatch');
  a.cmpImm8(REG.RCX, 44);  // ','
  a.jcc(COND.E, 'cnm_dispatch');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'cnm_dispatch');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('cnm_hash_loop');

  a.label('cnm_dispatch');
  a.movImm64(REG.RCX, HASH_CONNECT_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'net_connect');

  a.label('cnm_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // net.connect(port, 'a.b.c.d') -> tagged socket
  a.label('net_connect');
  a.label('nc_seek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'nc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.NE, 'nc_seek');

  a.call('parse_expr');           // port
  a.push(REG.RAX);

  a.label('nc_seek_comma');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'nc_fail_pop');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 44);  // ','
  a.jcc(COND.NE, 'nc_seek_comma');

  a.call('parse_expr');           // host value
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RCX);                 // port
  a.movImm32(REG.RAX, NET_OP_CONNECT);
  a.call('net_request');          // blocks until connected, returns socket
  a.jmp('fs_method_done');

  a.label('nc_fail_pop');
  a.pop(REG.RAX);
  a.label('nc_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // --------------------------------------------------------------- fetch
  // fetch(url) -> response object. The net worker performs the whole HTTP
  // transaction (URL parse, DNS, connect, request, read loop, response
  // split), so the dispatcher pays one queue round trip instead of driving
  // a read loop itself.
  a.label('call_fetch');
  a.label('cf_seek_open');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'cf_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.NE, 'cf_seek_open');
  a.call('parse_expr');           // URL value
  a.mov(REG.RDX, REG.RAX);
  a.xor(REG.RCX, REG.RCX);
  a.movImm32(REG.RAX, NET_OP_FETCH);
  a.call('net_request');          // blocks until the response is ready
  a.jmp('fs_method_done');
  a.label('cf_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // ------------------------------------------------ socket method dispatch
  // Entry from the main loop / console: receiver hash is in RBX.
  a.label('call_object_method');
  a.mov(REG.R8, REG.RBX);
  a.jmp('call_object_method_h');

  // Receiver hash in R8, R12 at the '.' after the receiver identifier.
  a.label('call_object_method_h');
  emitSlotIndex(a, REG.R8, REG.RCX, 'com_slot');
  a.call('load_slot');            // RAX = receiver value
  a.mov(REG.R8, REG.RAX);
  a.jmp('com_receiver_ready');

  // Receiver value already in RAX, R12 at the '.' after the expression.
  a.label('object_method_value');
  a.mov(REG.R8, REG.RAX);

  a.label('com_receiver_ready');
  a.inc(REG.R12);                 // skip '.'
  a.movImm64(REG.R9, FNV_OFFSET_STR);
  a.label('com_hash');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'com_dispatch');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'com_dispatch');
  a.cmpImm8(REG.RCX, 41);  // ')' — property access, e.g. s.length
  a.jcc(COND.E, 'com_dispatch');
  a.cmpImm8(REG.RCX, 44);  // ',' — first argument of a multi-arg log
  a.jcc(COND.E, 'com_dispatch');
  a.cmpImm8(REG.RCX, 59);  // ';' — statement terminator
  a.jcc(COND.E, 'com_dispatch');
  a.cmpImm8(REG.RCX, 46);  // '.' — chained member access
  a.jcc(COND.E, 'com_dispatch');
  a.cmpImm8(REG.RCX, 91);  // '[' — index access
  a.jcc(COND.E, 'com_dispatch');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'com_dispatch');
  a.xor(REG.R9, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R9, REG.RDX);
  a.inc(REG.R12);
  a.jmp('com_hash');

  a.label('com_dispatch');
  a.movImm64(REG.RCX, HASH_LENGTH_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'obj_length');

  // .then(callback) applies to any receiver; the callback is invoked with the
  // receiver as its first argument.
  a.movImm64(REG.RCX, HASH_THEN_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'com_then');

  // Fetch response objects: .status, .body/.text, .headers, .ok.
  a.mov(REG.R10, REG.R8);
  a.shrImm8(REG.R10, 56);
  a.cmpImm32(REG.R10, 0xfa);
  a.jcc(COND.E, 'com_response');

  // Array methods: receiver tag 0xFB selects push/pop.
  a.mov(REG.R10, REG.R8);
  a.shrImm8(REG.R10, 56);
  a.cmpImm32(REG.R10, 0xfb);
  a.jcc(COND.NE, 'com_not_array');
  a.movImm64(REG.RCX, HASH_PUSH_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'array_push');
  a.movImm64(REG.RCX, HASH_POP_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'array_pop');
  a.jmp('com_unknown');

  a.label('com_not_array');
  a.mov(REG.R10, REG.R8);
  a.shrImm8(REG.R10, 56);
  a.cmpImm32(REG.R10, 0xfd);      // socket tag
  a.jcc(COND.E, 'com_socket');
  a.cmpImm32(REG.R10, 0xf8);      // screen tag
  a.jcc(COND.E, 'com_screen');
  a.cmpImm32(REG.R10, 0xf9);      // window tag
  a.jcc(COND.E, 'com_window');
  a.jmp('com_unknown');

  a.mov(REG.RDI, REG.R8);         // fd
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.RDI, REG.RCX);

  a.movImm64(REG.RCX, HASH_WRITE_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'sock_write');
  a.movImm64(REG.RCX, HASH_READ_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'sock_read');
  a.movImm64(REG.RCX, HASH_SOCKET_CLOSE_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'sock_close');

  a.label('com_socket');
  a.jmp('com_unknown');

  // .length on a string, buffer, or integer (integers have no length).
  a.label('obj_length');
  a.mov(REG.RAX, REG.R8);
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'obj_length_zero');      // integer
  a.cmpImm32(REG.RCX, 0xfc);             // negative integer
  a.jcc(COND.E, 'obj_length_zero');
  a.cmpImm32(REG.RCX, 0xfa);             // response: length of its body
  a.jcc(COND.E, 'obj_length_response');
  a.mov(REG.RDX, REG.RCX);
  a.andImm32(REG.RDX, 0xf8);
  a.cmpImm32(REG.RDX, 0xf0);
  a.jcc(COND.E, 'obj_length_inline');
  a.cmpImm32(REG.RCX, 0xfd);             // socket
  a.jcc(COND.E, 'obj_length_zero');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.load64(REG.RAX, REG.RAX, 0);         // heap object length
  a.jmp('fsmd_ret');

  a.label('obj_length_inline');
  a.mov(REG.RAX, REG.RCX);
  a.andImm32(REG.RAX, 7);
  a.jmp('fsmd_ret');

  a.label('obj_length_response');
  a.mov(REG.R8, REG.RAX);
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);
  a.load64(REG.R8, REG.R8, 8);           // body value
  a.jmp('obj_length');

  a.label('obj_length_zero');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fsmd_ret');

  a.label('com_screen');
  a.movImm64(REG.RCX, HASH_WIDTH_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'screen_width');
  a.movImm64(REG.RCX, HASH_HEIGHT_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'screen_height');
  a.movImm64(REG.RCX, HASH_SCALE_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'screen_scale');
  a.jmp('com_unknown');

  a.label('screen_width');
  a.movImm32(REG.RAX, 1920);
  a.jmp('fsmd_ret');
  a.label('screen_height');
  a.movImm32(REG.RAX, 1080);
  a.jmp('fsmd_ret');
  a.label('screen_scale');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');

  a.label('com_window');
  a.movImm64(REG.RCX, HASH_OPEN_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_open');
  a.movImm64(REG.RCX, HASH_CREATE_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_open');
  a.movImm64(REG.RCX, HASH_SHOW_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_show');
  a.movImm64(REG.RCX, HASH_HIDE_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_show');
  a.movImm64(REG.RCX, HASH_FILL_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_fill');
  a.movImm64(REG.RCX, HASH_CLEAR_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_fill');
  a.movImm64(REG.RCX, HASH_WIN_CLOSE_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_close');
  a.movImm64(REG.RCX, HASH_RECT_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_rect');
  a.movImm64(REG.RCX, HASH_BLIT_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_blit');
  a.movImm64(REG.RCX, HASH_SETPIXEL_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_blit');
  a.movImm64(REG.RCX, HASH_DRAW_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_blit');
  a.movImm64(REG.RCX, HASH_REQUESTANIMATIONFRAME_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_raf');
  a.movImm64(REG.RCX, HASH_GETCONTEXT_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_raf');
  a.movImm64(REG.RCX, HASH_WIDTH_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_width');
  a.movImm64(REG.RCX, HASH_HEIGHT_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'window_height');
  a.jmp('com_unknown');

  a.label('window_width');
  a.movImm32(REG.RAX, 800);
  a.jmp('fsmd_ret');
  a.label('window_height');
  a.movImm32(REG.RAX, 600);
  a.jmp('fsmd_ret');
  a.label('window_open');
  a.inc(REG.R12); // skip '(' if present
  a.movImm64(REG.RAX, TAG_WINDOW_STR);
  a.jmp('fsmd_ret');
  a.label('window_show');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');
  a.label('window_fill');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');
  a.label('window_close');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');
  a.label('window_rect');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');
  a.label('window_blit');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');
  a.label('window_raf');
  a.movImm64(REG.RAX, TAG_WINDOW_STR);
  a.jmp('fsmd_ret');

  a.label('com_unknown');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // ------------------------------------------------ fetch response members
  // R8 = response value, R9 = member hash. The object is
  // [status:u64][body:value][headers:value].
  a.label('com_response');
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);         // object pointer

  a.movImm64(REG.RCX, HASH_STATUS_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'resp_status');
  a.movImm64(REG.RCX, HASH_BODY_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'resp_body');
  a.movImm64(REG.RCX, HASH_TEXT_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'resp_body');
  a.movImm64(REG.RCX, HASH_HEADERS_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'resp_headers');
  a.movImm64(REG.RCX, HASH_OK_STR);
  a.cmp(REG.R9, REG.RCX);
  a.jcc(COND.E, 'resp_ok');
  a.jmp('com_unknown');

  a.label('resp_status');
  a.load64(REG.RAX, REG.R8, 0);
  a.jmp('fsmd_ret');
  a.label('resp_body');
  a.load64(REG.RAX, REG.R8, 8);
  a.jmp('fsmd_ret');
  a.label('resp_headers');
  a.load64(REG.RAX, REG.R8, 16);
  a.jmp('fsmd_ret');
  a.label('resp_ok');
  a.load64(REG.RAX, REG.R8, 0);
  a.movImm32(REG.RCX, 200);
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.L, 'resp_not_ok');
  a.movImm32(REG.RCX, 300);
  a.cmp(REG.RAX, REG.RCX);
  a.jcc(COND.GE, 'resp_not_ok');
  a.movImm32(REG.RAX, 1);
  a.jmp('fsmd_ret');
  a.label('resp_not_ok');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fsmd_ret');

  // ------------------------------------------------------------ .then(...)
  // Synchronous promise-like chaining: invoke the callback immediately with
  // the receiver as its first argument. A callback that returns a value
  // becomes the chain value; returning undefined keeps the receiver so
  // `.then(...).then(...)` chains naturally.
  a.label('com_then');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'then_no_call');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 40);          // '('
  a.jcc(COND.NE, 'then_no_call');
  // The caller may keep parser state in RBX/R15 (the let parser keeps the
  // destination name hash in RBX), so save them across the callback.
  a.push(REG.RBX);
  a.push(REG.R15);
  a.push(REG.R8);                  // receiver survives the callback
  a.inc(REG.R12);                  // consume '('
  a.call('parse_then_callback');   // R12 just past ')', RBX = entry or 0
  a.test(REG.RBX, REG.RBX);
  a.jcc(COND.Z, 'then_invoke_done');
  // Pass the preserved receiver as the callback's first argument.
  a.load64(REG.RAX, REG.RSP, 0);
  a.push(REG.RAX);
  a.movImm32(REG.R15, 1);
  a.leaRip(REG.R10, 'then_after_callback');
  a.jmp('invoke_function');

  a.label('then_after_callback');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'then_keep_result');
  a.pop(REG.RAX);                  // undefined -> keep receiver for chaining
  a.pop(REG.R15);
  a.pop(REG.RBX);
  a.jmp('fsmd_ret');
  a.label('then_keep_result');
  a.pop(REG.RCX);                  // discard the preserved receiver
  a.pop(REG.R15);
  a.pop(REG.RBX);
  a.jmp('fsmd_ret');

  a.label('then_invoke_done');
  a.pop(REG.RAX);                  // no callback: return the receiver unchanged
  a.pop(REG.R15);
  a.pop(REG.RBX);
  a.jmp('fsmd_ret');
  a.label('then_no_call');
  a.mov(REG.RAX, REG.R8);
  a.jmp('fsmd_ret');

  // ------------------------------------------------ parse .then callback
  // R12 just past the opening '('. Parses an arrow callback
  // (`x => expr`, `x => { ... }`, `(a, b) => ...`) or a named function
  // reference, registers a reusable synthetic function entry, and leaves
  // RBX = entry (or 0 on failure) with R12 just past the matching ')'.
  a.label('parse_then_callback');
  a.xor(REG.R15, REG.R15);         // parameter count
  a.xor(REG.RBX, REG.RBX);         // result entry
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);

  a.cmpImm8(REG.RAX, 40);          // '(' -> parenthesized parameter list
  a.jcc(COND.E, 'ptc_paren_params');

  // Single identifier: `x => ...` or a named function reference.
  a.call('ptc_hash_ident');
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 61);          // '='
  a.jcc(COND.E, 'ptc_single_arrow');
  a.cmpImm8(REG.RAX, 41);          // ')' -> named function
  a.jcc(COND.E, 'ptc_named_ref');
  a.jmp('ptc_fail');

  a.label('ptc_single_arrow');
  a.push(REG.R8);                  // parameter 0
  a.movImm32(REG.R15, 1);
  a.inc(REG.R12);                  // consume '='
  a.jmp('ptc_arrow_gt');

  a.label('ptc_named_ref');
  // R8 = name hash, R12 at ')'.
  a.call('lookup_function');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'ptc_fail');
  a.mov(REG.RBX, REG.RAX);
  a.inc(REG.R12);                  // consume ')'
  a.ret();

  a.label('ptc_paren_params');
  a.inc(REG.R12);                  // consume '('
  a.label('ptc_param_loop');
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);          // ')'
  a.jcc(COND.E, 'ptc_params_done');
  a.cmpImm8(REG.RAX, 44);          // ','
  a.jcc(COND.E, 'ptc_param_comma');
  a.call('ptc_hash_ident');
  a.cmpImm32(REG.R15, 8);
  a.jcc(COND.GE, 'ptc_param_loop');
  a.push(REG.R8);
  a.inc(REG.R15);
  a.jmp('ptc_param_loop');
  a.label('ptc_param_comma');
  a.inc(REG.R12);
  a.jmp('ptc_param_loop');

  a.label('ptc_params_done');
  a.inc(REG.R12);                  // consume ')'
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 61);          // '='
  a.jcc(COND.NE, 'ptc_fail');
  a.inc(REG.R12);

  a.label('ptc_arrow_gt');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 62);          // '>'
  a.jcc(COND.NE, 'ptc_fail');
  a.inc(REG.R12);
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 123);         // '{' -> block body
  a.jcc(COND.E, 'ptc_block_body');

  // Expression body: everything up to the call's closing ')'.
  a.mov(REG.RBX, REG.R12);         // body start
  a.call('scan_arrow_expr_end');   // R12 at the closing ')'
  a.mov(REG.R10, REG.R12);         // body end (exclusive)
  a.inc(REG.R12);                  // consume ')'
  a.movImm32(REG.R11, 1);          // expression body
  a.jmp('ptc_register');

  a.label('ptc_block_body');
  a.inc(REG.R12);                  // consume '{'
  a.mov(REG.RBX, REG.R12);         // body start
  a.call('scan_block_body');       // R12 just past '}'
  a.mov(REG.R10, REG.R12);         // body end
  a.xor(REG.R11, REG.R11);         // block body
  a.call('skip_ws_all');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_fail');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 41);          // ')'
  a.jcc(COND.NE, 'ptc_fail');
  a.inc(REG.R12);                  // consume ')'

  a.label('ptc_register');
  // Reuse an entry for the same source position, so a .then in a loop does
  // not exhaust the function table.
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R8, REG.R9, 0);     // count
  a.label('ptc_find_loop');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'ptc_new_entry');
  a.dec(REG.R8);
  a.mov(REG.RCX, REG.R8);
  a.shlImm8(REG.RCX, 7);
  a.mov(REG.RDX, REG.R8);
  a.shlImm8(REG.RDX, 6);
  a.add(REG.RCX, REG.RDX);
  a.movImm64(REG.RDX, '0x' + (heapBase + FUNC_TABLE).toString(16));
  a.add(REG.RCX, REG.RDX);         // entry pointer
  a.load64(REG.RDX, REG.RCX, 8);   // body start
  a.cmp(REG.RDX, REG.RBX);
  a.jcc(COND.NE, 'ptc_find_loop');
  a.load64(REG.RDX, REG.RCX, FUNC_FLAGS);
  a.btImm(REG.RDX, 1);             // FUNC_CALLBACK
  a.jcc(COND.NC, 'ptc_find_loop');
  a.mov(REG.RBX, REG.RCX);
  a.jmp('ptc_discard_params');

  a.label('ptc_new_entry');
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.R8, REG.R9, 0);
  a.cmpImm32(REG.R8, FUNC_TABLE_CAP);
  a.jcc(COND.GE, 'ptc_abort');
  a.mov(REG.RAX, REG.R8);
  a.shlImm8(REG.RAX, 7);
  a.mov(REG.RCX, REG.R8);
  a.shlImm8(REG.RCX, 6);
  a.add(REG.RAX, REG.RCX);
  a.movImm64(REG.RCX, '0x' + (heapBase + FUNC_TABLE).toString(16));
  a.add(REG.RAX, REG.RCX);         // entry pointer
  a.xor(REG.RCX, REG.RCX);
  a.store64(REG.RAX, REG.RCX, 0);  // name hash
  a.store64(REG.RAX, REG.RBX, 8);  // body start
  a.store64(REG.RAX, REG.R10, 16); // body end
  a.store64(REG.RAX, REG.R15, 24);// parameter count
  a.mov(REG.RCX, REG.R15);
  a.label('ptc_param_store');
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'ptc_param_stored');
  a.dec(REG.RCX);
  a.pop(REG.RDX);
  a.mov(REG.R8, REG.RCX);
  a.shlImm8(REG.R8, 3);
  a.add(REG.R8, REG.RAX);
  a.store64(REG.R8, REG.RDX, 32);
  a.jmp('ptc_param_store');
  a.label('ptc_param_stored');
  a.xor(REG.RDX, REG.RDX);
  a.store64(REG.RAX, REG.RDX, FUNC_FLAGS);
  a.store64(REG.RAX, REG.RDX, FUNC_SPILL_MASK);
  a.store64(REG.RAX, REG.RDX, FUNC_DEP_COUNT);
  a.label('ptc_publish');
  a.movImm64(REG.R9, '0x' + (heapBase + FUNC_COUNT).toString(16));
  a.load64(REG.RCX, REG.R9, 0);
  a.inc(REG.RCX);
  a.store64(REG.R9, REG.RCX, 0);
  a.mov(REG.RBX, REG.RAX);         // entry pointer
  a.mov(REG.R15, REG.R11);         // expression-body flag survives analyze
  a.call('analyze_function');
  a.load64(REG.RAX, REG.RBX, FUNC_FLAGS);
  a.movImm64(REG.RCX, FUNC_CALLBACK);
  a.or(REG.RAX, REG.RCX);
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ptc_set_flags');
  a.movImm64(REG.RCX, FUNC_EXPR_BODY);
  a.or(REG.RAX, REG.RCX);
  a.label('ptc_set_flags');
  a.store64(REG.RBX, REG.RAX, FUNC_FLAGS);
  a.ret();

  a.label('ptc_discard_params');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ptc_discard_done');
  a.pop(REG.RAX);
  a.dec(REG.R15);
  a.jmp('ptc_discard_params');
  a.label('ptc_discard_done');
  a.ret();

  a.label('ptc_abort');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ptc_abort_done');
  a.pop(REG.RAX);
  a.dec(REG.R15);
  a.jmp('ptc_abort');
  a.label('ptc_abort_done');
  a.xor(REG.RBX, REG.RBX);
  a.ret();

  a.label('ptc_fail');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'ptc_fail_skip');
  a.pop(REG.RAX);
  a.dec(REG.R15);
  a.jmp('ptc_fail');
  a.label('ptc_fail_skip');
  a.call('ptc_skip_call');
  a.xor(REG.RBX, REG.RBX);
  a.ret();

  // Scan from R12 inside .then(...) to just past the matching ')'. Used when
  // the callback syntax is not understood.
  a.label('ptc_skip_call');
  a.xor(REG.R8, REG.R8);
  a.label('ptc_skip_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_skip_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);          // '
  a.jcc(COND.E, 'ptc_skip_q1');
  a.cmpImm8(REG.RAX, 34);          // "
  a.jcc(COND.E, 'ptc_skip_q2');
  a.cmpImm8(REG.RAX, 40);          // '('
  a.jcc(COND.E, 'ptc_skip_open');
  a.cmpImm8(REG.RAX, 41);          // ')'
  a.jcc(COND.E, 'ptc_skip_close');
  a.jmp('ptc_skip_loop');
  a.label('ptc_skip_open');
  a.inc(REG.R8);
  a.jmp('ptc_skip_loop');
  a.label('ptc_skip_close');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'ptc_skip_ret');
  a.dec(REG.R8);
  a.jmp('ptc_skip_loop');
  a.label('ptc_skip_q1');
  a.movImm32(REG.R9, 39);
  a.jmp('ptc_skip_qloop');
  a.label('ptc_skip_q2');
  a.movImm32(REG.R9, 34);
  a.label('ptc_skip_qloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'ptc_skip_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'ptc_skip_qloop');
  a.jmp('ptc_skip_loop');
  a.label('ptc_skip_ret');
  a.ret();

  // Hash an identifier at R12 into R8, leaving R12 at the delimiter.
  a.label('ptc_hash_ident');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('phi_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'phi_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'phi_done');
  a.cmpImm8(REG.RAX, 44);          // ','
  a.jcc(COND.E, 'phi_done');
  a.cmpImm8(REG.RAX, 41);          // ')'
  a.jcc(COND.E, 'phi_done');
  a.cmpImm8(REG.RAX, 61);          // '='
  a.jcc(COND.E, 'phi_done');
  a.cmpImm8(REG.RAX, 40);          // '('
  a.jcc(COND.E, 'phi_done');
  a.cmpImm8(REG.RAX, 123);         // '{'
  a.jcc(COND.E, 'phi_done');
  a.cmpImm8(REG.RAX, 59);          // ';'
  a.jcc(COND.E, 'phi_done');
  a.xor(REG.R8, REG.RAX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('phi_loop');
  a.label('phi_done');
  a.ret();

  // R12 at the start of an expression-bodied arrow. Scan to the ')' that
  // closes the enclosing .then(...), tracking nested parentheses and quotes,
  // and leave R12 at that ')'.
  a.label('scan_arrow_expr_end');
  a.xor(REG.R8, REG.R8);
  a.label('saee_loop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'saee_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 39);          // '
  a.jcc(COND.E, 'saee_q1');
  a.cmpImm8(REG.RAX, 34);          // "
  a.jcc(COND.E, 'saee_q2');
  a.cmpImm8(REG.RAX, 40);          // '('
  a.jcc(COND.E, 'saee_open');
  a.cmpImm8(REG.RAX, 41);          // ')'
  a.jcc(COND.E, 'saee_close');
  a.inc(REG.R12);
  a.jmp('saee_loop');
  a.label('saee_open');
  a.inc(REG.R8);
  a.inc(REG.R12);
  a.jmp('saee_loop');
  a.label('saee_close');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'saee_ret');
  a.dec(REG.R8);
  a.inc(REG.R12);
  a.jmp('saee_loop');
  a.label('saee_q1');
  a.movImm32(REG.R9, 39);
  a.jmp('saee_qloop');
  a.label('saee_q2');
  a.movImm32(REG.R9, 34);
  a.label('saee_qloop');
  a.call('ensure_input');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'saee_ret');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R9);
  a.jcc(COND.NE, 'saee_qloop');
  a.jmp('saee_loop');
  a.label('saee_ret');
  a.ret();

  // ------------------------------------------------ array.push(value)
  // R8 = array value, R12 at '(' after the method name. Appends in place,
  // doubling the data buffer when full, and returns the new length. The
  // handle is stable so the variable slot never needs updating.
  a.label('array_push');
  a.inc(REG.R12);                 // consume '('
  a.push(REG.R8);                 // receiver must survive expression parsing
  a.call('parse_expr');           // RAX = value
  a.mov(REG.RDX, REG.RAX);        // value
  a.pop(REG.R8);                  // receiver value
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);         // handle
  a.load64(REG.R10, REG.R8, 0);   // len
  a.load64(REG.R11, REG.R8, 8);   // cap
  a.load64(REG.R9, REG.R8, 16);   // data buffer
  a.cmp(REG.R10, REG.R11);
  a.jcc(COND.L, 'array_push_room');
  // Grow: newcap = max(4, cap * 2), allocate and copy len elements.
  a.mov(REG.RCX, REG.R11);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.NZ, 'array_push_double');
  a.movImm32(REG.RCX, 4);
  a.jmp('array_push_alloc');
  a.label('array_push_double');
  a.shlImm8(REG.RCX, 1);
  a.label('array_push_alloc');
  a.mov(REG.RAX, REG.RCX);
  a.shlImm8(REG.RAX, 3);
  a.mov(REG.RSI, REG.R14);        // new data buffer
  a.add(REG.R14, REG.RAX);
  a.xor(REG.RAX, REG.RAX);        // index
  a.label('array_push_copy');
  a.cmp(REG.RAX, REG.R10);
  a.jcc(COND.GE, 'array_push_copied');
  a.load64Indexed(REG.RDI, REG.R9, REG.RAX);
  a.store64Indexed(REG.RSI, REG.RAX, REG.RDI);
  a.inc(REG.RAX);
  a.jmp('array_push_copy');
  a.label('array_push_copied');
  a.mov(REG.R9, REG.RSI);
  a.store64(REG.R8, REG.R9, 16);  // data pointer
  a.store64(REG.R8, REG.RCX, 8);  // capacity
  a.label('array_push_room');
  a.store64Indexed(REG.R9, REG.R10, REG.RDX);
  a.inc(REG.R10);
  a.store64(REG.R8, REG.R10, 0);  // publish new len
  a.mov(REG.RAX, REG.R10);
  a.jmp('fs_method_done');

  // ------------------------------------------------------- array.pop()
  // R8 = array value. Returns the removed element, or 0 when empty.
  a.label('array_pop');
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);
  a.load64(REG.R10, REG.R8, 0);   // len
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'array_pop_empty');
  a.dec(REG.R10);
  a.store64(REG.R8, REG.R10, 0);  // shrink first
  a.load64(REG.R9, REG.R8, 16);   // data buffer
  a.load64Indexed(REG.RAX, REG.R9, REG.R10);
  a.jmp('fs_method_done');
  a.label('array_pop_empty');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fs_method_done');

  // socket.write(data) -> bytes written
  a.label('sock_write');
  a.label('sw_seek');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'com_unknown');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 40);  // '('
  a.jcc(COND.NE, 'sw_seek');

  a.push(REG.RDI);                // fd must survive expression parsing
  a.call('parse_expr');           // data value
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RCX);                 // fd
  a.movImm32(REG.RAX, NET_OP_WRITE);
  a.call('net_request');          // fire-and-forget, returns 1
  a.jmp('fs_method_done');

  // socket.read() -> buffer
  a.label('sock_read');
  a.mov(REG.RCX, REG.RDI);        // fd
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, NET_OP_READ);
  a.call('net_request');          // blocks until bytes arrive
  a.jmp('fs_method_done');

  // socket.close()
  a.label('sock_close');
  a.mov(REG.RCX, REG.RDI);        // fd
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, NET_OP_CLOSE);
  a.call('net_request');          // fire-and-forget, returns 1
  a.jmp('fs_method_done');

  // ------------------------------------------------------------- load_slot
  // RCX = ring slot 0..247. Returns the slot value in RAX.
  // Clobbers RCX, R9, R10.
  a.label('load_slot');
  emitLoadSlot(a, 'ls');

  // ------------------------------------------------------------ store_slot
  // RCX = ring slot 0..247, RAX = value. Clobbers RCX, R9, R10.
  a.label('store_slot');
  emitStoreSlot(a, 'ss');

  // ------------------------------------------------------------ parse_value
  // Parses one argument expression: a quoted string literal or an identifier
  // naming a variable. Returns the value in RAX and advances R12.
  // Clobbers RAX, RCX, RDX, R8-R11.
  a.label('parse_value');
  a.label('pv_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pv_zero');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'pv_start');
  a.inc(REG.R12);
  a.jmp('pv_ws');

  a.label('pv_start');
  a.cmpImm8(REG.RAX, 40);  // '(' -> parenthesized expression
  a.jcc(COND.E, 'pv_paren');
  a.cmpImm8(REG.RAX, 91);  // '[' -> array literal
  a.jcc(COND.E, 'pv_array');
  a.cmpImm8(REG.RAX, 39);  // '
  a.jcc(COND.E, 'pv_string');
  a.cmpImm8(REG.RAX, 34);  // "
  a.jcc(COND.E, 'pv_string');
  a.cmpImm8(REG.RAX, 45);  // '-'
  a.jcc(COND.E, 'pv_negative');
  a.cmpImm8(REG.RAX, 48);  // '0'
  a.jcc(COND.L, 'pv_hash_start');
  a.cmpImm8(REG.RAX, 57);  // '9'
  a.jcc(COND.G, 'pv_hash_start');

  // Decimal integer literal.
  a.xor(REG.RAX, REG.RAX);
  a.label('pv_num_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pv_num_done');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 48);
  a.jcc(COND.L, 'pv_num_done');
  a.cmpImm8(REG.RCX, 57);
  a.jcc(COND.G, 'pv_num_done');
  a.movImm32(REG.RDX, 10);
  a.imul(REG.RAX, REG.RDX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RAX, REG.RCX);
  a.inc(REG.R12);
  a.jmp('pv_num_loop');
  a.label('pv_num_done');
  a.ret();

  // Negative integer literal: -123 -> TAG_NEG | magnitude.
  a.label('pv_negative');
  a.inc(REG.R12);
  a.xor(REG.RAX, REG.RAX);
  a.label('pv_neg_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pv_neg_done');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 48);
  a.jcc(COND.L, 'pv_neg_done');
  a.cmpImm8(REG.RCX, 57);
  a.jcc(COND.G, 'pv_neg_done');
  a.movImm32(REG.RDX, 10);
  a.imul(REG.RAX, REG.RDX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RAX, REG.RCX);
  a.inc(REG.R12);
  a.jmp('pv_neg_loop');
  a.label('pv_neg_done');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'pv_zero');
  a.movImm64(REG.RCX, TAG_NEG_STR);
  a.or(REG.RAX, REG.RCX);
  a.ret();

  a.label('pv_hash_start');
  a.movImm64(REG.R8, FNV_OFFSET_STR);
  a.label('pv_hash');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pv_load');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.LE, 'pv_load');
  a.cmpImm8(REG.RCX, 44);  // ','
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 41);  // ')'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 59);  // ';'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 46);  // '.'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 91);  // '['
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 93);  // ']'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 40);  // '('
  a.jcc(COND.E, 'pv_call');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 60);  // '<'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 62);  // '>'
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 61);  // '='
  a.jcc(COND.E, 'pv_load');
  a.cmpImm8(REG.RCX, 33);  // '!'
  a.jcc(COND.E, 'pv_load');
  a.xor(REG.R8, REG.RCX);
  a.movImm64(REG.RDX, FNV_PRIME_STR);
  a.imul(REG.R8, REG.RDX);
  a.inc(REG.R12);
  a.jmp('pv_hash');

  a.label('pv_load');
  a.movImm64(REG.RCX, HASH_CONSOLE_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.NE, 'pv_not_console');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pv_not_console');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 46);           // '.'
  a.jcc(COND.NE, 'pv_not_console');
  a.movImm32(REG.RCX, 1);
  a.store64(REG.RBP, REG.RCX, STATE_CONSOLE_VALUE);
  a.jmp('handle_console');          // R12 at '.', same entry as the statement
  a.label('pv_not_console');
  a.movImm64(REG.RCX, HASH_WINDOW_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'pv_window');
  a.movImm64(REG.RCX, HASH_SCREEN_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'pv_screen');
  emitSlotIndex(a, REG.R8, REG.RCX, 'pv_slot');
  a.call('load_slot');
  a.call('value_member');
  a.ret();

  a.label('pv_window');
  a.movImm64(REG.RAX, TAG_WINDOW_STR);
  a.call('value_member');
  a.ret();

  a.label('pv_screen');
  a.movImm64(REG.RAX, TAG_SCREEN_STR);
  a.call('value_member');
  a.ret();

  // Identifier followed by '(': a function call used as a value.
  a.label('pv_call');
  a.movImm64(REG.RCX, HASH_FETCH_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'pv_fetch');
  a.movImm64(REG.RCX, HASH_REQUESTANIMATIONFRAME_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'pv_raf');
  a.movImm64(REG.RCX, HASH_SETTIMEOUT_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'pv_timeout');
  a.movImm64(REG.RCX, HASH_SETINTERVAL_STR);
  a.cmp(REG.R8, REG.RCX);
  a.jcc(COND.E, 'pv_timeout');
  a.call('lookup_function');      // R8 = name hash -> RAX = entry or 0
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'pv_call_unknown');
  a.leaRip(REG.R10, 'pv_after_call');
  a.jmp('call_function');
  a.label('pv_call_unknown');
  a.call('skip_paren_group');
  a.xor(REG.RAX, REG.RAX);
  a.ret();
  a.label('pv_after_call');
  a.call('value_member');
  a.ret();

  a.label('pv_fetch');
  a.call('call_fetch');
  a.call('value_member');
  a.ret();

  a.label('pv_raf');
  a.movImm64(REG.RAX, TAG_WINDOW_STR);
  a.mov(REG.R8, REG.RAX);
  a.call('object_method_value');
  a.ret();

  a.label('pv_timeout');
  a.call('parse_timer_call');
  a.call('value_member');
  a.ret();

  a.label('pv_string');
  a.call('parse_string');
  a.ret();

  a.label('pv_array');
  a.call('parse_array');
  a.ret();

  a.label('pv_paren');
  a.call('parse_group');
  a.call('value_member');
  a.ret();

  a.label('pv_zero');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // ------------------------------------------------------------ parse_expr
  // Left-associative concatenation/add over primaries. Used for call
  // arguments (fs/net/process); let and console have their own inline loops
  // so their associativity stays exactly JS-compatible.
  a.label('parse_expr');
  a.call('parse_value');
  a.label('pe_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pe_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.NE, 'pe_check');
  a.inc(REG.R12);
  a.jmp('pe_scan');
  a.label('pe_check');
  a.cmpImm8(REG.RCX, 43);  // '+'
  a.jcc(COND.E, 'pe_plus');
  a.label('pe_ret');
  a.ret();
  a.label('pe_plus');
  a.inc(REG.R12);
  a.push(REG.RAX);
  a.call('parse_value');
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RAX);
  a.call('concat_values');
  a.jmp('pe_scan');

  // ------------------------------------------------------ parse_value_line
  // Like parse_expr, but a newline terminates the expression instead of being
  // skipped. Used by assignments and conditions so a statement without a
  // semicolon does not consume the following line.
  // Clobbers RAX, RCX, RDX, R8-R11; preserves RBX, R12-R15, RBP.
  a.label('parse_value_line');
  a.call('parse_value');
  // Member access (e.g. a.length) on the parsed primary.
  a.label('pvl_member');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pvl_scan');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 46);         // '.'
  a.jcc(COND.E, 'pvl_dot');
  a.jmp('pvl_scan');
  a.label('pvl_dot');
  a.call('object_method_value');
  a.jmp('pvl_member');
  a.label('pvl_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pvl_done');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 10);
  a.jcc(COND.E, 'pvl_done');
  a.cmpImm8(REG.RCX, 13);
  a.jcc(COND.E, 'pvl_done');
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.G, 'pvl_check');
  a.inc(REG.R12);
  a.jmp('pvl_scan');
  a.label('pvl_check');
  a.cmpImm8(REG.RCX, 43);         // '+'
  a.jcc(COND.E, 'pvl_plus');
  a.jmp('pvl_done');
  a.label('pvl_plus');
  a.inc(REG.R12);
  a.push(REG.RAX);
  a.call('parse_value');
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.RAX);
  a.call('concat_values');
  a.jmp('pvl_member');
  a.label('pvl_done');
  a.ret();

  // ------------------------------------------------------------ parse_group
  // R12 points at '('. Consumes the parenthesized expression, leaving R12
  // just past the closing ')'. Returns the inner value in RAX.
  // Clobbers RAX, RCX, RDX, R8-R11 (via parse_expr).
  a.label('parse_group');
  a.inc(REG.R12);                  // consume '('
  a.call('parse_expr');
  a.label('pg_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pg_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.NE, 'pg_check');
  a.inc(REG.R12);
  a.jmp('pg_ws');
  a.label('pg_check');
  a.cmpImm8(REG.RCX, 41);          // ')'
  a.jcc(COND.NE, 'pg_ret');
  a.inc(REG.R12);
  a.label('pg_ret');
  a.ret();

  // ------------------------------------------------------ chained access
  // RAX = value, R12 just past the expression that produced it. Applies any
  // chain of index ([...]) and property (.name) accesses, leaving the final
  // value in RAX. Used after calls and parenthesized groups.
  a.label('value_member');
  a.label('vm_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'vm_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 91);         // '['
  a.jcc(COND.E, 'vm_index');
  a.cmpImm8(REG.RCX, 46);         // '.'
  a.jcc(COND.E, 'vm_dot');
  a.label('vm_ret');
  a.ret();
  a.label('vm_index');
  a.call('maybe_index');
  a.jmp('vm_loop');
  a.label('vm_dot');
  a.call('object_method_value');
  a.jmp('vm_loop');

  // ---------------------------------------------------------- maybe_index
  // RAX = value just loaded from a variable, R12 past the identifier. If a
  // '[' follows, index into it; otherwise return the value unchanged.
  a.label('maybe_index');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'mi_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 91);         // '['
  a.jcc(COND.E, 'mi_do');
  a.label('mi_ret');
  a.ret();
  a.label('mi_do');
  a.call('index_value');
  a.ret();

  // ----------------------------------------------------------- parse_index
  // R12 at '['. Parses [expr] and consumes the closing ']'. Returns the index
  // expression value in RAX. Clobbers RAX, RCX, RDX, R8-R11; preserves RBX,
  // R12-R15, RBP (via parse_expr).
  a.label('parse_index');
  a.inc(REG.R12);                 // consume '['
  a.call('parse_expr');           // RAX = index
  a.label('pi_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pi_ret');
  a.load8(REG.RCX, REG.R12, 0);
  a.cmpImm8(REG.RCX, 32);
  a.jcc(COND.G, 'pi_close');
  a.inc(REG.R12);
  a.jmp('pi_ws');
  a.label('pi_close');
  a.cmpImm8(REG.RCX, 93);         // ']'
  a.jcc(COND.NE, 'pi_ret');
  a.inc(REG.R12);
  a.label('pi_ret');
  a.ret();

  // ----------------------------------------------------------- index_value
  // RAX = receiver value, R12 at '['. Parses [expr], consumes ']', and
  // returns the element value. Non-arrays, non-integer indices, and
  // out-of-range accesses yield 0. Clobbers RAX, RCX, RDX, R8-R11;
  // preserves RBX, R12-R15, RBP.
  a.label('index_value');
  a.push(REG.RAX);                // receiver must survive index parsing
  a.call('parse_index');          // RAX = index
  a.mov(REG.RDX, REG.RAX);
  a.pop(REG.R8);                  // receiver
  a.label('iv_bounds');
  a.mov(REG.RCX, REG.RDX);
  a.shrImm8(REG.RCX, 56);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.NZ, 'iv_oob');       // negative or non-integer index
  a.mov(REG.RCX, REG.R8);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xfb);      // array tag
  a.jcc(COND.NE, 'iv_oob');
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);         // handle
  a.load64(REG.RAX, REG.R8, 0);   // len
  a.cmp(REG.RDX, REG.RAX);
  a.jcc(COND.GE, 'iv_oob');
  a.load64(REG.R8, REG.R8, 16);   // data buffer
  a.load64Indexed(REG.RAX, REG.R8, REG.RDX);
  a.ret();
  a.label('iv_oob');
  a.xor(REG.RAX, REG.RAX);
  a.ret();

  // ----------------------------------------------------------- parse_array
  // R12 points at '['. Parses a comma-separated literal, allocates a heap
  // object [len:u64][cap:u64][elem0:u64..], and returns its tagged value in
  // RAX with R12 just past the closing ']'. Literals reserve 16 spare slots
  // so push() can append in place without invalidating the stored pointer.
  // Clobbers RAX, RCX, RDX, R8-R11; preserves RBX, R12-R15, RBP.
  a.label('parse_array');
  a.push(REG.RBX);                // preserve caller's name hash
  a.push(REG.R12);                // literal start (at '[')
  a.inc(REG.R12);

  // Pass 1: count top-level commas, tracking nesting and quoted strings.
  a.xor(REG.R8, REG.R8);          // bracket depth
  a.xor(REG.R9, REG.R9);          // top-level commas
  a.xor(REG.R10, REG.R10);        // saw at least one token
  a.label('pa_scan');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pa_scan_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 39);         // '
  a.jcc(COND.E, 'pa_scan_quote');
  a.cmpImm8(REG.RAX, 34);         // "
  a.jcc(COND.E, 'pa_scan_quote');
  a.cmpImm8(REG.RAX, 91);         // '['
  a.jcc(COND.E, 'pa_scan_open');
  a.cmpImm8(REG.RAX, 93);         // ']'
  a.jcc(COND.E, 'pa_scan_close');
  a.cmpImm8(REG.RAX, 44);         // ','
  a.jcc(COND.E, 'pa_scan_comma');
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.LE, 'pa_scan');      // whitespace does not count as a token
  a.movImm32(REG.R10, 1);
  a.jmp('pa_scan');
  a.label('pa_scan_open');
  a.inc(REG.R8);
  a.movImm32(REG.R10, 1);
  a.jmp('pa_scan');
  a.label('pa_scan_comma');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.NZ, 'pa_scan');
  a.inc(REG.R9);
  a.jmp('pa_scan');
  a.label('pa_scan_close');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'pa_scan_done');
  a.dec(REG.R8);
  a.jmp('pa_scan');
  a.label('pa_scan_quote');
  a.mov(REG.R11, REG.RAX);        // matching quote byte
  a.label('pa_quote_loop');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pa_scan_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmp(REG.RAX, REG.R11);
  a.jcc(COND.NE, 'pa_quote_loop');
  a.movImm32(REG.R10, 1);
  a.jmp('pa_scan');

  // len = 0 for [], else commas + 1.
  a.label('pa_scan_done');
  a.xor(REG.RCX, REG.RCX);
  a.test(REG.R10, REG.R10);
  a.jcc(COND.Z, 'pa_len_ready');
  a.mov(REG.RCX, REG.R9);
  a.inc(REG.RCX);
  a.label('pa_len_ready');

  // Allocate a stable 24-byte handle [len][cap][data] plus cap element
  // slots. The handle never moves, so growing the data buffer cannot
  // invalidate the value stored in a variable slot.
  a.mov(REG.R8, REG.RCX);
  a.addImm32(REG.R8, 16);         // initial capacity = len + 16 spare
  a.mov(REG.R11, REG.R14);        // handle
  a.addImm32(REG.R14, 24);
  a.mov(REG.R9, REG.R14);         // data buffer
  a.mov(REG.R10, REG.R8);
  a.shlImm8(REG.R10, 3);
  a.add(REG.R14, REG.R10);
  a.store64(REG.R11, REG.RCX, 0); // len
  a.store64(REG.R11, REG.R8, 8);  // cap
  a.store64(REG.R11, REG.R9, 16);// data pointer

  // Pass 2: parse each element into its slot.
  a.load64(REG.R12, REG.RSP, 0);
  a.inc(REG.R12);
  a.push(REG.RCX);                // len
  a.push(REG.RCX);                // remaining
  a.push(REG.R11);                // object pointer
  a.label('pa_parse_loop');
  a.load64(REG.R9, REG.RSP, 8);
  a.test(REG.R9, REG.R9);
  a.jcc(COND.Z, 'pa_parse_close');
  a.label('pa_skip_ws');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pa_parse_close');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'pa_elem');
  a.inc(REG.R12);
  a.jmp('pa_skip_ws');
  a.label('pa_elem');
  a.call('parse_expr');
  a.load64(REG.R9, REG.RSP, 8);   // remaining
  a.load64(REG.RCX, REG.RSP, 16); // len
  a.sub(REG.RCX, REG.R9);         // index
  a.load64(REG.R10, REG.RSP, 0);  // handle
  a.load64(REG.R10, REG.R10, 16);// data buffer
  a.store64Indexed(REG.R10, REG.RCX, REG.RAX);
  a.load64(REG.R9, REG.RSP, 8);
  a.dec(REG.R9);
  a.store64(REG.RSP, REG.R9, 8);
  a.label('pa_sep');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pa_parse_close');
  a.load8(REG.RAX, REG.R12, 0);
  a.cmpImm8(REG.RAX, 32);
  a.jcc(COND.G, 'pa_sep_check');
  a.inc(REG.R12);
  a.jmp('pa_sep');
  a.label('pa_sep_check');
  a.cmpImm8(REG.RAX, 44);         // ','
  a.jcc(COND.NE, 'pa_parse_close');
  a.inc(REG.R12);
  a.jmp('pa_parse_loop');

  a.label('pa_parse_close');
  a.label('pa_seek_close');
  a.cmp(REG.R12, REG.R13);
  a.jcc(COND.GE, 'pa_close_done');
  a.load8(REG.RAX, REG.R12, 0);
  a.inc(REG.R12);
  a.cmpImm8(REG.RAX, 93);         // ']'
  a.jcc(COND.NE, 'pa_seek_close');
  a.label('pa_close_done');
  a.load64(REG.RAX, REG.RSP, 0);  // object pointer
  a.addImm32(REG.RSP, 24);        // drop obj/remaining/len
  a.addImm32(REG.RSP, 8);         // drop literal start
  a.movImm64(REG.RCX, TAG_ARRAY_STR);
  a.or(REG.RAX, REG.RCX);
  a.pop(REG.RBX);
  a.ret();

  // -------------------------------------------------------- array_snapshot
  // RAX = array value. Allocates a deep copy (len elements) and returns its
  // tagged value, so deferred output observes the call-time contents even
  // when nested arrays are mutated before the output worker runs.
  // Clobbers RAX, RCX, RDX, R8-R11; advances R14.
  a.label('array_snapshot');
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.mov(REG.R8, REG.RAX);
  a.and(REG.R8, REG.RCX);         // source handle
  a.load64(REG.R9, REG.R8, 0);    // len
  a.load64(REG.R8, REG.R8, 16);   // source data buffer
  a.mov(REG.R11, REG.R14);        // destination handle
  a.addImm32(REG.R14, 24);
  a.mov(REG.R10, REG.R14);        // destination data buffer
  a.mov(REG.RAX, REG.R9);
  a.shlImm8(REG.RAX, 3);
  a.add(REG.R14, REG.RAX);
  a.store64(REG.R11, REG.R9, 0);  // len
  a.store64(REG.R11, REG.R9, 8);  // cap = len
  a.store64(REG.R11, REG.R10, 16);// data pointer
  a.mov(REG.RCX, REG.R9);         // count
  a.xor(REG.RDX, REG.RDX);        // index
  a.label('as_copy');
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'as_done');
  a.load64Indexed(REG.RAX, REG.R8, REG.RDX);
  a.mov(REG.R9, REG.RAX);
  a.shrImm8(REG.R9, 56);
  a.cmpImm32(REG.R9, 0xfb);       // nested array -> deep-copy it too
  a.jcc(COND.NE, 'as_store');
  a.push(REG.RCX);
  a.push(REG.RDX);
  a.push(REG.R8);
  a.push(REG.R10);
  a.push(REG.R11);
  a.call('array_snapshot');
  a.pop(REG.R11);
  a.pop(REG.R10);
  a.pop(REG.R8);
  a.pop(REG.RDX);
  a.pop(REG.RCX);
  a.label('as_store');
  a.store64Indexed(REG.R10, REG.RDX, REG.RAX);
  a.inc(REG.RDX);
  a.dec(REG.RCX);
  a.jmp('as_copy');
  a.label('as_done');
  a.mov(REG.RAX, REG.R11);
  a.movImm64(REG.RCX, TAG_ARRAY_STR);
  a.or(REG.RAX, REG.RCX);
  a.ret();

  // ---------------------------------------------------------- print_value
  // RAX = value. Appends an integer or the bytes of a string/buffer to the
  // output worker's line buffer. Runs on the output core, never the
  // dispatcher. Preserves R12/R13/R14/R15/RBX.
  a.label('print_value');
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'print_value_num');
  a.cmpImm32(REG.RCX, 0xfd);       // socket: print the descriptor
  a.jcc(COND.E, 'print_value_sock');
  a.cmpImm32(REG.RCX, 0xfb);       // array
  a.jcc(COND.E, 'print_value_array');
  a.cmpImm32(REG.RCX, 0xfa);       // fetch response: print its body
  a.jcc(COND.E, 'print_value_response');
  a.cmpImm32(REG.RCX, 0xfc);       // negative integer
  a.jcc(COND.E, 'print_value_neg');

  a.mov(REG.RDX, REG.RCX);
  a.andImm8(REG.RDX, 0xf8);        // 0xF0..0xF7 = inline short string
  a.cmpImm32(REG.RDX, 0xf0);
  a.jcc(COND.E, 'print_value_inline');

  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.load64(REG.RDX, REG.RAX, 0);  // len
  a.addImm32(REG.RAX, 8);         // data
  a.mov(REG.RSI, REG.RAX);
  a.call('out_write');
  a.ret();

  a.label('print_value_inline');
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.andImm8(REG.RCX, 7);          // length = tag & 7
  a.subImm32(REG.RSP, 16);
  a.store64(REG.RSP, REG.RAX, 0); // payload bytes at [rsp]
  a.mov(REG.RSI, REG.RSP);
  a.mov(REG.RDX, REG.RCX);
  a.call('out_write');
  a.addImm32(REG.RSP, 16);
  a.ret();

  a.label('print_value_sock');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.jmp('print_u64');

  a.label('print_value_response');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.load64(REG.RAX, REG.RAX, 8);   // body value
  a.jmp('print_value');

  a.label('print_value_neg');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.push(REG.RAX);
  a.subImm32(REG.RSP, 16);
  a.mov(REG.R11, REG.RSP);
  a.movImm32(REG.RDX, 45);         // '-'
  a.store8(REG.R11, REG.RDX, 0);
  a.mov(REG.RSI, REG.RSP);
  a.movImm32(REG.RDX, 1);
  a.call('out_write');
  a.addImm32(REG.RSP, 16);
  a.pop(REG.RAX);
  a.jmp('print_u64');

  a.label('print_value_num');
  a.jmp('print_u64');

  // ------------------------------------------------------------ print_byte
  // RDX = one byte. Appends it to the line buffer.
  a.label('print_byte');
  a.subImm32(REG.RSP, 16);
  a.store8(REG.RSP, REG.RDX, 0);
  a.mov(REG.RSI, REG.RSP);
  a.movImm32(REG.RDX, 1);
  a.call('out_write');
  a.addImm32(REG.RSP, 16);
  a.ret();

  // -------------------------------------------------------- print_value_array
  // RAX = array value. Emits [e0, e1, ...] (or [] when empty) by recursing
  // through print_value for each element.
  a.label('print_value_array');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);          // handle
  a.load64(REG.RCX, REG.RAX, 0);    // len
  a.load64(REG.RDX, REG.RAX, 16);   // data buffer
  a.push(REG.RCX);                  // len
  a.push(REG.RCX);                  // remaining
  a.push(REG.RDX);                  // data buffer
  a.movImm32(REG.RDX, 91);          // '['
  a.call('print_byte');
  a.label('pva_loop');
  a.load64(REG.RDX, REG.RSP, 8);    // remaining
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'pva_close');
  a.load64(REG.RCX, REG.RSP, 16);   // len
  a.cmp(REG.RDX, REG.RCX);
  a.jcc(COND.E, 'pva_first');       // no separator before the first
  a.movImm32(REG.RDX, 44);          // ','
  a.call('print_byte');
  a.movImm32(REG.RDX, 32);          // ' '
  a.call('print_byte');
  a.label('pva_first');
  a.load64(REG.RCX, REG.RSP, 16);   // len
  a.load64(REG.RDX, REG.RSP, 8);    // remaining
  a.sub(REG.RCX, REG.RDX);          // index
  a.load64(REG.RDX, REG.RSP, 0);    // data buffer
  a.load64Indexed(REG.RAX, REG.RDX, REG.RCX);
  a.call('print_value');
  a.load64(REG.RDX, REG.RSP, 8);
  a.dec(REG.RDX);
  a.store64(REG.RSP, REG.RDX, 8);
  a.jmp('pva_loop');
  a.label('pva_close');
  a.addImm32(REG.RSP, 24);
  a.movImm32(REG.RDX, 93);          // ']'
  a.call('print_byte');
  a.ret();

  // ---------------------------------------------------------- parse_string
  // R12 points at the opening quote. Returns a string value in RAX and
  // leaves R12 just past the closing quote.
  //
  // Short strings (0..7 bytes) are returned inline in the value word:
  //   top byte = 0xF0 | length, low 56 bits = bytes little-endian.
  // Longer strings live on the heap as [len:u64][bytes][NUL].
  // Clobbers RAX, RCX, RDX, RSI, R8-R11.
  a.label('parse_string');
  a.load8(REG.RSI, REG.R12, 0);   // quote character
  a.inc(REG.R12);
  a.mov(REG.R8, REG.R12);         // start of bytes
  a.mov(REG.R9, REG.R12);         // scan cursor
  a.xor(REG.R10, REG.R10);        // length

  a.label('ps_scan');
  a.cmp(REG.R9, REG.R13);
  a.jcc(COND.GE, 'ps_scan_done');
  a.load8(REG.RAX, REG.R9, 0);
  a.inc(REG.R9);
  a.cmp(REG.RAX, REG.RSI);
  a.jcc(COND.E, 'ps_scan_done');
  a.inc(REG.R10);
  a.jmp('ps_scan');

  a.label('ps_scan_done');
  a.mov(REG.R12, REG.R9);         // past the closing quote
  a.cmpImm32(REG.R10, 7);
  a.jcc(COND.G, 'ps_heap');

  // Inline path: build the payload from the last byte down so byte 0 ends
  // up in the low 8 bits.
  a.xor(REG.RAX, REG.RAX);
  a.mov(REG.R11, REG.R8);
  a.add(REG.R11, REG.R10);
  a.dec(REG.R11);                 // last byte
  a.label('ps_inline_loop');
  a.cmp(REG.R11, REG.R8);
  a.jcc(COND.L, 'ps_inline_done');
  a.load8(REG.RCX, REG.R11, 0);
  a.shlImm8(REG.RAX, 8);
  a.or(REG.RAX, REG.RCX);
  a.dec(REG.R11);
  a.jmp('ps_inline_loop');

  a.label('ps_inline_done');
  a.mov(REG.RCX, REG.R10);
  a.addImm32(REG.RCX, 0xf0);      // tag = 0xF0 | len
  a.shlImm8(REG.RCX, 56);
  a.or(REG.RAX, REG.RCX);
  a.ret();

  // Heap path.
  a.label('ps_heap');
  a.mov(REG.R11, REG.R14);        // object pointer
  a.mov(REG.R9, REG.R14);
  a.addImm32(REG.R9, 8);          // data write cursor
  a.mov(REG.RCX, REG.R8);         // source
  a.mov(REG.RDX, REG.R10);        // count
  a.label('ps_copy');
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'ps_copy_done');
  a.load8(REG.RAX, REG.RCX, 0);
  a.store8(REG.R9, REG.RAX, 0);
  a.inc(REG.RCX);
  a.inc(REG.R9);
  a.dec(REG.RDX);
  a.jmp('ps_copy');

  a.label('ps_copy_done');
  a.store64(REG.R11, REG.R10, 0); // object length
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R9, REG.RAX, 0);   // NUL-terminate
  a.mov(REG.RAX, REG.R10);
  a.addImm32(REG.RAX, 9);         // len + 8-byte header + NUL
  a.add(REG.R14, REG.RAX);
  a.mov(REG.RAX, REG.R11);
  a.movImm64(REG.RCX, TAG_STRING_STR);
  a.or(REG.RAX, REG.RCX);
  a.ret();

  // ---------------------------------------------------- materialize_string
  // RAX = string/buffer value. Returns a NUL-terminated byte pointer in RAX
  // and the length in RDX. Inline strings are spilled to 16 bytes of heap
  // scratch (the only place the register representation touches memory).
  // Clobbers RAX, RCX, RDX, R8, R9; advances R14.
  a.label('materialize_string');
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xfc);       // negative integer -> decimal string
  a.jcc(COND.E, 'ms_negative');
  a.mov(REG.RDX, REG.RCX);
  a.andImm8(REG.RDX, 0xf8);
  a.cmpImm32(REG.RDX, 0xf0);
  a.jcc(COND.E, 'ms_inline');

  // Heap object: skip the 8-byte length header.
  a.mov(REG.R8, REG.RAX);
  a.movImm64(REG.RCX, VALUE_MASK_STR);
  a.and(REG.R8, REG.RCX);
  a.load64(REG.RDX, REG.R8, 0);
  a.mov(REG.RAX, REG.R8);
  a.addImm32(REG.RAX, 8);
  a.ret();

  a.label('ms_inline');
  a.mov(REG.R8, REG.R14);         // scratch buffer
  a.store64(REG.R8, REG.RAX, 0);  // payload bytes + tag
  a.xor(REG.R9, REG.R9);
  a.store8(REG.R8, REG.R9, 7);    // clear tag byte -> NUL at/after payload
  a.mov(REG.RDX, REG.RCX);
  a.andImm8(REG.RDX, 7);          // length = tag & 7
  a.mov(REG.RAX, REG.R8);
  a.addImm32(REG.R14, 16);
  a.ret();

  a.label('ms_negative');
  a.push(REG.RSI);                // int_to_string clobbers more than
  a.push(REG.RDI);                // materialize_string documents
  a.push(REG.R10);
  a.push(REG.R11);
  a.call('int_to_string');        // RAX = heap string value
  a.pop(REG.R11);
  a.pop(REG.R10);
  a.pop(REG.RDI);
  a.pop(REG.RSI);
  a.jmp('materialize_string');    // tail-reenter with the new value

  // -------------------------------------------------------- int_to_string
  // RAX = integer value (tag 0 or TAG_NEG). Allocates a heap string
  // [len:u64][bytes][NUL] and returns its value in RAX. Advances R14.
  // Clobbers RAX, RCX, RDX, RSI, RDI, R8-R11.
  a.label('int_to_string');
  a.subImm32(REG.RSP, 32);
  a.mov(REG.RCX, REG.RSP);
  a.addImm32(REG.RCX, 31);          // digit cursor (writes backwards)
  a.xor(REG.R11, REG.R11);          // digit count
  a.xor(REG.R8, REG.R8);            // sign flag
  a.mov(REG.RDX, REG.RAX);
  a.shrImm8(REG.RDX, 56);
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'its_abs');
  a.movImm64(REG.RDX, VALUE_MASK_STR);
  a.and(REG.RAX, REG.RDX);
  a.movImm32(REG.R8, 1);
  a.label('its_abs');
  a.movImm32(REG.R9, 10);
  a.label('its_loop');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'its_done');
  a.xor(REG.RDX, REG.RDX);
  a.divReg(REG.R9);
  a.addImm32(REG.RDX, 48);
  a.store8(REG.RCX, REG.RDX, 0);
  a.dec(REG.RCX);
  a.inc(REG.R11);
  a.jmp('its_loop');
  a.label('its_done');
  a.test(REG.R11, REG.R11);
  a.jcc(COND.NZ, 'its_have_digits');
  a.movImm32(REG.RDX, 48);
  a.store8(REG.RCX, REG.RDX, 0);
  a.movImm32(REG.R11, 1);
  a.jmp('its_sign');
  a.label('its_have_digits');
  a.inc(REG.RCX);                   // start of digits
  a.label('its_sign');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'its_copy_setup');
  a.dec(REG.RCX);
  a.movImm32(REG.RDX, 45);          // '-'
  a.store8(REG.RCX, REG.RDX, 0);
  a.inc(REG.R11);
  a.label('its_copy_setup');
  a.mov(REG.R9, REG.R14);           // object pointer
  a.store64(REG.R9, REG.R11, 0);
  a.mov(REG.R10, REG.R9);
  a.addImm32(REG.R10, 8);           // destination
  a.mov(REG.RDX, REG.R11);          // count
  a.mov(REG.RSI, REG.RCX);          // source
  a.label('its_copy');
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'its_copy_done');
  a.load8(REG.RAX, REG.RSI, 0);
  a.store8(REG.R10, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.R10);
  a.dec(REG.RDX);
  a.jmp('its_copy');
  a.label('its_copy_done');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.R10, REG.RAX, 0);
  a.mov(REG.RAX, REG.R11);
  a.addImm32(REG.RAX, 9);
  a.add(REG.R14, REG.RAX);
  a.mov(REG.RAX, REG.R9);
  a.movImm64(REG.RCX, TAG_STRING_STR);
  a.or(REG.RAX, REG.RCX);
  a.addImm32(REG.RSP, 32);
  a.ret();

  // -------------------------------------------------------- concat_values
  // RAX = left value, RDX = right value. Both integers -> numeric add;
  // otherwise string concatenation (integers converted to decimal).
  a.label('concat_values');
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.mov(REG.R8, REG.RDX);
  a.shrImm8(REG.R8, 56);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'cv_a_int');
  a.cmpImm32(REG.RCX, 0xfc);
  a.jcc(COND.NE, 'cv_not_both');
  a.label('cv_a_int');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'cv_b_int');
  a.cmpImm32(REG.R8, 0xfc);
  a.jcc(COND.NE, 'cv_not_both');
  a.label('cv_b_int');
  // Decode both operands to signed 64-bit values.
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'cv_a_dec');
  a.movImm64(REG.R9, VALUE_MASK_STR);
  a.and(REG.RAX, REG.R9);
  a.neg(REG.RAX);
  a.label('cv_a_dec');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'cv_b_dec');
  a.movImm64(REG.R9, VALUE_MASK_STR);
  a.and(REG.RDX, REG.R9);
  a.neg(REG.RDX);
  a.label('cv_b_dec');
  a.add(REG.RAX, REG.RDX);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.S, 'cv_neg_result');
  a.ret();
  a.label('cv_neg_result');
  a.neg(REG.RAX);
  a.movImm64(REG.RCX, TAG_NEG_STR);
  a.or(REG.RAX, REG.RCX);
  a.ret();

  a.label('cv_not_both');
  // Convert either integer operand to a string, then concatenate.
  a.push(REG.RDX);                  // right value
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'cv_a_conv');
  a.cmpImm32(REG.RCX, 0xfc);
  a.jcc(COND.NE, 'cv_a_done');
  a.label('cv_a_conv');
  a.call('int_to_string');
  a.label('cv_a_done');
  a.push(REG.RAX);                  // left string
  a.load64(REG.RAX, REG.RSP, 8);    // right value
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'cv_b_conv');
  a.cmpImm32(REG.RCX, 0xfc);
  a.jcc(COND.NE, 'cv_b_done');
  a.label('cv_b_conv');
  a.call('int_to_string');
  a.label('cv_b_done');
  a.mov(REG.RDX, REG.RAX);          // right string
  a.pop(REG.RAX);                   // left string
  a.addImm32(REG.RSP, 8);           // drop right original
  a.jmp('concat_strings');

  // ------------------------------------------------------- concat_strings
  // RAX = left string/buffer, RDX = right string/buffer. Allocates a new
  // heap string with the bytes of both. Advances R14.
  a.label('concat_strings');
  a.push(REG.RDX);                  // right value
  a.call('materialize_string');     // left -> RAX=ptr, RDX=len
  a.push(REG.RAX);                  // left ptr
  a.push(REG.RDX);                  // left len
  a.load64(REG.RAX, REG.RSP, 16);   // right value
  a.call('materialize_string');     // right -> RAX=ptr, RDX=len
  a.mov(REG.R8, REG.RAX);           // right ptr
  a.mov(REG.R9, REG.RDX);           // right len
  a.pop(REG.RCX);                   // left len
  a.pop(REG.RSI);                   // left ptr
  a.addImm32(REG.RSP, 8);           // drop right original

  a.mov(REG.R10, REG.R14);          // object pointer
  a.mov(REG.R11, REG.RCX);
  a.add(REG.R11, REG.R9);           // total length
  a.store64(REG.R10, REG.R11, 0);
  a.mov(REG.RDI, REG.R10);
  a.addImm32(REG.RDI, 8);           // destination
  a.mov(REG.RDX, REG.RCX);          // left count
  a.label('cs_copy_left');
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'cs_left_done');
  a.load8(REG.RAX, REG.RSI, 0);
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.RDI);
  a.dec(REG.RDX);
  a.jmp('cs_copy_left');
  a.label('cs_left_done');
  a.mov(REG.RDX, REG.R9);           // right count
  a.mov(REG.RSI, REG.R8);           // right ptr
  a.label('cs_copy_right');
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'cs_right_done');
  a.load8(REG.RAX, REG.RSI, 0);
  a.store8(REG.RDI, REG.RAX, 0);
  a.inc(REG.RSI);
  a.inc(REG.RDI);
  a.dec(REG.RDX);
  a.jmp('cs_copy_right');
  a.label('cs_right_done');
  a.xor(REG.RAX, REG.RAX);
  a.store8(REG.RDI, REG.RAX, 0);
  a.mov(REG.RAX, REG.R11);
  a.addImm32(REG.RAX, 9);
  a.add(REG.R14, REG.RAX);
  a.mov(REG.RAX, REG.R10);
  a.movImm64(REG.RCX, TAG_STRING_STR);
  a.or(REG.RAX, REG.RCX);
  a.ret();

  // ---------------------------------------------------------- print_u64
  // RAX = unsigned 64-bit value. Writes decimal digits + no newline.
  // Clobbers RAX, RCX, RDX, RSI, RDI, R8, R11. Preserves R12/R13/R14/RBX.
  a.label('print_u64');
  a.subImm32(REG.RSP, 24);
  a.mov(REG.RCX, REG.RSP);
  a.addImm32(REG.RCX, 23);  // last byte of the scratch buffer

  a.xor(REG.R11, REG.R11);  // digit count
  a.movImm32(REG.R8, 10);   // divisor

  a.label('print_loop');
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, 'print_done');

  a.xor(REG.RDX, REG.RDX);
  a.divReg(REG.R8);
  a.addImm32(REG.RDX, 48);  // '0' + remainder
  a.store8(REG.RCX, REG.RDX, 0);
  a.dec(REG.RCX);
  a.inc(REG.R11);
  a.jmp('print_loop');

  a.label('print_done');
  a.test(REG.R11, REG.R11);
  a.jcc(COND.NZ, 'print_write_inc');
  // Zero prints as a single '0'.
  a.movImm32(REG.RDX, 48);
  a.store8(REG.RCX, REG.RDX, 0);
  a.movImm32(REG.R11, 1);
  a.jmp('print_write');

  a.label('print_write_inc');
  a.inc(REG.RCX);

  a.label('print_write');
  a.mov(REG.RDX, REG.R11);
  a.mov(REG.RSI, REG.RCX);
  a.call('out_write');      // append digits to the worker's line buffer

  a.addImm32(REG.RSP, 24);
  a.ret();

  // ----------------------------------------------------------- file_request
  // RAX = op, RCX = arg0 (path value), RDX = arg1 (data value).
  // Blocking ops wait for the file worker's completion record; writes are
  // fire-and-forget and return 1 immediately. Preserves R12/R13/R14/RBX/RBP.
  a.label('file_request');
  if (UEFI) {
    // The UEFI build has no file worker yet. Report failure instead of
    // blocking forever on a completion record nobody will publish.
    a.xor(REG.RAX, REG.RAX);
    a.ret();
  }
  a.mov(REG.R11, REG.RAX);          // op
  a.mov(REG.R10, REG.RCX);          // arg0
  a.mov(REG.R9, REG.RDX);           // arg1
  a.movImm64(REG.R8, '0x' + (heapBase + FILE_SEQ).toString(16));
  a.load64(REG.R8, REG.R8, 0);
  a.inc(REG.R8);                    // request sequence
  a.movImm64(REG.RSI, '0x' + (heapBase + FILE_SEQ).toString(16));
  a.store64(REG.RSI, REG.R8, 0);
  emitEnqueue(a, heapBase, FILE_QUEUE, {
    fields: [REG.R11, REG.R10, REG.R9, REG.R8],
    tmpA: REG.RSI,
    tmpB: REG.RDI,
  }, 'enq_file', SINGLE_CORE);

  a.cmpImm32(REG.R11, FILE_OP_WRITE);
  a.jcc(COND.E, 'fr_nowait');
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_COMPLETION_SEQ).toString(16));
  a.label('fr_wait');
  a.load64(REG.RDX, REG.RCX, 0);
  a.cmp(REG.RDX, REG.R8);
  a.jcc(COND.E, 'fr_ready');
  emitIdle(a, SINGLE_CORE);
  a.jmp('fr_wait');
  a.label('fr_ready');
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_COMPLETION_VALUE).toString(16));
  a.load64(REG.RAX, REG.RCX, 0);
  a.ret();
  a.label('fr_nowait');
  a.movImm32(REG.RAX, 1);
  a.ret();

  // ------------------------------------------------------------ net_request
  // RAX = op, RCX = a (port or fd), RDX = b (host or data value).
  // connect/read block; write/close are fire-and-forget.
  a.label('net_request');
  if (UEFI) {
    // No TCP stack in the UEFI build. Fail fast; fs/net/fetch callers see 0.
    a.xor(REG.RAX, REG.RAX);
    a.ret();
  }
  a.mov(REG.R11, REG.RAX);          // op
  a.mov(REG.R10, REG.RCX);          // a
  a.mov(REG.R9, REG.RDX);           // b
  a.movImm64(REG.R8, '0x' + (heapBase + NET_SEQ).toString(16));
  a.load64(REG.R8, REG.R8, 0);
  a.inc(REG.R8);
  a.movImm64(REG.RSI, '0x' + (heapBase + NET_SEQ).toString(16));
  a.store64(REG.RSI, REG.R8, 0);
  emitEnqueue(a, heapBase, NET_QUEUE, {
    fields: [REG.R11, REG.R10, REG.R9, REG.R8],
    tmpA: REG.RSI,
    tmpB: REG.RDI,
  }, 'enq_net', SINGLE_CORE);

  a.cmpImm32(REG.R11, NET_OP_WRITE);
  a.jcc(COND.E, 'nr_nowait');
  a.cmpImm32(REG.R11, NET_OP_CLOSE);
  a.jcc(COND.E, 'nr_nowait');
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_COMPLETION_SEQ).toString(16));
  a.label('nr_wait');
  a.load64(REG.RDX, REG.RCX, 0);
  a.cmp(REG.RDX, REG.R8);
  a.jcc(COND.E, 'nr_ready');
  emitIdle(a, SINGLE_CORE);
  a.jmp('nr_wait');
  a.label('nr_ready');
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_COMPLETION_VALUE).toString(16));
  a.load64(REG.RAX, REG.RCX, 0);
  a.ret();
  a.label('nr_nowait');
  a.movImm32(REG.RAX, 1);
  a.ret();

  // ------------------------------------------------------ enqueue_output
  // RAX = value word, RDX = kind. Called by the dispatcher; spins only when
  // the output queue is full. Preserves R12/R13/R14/RBX.
  a.label('enqueue_output');
  if (UEFI) {
    // No output worker: format one item synchronously and flush it. The
    // formatter uses R13/R14/R15/RBP as its private output state, so preserve
    // the interpreter's registers around the call.
    a.push(REG.R12);
    a.push(REG.R13);
    a.push(REG.R14);
    a.push(REG.R15);
    a.push(REG.RBP);
    a.push(REG.RBX);
    a.mov(REG.R11, REG.RAX);        // value
    a.mov(REG.R10, REG.RDX);        // kind
    a.movImm64(REG.R13, '0x' + (heapBase + OUT_BUF).toString(16));
    a.movImm64(REG.R14, '0x' + (heapBase + OUT_SCRATCH).toString(16));
    a.xor(REG.R15, REG.R15);
    a.movImm32(REG.RBP, 1);
    a.cmpImm32(REG.R10, OUT_KIND_ERR);
    a.jcc(COND.B, 'uefi_out_kind');
    a.subImm32(REG.R10, OUT_KIND_ERR);
    a.movImm32(REG.RBP, 2);
    a.label('uefi_out_kind');
    a.cmpImm32(REG.R10, OUT_KIND_EXIT);
    a.jcc(COND.E, 'uefi_out_exit');
    a.cmpImm32(REG.R10, OUT_KIND_NL);
    a.jcc(COND.E, 'uefi_out_nl');
    a.cmpImm32(REG.R10, OUT_KIND_SPACE);
    a.jcc(COND.E, 'uefi_out_space');
    a.cmpImm32(REG.R10, OUT_KIND_RAW);
    a.jcc(COND.E, 'uefi_out_raw');
    a.mov(REG.RAX, REG.R11);
    a.call('print_value');
    a.call('out_newline');
    a.jmp('uefi_out_flush');
    a.label('uefi_out_raw');
    a.mov(REG.RAX, REG.R11);
    a.call('print_value');
    a.jmp('uefi_out_flush');
    a.label('uefi_out_nl');
    a.call('out_newline');
    a.jmp('uefi_out_flush');
    a.label('uefi_out_space');
    a.call('out_space');
    a.label('uefi_out_flush');
    a.call('out_flush');
    a.label('uefi_out_done');
    a.pop(REG.RBX);
    a.pop(REG.RBP);
    a.pop(REG.R15);
    a.pop(REG.R14);
    a.pop(REG.R13);
    a.pop(REG.R12);
    a.ret();
    a.label('uefi_out_exit');
    a.call('uefi_shutdown');
    a.jmp('uefi_out_done');
  } else {
  a.mov(REG.R11, REG.RAX);          // value
  a.mov(REG.R10, REG.RDX);          // kind
  emitEnqueue(a, heapBase, OUT_QUEUE, {
    fields: [REG.R11, REG.R10],
    tmpA: REG.R8,
    tmpB: REG.R9,
  }, 'enq_out', SINGLE_CORE);
  a.ret();
  }

  // --------------------------------------------------------- console_emit
  // RAX = value, RDX = kind. Routes the entry to fd 2 when the current
  // console method is .error or .warn (RBP = 1), otherwise fd 1.
  a.label('console_emit');
  // Arrays are mutable heap objects but output is asynchronous: snapshot the
  // value now so console.log shows the state at call time.
  a.mov(REG.RCX, REG.RAX);
  a.shrImm8(REG.RCX, 56);
  a.cmpImm32(REG.RCX, 0xfb);
  a.jcc(COND.NE, 'ce_not_array');
  a.push(REG.RDX);                // preserve output kind
  a.call('array_snapshot');
  a.pop(REG.RDX);
  a.label('ce_not_array');
  a.load64(REG.RCX, REG.RBP, STATE_CONSOLE_FD);
  a.test(REG.RCX, REG.RCX);
  a.jcc(COND.Z, 'ce_stdout');
  a.addImm32(REG.RDX, OUT_KIND_ERR);
  a.label('ce_stdout');
  a.jmp('enqueue_output');

  // ----------------------------------------------------------- out_flush
  // Write the worker's line buffer to stdout. Clobbers RAX, RCX, RDX, RSI,
  // RDI, R11; preserves R8-R10 and R12-R15.
  a.label('out_flush');
  a.test(REG.R15, REG.R15);
  a.jcc(COND.Z, 'of_done');
  if (UEFI) {
    // Convert the byte line buffer to UTF-16 and hand it to ConOut.
    a.push(REG.R8);
    a.push(REG.R9);
    a.push(REG.R10);
    a.mov(REG.R8, REG.R13);                   // source bytes
    a.mov(REG.R9, REG.R15);                   // byte count
    a.movImm64(REG.R10, '0x' + (heapBase + OUT_U16).toString(16));
    a.label('of_conv');
    a.test(REG.R9, REG.R9);
    a.jcc(COND.Z, 'of_conv_done');
    a.load8(REG.RAX, REG.R8, 0);
    a.store16(REG.R10, REG.RAX, 0);
    a.inc(REG.R8);
    a.addImm32(REG.R10, 2);
    a.dec(REG.R9);
    a.jmp('of_conv');
    a.label('of_conv_done');
    a.xor(REG.RAX, REG.RAX);
    a.store16(REG.R10, REG.RAX, 0);
    a.movImm64(REG.R11, '0x' + (heapBase + DISPATCH_STATE).toString(16));
    a.load64(REG.RCX, REG.R11, STATE_CON_OUT);
    a.movImm64(REG.RDX, '0x' + (heapBase + OUT_U16).toString(16));
    a.load64(REG.RAX, REG.RCX, 8);            // OutputString
    a.call('uefi_call');
    a.pop(REG.R10);
    a.pop(REG.R9);
    a.pop(REG.R8);
  } else {
    a.mov(REG.RSI, REG.R13);
    a.mov(REG.RDX, REG.R15);
    a.movImm32(REG.RAX, 1);
    a.mov(REG.RDI, REG.RBP);          // fd 1 or 2, set by the worker
    a.syscall();
  }
  a.xor(REG.R15, REG.R15);
  a.label('of_done');
  a.ret();

  // ----------------------------------------------------------- out_write
  // RSI = bytes, RDX = length. Append to the line buffer, flushing whenever
  // it fills. Clobbers RAX, RCX, R8-R10; preserves R12-R15.
  a.label('out_write');
  a.mov(REG.R8, REG.RSI);
  a.mov(REG.R9, REG.RDX);
  a.label('outw_copy');
  a.test(REG.R9, REG.R9);
  a.jcc(COND.Z, 'outw_done');
  a.cmpImm32(REG.R15, OUT_BUF_CAP);
  a.jcc(COND.B, 'outw_space');
  a.call('out_flush');
  a.label('outw_space');
  a.mov(REG.RCX, REG.R13);
  a.add(REG.RCX, REG.R15);
  a.load8(REG.RAX, REG.R8, 0);
  a.store8(REG.RCX, REG.RAX, 0);
  a.inc(REG.R8);
  a.inc(REG.R15);
  a.dec(REG.R9);
  a.jmp('outw_copy');
  a.label('outw_done');
  a.ret();

  // --------------------------------------------------------- out_newline
  // Append a newline and flush: line-buffered like a TTY, so interactive
  // scripts still see output before the program exits.
  a.label('out_newline');
  a.cmpImm32(REG.R15, OUT_BUF_CAP);
  a.jcc(COND.B, 'on_space');
  a.call('out_flush');
  a.label('on_space');
  if (UEFI) {
    a.cmpImm32(REG.R15, OUT_BUF_CAP - 1);
    a.jcc(COND.B, 'on_cr');
    a.call('out_flush');
    a.label('on_cr');
    a.mov(REG.RCX, REG.R13);
    a.add(REG.RCX, REG.R15);
    a.movImm32(REG.RAX, 13);
    a.store8(REG.RCX, REG.RAX, 0);
    a.inc(REG.R15);
  }
  a.mov(REG.RCX, REG.R13);
  a.add(REG.RCX, REG.R15);
  a.movImm32(REG.RAX, 10);
  a.store8(REG.RCX, REG.RAX, 0);
  a.inc(REG.R15);
  a.ret();

  // ----------------------------------------------------------- out_space
  // Append a single space, flushing if the line buffer is full.
  a.label('out_space');
  a.cmpImm32(REG.R15, OUT_BUF_CAP);
  a.jcc(COND.B, 'os_space');
  a.call('out_flush');
  a.label('os_space');
  a.mov(REG.RCX, REG.R13);
  a.add(REG.RCX, REG.R15);
  a.movImm32(REG.RAX, 32);
  a.store8(REG.RCX, REG.RAX, 0);
  a.inc(REG.R15);
  a.ret();

  // --------------------------------------------------------- output_worker
  // Runs on CPU 8. Drains the dispatcher's queue, formats values, and writes
  // whole lines. R12 = tail, R13 = line buffer, R14 = inline scratch,
  // R15 = buffered length.
  a.label('output_worker');
  emitPinCpu(a, CPU_OUTPUT);
  a.movImm64(REG.R13, '0x' + (heapBase + OUT_BUF).toString(16));
  a.movImm64(REG.R14, '0x' + (heapBase + OUT_SCRATCH).toString(16));
  a.movImm32(REG.RBP, 1);           // current target fd (1 = stdout)
  a.xor(REG.R15, REG.R15);
  a.xor(REG.R12, REG.R12);

  a.label('ow_loop');
  a.movImm64(REG.R9, '0x' + (heapBase + OUT_QUEUE.head).toString(16));
  a.load64(REG.R9, REG.R9, 0);      // head
  a.cmp(REG.R9, REG.R12);
  a.jcc(COND.E, 'ow_spin');

  a.mov(REG.R10, REG.R12);
  a.andImm32(REG.R10, OUT_QUEUE.mask);
  a.shlImm8(REG.R10, 4);
  a.movImm64(REG.R11, '0x' + (heapBase + OUT_QUEUE.slots).toString(16));
  a.add(REG.R10, REG.R11);
  a.load64(REG.R8, REG.R10, 0);     // value
  a.load64(REG.R9, REG.R10, 8);     // kind

  // Stderr kinds are the stdout kind + OUT_KIND_ERR. Flush the current buffer
  // before switching targets so stdout/stderr ordering is preserved.
  a.movImm32(REG.R10, 1);
  a.cmpImm32(REG.R9, OUT_KIND_ERR);
  a.jcc(COND.B, 'ow_kind_stdout');
  a.subImm32(REG.R9, OUT_KIND_ERR);
  a.movImm32(REG.R10, 2);
  a.label('ow_kind_stdout');
  a.cmp(REG.R10, REG.RBP);
  a.jcc(COND.E, 'ow_kind_ready');
  a.call('out_flush');
  a.mov(REG.RBP, REG.R10);
  a.label('ow_kind_ready');
  a.mov(REG.RAX, REG.R8);
  a.mov(REG.RDX, REG.R9);

  a.cmpImm32(REG.RDX, OUT_KIND_EXIT);
  a.jcc(COND.E, 'ow_exit');
  a.cmpImm32(REG.RDX, OUT_KIND_NL);
  a.jcc(COND.E, 'ow_newline');
  a.cmpImm32(REG.RDX, OUT_KIND_SPACE);
  a.jcc(COND.E, 'ow_space');
  a.cmpImm32(REG.RDX, OUT_KIND_RAW);
  a.jcc(COND.E, 'ow_raw');
  a.call('print_value');
  a.call('out_newline');
  a.jmp('ow_advance');

  a.label('ow_raw');
  a.call('print_value');
  a.jmp('ow_advance');

  a.label('ow_space');
  a.call('out_space');
  a.jmp('ow_advance');

  a.label('ow_newline');
  a.call('out_newline');

  a.label('ow_advance');
  a.inc(REG.R12);
  a.movImm64(REG.R9, '0x' + (heapBase + OUT_QUEUE.tail).toString(16));
  a.store64(REG.R9, REG.R12, 0);
  a.jmp('ow_loop');

  a.label('ow_spin');
  // Queue is empty: the burst is over, so flush now. This keeps interactive
  // scripts prompt while letting fast scripts batch thousands of lines into a
  // handful of write syscalls.
  a.call('out_flush');
  emitIdle(a, SINGLE_CORE);
  a.jmp('ow_loop');

  a.label('ow_exit');
  a.call('out_flush');
  a.movImm64(REG.RCX, '0x' + (heapBase + OUT_DONE).toString(16));
  a.movImm32(REG.RDX, 1);
  a.store8(REG.RCX, REG.RDX, 0);
  a.movImm32(REG.RAX, 60);          // exit this thread only
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  // ----------------------------------------------------------- input_worker
  // Runs on CPU 2. Reads the script into the shared input buffer and publishes
  // a monotonic safe offset (just past the last '\n' or ';'), so the
  // dispatcher can parse while the rest of the file is still arriving.
  // RBP = raw bytes read, R12 = buffer base, R13 = fd.
  a.label('input_worker');
  emitPinCpu(a, CPU_INPUT);
  a.xor(REG.RBP, REG.RBP);
  a.movImm64(REG.R12, HEAP_BASE_STR);
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_FD).toString(16));
  a.load64(REG.R13, REG.RCX, 0);

  a.label('iw_loop');
  a.movImm32(REG.RDX, INPUT_CAP);
  a.sub(REG.RDX, REG.RBP);          // room left in the buffer
  a.test(REG.RDX, REG.RDX);
  a.jcc(COND.Z, 'iw_eof');
  a.mov(REG.RSI, REG.R12);
  a.add(REG.RSI, REG.RBP);
  a.mov(REG.RDI, REG.R13);          // fd
  a.xor(REG.RAX, REG.RAX);          // read
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.LE, 'iw_eof');
  a.add(REG.RBP, REG.RAX);

  // Scan back to the last statement boundary and publish up to it.
  a.mov(REG.R8, REG.RBP);
  a.label('iw_scan');
  a.test(REG.R8, REG.R8);
  a.jcc(COND.Z, 'iw_scan_none');
  a.mov(REG.RCX, REG.R8);
  a.dec(REG.RCX);
  a.load8Indexed(REG.R9, REG.R12, REG.RCX);
  a.cmpImm8(REG.R9, 10);            // '\n'
  a.jcc(COND.E, 'iw_safe');
  a.cmpImm8(REG.R9, 59);            // ';'
  a.jcc(COND.E, 'iw_safe');
  a.dec(REG.R8);
  a.jmp('iw_scan');

  a.label('iw_safe');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
  a.store64(REG.RCX, REG.R8, 0);
  a.jmp('iw_loop');

  a.label('iw_scan_none');
  // No boundary yet. If the buffer is full, publish everything so a single
  // enormous line still makes progress.
  a.cmpImm32(REG.RBP, INPUT_CAP);
  a.jcc(COND.B, 'iw_loop');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
  a.store64(REG.RCX, REG.RBP, 0);
  a.jmp('iw_loop');

  a.label('iw_eof');
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
  a.store64(REG.RCX, REG.RBP, 0);   // publish the tail (no trailing newline)
  a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
  a.movImm32(REG.RAX, 1);
  a.store8(REG.RCX, REG.RAX, 0);
  a.movImm32(REG.RAX, 60);          // exit this thread only
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  // ----------------------------------------------------------- file_worker
  // Runs on CPU 4. Drains file requests in FIFO order, so a read enqueued
  // after a write observes that write. RBP = tail, R12 = result allocator,
  // R13 = materialize scratch, R15 = request sequence.
  a.label('file_worker');
  emitPinCpu(a, CPU_FILE);
  a.movImm64(REG.R12, '0x' + (heapBase + FILE_HEAP).toString(16));
  a.movImm64(REG.R13, '0x' + (heapBase + FILE_SCRATCH).toString(16));
  a.xor(REG.RBP, REG.RBP);          // tail

  a.label('fw_loop');
  a.movImm64(REG.R9, '0x' + (heapBase + FILE_QUEUE.head).toString(16));
  a.load64(REG.R9, REG.R9, 0);      // head
  a.cmp(REG.R9, REG.RBP);
  a.jcc(COND.E, 'fw_spin');

  a.mov(REG.R10, REG.RBP);
  a.andImm32(REG.R10, FILE_QUEUE.mask);
  a.shlImm8(REG.R10, 5);            // 32-byte entries
  a.movImm64(REG.R11, '0x' + (heapBase + FILE_QUEUE.slots).toString(16));
  a.add(REG.R10, REG.R11);
  a.load64(REG.R11, REG.R10, 0);    // op
  a.load64(REG.R15, REG.R10, 24);   // seq

  a.cmpImm32(REG.R11, FILE_OP_EXIT);
  a.jcc(COND.E, 'fw_exit');
  a.cmpImm32(REG.R11, FILE_OP_WRITE);
  a.jcc(COND.E, 'fw_write');
  a.cmpImm32(REG.R11, FILE_OP_EXISTS);
  a.jcc(COND.E, 'fw_exists');

  // ---- readFileSync ---------------------------------------------------
  a.label('fw_read');
  a.load64(REG.RAX, REG.R10, 8);    // path value
  a.mov(REG.R14, REG.R13);
  a.call('materialize_string');     // RAX = path, RDX = length
  a.mov(REG.R14, REG.R12);          // result allocator
  a.mov(REG.RDI, REG.RAX);
  a.xor(REG.RSI, REG.RSI);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, 2);           // open O_RDONLY
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'fw_read_fail');
  a.mov(REG.RDI, REG.RAX);          // fd
  a.mov(REG.RSI, REG.R14);
  a.addImm32(REG.RSI, 8);
  a.xor(REG.RAX, REG.RAX);          // read
  a.movImm32(REG.RDX, READ_CAP);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'fw_read_close_fail');

  a.store64(REG.R14, REG.RAX, 0);   // object length
  a.mov(REG.R8, REG.R14);           // object pointer
  a.mov(REG.RCX, REG.R14);
  a.addImm32(REG.RCX, 8);
  a.add(REG.RCX, REG.RAX);          // end of data
  a.xor(REG.RDX, REG.RDX);
  a.store8(REG.RCX, REG.RDX, 0);    // NUL-terminate
  a.addImm32(REG.RAX, 9);
  a.add(REG.R14, REG.RAX);          // advance the result heap
  a.mov(REG.R12, REG.R14);
  a.movImm32(REG.RAX, 3);           // close
  a.syscall();
  a.mov(REG.RAX, REG.R8);
  a.movImm64(REG.RCX, TAG_BUFFER_STR);
  a.or(REG.RAX, REG.RCX);
  a.jmp('fw_complete');

  a.label('fw_read_close_fail');
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.label('fw_read_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fw_complete');

  // ---- writeFileSync --------------------------------------------------
  a.label('fw_write');
  a.load64(REG.RAX, REG.R10, 8);    // path value
  a.mov(REG.R14, REG.R13);
  a.call('materialize_string');
  a.mov(REG.R14, REG.R12);
  a.mov(REG.RDI, REG.RAX);
  a.movImm32(REG.RSI, 577);         // O_WRONLY|O_CREAT|O_TRUNC
  a.movImm32(REG.RDX, 420);         // 0644
  a.movImm32(REG.RAX, 2);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'fw_advance');
  a.mov(REG.RDI, REG.RAX);          // fd
  a.load64(REG.RAX, REG.R10, 16);   // data value
  a.mov(REG.R14, REG.R13);
  a.call('materialize_string');     // RAX = data, RDX = length
  a.mov(REG.R14, REG.R12);
  a.mov(REG.RSI, REG.RAX);
  a.movImm32(REG.RAX, 1);           // write
  a.syscall();
  a.movImm32(REG.RAX, 3);           // close
  a.syscall();
  a.jmp('fw_advance');

  // ---- existsSync -----------------------------------------------------
  a.label('fw_exists');
  a.load64(REG.RAX, REG.R10, 8);    // path value
  a.mov(REG.R14, REG.R13);
  a.call('materialize_string');
  a.mov(REG.R14, REG.R12);
  a.mov(REG.RDI, REG.RAX);
  a.xor(REG.RSI, REG.RSI);
  a.xor(REG.RDX, REG.RDX);
  a.movImm32(REG.RAX, 2);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'fw_exists_no');
  a.mov(REG.RDI, REG.RAX);
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.movImm32(REG.RAX, 1);
  a.jmp('fw_complete');
  a.label('fw_exists_no');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('fw_complete');

  // ---- completion / advance ------------------------------------------
  a.label('fw_complete');
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_COMPLETION_VALUE).toString(16));
  a.store64(REG.RCX, REG.RAX, 0);
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_COMPLETION_SEQ).toString(16));
  a.store64(REG.RCX, REG.R15, 0);   // publish after the value

  a.label('fw_advance');
  a.inc(REG.RBP);
  a.movImm64(REG.R9, '0x' + (heapBase + FILE_QUEUE.tail).toString(16));
  a.store64(REG.R9, REG.RBP, 0);
  a.jmp('fw_loop');

  a.label('fw_spin');
  emitIdle(a, SINGLE_CORE);
  a.jmp('fw_loop');

  a.label('fw_exit');
  a.xor(REG.RAX, REG.RAX);
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_COMPLETION_VALUE).toString(16));
  a.store64(REG.RCX, REG.RAX, 0);
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_COMPLETION_SEQ).toString(16));
  a.store64(REG.RCX, REG.R15, 0);
  a.movImm64(REG.RCX, '0x' + (heapBase + FILE_DONE).toString(16));
  a.movImm32(REG.RDX, 1);
  a.store8(REG.RCX, REG.RDX, 0);
  a.movImm32(REG.RAX, 60);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  // ------------------------------------------------------------ net_worker
  // Runs on CPU 6. FIFO network requests: connect/read block the dispatcher,
  // write/close are fire-and-forget. RBP = tail, R12 = result allocator,
  // R13 = scratch, R15 = request sequence.
  a.label('net_worker');
  emitPinCpu(a, CPU_NET);
  a.movImm64(REG.R12, '0x' + (heapBase + NET_HEAP).toString(16));
  a.movImm64(REG.R13, '0x' + (heapBase + NET_SCRATCH).toString(16));
  a.xor(REG.RBP, REG.RBP);          // tail

  a.label('nw_loop');
  a.movImm64(REG.R9, '0x' + (heapBase + NET_QUEUE.head).toString(16));
  a.load64(REG.R9, REG.R9, 0);      // head
  a.cmp(REG.R9, REG.RBP);
  a.jcc(COND.E, 'nw_spin');

  a.mov(REG.R10, REG.RBP);
  a.andImm32(REG.R10, NET_QUEUE.mask);
  a.shlImm8(REG.R10, 5);            // 32-byte entries
  a.movImm64(REG.R11, '0x' + (heapBase + NET_QUEUE.slots).toString(16));
  a.add(REG.R10, REG.R11);
  a.load64(REG.R11, REG.R10, 0);    // op
  a.load64(REG.R15, REG.R10, 24);   // seq

  a.cmpImm32(REG.R11, NET_OP_EXIT);
  a.jcc(COND.E, 'nw_exit');
  a.cmpImm32(REG.R11, NET_OP_WRITE);
  a.jcc(COND.E, 'nw_write');
  a.cmpImm32(REG.R11, NET_OP_READ);
  a.jcc(COND.E, 'nw_read');
  a.cmpImm32(REG.R11, NET_OP_CLOSE);
  a.jcc(COND.E, 'nw_close');
  a.cmpImm32(REG.R11, NET_OP_FETCH);
  a.jcc(COND.E, 'nw_fetch');

  // ---- connect --------------------------------------------------------
  a.label('nw_connect');
  a.load64(REG.RBX, REG.R10, 8);    // port
  a.load64(REG.RAX, REG.R10, 16);   // host value
  a.mov(REG.R14, REG.R13);
  a.call('materialize_string');     // RAX = host bytes
  a.mov(REG.R14, REG.R12);
  a.mov(REG.R9, REG.RAX);           // host cursor

  // sockaddr_in at scratch + 64
  a.mov(REG.RSI, REG.R13);
  a.addImm32(REG.RSI, 64);
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RSI, REG.RAX, 0);
  a.store64(REG.RSI, REG.RAX, 8);
  a.movImm32(REG.RAX, 2);           // AF_INET
  a.store8(REG.RSI, REG.RAX, 0);
  a.mov(REG.RCX, REG.RBX);
  a.shrImm8(REG.RCX, 8);
  a.store8(REG.RSI, REG.RCX, 2);    // port high byte
  a.mov(REG.RCX, REG.RBX);
  a.andImm32(REG.RCX, 0xff);
  a.store8(REG.RSI, REG.RCX, 3);    // port low byte

  a.xor(REG.R10, REG.R10);          // octet index
  a.xor(REG.RDX, REG.RDX);          // current octet
  a.label('nw_quad_loop');
  a.load8(REG.RCX, REG.R9, 0);
  a.cmpImm8(REG.RCX, 0);
  a.jcc(COND.E, 'nw_quad_last');
  a.cmpImm8(REG.RCX, 46);  // '.'
  a.jcc(COND.E, 'nw_quad_store');
  a.movImm32(REG.RAX, 10);
  a.imul(REG.RDX, REG.RAX);
  a.subImm32(REG.RCX, 48);
  a.add(REG.RDX, REG.RCX);
  a.inc(REG.R9);
  a.jmp('nw_quad_loop');

  a.label('nw_quad_store');
  a.mov(REG.RAX, REG.RSI);
  a.addImm32(REG.RAX, 4);
  a.add(REG.RAX, REG.R10);
  a.store8(REG.RAX, REG.RDX, 0);
  a.inc(REG.R10);
  a.xor(REG.RDX, REG.RDX);
  a.inc(REG.R9);
  a.jmp('nw_quad_loop');

  a.label('nw_quad_last');
  a.mov(REG.RAX, REG.RSI);
  a.addImm32(REG.RAX, 4);
  a.add(REG.RAX, REG.R10);
  a.store8(REG.RAX, REG.RDX, 0);

  a.mov(REG.R9, REG.RSI);           // sockaddr survives socket()
  a.movImm32(REG.RAX, 41);          // socket
  a.movImm32(REG.RDI, 2);
  a.movImm32(REG.RSI, 1);
  a.xor(REG.RDX, REG.RDX);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nw_connect_fail');
  a.mov(REG.RDI, REG.RAX);          // fd
  a.movImm32(REG.RAX, 42);          // connect
  a.mov(REG.RSI, REG.R9);
  a.movImm32(REG.RDX, 16);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nw_connect_close_fail');
  a.mov(REG.RAX, REG.RDI);
  a.movImm64(REG.RCX, TAG_SOCKET_STR);
  a.or(REG.RAX, REG.RCX);
  a.jmp('nw_complete');

  a.label('nw_connect_close_fail');
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.label('nw_connect_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('nw_complete');

  // ---- write ----------------------------------------------------------
  a.label('nw_write');
  a.load64(REG.RAX, REG.R10, 16);   // data value
  a.mov(REG.R14, REG.R13);
  a.call('materialize_string');     // RAX = data, RDX = length
  a.mov(REG.R14, REG.R12);
  a.mov(REG.RSI, REG.RAX);
  a.load64(REG.RDI, REG.R10, 8);    // fd
  a.movImm32(REG.RAX, 1);
  a.syscall();
  a.jmp('nw_advance');

  // ---- read -----------------------------------------------------------
  a.label('nw_read');
  a.load64(REG.RDI, REG.R10, 8);    // fd
  a.mov(REG.RSI, REG.R12);
  a.addImm32(REG.RSI, 8);
  a.xor(REG.RAX, REG.RAX);
  a.movImm32(REG.RDX, READ_CAP);
  a.syscall();
  a.cmpImm32(REG.RAX, 0);
  a.jcc(COND.L, 'nw_read_fail');
  a.store64(REG.R12, REG.RAX, 0);
  a.mov(REG.R8, REG.R12);
  a.mov(REG.RCX, REG.R12);
  a.addImm32(REG.RCX, 8);
  a.add(REG.RCX, REG.RAX);
  a.xor(REG.RDX, REG.RDX);
  a.store8(REG.RCX, REG.RDX, 0);
  a.addImm32(REG.RAX, 9);
  a.add(REG.R12, REG.RAX);
  a.mov(REG.RAX, REG.R8);
  a.movImm64(REG.RCX, TAG_BUFFER_STR);
  a.or(REG.RAX, REG.RCX);
  a.jmp('nw_complete');
  a.label('nw_read_fail');
  a.xor(REG.RAX, REG.RAX);
  a.jmp('nw_complete');

  // ---- close ----------------------------------------------------------
  a.label('nw_close');
  a.load64(REG.RDI, REG.R10, 8);
  a.movImm32(REG.RAX, 3);
  a.syscall();
  a.jmp('nw_advance');

  // ---- fetch ----------------------------------------------------------
  emitNetFetch(a, heapBase);

  // ---- completion / advance ------------------------------------------
  a.label('nw_complete');
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_COMPLETION_VALUE).toString(16));
  a.store64(REG.RCX, REG.RAX, 0);
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_COMPLETION_SEQ).toString(16));
  a.store64(REG.RCX, REG.R15, 0);   // publish after the value

  a.label('nw_advance');
  a.inc(REG.RBP);
  a.movImm64(REG.R9, '0x' + (heapBase + NET_QUEUE.tail).toString(16));
  a.store64(REG.R9, REG.RBP, 0);
  a.jmp('nw_loop');

  a.label('nw_spin');
  emitIdle(a, SINGLE_CORE);
  a.jmp('nw_loop');

  a.label('nw_exit');
  a.xor(REG.RAX, REG.RAX);
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_COMPLETION_VALUE).toString(16));
  a.store64(REG.RCX, REG.RAX, 0);
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_COMPLETION_SEQ).toString(16));
  a.store64(REG.RCX, REG.R15, 0);
  a.movImm64(REG.RCX, '0x' + (heapBase + NET_DONE).toString(16));
  a.movImm32(REG.RDX, 1);
  a.store8(REG.RCX, REG.RDX, 0);
  a.movImm32(REG.RAX, 60);
  a.xor(REG.RDI, REG.RDI);
  a.syscall();

  // --------------------------------------------------------- compute_worker
  // Runs on CPU 10. Waits for a request sequence, binds the snapshot
  // dependency set and the arguments into its own ring, then replays the
  // function body with the shared interpreter. A type-3 control frame makes
  // `return` and the closing '}' publish the value and go back to waiting.
  a.label('compute_worker');
  emitPinCpu(a, CPU_COMPUTE);
  a.movImm64(REG.RBP, '0x' + (heapBase + WORKER_STATE).toString(16));
  a.movImm64(REG.R14, '0x' + (heapBase + COMP_HEAP).toString(16));
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBP, REG.RAX, STATE_CONTROL_DEPTH);
  a.store64(REG.RBP, REG.RAX, STATE_FUNC_DEPTH);
  a.store64(REG.RBP, REG.RAX, STATE_FUNC_RETVAL);
  a.store64(REG.RBP, REG.RAX, STATE_CONSOLE_FD);
  a.store64(REG.RBP, REG.RAX, STATE_REMOTE_OK); // nested calls stay local

  a.label('cw_loop');
  a.movImm64(REG.R8, '0x' + (heapBase + COMP_REQ_SEQ).toString(16));
  a.load64(REG.R9, REG.R8, 0);
  a.movImm64(REG.R8, '0x' + (heapBase + COMP_RESP_SEQ).toString(16));
  a.load64(REG.R10, REG.R8, 0);
  a.cmp(REG.R9, REG.R10);
  a.jcc(COND.NE, 'cw_work');
  emitIdle(a, SINGLE_CORE);
  a.jmp('cw_loop');

  a.label('cw_work');
  a.movImm64(REG.R11, '0x' + (heapBase + COMP_REQ).toString(16));
  a.load64(REG.RBX, REG.R11, REQ_ENTRY);
  a.load64(REG.R12, REG.RBX, 8);              // body start
  a.load64(REG.R13, REG.R11, REQ_BODY_END);

  // Bind the snapshot dependencies first, so parameters can shadow them.
  a.load64(REG.R8, REG.R11, REQ_DEPC);
  a.xor(REG.R15, REG.R15);
  a.label('cw_dep_loop');
  a.cmp(REG.R15, REG.R8);
  a.jcc(COND.GE, 'cw_dep_done');
  a.movImm64(REG.RCX, '0x' + (heapBase + COMP_REQ_DEP_SLOTS).toString(16));
  a.add(REG.RCX, REG.R15);
  a.load8(REG.RCX, REG.RCX, 0);
  a.mov(REG.RDX, REG.R15);
  a.shlImm8(REG.RDX, 3);
  a.movImm64(REG.R10, '0x' + (heapBase + COMP_REQ_DEP_VALUES).toString(16));
  a.add(REG.R10, REG.RDX);
  a.load64(REG.RAX, REG.R10, 0);
  a.call('store_slot');
  a.inc(REG.R15);
  a.jmp('cw_dep_loop');
  a.label('cw_dep_done');

  // Push the arguments and reuse the dispatcher's binding logic.
  a.load64(REG.R15, REG.R11, REQ_ARGC);
  a.xor(REG.R9, REG.R9);
  a.label('cw_arg_loop');
  a.cmp(REG.R9, REG.R15);
  a.jcc(COND.GE, 'cw_arg_done');
  a.mov(REG.RDX, REG.R9);
  a.shlImm8(REG.RDX, 3);
  a.movImm64(REG.R10, '0x' + (heapBase + COMP_REQ_ARGS).toString(16));
  a.add(REG.R10, REG.RDX);
  a.load64(REG.RAX, REG.R10, 0);
  a.push(REG.RAX);
  a.inc(REG.R9);
  a.jmp('cw_arg_loop');
  a.label('cw_arg_done');
  a.call('bind_args');

  a.movImm32(REG.R8, 3);          // type 3: remote function boundary
  a.xor(REG.RCX, REG.RCX);
  a.xor(REG.RDX, REG.RDX);
  a.call('push_control');
  a.jmp('main_loop');

  // RAX = remote return value. Publish it, then the response sequence.
  a.label('remote_return');
  a.movImm64(REG.R8, '0x' + (heapBase + COMP_RESP_VALUE).toString(16));
  a.store64(REG.R8, REG.RAX, 0);
  a.movImm64(REG.R9, '0x' + (heapBase + COMP_REQ_SEQ).toString(16));
  a.load64(REG.R10, REG.R9, 0);
  a.movImm64(REG.R9, '0x' + (heapBase + COMP_RESP_SEQ).toString(16));
  a.store64(REG.R9, REG.R10, 0);
  // A malformed body must not poison the next request.
  a.xor(REG.RAX, REG.RAX);
  a.store64(REG.RBP, REG.RAX, STATE_CONTROL_DEPTH);
  a.store64(REG.RBP, REG.RAX, STATE_FUNC_DEPTH);
  a.jmp('cw_loop');

  // -------------------------------------------------------- UEFI script load
  // Uses LoadedImage -> DeviceHandle -> SimpleFileSystem, then reads the
  // script named by LoadOptions (or \script.kz) into the input buffer at the
  // bss base. Returns R12 = buffer start, R13 = end, R14 = heap start.
  if (UEFI) {
    a.label('load_script_uefi');
    // LoadedImage protocol on the image handle.
    a.load64(REG.RCX, REG.RBP, STATE_IMAGE_HANDLE);
    a.leaRip(REG.RDX, 'guid_loaded_image');
    a.movImm64(REG.R8, '0x' + (heapBase + STATE_LOADED_IMAGE).toString(16));
    a.load64(REG.RAX, REG.RBP, STATE_BOOT_SERVICES);
    a.load64(REG.RAX, REG.RAX, 152);        // HandleProtocol
    a.call('uefi_call');
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, 'ls_fail');

    // SimpleFileSystem on the loaded image's device handle.
    a.load64(REG.RCX, REG.RBP, STATE_LOADED_IMAGE);
    a.load64(REG.RCX, REG.RCX, 24);         // DeviceHandle
    a.leaRip(REG.RDX, 'guid_simple_fs');
    a.movImm64(REG.R8, '0x' + (heapBase + STATE_SFS).toString(16));
    a.load64(REG.RAX, REG.RBP, STATE_BOOT_SERVICES);
    a.load64(REG.RAX, REG.RAX, 152);
    a.call('uefi_call');
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, 'ls_fail');

    // OpenVolume -> root directory.
    a.load64(REG.RCX, REG.RBP, STATE_SFS);
    a.movImm64(REG.RDX, '0x' + (heapBase + STATE_ROOT_DIR).toString(16));
    a.load64(REG.RAX, REG.RCX, 8);
    a.call('uefi_call');
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, 'ls_fail');

    a.call('uefi_build_script_path');

    // root->Open(root, &file, path, EFI_FILE_MODE_READ, 0)
    a.load64(REG.RCX, REG.RBP, STATE_ROOT_DIR);
    a.movImm64(REG.RDX, '0x' + (heapBase + STATE_SCRIPT_FILE).toString(16));
    a.movImm64(REG.R8, '0x' + (heapBase + SCRIPT_PATH).toString(16));
    a.movImm32(REG.R9, 1);                  // EFI_FILE_MODE_READ
    a.xor(REG.R10, REG.R10);
    a.load64(REG.RAX, REG.RCX, 8);
    a.call('uefi_call5');
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, 'ls_fail');

    // Read up to INPUT_CAP-1 bytes in one shot; the runtime caps input anyway.
    a.movImm64(REG.R12, HEAP_BASE_STR);
    a.subImm32(REG.RSP, 16);
    a.movImm32(REG.RAX, INPUT_CAP - 1);
    a.store64(REG.RSP, REG.RAX, 0);
    a.load64(REG.RCX, REG.RBP, STATE_SCRIPT_FILE);
    a.mov(REG.RDX, REG.RSP);
    a.mov(REG.R8, REG.R12);
    a.load64(REG.RAX, REG.RCX, 32);         // Read
    a.call('uefi_call');
    a.load64(REG.R13, REG.RSP, 0);          // bytes read
    a.addImm32(REG.RSP, 16);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.NZ, 'ls_close_fail');
    a.mov(REG.R15, REG.R13);                // preserve across Close

    // Close the file.
    a.load64(REG.RCX, REG.RBP, STATE_SCRIPT_FILE);
    a.load64(REG.RAX, REG.RCX, 16);
    a.call('uefi_call');

    a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
    a.store64(REG.RCX, REG.R15, 0);
    a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
    a.movImm32(REG.RDX, 1);
    a.store8(REG.RCX, REG.RDX, 0);
    a.movImm64(REG.R12, HEAP_BASE_STR);
    a.mov(REG.R13, REG.R12);
    a.add(REG.R13, REG.R15);
    a.movImm64(REG.R14, HEAP_BASE_STR);
    a.addImm32(REG.R14, INPUT_CAP);
    a.ret();

    a.label('ls_close_fail');
    a.load64(REG.RCX, REG.RBP, STATE_SCRIPT_FILE);
    a.load64(REG.RAX, REG.RCX, 16);
    a.call('uefi_call');
    a.jmp('ls_fail');

    a.label('ls_fail');
    // No script: present an empty program rather than hanging.
    a.movImm64(REG.RCX, '0x' + (heapBase + IN_READY).toString(16));
    a.xor(REG.RDX, REG.RDX);
    a.store64(REG.RCX, REG.RDX, 0);
    a.movImm64(REG.RCX, '0x' + (heapBase + IN_EOF).toString(16));
    a.movImm32(REG.RDX, 1);
    a.store8(REG.RCX, REG.RDX, 0);
    a.movImm64(REG.R12, HEAP_BASE_STR);
    a.mov(REG.R13, REG.R12);
    a.movImm64(REG.R14, HEAP_BASE_STR);
    a.ret();

    // Parse the second token of LoadOptions into SCRIPT_PATH as UTF-16.
    a.label('uefi_build_script_path');
    a.movImm64(REG.R10, '0x' + (heapBase + SCRIPT_PATH).toString(16));
    a.load64(REG.R8, REG.RBP, STATE_LOADED_IMAGE);
    a.load64(REG.R8, REG.R8, 56);           // LoadOptions
    a.test(REG.R8, REG.R8);
    a.jcc(COND.Z, 'bsp_default');

    // Skip leading whitespace.
    a.label('bsp_lead');
    a.load16(REG.RAX, REG.R8, 0);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'bsp_default');
    a.cmpImm32(REG.RAX, 32);
    a.jcc(COND.A, 'bsp_skip_app');
    a.addImm32(REG.R8, 2);
    a.jmp('bsp_lead');

    // Skip the application name.
    a.label('bsp_skip_app');
    a.load16(REG.RAX, REG.R8, 0);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'bsp_default');
    a.cmpImm32(REG.RAX, 32);
    a.jcc(COND.BE, 'bsp_after_app');
    a.addImm32(REG.R8, 2);
    a.jmp('bsp_skip_app');

    // Skip whitespace before the script path.
    a.label('bsp_after_app');
    a.load16(REG.RAX, REG.R8, 0);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'bsp_default');
    a.cmpImm32(REG.RAX, 32);
    a.jcc(COND.A, 'bsp_strip_drive');
    a.addImm32(REG.R8, 2);
    a.jmp('bsp_after_app');

    // Strip a shell volume prefix such as "fs0:".
    a.label('bsp_strip_drive');
    a.load16(REG.RAX, REG.R8, 0);
    a.cmpImm32(REG.RAX, 0x66);              // 'f'
    a.jcc(COND.NE, 'bsp_copy');
    a.load16(REG.RAX, REG.R8, 2);
    a.cmpImm32(REG.RAX, 0x73);              // 's'
    a.jcc(COND.NE, 'bsp_copy');
    a.load16(REG.RAX, REG.R8, 4);
    a.cmpImm32(REG.RAX, 0x30);
    a.jcc(COND.L, 'bsp_copy');
    a.cmpImm32(REG.RAX, 0x39);
    a.jcc(COND.G, 'bsp_copy');
    a.load16(REG.RAX, REG.R8, 6);
    a.cmpImm32(REG.RAX, 0x3a);              // ':'
    a.jcc(COND.NE, 'bsp_copy');
    a.addImm32(REG.R8, 8);
    a.jmp('bsp_copy');

    a.label('bsp_copy');
    a.load16(REG.RAX, REG.R8, 0);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'bsp_done');
    a.cmpImm32(REG.RAX, 32);
    a.jcc(COND.BE, 'bsp_done');
    a.cmpImm32(REG.RAX, 0x2f);              // '/'
    a.jcc(COND.NE, 'bsp_store');
    a.movImm32(REG.RAX, 0x5c);              // '\'
    a.label('bsp_store');
    a.store16(REG.R10, REG.RAX, 0);
    a.addImm32(REG.R10, 2);
    a.addImm32(REG.R8, 2);
    a.jmp('bsp_copy');

    a.label('bsp_done');
    a.xor(REG.RAX, REG.RAX);
    a.store16(REG.R10, REG.RAX, 0);
    a.ret();

    a.label('bsp_default');
    a.leaRip(REG.R8, 'default_script_path');
    a.label('bsp_default_copy');
    a.load16(REG.RAX, REG.R8, 0);
    a.store16(REG.R10, REG.RAX, 0);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'bsp_default_done');
    a.addImm32(REG.R8, 2);
    a.addImm32(REG.R10, 2);
    a.jmp('bsp_default_copy');
    a.label('bsp_default_done');
    a.ret();
  }


  // Natural end of input. Pending timers still get a chance to run before the
  // program terminates.
  a.label('exit');
  a.xor(REG.R15, REG.R15);          // default status 0
  a.jmp('timer_loop');

  // process.exit(code): stop immediately, without running pending timers.
  a.label('exit_with_code');
  if (UEFI) {
    a.jmp('timer_finished');
  } else {
    a.jmp('exit_drain');
  }

  if (!UEFI) {
    // Linux fallback: a one-millisecond nanosleep drives the same software
    // clock the UEFI build advances with BootServices->Stall. This keeps timer
    // behaviour testable natively without changing callback semantics.
    a.label('linux_stall');
    a.subImm32(REG.RSP, 16);
    a.xor(REG.RAX, REG.RAX);
    a.store64(REG.RSP, REG.RAX, 0);       // tv_sec
    a.movImm64(REG.RAX, 1000000);
    a.store64(REG.RSP, REG.RAX, 8);       // tv_nsec
    a.mov(REG.RDI, REG.RSP);
    a.xor(REG.RSI, REG.RSI);              // rem = NULL
    a.movImm32(REG.RAX, 35);              // nanosleep
    a.syscall();
    a.addImm32(REG.RSP, 16);
    a.ret();
  }

  {
    // ------------------------------------------------------------ timer loop
    // Runs after the script reaches EOF. Timers are ordered only by scanning
    // the small table; delays use the software millisecond clock advanced by
    // the platform's sleep primitive. Intervals reschedule themselves and keep
    // running until cleared (or, on UEFI, the firmware is reset).
    a.label('timer_loop');
    a.movImm64(REG.R9, '0x' + (heapBase + TIMER_TABLE).toString(16));
    a.load64(REG.R10, REG.RBP, STATE_CLOCK_TICKS); // now (ms)
    a.xor(REG.R8, REG.R8);                         // entry index
    a.movImm32(REG.R11, TIMER_TABLE_CAP);
    a.label('tl_scan');
    a.cmp(REG.R8, REG.R11);
    a.jcc(COND.GE, 'tl_idle');
    // entry = table + index * 40
    a.mov(REG.RCX, REG.R8);
    a.shlImm8(REG.RCX, 5);           // index * 32
    a.mov(REG.RDX, REG.R8);
    a.shlImm8(REG.RDX, 3);           // index * 8
    a.add(REG.RCX, REG.RDX);
    a.add(REG.RCX, REG.R9);          // entry pointer
    a.load64(REG.RAX, REG.RCX, 8);   // kind
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'tl_next');
    a.load64(REG.RDX, REG.RCX, 16);  // due
    a.cmp(REG.RDX, REG.R10);
    a.jcc(COND.A, 'tl_next');        // due > now

    a.cmpImm32(REG.RAX, 2);
    a.jcc(COND.E, 'tl_interval');

    // One-shot timer: retire it before running the callback.
    a.xor(REG.RDX, REG.RDX);
    a.store64(REG.RCX, REG.RDX, 8);
    a.load64(REG.RAX, REG.RBP, STATE_TIMER_ACTIVE);
    a.dec(REG.RAX);
    a.store64(REG.RBP, REG.RAX, STATE_TIMER_ACTIVE);
    a.jmp('tl_run');

    a.label('tl_interval');
    // due += interval; if we fell behind, skip the missed ticks.
    a.load64(REG.RDX, REG.RCX, 16);
    a.load64(REG.RAX, REG.RCX, 24);
    a.add(REG.RDX, REG.RAX);
    a.store64(REG.RCX, REG.RDX, 16);
    a.cmp(REG.RDX, REG.R10);
    a.jcc(COND.A, 'tl_run');
    a.mov(REG.RDX, REG.R10);
    a.add(REG.RDX, REG.RAX);
    a.store64(REG.RCX, REG.RDX, 16);

    a.label('tl_run');
    a.load64(REG.RBX, REG.RCX, 32);  // callback registry entry
    a.test(REG.RBX, REG.RBX);
    a.jcc(COND.Z, 'timer_loop');
    a.leaRip(REG.R10, 'tl_after_cb');
    a.xor(REG.R15, REG.R15);         // no arguments
    a.jmp('invoke_function');
    a.label('tl_after_cb');
    a.jmp('timer_loop');

    a.label('tl_next');
    a.inc(REG.R8);
    a.jmp('tl_scan');

    a.label('tl_idle');
    a.load64(REG.RAX, REG.RBP, STATE_TIMER_ACTIVE);
    a.test(REG.RAX, REG.RAX);
    a.jcc(COND.Z, 'timer_finished');
    a.load64(REG.RAX, REG.RBP, STATE_CLOCK_TICKS);
    a.inc(REG.RAX);
    a.store64(REG.RBP, REG.RAX, STATE_CLOCK_TICKS);
    if (UEFI) {
      a.movImm32(REG.RAX, 1000);       // 1 ms
      a.call('uefi_stall');
    } else {
      a.call('linux_stall');
    }
    a.jmp('timer_loop');
  }

  a.label('timer_finished');
  if (UEFI) {
    a.call('uefi_shutdown');
    a.label('uefi_exit_hang');
    a.jmp('uefi_exit_hang');
  } else {
    a.jmp('exit_drain');
  }

  a.label('exit_drain');
  a.movImm32(REG.RAX, NET_OP_EXIT);
  a.xor(REG.RCX, REG.RCX);
  a.xor(REG.RDX, REG.RDX);
  a.call('net_request');
  a.movImm32(REG.RAX, FILE_OP_EXIT);
  a.xor(REG.RCX, REG.RCX);
  a.xor(REG.RDX, REG.RDX);
  a.call('file_request');
  a.xor(REG.RAX, REG.RAX);
  a.movImm32(REG.RDX, OUT_KIND_EXIT);
  a.call('enqueue_output');
  a.movImm64(REG.RCX, '0x' + (heapBase + OUT_DONE).toString(16));
  a.label('exit_wait');
  a.load8(REG.RAX, REG.RCX, 0);
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.NZ, 'exit_now');
  emitIdle(a, SINGLE_CORE);
  a.jmp('exit_wait');
  a.label('exit_now');
  a.movImm32(REG.RAX, 231);  // sys_exit_group
  a.mov(REG.RDI, REG.R15);   // exit status
  a.syscall();

  // ---------------------------------------------------------------- data
  a.label('guid_loaded_image');
  a.emitBytes(Buffer.from([
    0xa1, 0x31, 0x1b, 0x5b, 0x62, 0x95, 0xd2, 0x11,
    0x8e, 0x3f, 0x00, 0xa0, 0xc9, 0x69, 0x72, 0x3b,
  ]));
  a.label('guid_simple_fs');
  a.emitBytes(Buffer.from([
    0x22, 0x5b, 0x4e, 0x96, 0x59, 0x64, 0xd2, 0x11,
    0x8e, 0x39, 0x00, 0xa0, 0xc9, 0x69, 0x72, 0x3b,
  ]));
  a.label('default_script_path');
  for (const ch of '\\script.kz') a.emit(ch.charCodeAt(0), 0);
  a.emit(0, 0);
  a.label('net_http_get');
  a.emitBytes(Buffer.from('GET '));
  a.label('net_http_mid');
  a.emitBytes(Buffer.from(' HTTP/1.0\r\nHost: '));
  a.label('net_http_tail');
  a.emitBytes(Buffer.from('\r\nConnection: close\r\n\r\n'));
  a.label('tls_openssl');
  a.emitBytes(Buffer.from('/usr/bin/openssl\0'));
  a.label('tls_argv0');
  a.emitBytes(Buffer.from('openssl\0'));
  a.label('tls_s_client');
  a.emitBytes(Buffer.from('s_client\0'));
  a.label('tls_quiet');
  a.emitBytes(Buffer.from('-quiet\0'));
  a.label('tls_connect');
  a.emitBytes(Buffer.from('-connect\0'));
  a.label('tls_servername');
  a.emitBytes(Buffer.from('-servername\0'));
  a.label('tls_devnull');
  a.emitBytes(Buffer.from('/dev/null\0'));
  a.label('scheme_http');
  a.emitBytes(Buffer.from('http://\0'));
  a.label('scheme_https');
  a.emitBytes(Buffer.from('https://\0'));
  if (TEST_SOURCE !== null) {
    a.label('test_data');
    a.emitBytes(Buffer.from(TEST_SOURCE));
  }

  if (UEFI) {
    a.label('uefi_avx512_msg');
    a.emitBytes(Buffer.concat([
      Buffer.from('reg-runtime: AVX-512F is required (CPUID/XCR0).\r\n', 'utf16le'),
      Buffer.alloc(2),
    ]));

    if (UEFI_TRACE) {
      const trace = (label, text) => {
        a.label(label);
        a.emitBytes(Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.alloc(2)]));
      };
      trace('trace_state', 'T1: state\r\n');
      trace('trace_cpuid1', 'T1a: cpuid1\r\n');
      trace('trace_cpuid7', 'T1b: cpuid7\r\n');
      trace('trace_cpuidd', 'T1c: cpuidD\r\n');
      trace('trace_cr4', 'T2a: cr4\r\n');
      trace('trace_avx', 'T2: avx\r\n');
      trace('trace_ring', 'T3: ring\r\n');
      trace('trace_main', 'T4: main\r\n');
      trace('trace_console', 'T5: console\r\n');
      trace('trace_hash', 'T7: hash\r\n');
      trace('trace_uefi_enqueue', 'T6: uefi enqueue\r\n');
    }
  }

  return a.resolve();
}

// Assemble the streaming runtime. Two-pass assembly: the writable heap lives
// in the bss segment whose vaddr depends on the final text length, so assemble
// once to measure, then rebind the heap-base immediate and assemble again (same
// size, so the vaddr is stable).
export function generateRuntimeAssembly() {
  if (UEFI) {
    // UEFI global state lives at a fixed address reserved by the entry code;
    // the image itself is position independent and can load anywhere.
    return buildRuntime(UEFI_HEAP_BASE);
  }
  const probe = buildRuntime(0x1000000);
  const heapBase = TEXT_BASE - 0x1000 + align(0x1000 + probe.length, 0x1000);
  const textBytes = buildRuntime(heapBase);
  return textBytes;
}

export { BSS_SIZE };
