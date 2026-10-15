import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boardKey, CATALOGUE_PER_WEEK, CATALOGUE_SEED, catalogueGuesses, dedupeGuesses, freehireGuesses, loadCatalogue, type CatalogueEntry } from '../../../src/app/coverage/catalogue.js';
import { freehireCompanyKey } from '../../../src/app/coverage/freehire-boards.js';
import { PlatformGuess, type CompanyVerdict } from '../../../src/app/coverage/types.js';
import { AppStore } from '../../../src/app/store/app-store.js';

const line = (o: Partial<CatalogueEntry> & { ref: string; platform: CatalogueEntry['platform'] }): string =>
  JSON.stringify({ boardUrl: `https://example.test/${o.ref}`, company: `Co ${o.ref}`, board: o.ref, evidence: 1, example: { title: 'Engineer', location: 'India', url: 'https://example.test/j' }, ...o });
const entry = (o: Partial<CatalogueEntry> & { ref: string; platform: CatalogueEntry['platform'] }): CatalogueEntry => JSON.parse(line(o)) as CatalogueEntry;

describe('loadCatalogue', () => {
  it('parses every line of a 3-line seed', () => {
    const text = [line({ platform: 'lever', ref: 'a' }), line({ platform: 'greenhouse', ref: 'b' }), line({ platform: 'ashby', ref: 'c' })].join('\n') + '\n';
    expect(loadCatalogue(text).map((e) => e.ref)).toEqual(['a', 'b', 'c']);
  });

  it('a bad line is an error naming its number', () => {
    const text = [line({ platform: 'lever', ref: 'a' }), '{"platform":"lever"', line({ platform: 'ashby', ref: 'c' })].join('\n');
    expect(() => loadCatalogue(text)).toThrow(/line 2/);
    const wrongShape = [line({ platform: 'lever', ref: 'a' }), JSON.stringify({ platform: 'nope', ref: 'x' })].join('\n');
    expect(() => loadCatalogue(wrongShape)).toThrow(/line 2/);
  });

  it('the vendored seed parses in full', () => {
    const all = loadCatalogue(readFileSync(CATALOGUE_SEED, 'utf8'));
    expect(all.length).toBeGreaterThan(1000);
  });
});

describe('catalogueGuesses', () => {
  const entries = [
    entry({ platform: 'lever', ref: 'low', evidence: 1 }),
    entry({ platform: 'lever', ref: 'top', evidence: 9 }),
    entry({ platform: 'greenhouse', ref: 'tie-b', evidence: 4 }),
    entry({ platform: 'ashby', ref: 'tie-a', evidence: 4 }),
    entry({ platform: 'greenhouse', ref: 'tie-a', evidence: 4 }),
  ];

  it('orders by evidence desc, then platform, then ref', () => {
    const { guesses, left } = catalogueGuesses(entries, new Set(), '2026-10-11');
    expect(guesses.map((g) => `${g.platform} ${g.slug}`)).toEqual(['lever top', 'ashby tie-a', 'greenhouse tie-a', 'greenhouse tie-b', 'lever low']);
    expect(left).toBe(0);
  });

  it('skips a known board key (any registry status) and counts what the limit leaves', () => {
    const known = new Set([boardKey('lever', 'TOP'), boardKey('greenhouse', 'tie-b')]);
    const { guesses, left } = catalogueGuesses(entries, known, '2026-10-11', 2);
    expect(guesses.map((g) => g.slug)).toEqual(['tie-a', 'tie-a']);
    expect(left).toBe(1);
  });

  it("an Eightfold board is one key with or without the verifier's stored API variant (v2:, pcsx:)", () => {
    const plain = boardKey('eightfold', 'apply.careers.microsoft.com/microsoft.com');
    expect(boardKey('eightfold', 'v2:apply.careers.microsoft.com/microsoft.com')).toBe(plain);
    expect(boardKey('eightfold', 'PCSX:Apply.Careers.Microsoft.com/microsoft.com')).toBe(plain);
    // only Eightfold slugs carry the variant: another platform's ref is kept whole
    expect(boardKey('lever', 'v2:x')).toBe('lever v2:x');
  });

  it('a registry row holding an Eightfold board under its stored variant (rejected) keeps the catalogue entry out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp-cat-'));
    const app = AppStore.open(join(dir, 'jobpilot.db'));
    try {
      const v: CompanyVerdict = {
        guess: {
          site: { candidate: { companyKey: 'microsoft.com', name: 'Microsoft', website: 'https://microsoft.com', careersUrl: null, source: 'remoteintech', runDate: '2026-10-04' }, careersUrl: 'https://careers.microsoft.com', method: 'listed', evidence: null },
          platform: 'eightfold', slug: 'v2:apply.careers.microsoft.com/microsoft.com', boardUrl: 'https://apply.careers.microsoft.com/api/apply/v2/jobs?domain=microsoft.com', signature: null, routedFrom: null, evidence: [],
        },
        status: 'verified', reasons: [], boardName: null, jobsSeen: 3,
      };
      app.upsertCompanyVerdict(v, '2026-10-04T00:00:00Z');
      expect(app.setCompanyOverride('microsoft.com', 'rejected', '2026-10-05T00:00:00Z')).toBe(true);
      const ms = entry({ platform: 'eightfold', ref: 'apply.careers.microsoft.com/microsoft.com', company: 'Microsoft', evidence: 291 });
      const { guesses, left } = catalogueGuesses([ms, entry({ platform: 'lever', ref: 'other' })], new Set(app.registryBoardKeys()), '2026-10-11');
      expect(guesses.map((g) => g.slug)).toEqual(['other']);
      expect(left).toBe(0);
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the default weekly limit is 300', () => {
    expect(CATALOGUE_PER_WEEK).toBe(300);
  });

  it('a guess is the D3 shape: derived key, no website, source freehire, week as run date', () => {
    const g = catalogueGuesses([entry({ platform: 'lever', ref: 'top', company: 'Top Co' })], new Set(), '2026-10-11').guesses[0] as PlatformGuess;
    expect(PlatformGuess.schema.safeParse(g).success).toBe(true);
    expect(g.site.candidate).toEqual({ companyKey: freehireCompanyKey('lever', 'top'), name: 'Top Co', website: '', careersUrl: null, source: 'freehire', runDate: '2026-10-11' });
    expect(g.platform).toBe('lever');
    expect(g.slug).toBe('top');
    expect(g.signature).toBe('freehire-catalogue:96b53a2c');
  });
});

describe('dedupeGuesses and the selection record', () => {
  it('the first of a board key wins, order kept', () => {
    const a = catalogueGuesses([entry({ platform: 'lever', ref: 'x', company: 'First' })], new Set(), 'w').guesses[0] as PlatformGuess;
    const b = catalogueGuesses([entry({ platform: 'lever', ref: 'X', company: 'Second' })], new Set(), 'w').guesses[0] as PlatformGuess;
    expect(dedupeGuesses([a, b]).map((g) => g.site.candidate.name)).toEqual(['First']);
  });

  it('freehireGuesses rebuilds recorded keys in the recorded order', () => {
    const es = [entry({ platform: 'lever', ref: 'one', evidence: 1 }), entry({ platform: 'lever', ref: 'two', evidence: 2 })];
    const g = freehireGuesses(es, [boardKey('lever', 'one'), boardKey('lever', 'two'), boardKey('lever', 'gone')], 'w');
    expect(g.map((x) => x.slug)).toEqual(['one', 'two']);
  });
});
