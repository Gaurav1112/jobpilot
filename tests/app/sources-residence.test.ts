import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { namesIndia, namesOffice, namesResidence } from '../../src/app/agents/sources/platforms/shared.js';
import { sitemalCountry } from '../../src/app/agents/sources/platforms/successfactors.js';
import { reasonLabel } from '../../src/app/coverage/probe.js';
import { DEFAULT_RESIDENCE, residenceScope } from '../../src/app/geo/residence.js';
import { runEightfold, runOracle, runSuccessFactors, runWorkday, sourceFixture, withoutRemote, type WorkdayFixture } from '../support/platform-run.js';

/**
 * Profiles Task 14: the registry platform adapters read the residence country's lists (the pack's
 * `eligibility.residence`), on fixtures derived from the recorded India boards by fixed substitutions
 * (`tests/fixtures/sources/residence/de-*.json`: Bengaluru → Berlin, India → Germany, IN → DE, …). For `IN` every
 * request, note and output is today's (the existing adapter suites, unedited).
 */

const DE = { residence: 'DE', officeCities: ['berlin'] } as const;
const said = (r: { requests: { url: string; body?: string }[] }, re: RegExp): boolean => r.requests.some((q) => re.test(q.url) || re.test(q.body ?? ''));

type Facet = { descriptor?: string; id?: string; values?: Facet[] };
const facetIds = (fixture: string, pick: (descriptor: string) => boolean): string[] => {
  const out: string[] = [];
  const walk = (ns: readonly Facet[]): void => {
    for (const n of ns) {
      if (n.values !== undefined) walk(n.values);
      else if (n.id !== undefined && pick(n.descriptor ?? '')) out.push(n.id);
    }
  };
  walk(sourceFixture<{ discovery: { facets: Facet[] } }>(fixture).discovery.facets);
  return out;
};
const applied = (r: { requests: { body?: string }[] }): Record<string, string[]>[] =>
  r.requests.filter((q) => q.body !== undefined).map((q) => (JSON.parse(q.body as string) as { appliedFacets: Record<string, string[]> }).appliedFacets);

describe('Workday reads the residence country', () => {
  it('a German profile reads the Germany list and the Berlin office list, not India', async () => {
    const r = await runWorkday('residence/de-workday-nvidia.json', DE);
    const lists = applied(r);
    const germanSites = facetIds('residence/de-workday-nvidia.json', (d) => /^Germany, /.test(d));
    const berlin = facetIds('residence/de-workday-nvidia.json', (d) => d === 'Germany, Berlin');
    expect(lists).toContainEqual({ locations: germanSites });
    expect(lists).toContainEqual({ locations: berlin });
    expect(said(r, /India/)).toBe(false);
    expect(r.postings.length).toBeGreaterThan(0);
    // the residence-named notes
    expect(r.skipped.some((s) => s.startsWith('short-list Acme (Germany list)'))).toBe(true);
    expect(r.skipped.some((s) => /not India-named/.test(s))).toBe(false);
    // the Berlin office list stamps its jobs
    expect(r.postings.some((p) => ((p.raw as { officeLocations?: string[] }).officeLocations ?? []).includes('Germany, Berlin'))).toBe(true);
  });

  it('the same fixture for an IN profile skips with the India note', async () => {
    const r = await runWorkday(withoutRemote(sourceFixture<WorkdayFixture>('residence/de-workday-nvidia.json')), { residence: 'IN' });
    expect(r.skipped.some((s) => s.startsWith('no-india-or-remote-facet '))).toBe(true);
  });

  it('a German profile on a board with no German facet gets the generic note', async () => {
    const r = await runWorkday(withoutRemote(sourceFixture<WorkdayFixture>('workday-nvidia.json')), { residence: 'DE' });
    expect(r.skipped).toContain('no-germany-or-remote-facet Acme: its location facets name neither Germany nor a remote type');
  });

  it('IN, written or not, reads the India list exactly as before', async () => {
    const india = facetIds('workday-nvidia.json', (d) => /^India, /.test(d));
    for (const elig of [{}, { residence: 'IN' }, { residence: 'in' }]) {
      const r = await runWorkday('workday-nvidia.json', elig);
      expect(applied(r)).toContainEqual({ locations: india });
      expect(r.skipped.some((s) => s.startsWith('short-list Acme (india list)'))).toBe(true);
    }
  });
});

describe('Eightfold reads the residence country', () => {
  it('a German profile searches location=Germany, not India', async () => {
    const r = await runEightfold('residence/de-eightfold-microsoft.json', DE, 'Germany');
    expect(said(r, /[?&]location=Germany(&|$)/)).toBe(true);
    expect(said(r, /India/)).toBe(false);
    expect(r.postings.length).toBeGreaterThan(0);
    expect(r.skipped.some((s) => s.startsWith('short-list Acme (Germany list)'))).toBe(true);
  });

  it('the same fixture for an IN profile skips with the India note', async () => {
    const r = await runEightfold('residence/de-eightfold-microsoft.json', { residence: 'IN' }, 'India');
    expect(r.skipped.some((s) => s.startsWith('no-india-or-remote-facet '))).toBe(true);
    expect(r.postings).toEqual([]);
  });

  it('a German profile on a board with no German value gets the generic note', async () => {
    const r = await runEightfold('eightfold-microsoft.json', { residence: 'DE' }, 'Germany');
    expect(r.skipped).toContain('no-germany-or-remote-facet Acme: its locations facet names neither Germany nor a remote type');
  });
});

