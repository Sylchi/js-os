/**
 * Pure JavaScript PE32+ / UEFI application writer.
 *
 * Emits a relocatable EFI application image with a single code section and a
 * minimal .reloc section. The generated code is position independent (all
 * internal references are RIP-relative), so the dummy relocation block only
 * lets firmware move the image when the preferred base is unavailable.
 */

const FILE_ALIGN = 0x200;
const SECTION_ALIGN = 0x1000;
const DOS_HEADER_SIZE = 0x40;
const PE_SIGNATURE_SIZE = 4;
const COFF_HEADER_SIZE = 20;
const OPTIONAL_HEADER_SIZE = 240;
const SECTION_HEADER_SIZE = 40;

// Preferred image base. The assembler uses 0x401000 as its text base.
export const IMAGE_BASE = 0x400000;
export const TEXT_RVA = 0x1000;
export const TEXT_BASE = IMAGE_BASE + TEXT_RVA; // 0x401000

const align = (n, a) => (n + a - 1) & ~(a - 1);

function writeAscii(buf, offset, str, length = str.length) {
  for (let i = 0; i < length; i++) {
    buf[offset + i] = str.charCodeAt(i) & 0xff;
  }
}

/**
 * @param {Object} opts
 * @param {Buffer} opts.text - machine code + rodata
 * @param {number} [opts.entryOffset=0] - entry point offset within text
 * @param {number} [opts.imageBase=IMAGE_BASE]
 * @param {number} [opts.subsystem=10] - EFI application
 * @returns {Buffer} PE32+ image
 */
