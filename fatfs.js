/**
 * Minimal FAT16 image builder / reader.
 *
 * The runtime talks to `File` and `Blob` through
 * EFI_SIMPLE_FILE_SYSTEM_PROTOCOL, which is just a FAT driver inside the
 * firmware. QEMU's `fat:rw:` pseudo-volume does not survive that driver, so we
 * hand it a genuine FAT16 volume instead: a real on-disk format is the honest
 * backing store for a real on-disk API.
 *
 * No external tooling (mkfs/mtools) required.
 */

const SECTOR = 512;

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function shortName(name) {
  // 8.3 only: no LFN entries are emitted.
  const upper = name.toUpperCase();
  const dot = upper.lastIndexOf('.');
  const base = dot === -1 ? upper : upper.slice(0, dot);
  const ext = dot === -1 ? '' : upper.slice(dot + 1);
  if (base.length < 1 || base.length > 8 || ext.length > 3) {
    throw new Error(`not an 8.3 name: ${name}`);
  }
  return (base.padEnd(8) + ext.padEnd(3)).slice(0, 11);
}

class Fat16 {
  constructor(opts = {}) {
    this.bytesPerSector = SECTOR;
    this.sectorsPerCluster = opts.sectorsPerCluster ?? 4;
    this.reservedSectors = 1;
    this.numFats = 2;
    this.rootEntries = opts.rootEntries ?? 512;
    this.totalSectors = opts.totalSectors ?? 65536; // 32 MiB
    this.media = 0xf8;
    this.label = (opts.label ?? 'REG-RUNTIME').toUpperCase().padEnd(11).slice(0, 11);
    this.volumeId = opts.volumeId ?? 0x20261103;
    this.files = new Map(); // 'EFI/BOOT/BOOTX64.EFI' -> Buffer
    this._layout();
  }

  _layout() {
    const rootDirSectors = (this.rootEntries * 32) / SECTOR;
    let fatSectors = 1;
    let clusters = 0;
    for (;;) {
      const dataSectors =
        this.totalSectors - this.reservedSectors - this.numFats * fatSectors - rootDirSectors;
      clusters = Math.floor(dataSectors / this.sectorsPerCluster);
      const need = Math.ceil(((clusters + 2) * 2) / SECTOR);
      if (need <= fatSectors) break;
      fatSectors = need;
    }
    this.rootDirSectors = rootDirSectors;
    this.sectorsPerFat = fatSectors;
    this.clusterCount = clusters;
    this.dataStartSector =
      this.reservedSectors + this.numFats * this.sectorsPerFat + rootDirSectors;
    if (this.clusterCount < 4085 || this.clusterCount >= 65525) {
      throw new Error(`cluster count ${this.clusterCount} is outside FAT16 range`);
    }
  }

  clusterBytes() {
    return this.sectorsPerCluster * SECTOR;
  }

  clusterOffset(n) {
    return (this.dataStartSector + (n - 2) * this.sectorsPerCluster) * SECTOR;
  }

  set(path, data) {
    this.files.set(path.replace(/^[\\/]+/, '').replace(/\\/g, '/'), data);
    return this;
  }

