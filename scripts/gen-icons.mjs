/**
 * Generuje wszystkie ikony aplikacji z podanego pliku źródłowego.
 * Użycie: node scripts/gen-icons.mjs <ścieżka-do-źródła>
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');

const src = process.argv[2];
if (!src) {
  console.error('Podaj ścieżkę do źródłowego PNG jako argument');
  process.exit(1);
}

const srcPath = resolve(src);
const iconsDir = resolve(root, 'public/icons');
mkdirSync(iconsDir, { recursive: true });

// --- ikony "any" (pełne logo, bez paddingu) ---
const sizes = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32.png', size: 32 },
];

for (const { name, size } of sizes) {
  await sharp(srcPath)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(resolve(iconsDir, name));
  console.log(`✓ ${name} (${size}x${size})`);
}

// --- ikony maskable (10% padding dookoła, safe zone) ---
const maskableSizes = [192, 512];
for (const size of maskableSizes) {
  const pad = Math.round(size * 0.1);
  const inner = size - pad * 2;
  const resized = await sharp(srcPath)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Wklej na przezroczyste tło z paddingiem
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: resized, top: pad, left: pad }])
    .png()
    .toFile(resolve(iconsDir, `icon-maskable-${size}.png`));
  console.log(`✓ icon-maskable-${size}.png (maskable, ${size}x${size})`);
}

// --- favicon.ico (32x32 PNG wbudowane w ICO) ---
const png32 = await sharp(srcPath)
  .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

// Minimalny ICO: ICONDIR (6 B) + ICONDIRENTRY (16 B) + PNG data
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);  // reserved
icoHeader.writeUInt16LE(1, 2);  // type = icon
icoHeader.writeUInt16LE(1, 4);  // count = 1

const icoEntry = Buffer.alloc(16);
icoEntry.writeUInt8(0, 0);           // width  (0 = 256)
icoEntry.writeUInt8(0, 1);           // height (0 = 256)
icoEntry.writeUInt8(0, 2);           // colorCount
icoEntry.writeUInt8(0, 3);           // reserved
icoEntry.writeUInt16LE(1, 4);        // planes
icoEntry.writeUInt16LE(32, 6);       // bitCount
icoEntry.writeUInt32LE(png32.length, 8);  // bytesInRes
icoEntry.writeUInt32LE(22, 12);      // imageOffset = 6 + 16

writeFileSync(resolve(root, 'public/favicon.ico'), Buffer.concat([icoHeader, icoEntry, png32]));
console.log('✓ favicon.ico');

console.log('\nWszystkie ikony wygenerowane pomyślnie.');
