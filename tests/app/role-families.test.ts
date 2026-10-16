import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAMILIES_GENERATED, renderRoleFamilies } from '../../scripts/gen-role-families.js';
import { titlePasses } from '../../src/app/agents/sources/platforms/shared.js';
import { scoreText } from '../../src/app/agents/scorer-lexicon.js';
import { effectiveTargets, ROLE_FAMILY_IDS, roleFamily } from '../../src/app/profiles/families.js';
import { loadPack } from '../../src/app/pack/load.js';
import { TargetsSchema } from '../../src/app/pack/schema.js';

const repo = join(import.meta.dirname, '../..');
const { pack } = loadPack(join(repo, 'tests/fixtures/pack'));

describe('role families', () => {
  it('the twelve families of the spec', () => {
    expect([...ROLE_FAMILY_IDS]).toEqual(['backend', 'frontend', 'full-stack', 'data', 'ml-ai', 'devops-sre', 'qa', 'mobile', 'security', 'product-design', 'solutions-support', 'technical-writing']);
    for (const id of ROLE_FAMILY_IDS) expect(roleFamily(id).titles.length).toBeGreaterThan(0);
  });
  it('absent: the very same targets object (the existing profile is untouched)', () => {
    expect(effectiveTargets(pack.targets)).toBe(pack.targets);
  });
  it('the schema takes a family and refuses an unknown one', () => {
    expect(TargetsSchema.parse({ ...pack.targets, roleFamily: 'frontend' }).roleFamily).toBe('frontend');
    expect(() => TargetsSchema.parse({ ...pack.targets, roleFamily: 'astronaut' })).toThrow();
  });
  it('empty titles take the family\'s; the person\'s own lists win', () => {
    const fe = { ...pack.targets, roleFamily: 'frontend' as const, titles: [], titleBonusWords: [] };
    expect(effectiveTargets(fe).titles).toEqual(roleFamily('frontend').titles);
    expect(effectiveTargets({ ...fe, titles: ['ui engineer'] }).titles).toEqual(['ui engineer']);
    // The fixture pack denies front-end roles (it is a backend search); a frontend person's pack would not.
    const p = { ...pack, filters: { ...pack.filters, roleDeny: [] }, targets: fe };
    expect(titlePasses('Senior Frontend Engineer', p)).toBe(true);
    expect(titlePasses('Senior Backend Engineer', p)).toBe(false);
    expect(scoreText('React Frontend Engineer', 'Build UIs.', null, p).breakdown.some((b) => b.label === 'title:family')).toBe(true);
  });
  it('the family\'s own bonus words fill only an empty list', () => {
    const own = { ...pack.targets, roleFamily: 'data' as const, titles: [], titleBonusWords: ['warehouse'] };
    expect(effectiveTargets(own).titleBonusWords).toEqual(['warehouse']);
    expect(effectiveTargets(own).titles).toEqual(roleFamily('data').titles);
  });
  it('families.generated.ts is exactly what role-families.yaml compiles to, and does no I/O', () => {
    const committed = readFileSync(FAMILIES_GENERATED, 'utf8');
    expect(committed, 'src/app/profiles/families.generated.ts is out of date: run `node --run families:gen`').toBe(renderRoleFamilies());
    expect(committed.match(/^import .*$/gm)).toEqual(["import type { RoleFamilyData, RoleFamilyId } from './families.js';"]);
  });
});
