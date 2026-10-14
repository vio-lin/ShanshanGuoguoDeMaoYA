import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { semanticCutout } from './semantic-cutout.mjs';

const inputDir = path.resolve('incoming-assets/bday-nini');
const outputDir = path.resolve('src/anniversaries/assets/bday-nini');
const cutoutDir = path.resolve('.build/semantic-cutouts/bday-nini');

await mkdir(outputDir, { recursive: true });
await mkdir(cutoutDir, { recursive: true });

const files = (await readdir(inputDir))
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .sort();

console.log(`Processing ${files.length} anniversary frames...`);

for (const file of files) {
  const inputPath = path.join(inputDir, file);
  const cutoutPath = path.join(cutoutDir, file);
  const outputPath = path.join(outputDir, file);

  // 1. Semantic cutout
  await semanticCutout({
    input: inputPath,
    output: cutoutPath,
    backend: 'apple-vision',
    subjectKind: 'illustration',
  });

  // 2. Normalize to 512x512 with bottom-center anchor, ~75% occupancy
  const img = sharp(cutoutPath);
  const meta = await img.metadata();
  const targetSize = 512;
  const targetOccupancy = 0.75;

  // Find the bounding box of non-transparent pixels
  const { data, info } = await img
    .clone()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  let minX = width, minY = height, maxX = 0, maxY = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;

  // Scale to fit target occupancy (use larger dimension)
  const scale = (targetSize * targetOccupancy) / Math.max(contentWidth, contentHeight);
  const newWidth = Math.round(contentWidth * scale);
  const newHeight = Math.round(contentHeight * scale);

  // Crop to content bounding box, resize, then place on 512x512 canvas with bottom-center anchor
  const resized = await sharp(cutoutPath)
    .extract({ left: minX, top: minY, width: contentWidth, height: contentHeight })
    .resize(newWidth, newHeight, { fit: 'fill' })
    .toBuffer();

  // Bottom-center: x = (512 - newWidth) / 2, y = 512 - newHeight
  const padX = Math.round((targetSize - newWidth) / 2);
  const padTop = targetSize - newHeight;

  await sharp({
    create: {
      width: targetSize,
      height: targetSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, top: padTop, left: padX }])
    .png()
    .toFile(outputPath);

  console.log(`  ✓ ${file} (${contentWidth}x${contentHeight} -> ${newWidth}x${newHeight})`);
}

console.log(`Done. Output: ${outputDir}`);
