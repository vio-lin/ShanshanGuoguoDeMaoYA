import type { PetSpec } from './shared/contracts';
import ragdollSpec from './pets/ragdoll/pet-spec.json';
import niniSpec from './pets/nini/pet-spec.json';

export interface PetProfile {
  id: string;
  displayName: string;
  spec: PetSpec;
  /** require.context 中的子目录名（相对 src/pets） */
  assetDir: string;
}

/**
 * 宠物注册表：新增宠物时在此注册，并把素材与 pet-spec.json 放入
 * src/pets/<id>/ 目录（assets/ + pet-spec.json）。
 */
export const PET_PROFILES: PetProfile[] = [
  { id: 'ragdoll', displayName: '哈哈', spec: ragdollSpec as PetSpec, assetDir: 'ragdoll' },
  { id: 'nini', displayName: '妮妮', spec: niniSpec as PetSpec, assetDir: 'nini' },
];

export function getPetProfile(id: string): PetProfile | undefined {
  return PET_PROFILES.find((profile) => profile.id === id);
}
