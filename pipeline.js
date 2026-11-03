// pipeline.js - cross-core plumbing for the kzero runtime.
//
// One cache-line-padded single-producer/single-consumer ring per pipeline
// stage. The producer owns `head`, the consumer owns `tail`; x86-64 TSO
// makes the payload stores visible before the head store and the payload
// loads ordered after the head load, so no fences are needed.
//
// Queue memory layout (offsets from the queue base):
//   0   : head  (u64, producer writes)  + 56 bytes padding
//   64  : tail  (u64, consumer writes)  + 56 bytes padding
//   128 : slots (capacity * 16 bytes), each slot = [value:u64][kind:u64]
//
// Also contains the two thread primitives the runtime needs: pinning the
// current thread to a physical core and spawning a clone(CLONE_VM) worker
// on a private bss stack.

import { REG, COND } from './asm.js';

export const CACHE_LINE = 64;
export const ENTRY_SIZE = 16;

/**
 * @param {number} base - byte offset of the queue within the shared bss
 * @param {number} capacity - power-of-two number of slots
 * @param {number} [entrySize=16] - bytes per slot, multiple of 8
 */
export function queueLayout(base, capacity, entrySize = ENTRY_SIZE) {
  if ((capacity & (capacity - 1)) !== 0) {
    throw new Error(`queue capacity must be a power of two, got ${capacity}`);
  }
  if (entrySize < 8 || (entrySize & 7) !== 0) {
    throw new Error(`queue entry size must be a multiple of 8, got ${entrySize}`);
  }
  return {
    base,
    head: base,
    tail: base + CACHE_LINE,
    slots: base + 2 * CACHE_LINE,
    capacity,
    mask: capacity - 1,
    entrySize,
    entryShift: Math.log2(entrySize),
    bytes: 2 * CACHE_LINE + capacity * entrySize,
  };
}

let seq = 0;

/**
 * Idle one iteration of a spin loop.
 *
 * On dedicated cores a `pause` hint is ideal. When every stage shares one
 * core (KZERO_SINGLE_CORE), spinning never lets the peer thread run, so the
 * dispatcher/worker ping-pong starves instead of completing. In that build
 * yield the CPU explicitly.
 *
 * Preserves RCX and R11 (the syscall-clobbered registers); RAX is scratch.
 */
export function emitIdle(a, singleCore) {
  if (process.env.KZERO_PLATFORM !== 'linux') return;
  if (singleCore) {
    a.push(REG.RCX);
    a.push(REG.R11);
    a.movImm32(REG.RAX, 24); // sched_yield
    a.syscall();
    a.pop(REG.R11);
    a.pop(REG.RCX);
  } else {
    a.pause();
  }
}

/**
 * Emit an inline enqueue. Spins (with `pause`, or `sched_yield` in the
 * single-core build) while the queue is full.
 *
 * @param {Assembler} a
 * @param {number} bssBase - virtual address of the shared bss
 * @param {object} q - layout from queueLayout()
 * @param {object} r - { fields: register[], tmpA, tmpB }. `fields` are stored
 *   into the slot at offsets 0, 8, 16, ... in order; the temps are scratch
 *   and must not alias any field.
 * @param {string} [prefix] - unique label prefix
 * @param {boolean} [singleCore] - yield instead of pause while the queue is full
 */
export function emitEnqueue(a, bssBase, q, r, prefix, singleCore = false) {
  const p = prefix ?? `enq${seq++}`;
  const headAddr = '0x' + (bssBase + q.head).toString(16);
  const tailAddr = '0x' + (bssBase + q.tail).toString(16);
  const slotsAddr = '0x' + (bssBase + q.slots).toString(16);
  const { fields, tmpA, tmpB } = r;

  a.label(`${p}_retry`);
  a.movImm64(tmpA, headAddr);
  a.load64(tmpA, tmpA, 0);          // head
  a.movImm64(tmpB, tailAddr);
  a.load64(tmpB, tmpB, 0);          // tail
  a.mov(REG.RCX, tmpA);
  a.sub(REG.RCX, tmpB);
  a.cmpImm32(REG.RCX, q.capacity);
  a.jcc(COND.B, `${p}_space`);
  emitIdle(a, singleCore);
  a.jmp(`${p}_retry`);

  a.label(`${p}_space`);
  a.mov(REG.RCX, tmpA);
  a.andImm32(REG.RCX, q.mask);
  a.shlImm8(REG.RCX, q.entryShift);
  a.movImm64(tmpB, slotsAddr);
  a.add(REG.RCX, tmpB);
  for (let i = 0; i < fields.length; i++) {
    a.store64(REG.RCX, fields[i], i * 8);
  }

  // Publish: the slot stores above precede the head store in program order.
  a.inc(tmpA);
  a.movImm64(tmpB, headAddr);
  a.store64(tmpB, tmpA, 0);
}

/**
 * Pin the current thread to one logical CPU.
 * sched_setaffinity(0, 8, &mask), mask built on the stack.
 * Clobbers RAX, RDI, RSI, RDX.
 */
export function emitPinCpu(a, cpu) {
  a.subImm32(REG.RSP, 16);
  a.movImm32(REG.RDX, 1 << cpu);
  a.store64(REG.RSP, REG.RDX, 0);
  a.movImm32(REG.RAX, 203);
  a.xor(REG.RDI, REG.RDI);
  a.movImm32(REG.RSI, 8);
  a.mov(REG.RDX, REG.RSP);
  a.syscall();
  a.addImm32(REG.RSP, 16);
}

/**
 * clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM)
 * with a private stack. The child resumes at `childLabel` with RAX = 0 and
 * RBX = index; the parent continues with RAX = tid.
 * Clobbers RAX, RDI, RSI, RDX, R8, R10.
 */
export function emitCloneWorker(a, { stackTop, index, childLabel }) {
  a.movImm64(REG.RBX, '0x' + index.toString(16));
  a.movImm64(REG.RSI, '0x' + stackTop.toString(16));
  a.movImm32(REG.RDI, 0x50f00);
  a.movImm32(REG.RAX, 56);
  a.xor(REG.RDX, REG.RDX);
  a.xor(REG.R10, REG.R10);
  a.xor(REG.R8, REG.R8);
  a.syscall();
  a.test(REG.RAX, REG.RAX);
  a.jcc(COND.Z, childLabel);
}