  // ---------------------------------------------------------------- build
  build() {
    const image = Buffer.alloc(this.totalSectors * SECTOR);
    this._writeBootSector(image);

    // Tree from the flat path map.
    const root = { children: new Map(), dir: true };
    for (const [path, data] of this.files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), dir: true });
        node = node.children.get(part);
        if (!node.dir) throw new Error(`path conflict at ${path}`);
      }
      node.children.set(parts[parts.length - 1], { data, dir: false });
    }

    const fat = new Uint16Array(this.clusterCount + 2);
    fat[0] = 0xfff8;
    fat[1] = 0xffff;
    let nextCluster = 2;

    const allocate = (count) => {
      if (count === 0) return 0;
      const start = nextCluster;
      if (start + count - 2 > this.clusterCount) {
        throw new Error('FAT16 image is full');
      }
      for (let i = 0; i < count; i++) {
        fat[nextCluster] = i === count - 1 ? 0xffff : nextCluster + 1;
        nextCluster++;
      }
      return start;
    };

    const stamp = dosDateTime();

    // Directories first, so they get low cluster numbers deterministically.
    const assignDirClusters = (node, parentCluster, isRoot) => {
      if (!isRoot) node.cluster = allocate(1);
      for (const child of node.children.values()) {
        if (child.dir) assignDirClusters(child, node.cluster ?? 0, false);
      }
    };
    assignDirClusters(root, 0, true);

    for (const child of root.children.values()) {
      if (!child.dir) {
        const count = Math.ceil(child.data.length / this.clusterBytes());
        child.cluster = allocate(count);
      }
    }
    const assignFileClusters = (node) => {
      for (const child of node.children.values()) {
        if (child.dir) assignFileClusters(child);
        else {
          const count = Math.ceil(child.data.length / this.clusterBytes());
          child.cluster = allocate(count);
        }
      }
    };
    assignFileClusters(root);

    // Emit directory tables and file payloads.
    const writeEntries = (node, isRoot) => {
      const entries = [];
      const pushEntry = (name11, attr, cluster, size) => {
        const e = Buffer.alloc(32);
        e.write(name11, 0, 'ascii');
        e[0x0b] = attr;
        e.writeUInt16LE(stamp.time, 0x0e);
        e.writeUInt16LE(stamp.day, 0x10);
        e.writeUInt16LE(stamp.day, 0x12);
        e.writeUInt16LE(stamp.time, 0x16);
        e.writeUInt16LE(stamp.day, 0x18);
        e.writeUInt16LE(cluster & 0xffff, 0x1a);
        e.writeUInt32LE(size >>> 0, 0x1c);
        entries.push(e);
      };

      if (!isRoot) {
        pushEntry('.          ', 0x10, node.cluster, 0);
        pushEntry('..         ', 0x10, node.parentCluster ?? 0, 0);
      }
      for (const [name, child] of node.children) {
        pushEntry(shortName(name), child.dir ? 0x10 : 0x20, child.cluster ?? 0,
          child.dir ? 0 : child.data.length);
      }

      const table = Buffer.concat(entries);
      const offset = isRoot ? this.rootDirOffset() : this.clusterOffset(node.cluster);
      const capacity = isRoot ? this.rootDirSectors * SECTOR : this.clusterBytes();
      if (table.length > capacity) throw new Error('directory full');
      table.copy(image, offset);

      for (const child of node.children.values()) {
        if (child.dir) {
          child.parentCluster = isRoot ? 0 : node.cluster;
          writeEntries(child, false);
        } else if (child.data.length) {
          const at = this.clusterOffset(child.cluster);
          child.data.copy(image, at);
        }
      }
    };
    writeEntries(root, true);

    // FAT copies.
    const fatBuf = Buffer.alloc(this.sectorsPerFat * SECTOR);
    for (let i = 0; i < fat.length; i++) fatBuf.writeUInt16LE(fat[i], i * 2);
    for (let copy = 0; copy < this.numFats; copy++) {
      const at = (this.reservedSectors + copy * this.sectorsPerFat) * SECTOR;
      fatBuf.copy(image, at);
    }

    this.usedClusters = nextCluster - 2;
    return image;
  }

  rootDirOffset() {
    return (this.reservedSectors + this.numFats * this.sectorsPerFat) * SECTOR;
  }

  _writeBootSector(image) {
    image.fill(0, 0, SECTOR);
    image[0x00] = 0xeb;
    image[0x01] = 0x3c;
    image[0x02] = 0x90;
    image.write('MSWIN4.1', 0x03, 'ascii');
    image.writeUInt16LE(SECTOR, 0x0b);
    image[0x0d] = this.sectorsPerCluster;
    image.writeUInt16LE(this.reservedSectors, 0x0e);
    image[0x10] = this.numFats;
    image.writeUInt16LE(this.rootEntries, 0x11);
    image.writeUInt16LE(0, 0x13);
    image[0x15] = this.media;
    image.writeUInt16LE(this.sectorsPerFat, 0x16);
    image.writeUInt16LE(63, 0x18);
    image.writeUInt16LE(255, 0x1a);
    image.writeUInt32LE(0, 0x1c);
    image.writeUInt32LE(this.totalSectors, 0x20);
    image[0x24] = 0x80;
    image[0x26] = 0x29;
    image.writeUInt32LE(this.volumeId >>> 0, 0x27);
    image.write(this.label.padEnd(11).slice(0, 11), 0x2b, 'ascii');
    image.write('FAT16   ', 0x36, 'ascii');
    image[0x1fe] = 0x55;
    image[0x1ff] = 0xaa;
  }
}

