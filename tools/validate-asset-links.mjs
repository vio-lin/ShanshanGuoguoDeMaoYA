import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const petsRoot = path.join(root, 'src', 'pets');
const errors = [];
let totalReferenced = 0;

async function walk(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) files.push(relative);
  }
  return files;
}

const petDirs = (await readdir(petsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
if (!petDirs.length) errors.push('src/pets contains no pet directories');

for (const dir of petDirs) {
  const petId = dir.name;
  const specPath = path.join(petsRoot, petId, 'pet-spec.json');
  let spec;
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8'));
  } catch (error) {
    errors.push(`${petId}: cannot read ${path.relative(root, specPath)} (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const assetRoot = path.join(petsRoot, petId, 'assets');
  // 运行时只加载动画帧；core-ip 是仓库母版，留在 assets-original/，不进安装包。
  const expected = new Set((spec.states ?? []).flatMap((state) => state.frames ?? []).filter(Boolean));
  const coreAsset = spec.character?.coreAsset;
  if (coreAsset) {
    try {
      await access(path.join(petsRoot, petId, 'assets-original', coreAsset));
    } catch (error) {
      errors.push(`${petId}: missing master asset in assets-original: ${coreAsset}`);
    }
  }
  for (const name of expected) {
    if (name.includes('\\')) errors.push(`${petId}: asset paths must use forward slashes: ${name}`);
  }
  let actual = [];
  try {
    actual = await walk(assetRoot);
  } catch (error) {
    errors.push(`${petId}: cannot read assets directory (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const actualSet = new Set(actual);
  for (const name of expected) if (!actualSet.has(name)) errors.push(`${petId}: missing or case-mismatched runtime asset: ${name}`);
  for (const name of actual) if (!expected.has(name)) errors.push(`${petId}: orphan runtime PNG is not referenced by pet-spec.json: ${name}`);
  const folded = new Map();
  for (const name of actual) {
    const key = name.toLocaleLowerCase('en-US');
    const previous = folded.get(key);
    if (previous && previous !== name) errors.push(`${petId}: case-insensitive asset collision: ${previous} <> ${name}`);
    folded.set(key, name);
  }
  totalReferenced += expected.size;
}

for (const relative of ['frontend/src/renderer/pet/index.ts']) {
  const source = await readFile(path.join(root, relative), 'utf8');
  if (!/import\.meta\.glob\(\s*['"]\/src\/pets\/\*\*\/assets\/\*\*\/\*\.png['"]/u.test(source)) {
    errors.push(`${relative} must glob only packed assets (/src/pets/**/assets/**/*.png)`);
  }
  if (/['"]\/src\/pets\/\*\*\/\*\.png['"]/u.test(source)) {
    errors.push(`${relative} must not glob the whole src/pets tree (assets-original would be packed)`);
  }
}

if (errors.length) {
  console.error(`Runtime asset links: FAIL\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exit(1);
}
console.log(`Runtime asset links: PASS (${petDirs.length} pets, ${totalReferenced} referenced PNGs, no orphans).`);
