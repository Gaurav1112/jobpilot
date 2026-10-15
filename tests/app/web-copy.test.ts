import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gigReasonText, GIG_REASON_CODES, reasonText } from '../../src/app/web/copy.js';
import { countText } from '../../src/app/web/format.js';
import { meta } from '../../src/app/web/views/common.js';
import { html } from '../../src/app/web/html.js';
import { elementsWith, textOf } from '../support/dom.js';
import { buildWebHome, fixtureApp, GIG, GOLDEN_ROUTES, JOB, removeWebHome, type WebHome } from '../support/web-fixture.js';

let w: WebHome;
beforeAll(() => {
  w = buildWebHome();
});
afterAll(() => removeWebHome(w.home));
const page = async (path: string): Promise<string> => (await fixtureApp(w.home).request(path)).text();

describe('A6: separators never dangle', () => {
  it('meta drops empty parts', () => {
    expect(meta(['GitLab', '', null, undefined, false, html``, 'via Himalayas']).value).toBe('<span>GitLab</span><span class="sep" aria-hidden="true">·</span><span>via Himalayas</span>');
    expect(meta([]).value).toBe('');
  });
  it('no fixture page has a separator next to another, or at the start or end of a line', async () => {
    for (const [name, path] of GOLDEN_ROUTES) {
      const body = await page(path);
      expect(body, name).not.toMatch(/<span class="sep" aria-hidden="true">·<\/span>\s*(<span class="sep"|<\/p>)/);
      expect(body, name).not.toMatch(/<p[^>]*>\s*<span class="sep"/);
    }
    expect(textOf(await page(`/jobs/${JOB.noLocation}`))).toContain('GitLabs Example · via Himalayas');
  });
});

describe('A6: reasons in words, codes only under Technical detail', () => {
  it('translates onsite and hybrid; every gig reason code has words', () => {
    expect(reasonText('onsite')).toBe('On-site only');
    expect(reasonText('hybrid')).toBe('Hybrid only, outside the cities you accept');
    for (const c of GIG_REASON_CODES) expect(gigReasonText(c), c).not.toMatch(/Technical detail|^[a-z-]+$/);
    expect(GIG_REASON_CODES).toEqual(expect.arrayContaining(['budget-below-floor', 'budget-preset', 'hours-over-cap', 'hours-unclear', 'rate-unclear', 'role-filter', 'closed', 'naming']));
  });
  it('a not-eligible row shows words only; the job page keeps the codes in a closed Technical detail', async () => {
    const list = await page('/?band=rejected');
    expect(list).not.toMatch(/<code>/);
    expect(textOf(list)).toContain('Not eligible: The title matches a role you filtered out; On-site only');
    const job = await page(`/jobs/${JOB.rejected}`);
    const tech = elementsWith(job, 'class', 'tech');
    expect(tech).toHaveLength(1);
    expect(tech[0]).not.toMatch(/<details[^>]*\sopen/);
    expect(textOf(tech[0] as string)).toBe('Technical detail role:front[- ]?end onsite');
    const gig = await page(`/freelance/${GIG.review}`);
    expect(textOf(gig)).toContain('The client picked a preset budget range');
    expect(elementsWith(gig, 'class', 'tech')).toHaveLength(1);
  });
});

describe('A6: numbers, the recommended format, gig labels and dashes', () => {
  it('counts use en-IN grouping', () => {
    expect([countText(7), countText(12_044), countText(570_418), countText(10_000_000)]).toEqual(['7', '12,044', '5,70,418', '1,00,00,000']);
  });
  it('the job page says which format to send and labels each download', async () => {
    const t = textOf(await page(`/jobs/${JOB.ready}`));
    expect(t).toContain('Recommended for Greenhouse: PDF.');
    expect(t).not.toMatch(/reads (PDF|Word)/);
    expect(t).toContain('Download PDF of the resume (recommended)');
    expect(t).toContain('Download Word (DOCX) of the cover letter');
  });
  it('gig rows label their facts, and the dashboard joins with a real dash', async () => {
    const t = textOf(await page('/freelance'));
    expect(t).toContain('Hours: 15 h/week');
    expect(t).toContain('Overlap: 4 hours overlap with US Eastern (your hours 18:00–00:00 IST)');
    expect(textOf(await page('/freelance?tab=gigs'))).toContain('Bids: 7');
  });
  it('the dashboard\'s own strings never join with " - " (§6.3); run-written notes are mapped in Phase B9', () => {
    const dir = join(import.meta.dirname, '../../src/app/web');
    const files = ['copy.ts', 'server.ts', 'freelance.ts', 'companies.ts', ...readdirSync(join(dir, 'views')).map((f) => `views/${f}`)];
    const offenders = files.flatMap((f) => {
      // comments and template expressions are code, not copy
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\$\{[^}]*\}/g, '');
      return [...src.matchAll(/(['`])[^'`\n]*\s-\s[^'`\n]*\1/g)].map((m) => `${f}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });
});
