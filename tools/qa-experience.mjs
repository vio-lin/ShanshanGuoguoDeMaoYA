import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const qaDirectory = path.join(root, 'qa');
await mkdir(qaDirectory, { recursive: true });
const issues = [];

// 多宠物模式遍历 src/pets/*；显式 --pets=0 或目录不存在时回退根 pet-spec.json + src/assets/pet。
async function resolveTargets() {
  const petsRoot = path.join(root, 'src', 'pets');
  const targets = [];
  let entries = [];
  try { entries = (await readdir(petsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()); } catch { entries = []; }
  if (entries.length) {
    for (const entry of entries) {
      const specPath = path.join(petsRoot, entry.name, 'pet-spec.json');
      const spec = JSON.parse(await readFile(specPath, 'utf8'));
      targets.push({ petId: entry.name, spec, assetDirectory: path.resolve(petsRoot, entry.name, 'assets') });
    }
    return targets;
  }
  const spec = JSON.parse(await readFile(path.join(root, 'pet-spec.json'), 'utf8'));
  targets.push({ petId: '', spec, assetDirectory: path.join(root, 'src', 'assets', 'pet') });
  return targets;
}

const targets = await resolveTargets();
const summary = { pets: targets.map((target) => target.petId || '(root)') };

for (const target of targets) {
  const { petId, spec, assetDirectory } = target;
  const tag = petId ? `[${petId}] ` : '';
  const usedFiles = new Set();
  usedFiles.add(spec.character.coreAsset.replaceAll('\\', '/'));
  const triggerOwners = new Map();
  const stateById = new Map(spec.states.map((state) => [state.id, state]));

  for (const state of spec.states) {
    for (const frame of state.frames) usedFiles.add(frame.replaceAll('\\', '/'));
    if (!state.triggers.length) issues.push({ gate: 'reachability', petId, state: state.id, message: `${tag}state has no runtime trigger` });
    for (const trigger of state.triggers) {
      if (triggerOwners.has(trigger)) issues.push({ gate: 'reachability', petId, state: state.id, message: `${tag}trigger ${trigger} is already owned by ${triggerOwners.get(trigger)}` });
      triggerOwners.set(trigger, state.id);
    }
  }
  for (const interaction of spec.experience.interactions) {
    const state = stateById.get(interaction.stateId);
    if (!state) issues.push({ gate: 'interaction', petId, interaction: interaction.id, message: `${tag}missing state ${interaction.stateId}` });
    else if (state.frames.length < 2) issues.push({ gate: 'motion', petId, interaction: interaction.id, message: `${tag}interaction state needs at least two distinct frames` });
    if (triggerOwners.get(`interaction:${interaction.id}`) !== interaction.stateId) issues.push({ gate: 'interaction', petId, interaction: interaction.id, message: `${tag}menu action, trigger and stateId are not connected` });
  }
  const multiFrameStates = spec.states.filter((state) => state.frames.length >= 2).map((state) => state.id);
  if (multiFrameStates.length < 4) issues.push({ gate: 'motion', petId, message: `${tag}fewer than four multi-frame states` });
  if (!spec.motion.breathing.enabled && !spec.motion.squashStretch.enabled) issues.push({ gate: 'motion', petId, message: `${tag}both procedural breathing and squash/stretch are disabled` });
  let files = [];
  try {
    files = (await readdir(assetDirectory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
      .map((entry) => path.relative(assetDirectory, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  } catch {
    issues.push({ gate: 'asset-coverage', petId, message: `${tag}asset directory missing: ${path.relative(root, assetDirectory)}` });
  }
  const unusedAssets = files.filter((file) => !usedFiles.has(file));
  const missingAssets = [...usedFiles].filter((file) => !files.includes(file));
  for (const file of unusedAssets) issues.push({ gate: 'asset-coverage', petId, file, message: `${tag}PNG exists but neither a runtime state nor coreAsset references it` });
  for (const file of missingAssets) issues.push({ gate: 'asset-coverage', petId, file, message: `${tag}pet-spec references a missing PNG` });
  summary[petId || 'root'] = { states: spec.states.length, triggers: triggerOwners.size, interactions: spec.experience.interactions.length, multiFrameStates, unusedAssets, missingAssets };
}

const report = {
  generatedAt: new Date().toISOString(),
  passed: issues.length === 0,
  summary,
  issues,
};
await writeFile(path.join(qaDirectory, 'experience-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const petStats = targets.map((target) => `${target.petId || 'root'}:${summary[target.petId || 'root'].states}states/${summary[target.petId || 'root'].triggers}triggers`).join(' ');
console.log(`Experience QA: ${report.passed ? 'PASS' : 'FAIL'} (${petStats})`);
if (!report.passed) {
  for (const issue of issues) console.error(`- [${issue.gate}] ${issue.message}${issue.file ? `: ${issue.file}` : ''}`);
  process.exit(1);
}
