import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scorePosting, type ScorerPack } from '../../../src/app/agents/scorer-lexicon.js';
import type { WritingPack } from '../../../src/app/agents/writing/grounded.js';
import { gigKey } from '../../../src/app/freelance/keys.js';
import { checklistMarkdown, networkPack, profileText, type NetworkPackResult } from '../../../src/app/freelance/networks.js';
import { evidenceFor, syntheticPosting } from '../../../src/app/freelance/writing/gig-evidence.js';
import { resumeProblems } from '../../../src/app/guardrails.js';
import { resolvePdftotext } from '../../../src/app/kernel.js';
import type { Network } from '../../../src/app/pack/freelance-schema.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { forbiddenTermStrict } from '../../../src/app/pack/rules.js';
import { Posting } from '../../../src/app/types.js';

const root = join(import.meta.dirname, '../../..');
const packDir = join(root, 'tests/fixtures/pack');
const AS_OF = '2026-10';
const MOONLIGHTING = "Before your first gig: check your employment contract's moonlighting and IP clauses.";

const { pack: full } = loadPack(packDir);
const { contact: _c, answers: _a, ...pub } = full;
const pack = pub as unknown as WritingPack;
const naming = { forbiddenTerms: full.naming.forbiddenTerms };
const networks = full.networks;
const toptal = networks.find((n) => n.id === 'toptal') as Network;

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?])\s+/u).filter((s) => s !== '');

describe('gig evidence', () => {
  it('syntheticPosting builds a valid Posting@1 keyed as a synthetic gig', () => {
    const p = syntheticPosting({ key: 'toptal', title: 'backend engineer', company: 'Toptal', text: 'backend, microservices', firstSeen: '2026-10-01' });
    expect(Posting.schema.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ ats: 'feed', source: 'gig', sourceId: 'toptal', jobKey: gigKey('synthetic', 'toptal'), comp: null, yearsRequired: null });
    expect(p.remote.structured).toBe('remote');
    expect(p.remote.countries).toEqual(['worldwide']);
    expect(p.descriptionText).toBe('backend, microservices');
  });

  it('evidenceFor scores the posting with the real scorer, as G-GROUND re-derives it', () => {
    const p = syntheticPosting({ key: 'toptal', title: 'backend engineer', company: 'Toptal', text: 'microservices, distributed systems', firstSeen: '2026-10-01' });
    const ev = evidenceFor(p, pack, pub);
    expect(ev.scored).toEqual(scorePosting({ posting: p, verdict: 'eligible', reasons: [], notes: [] }, pub as unknown as ScorerPack));
    expect(ev.covered).toContain('microservices');
  });
});

