/**
 * Targets per role family (profiles spec §6). The families and their starter lists live in the readable
 * `data/role-families.yaml`, compiled by `scripts/gen-role-families.ts` into the pure `families.generated.ts`: the
 * title pre-filter and the scorer (agent code) read this module, and the containment scan forbids file I/O there.
 */
import { ROLE_FAMILIES } from './families.generated.js';

export const ROLE_FAMILY_IDS = ['backend', 'frontend', 'full-stack', 'data', 'ml-ai', 'devops-sre', 'qa', 'mobile', 'security', 'product-design', 'solutions-support', 'technical-writing'] as const;
export type RoleFamilyId = (typeof ROLE_FAMILY_IDS)[number];

/** One family's entry in role-families.yaml. */
export interface RoleFamilyData {
  readonly display: string;
  readonly titles: readonly string[];
  readonly bonusWords: readonly string[];
}

export function roleFamily(id: RoleFamilyId): { id: RoleFamilyId; display: string; titles: string[]; bonusWords: string[] } {
  const f = ROLE_FAMILIES[id];
  return { id, display: f.display, titles: [...f.titles], bonusWords: [...f.bonusWords] };
}

/** The targets a run uses: the same object when no family is set; else the family fills only lists the person left empty. */
export function effectiveTargets<T extends { titles: string[]; titleBonusWords: string[]; roleFamily?: RoleFamilyId | undefined }>(t: T): T {
  if (t.roleFamily === undefined) return t;
  const f = roleFamily(t.roleFamily);
  return { ...t, titles: t.titles.length > 0 ? t.titles : f.titles, titleBonusWords: t.titleBonusWords.length > 0 ? t.titleBonusWords : f.bonusWords };
}
