#!/usr/bin/env node
/**
 * Build a genuine FAT16 boot volume and place the runtime image on it.
 *
 *   node mkdisk.js BOOTX64.EFI disk.img
 *
 * The volume is a real on-disk filesystem, not QEMU's `fat:rw:` pseudo-drive,
 * so EFI_SIMPLE_FILE_SYSTEM_PROTOCOL can create and write files — which is what
 * backs `File` and `Blob` in the runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Fat16 } from './fatfs.js';

const efiPath = path.resolve(process.argv[2] ?? 'ui_probe.efi');
const diskPath = path.resolve(process.argv[3] ?? 'disk.img');

const efi = fs.readFileSync(efiPath);
const readme = Buffer.from(
  'REG-RUNTIME\r\n' +
  'This volume is a FAT16 image built by fatfs.js.\r\n' +
  'The runtime writes files here through the File API.\r\n',
  'ascii',
);

const fs16 = new Fat16({ totalSectors: 65536, label: 'REG-RUNTIME' });
fs16.set('EFI/BOOT/BOOTX64.EFI', efi);
fs16.set('README.TXT', readme);

const image = fs16.build();
fs.writeFileSync(diskPath, image, { mode: 0o644 });

console.log(
  `[mkdisk] ${diskPath} ${(image.length / 1048576).toFixed(1)} MiB ` +
  `(${fs16.clusterCount} clusters, ${fs16.sectorsPerFat} sectors/FAT, ` +
  `${fs16.usedClusters} used)`,
);
