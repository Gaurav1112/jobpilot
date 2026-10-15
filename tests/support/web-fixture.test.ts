import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWebHome, fixtureApp, GOLDEN_ROUTES, GIG, JOB, NARROW_ONLY, normalise, removeWebHome, type WebHome } from './web-fixture.js';
import { rowOf, textOf } from './dom.js';

let w: WebHome;
beforeAll(() => {
  w = buildWebHome();
});
afterAll(() => removeWebHome(w.home));

describe('the fixture home', () => {
  it('serves every golden route with its expected status', async () => {
    for (const [name, path, status] of GOLDEN_ROUTES) expect((await fixtureApp(w.home).request(path)).status, name).toBe(status);
  });
  it('holds the cases Phase A changes: an applied job, a blocked one, a B2B note, a review gig, a skipped host', async () => {
    const jobs = await (await fixtureApp(w.home).request('/')).text();
    expect(textOf(rowOf(jobs, 'data-job', JOB.blocked))).toContain('Backend Engineer');
    expect(textOf(rowOf(jobs, 'data-job', JOB.b2b))).toContain('B2B contractor: no PF/benefits');
    expect(textOf(await (await fixtureApp(w.home).request('/freelance?tab=review')).text())).toContain('Hourly in CAD');
    expect(textOf(await (await fixtureApp(w.home).request('/companies')).text())).toContain('robots.txt refused');
    expect(textOf(await (await fixtureApp(w.home).request(`/freelance/${GIG.proposal}`)).text())).toContain('Your proposal');
  });
  it('is deterministic: the CSRF token is the only per-session value, and normalise replaces it', async () => {
    const a = normalise(await (await fixtureApp(w.home).request(`/jobs/${JOB.ready}`)).text());
    const b = normalise(await (await fixtureApp(w.home).request(`/jobs/${JOB.ready}`)).text());
    expect(a).toBe(b);
    expect(a).toContain('name="_csrf" value="x"');
    expect(a).not.toMatch(/[0-9a-f]{64}/);
  });
});

/** Every GET route in the dashboard source that renders a page (files, static and sent snapshots excluded). */
function pagePatterns(): string[] {
  const root = join(import.meta.dirname, '../..');
  const src = ['server.ts', 'freelance.ts', 'companies.ts'].map((f) => readFileSync(join(root, 'src/app/web', f), 'utf8')).join('\n');
  return [...src.matchAll(/app\.get\(\s*['`]([^'`]+)['`]/g)].map((m) => m[1] as string).filter((p) => !/\/(files|sent|static)\b/.test(p)).sort();
}

describe('the page inventory', () => {
  it('every GET page route has a golden and a 400 px check', () => {
    const paths = [...GOLDEN_ROUTES.map(([, p]) => p), ...NARROW_ONLY.map(([, p]) => p)].map((p) => p.split('?')[0] as string);
    const missing = pagePatterns().filter((pat) => !paths.some((p) => new RegExp(`^${pat.replace(/:[a-z]+/gi, '[^/]+')}$`).test(p)));
    expect(missing).toEqual([]);
  });
});