// ------------------------------------------------------------------ reader
/** Parse a FAT16 image well enough to list and extract files. */
function openFat16(image) {
  const bps = image.readUInt16LE(0x0b);
  const spc = image[0x0d];
  const reserved = image.readUInt16LE(0x0e);
  const numFats = image[0x10];
  const rootEntries = image.readUInt16LE(0x11);
  const sectorsPerFat = image.readUInt16LE(0x16);
  const rootDirSectors = (rootEntries * 32) / bps;
  const fatOffset = reserved * bps;
  const rootOffset = (reserved + numFats * sectorsPerFat) * bps;
  const dataOffset = (reserved + numFats * sectorsPerFat + rootDirSectors) * bps;
  const clusterSize = spc * bps;

  const clusterOffset = (n) => dataOffset + (n - 2) * clusterSize;
  const nextCluster = (n) => image.readUInt16LE(fatOffset + n * 2);

  const readChain = (start, size) => {
    if (start === 0) return Buffer.alloc(0);
    const chunks = [];
    let cluster = start;
    while (cluster >= 2 && cluster < 0xfff8 && chunks.length < 100000) {
      chunks.push(image.subarray(clusterOffset(cluster), clusterOffset(cluster) + clusterSize));
      cluster = nextCluster(cluster);
    }
    const all = Buffer.concat(chunks);
    return size === undefined ? all : all.subarray(0, size);
  };

  const parseDir = (buf) => {
    const out = [];
    for (let off = 0; off + 32 <= buf.length; off += 32) {
      const e = buf.subarray(off, off + 32);
      if (e[0] === 0x00) break;
      if (e[0] === 0xe5) continue;
      const attr = e[0x0b];
      if (attr === 0x0f) continue;
      const name = e.toString('ascii', 0, 8).trimEnd();
      const ext = e.toString('ascii', 8, 11).trimEnd();
      if (name === '.' || name === '..') continue;
      out.push({
        name: ext ? `${name}.${ext}` : name,
        attr,
        dir: (attr & 0x10) !== 0,
        cluster: e.readUInt16LE(0x1a),
        size: e.readUInt32LE(0x1c),
      });
    }
    return out;
  };

  const listRoot = () => parseDir(image.subarray(rootOffset, rootOffset + rootDirSectors * bps));

  const list = (path = '/') => {
    const parts = path.replace(/^[\\/]+/, '').replace(/\\/g, '/').split('/').filter(Boolean);
    let entries = listRoot();
    for (const part of parts) {
      const hit = entries.find((x) => x.dir && x.name.toLowerCase() === part.toLowerCase());
      if (!hit) throw new Error(`no such directory: ${path}`);
      entries = parseDir(readChain(hit.cluster, clusterSize));
    }
    return entries;
  };

  const read = (path) => {
    const parts = path.replace(/^[\\/]+/, '').replace(/\\/g, '/').split('/').filter(Boolean);
    const file = parts.pop();
    let entries = list(parts.join('/') ? `/${parts.join('/')}` : '/');
    const hit = entries.find((x) => !x.dir && x.name.toLowerCase() === file.toLowerCase());
    if (!hit) throw new Error(`no such file: ${path}`);
    return readChain(hit.cluster, hit.size);
  };

  return { list, read, listRoot, geometry: { bps, spc, reserved, numFats, rootEntries, sectorsPerFat } };
}

export { Fat16, openFat16, shortName };