export function buildUefiImage({ text, entryOffset = 0, imageBase = IMAGE_BASE, subsystem = 10 }) {
  const textRawSize = align(text.length, FILE_ALIGN);
  const relocRva = align(TEXT_RVA + text.length, SECTION_ALIGN);
  const relocSize = 12; // one IMAGE_BASE_RELOCATION block with an ABSOLUTE entry
  const relocRawSize = align(relocSize, FILE_ALIGN);

  const headersSize = align(
    DOS_HEADER_SIZE + PE_SIGNATURE_SIZE + COFF_HEADER_SIZE + OPTIONAL_HEADER_SIZE + 2 * SECTION_HEADER_SIZE,
    FILE_ALIGN,
  );
  const textRawPtr = headersSize;
  const relocRawPtr = textRawPtr + textRawSize;
  const fileSize = relocRawPtr + relocRawSize;

  const sizeOfImage = align(relocRva + relocSize, SECTION_ALIGN);
  const sizeOfCode = textRawSize;
  const sizeOfInitializedData = relocRawSize;
  const entryRva = TEXT_RVA + entryOffset;

  const image = Buffer.alloc(fileSize);

  // ---------------------------------------------------------------- DOS stub
  image[0] = 0x4d; // MZ
  image[1] = 0x5a;
  image.writeUInt32LE(DOS_HEADER_SIZE, 0x3c); // e_lfanew

  // -------------------------------------------------------------- PE signature
  let o = DOS_HEADER_SIZE;
  writeAscii(image, o, 'PE\0\0', 4);
  o += 4;

  // ------------------------------------------------------------- COFF header
  image.writeUInt16LE(0x8664, o); o += 2; // IMAGE_FILE_MACHINE_AMD64
  image.writeUInt16LE(2, o); o += 2;      // NumberOfSections
  image.writeUInt32LE(0, o); o += 4;      // TimeDateStamp
  image.writeUInt32LE(0, o); o += 4;      // PointerToSymbolTable
  image.writeUInt32LE(0, o); o += 4;      // NumberOfSymbols
  image.writeUInt16LE(OPTIONAL_HEADER_SIZE, o); o += 2;
  image.writeUInt16LE(0x0022, o); o += 2; // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

  // ------------------------------------------------------ optional header (PE32+)
  const opt = o;
  image.writeUInt16LE(0x20b, o); o += 2;  // PE32+ magic
  image.writeUInt8(0, o++);               // MajorLinkerVersion
  image.writeUInt8(0, o++);               // MinorLinkerVersion
  image.writeUInt32LE(sizeOfCode, o); o += 4;
  image.writeUInt32LE(sizeOfInitializedData, o); o += 4;
  image.writeUInt32LE(0, o); o += 4;      // SizeOfUninitializedData
  image.writeUInt32LE(entryRva, o); o += 4;
  image.writeUInt32LE(TEXT_RVA, o); o += 4; // BaseOfCode
  image.writeBigUInt64LE(BigInt(imageBase), o); o += 8;
  image.writeUInt32LE(SECTION_ALIGN, o); o += 4;
  image.writeUInt32LE(FILE_ALIGN, o); o += 4;
  image.writeUInt16LE(0, o); o += 2;      // MajorOperatingSystemVersion
  image.writeUInt16LE(0, o); o += 2;      // MinorOperatingSystemVersion
  image.writeUInt16LE(0, o); o += 2;      // MajorImageVersion
  image.writeUInt16LE(0, o); o += 2;      // MinorImageVersion
  image.writeUInt16LE(0, o); o += 2;      // MajorSubsystemVersion
  image.writeUInt16LE(0, o); o += 2;      // MinorSubsystemVersion
  image.writeUInt32LE(0, o); o += 4;      // Win32VersionValue
  image.writeUInt32LE(sizeOfImage, o); o += 4;
  image.writeUInt32LE(headersSize, o); o += 4; // SizeOfHeaders
  image.writeUInt32LE(0, o); o += 4;      // CheckSum
  image.writeUInt16LE(subsystem, o); o += 2;
  image.writeUInt16LE(0, o); o += 2;      // DllCharacteristics
  image.writeBigUInt64LE(0x100000n, o); o += 8; // SizeOfStackReserve
  image.writeBigUInt64LE(0x1000n, o); o += 8;   // SizeOfStackCommit
  image.writeBigUInt64LE(0x100000n, o); o += 8; // SizeOfHeapReserve
  image.writeBigUInt64LE(0x1000n, o); o += 8;   // SizeOfHeapCommit
  image.writeUInt32LE(0, o); o += 4;      // LoaderFlags
  image.writeUInt32LE(16, o); o += 4;     // NumberOfRvaAndSizes
  for (let i = 0; i < 16; i++) {          // data directories (all empty)
    image.writeUInt32LE(0, o); o += 4;
    image.writeUInt32LE(0, o); o += 4;
  }
  if (o - opt !== OPTIONAL_HEADER_SIZE) {
    throw new Error(`optional header size mismatch: ${o - opt}`);
  }

  // ---------------------------------------------------------- section headers
  const textSection = o;
  writeAscii(image, o, '.text\0\0\0', 8); o += 8;
  image.writeUInt32LE(text.length, o); o += 4;    // VirtualSize
  image.writeUInt32LE(TEXT_RVA, o); o += 4;       // VirtualAddress
  image.writeUInt32LE(textRawSize, o); o += 4;    // SizeOfRawData
  image.writeUInt32LE(textRawPtr, o); o += 4;     // PointerToRawData
  image.writeUInt32LE(0, o); o += 4;              // PointerToRelocations
  image.writeUInt32LE(0, o); o += 4;              // PointerToLinenumbers
  image.writeUInt16LE(0, o); o += 2;              // NumberOfRelocations
  image.writeUInt16LE(0, o); o += 2;              // NumberOfLinenumbers
  image.writeUInt32LE(0x60000020, o); o += 4;     // code | execute | read

  writeAscii(image, o, '.reloc\0\0', 8); o += 8;
  image.writeUInt32LE(relocSize, o); o += 4;
  image.writeUInt32LE(relocRva, o); o += 4;
  image.writeUInt32LE(relocRawSize, o); o += 4;
  image.writeUInt32LE(relocRawPtr, o); o += 4;
  image.writeUInt32LE(0, o); o += 4;
  image.writeUInt32LE(0, o); o += 4;
  image.writeUInt16LE(0, o); o += 2;
  image.writeUInt16LE(0, o); o += 2;
  image.writeUInt32LE(0x42000040, o); o += 4;     // initialized | discardable | read

  // -------------------------------------------------------------------- payload
  text.copy(image, textRawPtr);
  const r = relocRawPtr;
  image.writeUInt32LE(TEXT_RVA, r);       // PageRVA
  image.writeUInt32LE(relocSize, r + 4);  // BlockSize
  image.writeUInt16LE(0x0000, r + 8);     // IMAGE_REL_BASED_ABSOLUTE
  image.writeUInt16LE(0x0000, r + 10);    // padding
  image.fill(0, r + relocSize, r + relocRawSize);

  return image;
}
