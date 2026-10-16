import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfile } from '../../src/app/profiles/commands.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { createRootDashboard } from '../../src/app/web/root.js';
import { fillJobs } from '../support/jobs-fixture.js';

const repo = join(import.meta.dirname, '../..');
const clock = { now: () => '2026-10-09T06:30:00.000Z' };
const SID = 'a'.repeat(32);
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-webroot-'));
  for (const id of ['asha', 'lena']) {
    createProfile({ root, id, clock, fromPack: join(repo, 'tests/fixtures/pack') });
    const app = AppStore.open(join(root, 'profiles', id, 'jobpilot.db'), { schema: 'migrate' });
    fillJobs(app, 3);
    app.close();
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = (app: ReturnType<typeof createRootDashboard>, path: string) => app.request(path, { headers: { host: 'localhost', cookie: `jp_sid=${SID}` } });
const tokenOf = async (app: ReturnType<typeof createRootDashboard>, id: string): Promise<string> => {
  const body = await (await get(app, `/p/${id}/facts`)).text();
  return /name="_csrf" value="([0-9a-f]{64})"/.exec(body)?.[1] ?? '';
};
const firstJob = (id: string): string => {
  const db = AppStore.open(join(root, 'profiles', id, 'jobpilot.db'));
  try {
    return db.listJobs({}).map((j) => j.jobKey).sort()[0] as string;
  } finally {
    db.close();
  }
};

describe('the root dashboard', () => {
  it('/ goes to the active profile; an unknown profile is 404', async () => {
    const app = createRootDashboard({ root, clock });
    const r = await get(app, '/');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/p/asha/');
    expect((await get(app, '/p/sam/')).status).toBe(404);
    expect((await get(app, '/p/lena')).headers.get('location')).toBe('/p/lena/');
  });
  it('each profile sees only its own jobs, and the switcher lists both', async () => {
    const app = createRootDashboard({ root, clock });
    const asha = await (await get(app, '/p/asha/')).text();
    expect(asha).toContain(`href="/p/asha/jobs/${firstJob('asha')}?`);
    expect(asha).not.toContain(`/p/lena/jobs/`);
    expect(asha).toMatch(/<nav class="profiles" aria-label="Profiles">[\s\S]*href="\/p\/asha\/" aria-current="page"[\s\S]*href="\/p\/lena\/"/);
  });
  it('CSRF is per profile: asha\'s token is refused on lena', async () => {
    const app = createRootDashboard({ root, clock });
    const ashaToken = await tokenOf(app, 'asha');
    const lenaToken = await tokenOf(app, 'lena');
    expect(ashaToken).not.toBe(lenaToken);
    const post = (token: string) => app.request(`/p/lena/jobs/${firstJob('lena')}/note`, { method: 'POST', headers: { host: 'localhost', cookie: `jp_sid=${SID}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${token}&note=hello` });
    expect((await post(ashaToken)).status).toBe(403);
    expect([200, 303]).toContain((await post(lenaToken)).status);
  });
  it('/p/<id> redirects only a known id; anything else is 404, never a 500 or a redirect to nowhere', async () => {
    const app = createRootDashboard({ root, clock });
    const r = await get(app, '/p/lena');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/p/lena/');
    for (const p of ['/p/Asha', '/p/sam', '/p/a%0d%0aSet-Cookie:x=1', '/p/%2F%2Fevil.example']) {
      const x = await get(app, p);
      expect(x.status, p).toBe(404);
      expect(x.headers.get('location'), p).toBeNull();
    }
  });
  it('a percent-encoded profile id is not a profile: 404, never a sliced path', async () => {
    const app = createRootDashboard({ root, clock });
    expect((await get(app, '/p/asha/facts')).status).toBe(200);
    for (const p of ['/p/%61sha/facts', '/p/%61sha/', '/p/asha%2Flena/']) {
      const x = await get(app, p);
      expect(x.status, p).toBe(404);
      expect(await x.text(), p).toBe('no such profile'); // refused at the root, never handed to a profile's dashboard
    }
  });
  it('a foreign Host is refused before routing', async () => {
    const app = createRootDashboard({ root, clock, port: 4317 });
    expect((await app.request('http://evil.example/', { headers: { host: 'evil.example' } })).status).toBe(403);
  });
  it('a root with no profiles says how to make one', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'jobpilot-webroot0-'));
    mkdirSync(join(empty, 'profiles'));
    const r = await createRootDashboard({ root: empty, clock }).request('/', { headers: { host: 'localhost' } });
    expect(await r.text()).toContain('jobpilot profile create');
    rmSync(empty, { recursive: true, force: true });
  });
});
