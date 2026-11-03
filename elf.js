/**
 * Pure JavaScript Static ELF64 Linker & Writer for Linux x86-64
 *
 * No external linker, no gcc, no glibc, no ld.so.
 * Emits kernel-loadable static ELF with Program Headers (PT_LOAD).
 */

const PAGE = 0x1000;
const TEXT_VADDR = 0x400000;
const TEXT_OFFSET = 0x1000;
const EHDR_SIZE = 64;
const PHDR_SIZE = 56;

export const TEXT_BASE = TEXT_VADDR + TEXT_OFFSET; // 0x401000

const align = (n, a) => (n + a - 1) & ~(a - 1);

/**
 * @param {Object} options
 * @param {Buffer} options.text - Executable machine code + rodata
 * @param {Buffer} [options.data] - Mutable data segment
 * @param {number} [options.bssSize=0] - BSS zero-initialized allocation
 * @param {number} [options.entry=TEXT_BASE] - Virtual address of entry point
 * @returns {Buffer} Raw ELF64 static executable image
 */
export function buildStaticElf64({ text, data = Buffer.alloc(0), bssSize = 0, entry = TEXT_BASE }) {
  const hasData = data.length > 0 || bssSize > 0;
  const phnum = hasData ? 2 : 1;

  const textEnd = TEXT_OFFSET + text.length;
  const dataOffset = align(textEnd, PAGE);
  const dataVaddr = TEXT_VADDR + dataOffset;
  const totalFileSize = hasData ? dataOffset + data.length : textEnd;

  const image = Buffer.alloc(totalFileSize);
  let o = 0;

  // 1. e_ident[16]
  image.write('\x7fELF', o, 'latin1'); o += 4;
  image.writeUInt8(2, o++); // ELFCLASS64
  image.writeUInt8(1, o++); // ELFDATA2LSB (little-endian)
  image.writeUInt8(1, o++); // EV_CURRENT
  image.writeUInt8(0, o++); // ELFOSABI_SYSV
  image.writeUInt8(0, o++); // ABI Version
  o += 7; // padding to 16 bytes

  // 2. ELF Header fields
  image.writeUInt16LE(2, o); o += 2;        // e_type = ET_EXEC (2)
  image.writeUInt16LE(62, o); o += 2;       // e_machine = EM_X86_64 (62 / 0x3e)
  image.writeUInt32LE(1, o); o += 4;        // e_version = 1
  image.writeBigUInt64LE(BigInt(entry), o); o += 8; // e_entry
  image.writeBigUInt64LE(BigInt(EHDR_SIZE), o); o += 8; // e_phoff = 64
  image.writeBigUInt64LE(0n, o); o += 8;    // e_shoff = 0 (no sections required)
  image.writeUInt32LE(0, o); o += 4;        // e_flags = 0
  image.writeUInt16LE(EHDR_SIZE, o); o += 2; // e_ehsize = 64
  image.writeUInt16LE(PHDR_SIZE, o); o += 2; // e_phentsize = 56
  image.writeUInt16LE(phnum, o); o += 2;    // e_phnum
  image.writeUInt16LE(0, o); o += 2;        // e_shentsize = 0
  image.writeUInt16LE(0, o); o += 2;        // e_shnum = 0
  image.writeUInt16LE(0, o); o += 2;        // e_shstrndx = 0

  // 3. Program Header 1: PT_LOAD Text + RODATA (Read + Execute)
  image.writeUInt32LE(1, o); o += 4;        // p_type = PT_LOAD (1)
  image.writeUInt32LE(5, o); o += 4;        // p_flags = PF_R | PF_X (1 | 4 = 5)
  image.writeBigUInt64LE(0n, o); o += 8;    // p_offset = 0
  image.writeBigUInt64LE(BigInt(TEXT_VADDR), o); o += 8; // p_vaddr
  image.writeBigUInt64LE(BigInt(TEXT_VADDR), o); o += 8; // p_paddr
  image.writeBigUInt64LE(BigInt(textEnd), o); o += 8;    // p_filesz
  image.writeBigUInt64LE(BigInt(textEnd), o); o += 8;    // p_memsz
  image.writeBigUInt64LE(BigInt(PAGE), o); o += 8;       // p_align = 4096

  // 4. Optional Program Header 2: PT_LOAD Data + BSS (Read + Write)
  if (hasData) {
    image.writeUInt32LE(1, o); o += 4;      // p_type = PT_LOAD (1)
    image.writeUInt32LE(6, o); o += 4;      // p_flags = PF_R | PF_W (4 | 2 = 6)
    image.writeBigUInt64LE(BigInt(dataOffset), o); o += 8; // p_offset
    image.writeBigUInt64LE(BigInt(dataVaddr), o); o += 8;  // p_vaddr
    image.writeBigUInt64LE(BigInt(dataVaddr), o); o += 8;  // p_paddr
    image.writeBigUInt64LE(BigInt(data.length), o); o += 8; // p_filesz
    image.writeBigUInt64LE(BigInt(data.length + bssSize), o); o += 8; // p_memsz
    image.writeBigUInt64LE(BigInt(PAGE), o); o += 8;       // p_align = 4096
  }

  // 5. Copy Text Segment
  text.copy(image, TEXT_OFFSET);

  // 6. Copy Data Segment (if any)
  if (data.length > 0) {
    data.copy(image, dataOffset);
  }

  return image;
}