describe('networkPack', () => {
  const r = networkPack(toptal, pack, AS_OF, pub);

  it('toptal has no grounding problems', () => {
    expect(r.networkId).toBe('toptal');
    expect(r.problems).toEqual([]);
  });

  it('every fixture network passes resumeProblems (G-GROUND at full strength)', () => {
    expect(networks.length).toBe(8);
    for (const net of networks) {
      const res = networkPack(net, pack, AS_OF, pub);
      expect(res.problems, net.id).toEqual([]);
      expect(resumeProblems(res.resume, pack, '', pub), net.id).toEqual([]);
    }
  });

  it('gives one profile entry per profile field, each within its maxChars', () => {
    expect(r.profile.map((p) => p.id)).toEqual(toptal.profileFields.map((f) => f.id));
    for (const f of toptal.profileFields) {
      const p = r.profile.find((x) => x.id === f.id);
      expect(p?.text.length, f.id).toBeLessThanOrEqual(f.maxChars);
      expect(p?.text.length, f.id).toBeGreaterThan(0);
    }
  });

  it('every profile sentence is a substring of the resume headline, summary or skills line', () => {
    const sources = [r.resume.headline, r.resume.summary.text, r.resume.skills.join(', ')];
    for (const net of networks) {
      const res = networkPack({ ...net, profileFields: [...net.profileFields, { id: 'skills', maxChars: 60 }] }, pack, AS_OF, pub);
      for (const p of res.profile) for (const s of sentencesOf(p.text)) expect(sources.some((src) => src.includes(s)), `${net.id}/${p.id}: ${s}`).toBe(true);
    }
  });

  it('cuts at whole sentences, never mid-sentence, and refuses a first sentence over the limit', () => {
    const full = r.resume.summary.text;
    const first = sentencesOf(full)[0] as string;
    const cut = networkPack({ ...toptal, profileFields: [{ id: 'summary', maxChars: first.length + 1 }] }, pack, AS_OF, pub);
    expect(cut.profile[0]?.text).toBe(first);
    expect(cut.problems).toEqual([]);
    const tooShort = networkPack({ ...toptal, profileFields: [{ id: 'headline', maxChars: 3 }] }, pack, AS_OF, pub);
    expect(tooShort.profile[0]?.text).toBe('');
    expect(tooShort.problems).toEqual([`profile field headline: the first sentence has ${r.resume.headline.length} characters, the limit is 3`]);
  });

  it('cuts the skills field at whole skills', () => {
    const line = r.resume.skills.join(', ');
    const res = networkPack({ ...toptal, profileFields: [{ id: 'skills', maxChars: 20 }] }, pack, AS_OF, pub);
    const text = res.profile[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(20);
    expect(line.startsWith(text)).toBe(true);
    expect(r.resume.skills).toContain(text.split(', ').at(-1));
  });

  it('a profile field with no verified source is a problem', () => {
    const res = networkPack({ ...toptal, profileFields: [{ id: 'hourly-rate', maxChars: 10 }] }, pack, AS_OF, pub);
    expect(res.problems).toEqual(['profile field #1 (hourly-rate) has no verified source']);
  });

  it('missing lists the network keywords no fact backs, sorted', () => {
    expect(r.missing).toContain('backend');
    expect(r.missing).toContain('cloud');
    expect(r.missing).not.toContain('microservices');
    expect(r.missing).toEqual([...r.missing].sort());
  });

  it('refuses a forbidden term in a keyword or target title, never letting it reach the output', () => {
    const planted: Network = { ...toptal, keywords: [...toptal.keywords, 'Initech'], targetTitles: ['Initech engineer', ...toptal.targetTitles] };
    const res = networkPack(planted, pack, AS_OF, pub);
    expect(res.problems).toEqual(['G-NAMING: network keyword #5 names a forbidden term', 'G-NAMING: target title #1 names a forbidden term']);
    expect(res.missing).not.toContain('Initech');
    expect(forbiddenTermStrict(JSON.stringify(res), naming)).toBeUndefined();
    expect(forbiddenTermStrict(profileText(planted, res), naming)).toBeUndefined();
    expect(forbiddenTermStrict(checklistMarkdown(planted, res, pack), naming)).toBeUndefined();
    for (const p of res.problems) expect(forbiddenTermStrict(p, naming)).toBeUndefined();
  });

  it('builds the vetting checklist, citing only verified facts whose tech the stage names', () => {
    expect(r.checklist.map((c) => c.stage)).toEqual(toptal.screening.map((s) => s.stage));
    expect(r.checklist.map((c) => c.prep)).toEqual(toptal.screening.map((s) => s.prep));
    const withKafka = networkPack({ ...toptal, screening: [{ stage: 'Kafka deep dive', prep: ['Event streams'] }] }, pack, AS_OF, pub);
    const ev = withKafka.checklist[0]?.evidence ?? [];
    expect(ev).toContain('f-nw-01');
    expect(ev).toEqual([...ev].sort());
    for (const id of ev) expect(['verified', 'user-stated']).toContain(full.facts.find((f) => f.id === id)?.status);
  });

  it('checklist.md starts with the moonlighting line and flags an unchecked network file', () => {
    const md = checklistMarkdown(toptal, r, pack);
    expect(md.split('\n')[0]).toBe(MOONLIGHTING);
    expect(md).toContain(`Network file not yet checked by you: verify the stages at ${toptal.url}`);
    const checked = checklistMarkdown({ ...toptal, checkedByUser: true }, r, pack);
    expect(checked).not.toContain('Network file not yet checked by you');
  });

  it('is deterministic', () => {
    const again = networkPack(toptal, pack, AS_OF, pub);
    expect(JSON.stringify(again)).toBe(JSON.stringify(r));
    expect(profileText(toptal, again)).toBe(profileText(toptal, r));
    expect(checklistMarkdown(toptal, again, pack)).toBe(checklistMarkdown(toptal, r, pack));
  });

  it('result type carries every field', () => {
    const keys: (keyof NetworkPackResult)[] = ['networkId', 'resume', 'profile', 'checklist', 'problems', 'missing'];
    for (const k of keys) expect(r).toHaveProperty(k);
  });
});

const hasPdftotext = (() => {
  try {
    resolvePdftotext();
    return true;
  } catch {
    return false;
  }
})();

describe('jobpilot networks (CLI)', () => {
  let home: string;
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home } });
  const outOf = (id: string) => join(home, 'out/networks', id);

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'jobpilot-networks-'));
    cpSync(packDir, join(home, 'pack'), { recursive: true });
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('lists the networks', () => {
    const r = cli('networks', 'list');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const n of networks) expect(r.stdout).toMatch(new RegExp(`^${n.id}\\b`, 'm'));
  });

  it.skipIf(!hasPdftotext)('networks pack writes the four files, deterministically, with no forbidden term', () => {
    const first = cli('networks', 'pack', 'toptal');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const dir = outOf('toptal');
    for (const f of ['resume.pdf', 'resume.docx', 'profile.txt', 'checklist.md']) expect(existsSync(join(dir, f)), f).toBe(true);
    const checklist = readFileSync(join(dir, 'checklist.md'), 'utf8');
    expect(checklist.split('\n')[0]).toBe(MOONLIGHTING);
    expect(checklist).toContain(MOONLIGHTING);
    const profile = readFileSync(join(dir, 'profile.txt'), 'utf8');
    const pdf = execFileSync(resolvePdftotext(), ['-layout', join(dir, 'resume.pdf'), '-'], { encoding: 'utf8' });
    for (const t of [pdf, profile, checklist]) expect(forbiddenTermStrict(t, naming)).toBeUndefined();
    expect(pdf).toContain('Northwind Labs');
    const second = cli('networks', 'pack', 'toptal');
    expect(second.status).toBe(0);
    expect(readFileSync(join(dir, 'profile.txt'), 'utf8')).toBe(profile);
    expect(readFileSync(join(dir, 'checklist.md'), 'utf8')).toBe(checklist);
  }, 60_000);

  it.skipIf(!hasPdftotext)('networks pack --all writes every network', () => {
    const r = cli('networks', 'pack', '--all');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const n of networks) expect(existsSync(join(outOf(n.id), 'resume.pdf')), n.id).toBe(true);
  }, 120_000);

  it('refuses an unknown network id', () => {
    const r = cli('networks', 'pack', 'nope');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown network nope/);
    expect(existsSync(outOf('nope'))).toBe(false);
  });

  it('refuses a planted forbidden keyword and prints only the redacted problem', () => {
    const file = join(home, 'pack/networks/lemon.yaml');
    const before = readFileSync(file, 'utf8');
    rmSync(outOf('lemon'), { recursive: true, force: true });
    writeFileSync(file, before.replace('keywords: [', 'keywords: [Initech, '));
    try {
      const r = cli('networks', 'pack', 'lemon');
      expect(r.status).toBe(1);
      expect(r.stderr).not.toMatch(/initech/i);
      expect(r.stdout).not.toMatch(/initech/i);
      expect(r.stderr).toMatch(/networks/);
      expect(existsSync(outOf('lemon'))).toBe(false);
    } finally {
      writeFileSync(file, before);
    }
  });
});
