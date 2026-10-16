import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privacyHomes, privacyTermsOf, scanForTerms } from '../../src/app/privacy.js';
import { createProfile } from '../../src/app/profiles/commands.js';

const repo = join(import.meta.dirname, '../..');
const clock = { now: () => '2026-10-15T08:00:00.000Z' };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-priv-'));
  createProfile({ root, id: 'asha', clock, fromPack: join(repo, 'tests/fixtures/pack') });
  createProfile({ root, id: 'lena', clock, fromPack: join(repo, 'tests/fixtures/pack') });
  writeFileSync(join(root, 'profiles/lena/pack/naming.yaml'), 'employerDisplay: {}\nforbiddenTerms: [Globex]\n');
  writeFileSync(join(root, 'profiles/lena/pack/contact.yaml'), 'name: Lena Vogel\nemail: lena.vogel@example.org\nphone: "+49 30 0000000"\ncity: Berlin\nlinks: []\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('privacy per profile', () => {
  it('each profile has its own terms; the city is not one', () => {
    expect(privacyTermsOf(join(root, 'profiles/asha'))).toEqual(expect.arrayContaining(['initech', 'asha rao', 'asha.rao@example.com', '919000000000', '1200000', '1,200,000', '12,00,000']));
    expect(privacyTermsOf(join(root, 'profiles/lena'))).toEqual(expect.arrayContaining(['globex', 'lena vogel', 'lena.vogel@example.org', '49300000000']));
    expect(privacyTermsOf(join(root, 'profiles/lena'))).not.toContain('berlin');
  });
  it('the scan names file, profile and term index, never the term', () => {
    const dir = join(root, 'repo');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), '// written for Lena Vogel\n');
    writeFileSync(join(dir, 'src/b.ts'), '// clean\n');
    const hits = scanForTerms(dir, privacyHomes({ JOBPILOT_ROOT: root, HOME: '/Users/x' }));
    expect(hits).toEqual(['src/a.ts (lena, term #2)']);
    expect(hits.join('\n')).not.toMatch(/lena vogel/i);
  });
  it('the machine files hold no personal data', () => {
    writeFileSync(join(root, 'adopt.json'), JSON.stringify({ id: 'asha', moved: ['pack'], legacyLabelsLoaded: [] }));
    const homes = privacyHomes({ JOBPILOT_ROOT: root, HOME: '/Users/x' });
    const machine = join(root, 'machine-view');
    mkdirSync(machine);
    for (const f of ['active-profile', 'adopt.json']) cpSync(join(root, f), join(machine, f));
    expect(scanForTerms(machine, homes)).toEqual([]);
  });
  it('a removed profile still counts', () => {
    mkdirSync(join(root, 'removed'));
    cpSync(join(root, 'profiles/lena'), join(root, 'removed/lena-20261015T080000Z'), { recursive: true });
    rmSync(join(root, 'profiles/lena'), { recursive: true });
    expect(privacyHomes({ JOBPILOT_ROOT: root, HOME: '/Users/x' }).map((h) => h.label)).toEqual(['asha', 'removed:lena']);
  });
});

describe('numbers match on digit boundaries', () => {
  const scan = (files: Record<string, string>): string[] => {
    const dir = join(root, 'repo');
    mkdirSync(dir);
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    return scanForTerms(dir, privacyHomes({ JOBPILOT_ROOT: root, HOME: '/Users/x' }));
  };
  it('finds a phone however it is spaced', () => {
    expect(scan({ 'a.md': 'call +49-30 000 0000 now\n', 'b.md': 'tel: (49) 30.000.0000\n' })).toEqual(['a.md (lena, term #4)', 'b.md (lena, term #4)']);
  });
  it('never finds a phone glued from numbers on different lines, or inside a longer number', () => {
    expect(scan({ 'glued.json': '[49, 30,\n 0, 0, 0, 0, 0, 0, 0]\n', 'id.json': '{"id":"1493000000001"}\n' })).toEqual([]);
  });
  it('finds the pay floor in every written form, standing alone (lena shares the fixture pack, so her floor too)', () => {
    expect(scan({ 'a.md': 'floor 1200000 INR\n', 'b.md': 'at least ₹12,00,000/yr\n', 'c.md': '(1,200,000).\n' })).toEqual(['a.md (asha, term #6)', 'a.md (lena, term #5)', 'b.md (asha, term #8)', 'b.md (lena, term #7)', 'c.md (asha, term #7)', 'c.md (lena, term #6)']);
  });
  it('never finds the pay floor inside a longer number, an id or a decimal', () => {
    expect(scan({ 'ids.jsonl': '{"url":"https://x.zohorecruit.in/jobs/careers/71200000098"}\n', 'key.ts': "upsert('w1200000001')\n", 'g.md': '112,00,000 and 1,200,000,000 and 0.1200000\n' })).toEqual([]);
  });
});