describe('Oracle reads the residence country', () => {
  it('a German profile reads the exact "Germany" location value, and German requisitions are rank 0', async () => {
    const r = await runOracle('residence/de-oracle-jpmorgan.json', DE);
    expect(said(r, /locationId=300000000289360/)).toBe(true);
    expect(said(r, /India/)).toBe(false);
    expect(r.postings.length).toBeGreaterThan(0);
    expect(r.skipped.some((s) => s.startsWith('short-list Acme (Germany list)'))).toBe(true);
    // details only for rank-0 (Germany-named) jobs: at least one asked
    expect(r.requests.some((q) => q.url.includes('recruitingCEJobRequisitionDetails'))).toBe(true);
  });

  it('the same fixture for an IN profile skips with the India note', async () => {
    const r = await runOracle('residence/de-oracle-jpmorgan.json', { residence: 'IN' });
    expect(r.skipped.some((s) => s.startsWith('no-india-or-remote-facet '))).toBe(true);
  });

  it('a German profile on a board with no German value gets the generic note', async () => {
    const r = await runOracle('oracle-jpmorgan.json', { residence: 'DE' });
    expect(r.skipped).toContain('no-germany-or-remote-facet Acme: its location facets name neither Germany nor a remote workplace type');
  });
});

describe('SuccessFactors reads the residence country', () => {
  const pages = (name: string): string => readFileSync(join(import.meta.dirname, '../fixtures/pages', name), 'utf8');
  const HOST = 'careers.hcltech.com';

  it('sitemalCountry: home, other or unknown, by the residence', () => {
    expect(sitemalCountry('DE', residenceScope('DE'))).toBe('home');
    expect(sitemalCountry('Berlin, Germany', residenceScope('DE'))).toBe('home');
    expect(sitemalCountry('IN', residenceScope('DE'))).toBe('other');
    expect(sitemalCountry('IN', DEFAULT_RESIDENCE)).toBe('home');
    expect(sitemalCountry('Bengaluru, Karnataka', DEFAULT_RESIDENCE)).toBe('home');
    expect(sitemalCountry('DE', DEFAULT_RESIDENCE)).toBe('other');
    expect(sitemalCountry(null, residenceScope('DE'))).toBe('unknown');
    expect(sitemalCountry('IN')).toBe('home');
  });

  it('a German profile reads no Indian item, with the Germany note', async () => {
    const r = await runSuccessFactors(HOST, pages('successfactors-hcltech-robots.txt'), pages('successfactors-hcltech-sitemal.xml'), { residence: 'DE' });
    expect(r.postings).toEqual([]);
    expect(r.skipped).toContain('not-germany Acme: 22 listed jobs located outside Germany not read');
  });
});

describe('the residence helpers', () => {
  it('namesResidence', () => {
    expect(namesResidence('Berlin, BE, DE', residenceScope('DE'))).toBe(true);
    expect(namesResidence('Germany, Berlin', residenceScope('DE'))).toBe(true);
    expect(namesResidence('Bengaluru, KA, IN', residenceScope('DE'))).toBe(false);
    expect(namesResidence('Bengaluru, KA, IN', DEFAULT_RESIDENCE)).toBe(true);
    expect(namesResidence('Indianapolis, IN', DEFAULT_RESIDENCE)).toBe(false);
    expect(namesIndia('Bengaluru, KA, IN')).toBe(true);
    expect(namesIndia('Berlin, BE, DE')).toBe(false);
  });

  it('namesOffice reads the residence country', () => {
    const de = residenceScope('DE');
    expect(namesOffice('Germany, Berlin', ['berlin'], de)).toBe(true);
    expect(namesOffice('München, Germany', ['munich'], de)).toBe(true);
    expect(namesOffice('Berlin, Germany', ['berlin'])).toBe(false);
    expect(namesOffice('India, Bengaluru', ['bengaluru'])).toBe(true);
    expect(namesOffice('India, Bengaluru', ['bengaluru'], de)).toBe(false);
  });

  it('the coverage probe labels any residence facet skip and country skip', () => {
    expect(reasonLabel('no-germany-or-remote-facet Acme: its location facets name neither Germany nor a remote type', 'x')).toBe('no-germany-or-remote-facet');
    expect(reasonLabel('no-united-states-or-remote-facet Acme: …', 'x')).toBe('no-united-states-or-remote-facet');
    expect(reasonLabel('no-india-or-remote-facet Acme: …', 'x')).toBe('no-india-or-remote-facet');
    expect(reasonLabel('not-germany Acme: 3 listed jobs located outside Germany not read', 'x')).toBe('not-germany');
    expect(reasonLabel('not-a-thing here', 'failed')).toBe('failed');
  });
});
