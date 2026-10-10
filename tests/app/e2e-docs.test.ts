import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { formatSummary, runDaily, type DailySummary } from '../../src/app/run.js';
import { AppStore, type JobView } from '../../src/app/store/app-store.js';
import type { Fact } from '../../src/app/pack/schema.js';
import { forbiddenTermStrict } from '../../src/app/pack/rules.js';
import { docxText } from '../../src/app/render/docx.js';
import { execFileSync } from 'node:child_process';
import { createDashboard } from '../../src/app/web/server.js';
import { overrideFact } from '../../src/app/project.js';
import { loadPack } from '../../src/app/pack/load.js';
import { diskDocCheck } from '../../src/app/docs-check.js';

/**
 * Documents across runs (final review I1, I2, I3): each test has its own home with the fictional fixture pack and the
 * offline fixture boards.
 */
const repo = join(import.meta.dirname, '../..');
const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

export function docsHome() {
  const home = mkdtempSync(join(tmpdir(), 'jp-docs-'));
  cpSync(join(repo, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
  const offline = offlineProviders(join(repo, 'tests/fixtures/e2e'));
  const clock = { t: '2026-10-09T01:30:00.000Z', now() { return this.t; } };
  const notes: string[] = [];
  const db = join(home, 'jobpilot.db');
  const withApp = <T>(f: (a: AppStore) => T): T => {
    const a = AppStore.open(db);
    try {
      return f(a);
    } finally {
      a.close();
    }
  };
  return {
    home,
    clock,
    notes,
    run: (extra: Partial<Parameters<typeof runDaily>[0]> = {}): Promise<DailySummary> =>
      runDaily({ home, clock, fetch: offline.fetch, browser: offline.browser, notifier: async (s) => void notes.push(s), sleep: async () => {}, pdftotext: pdftotext as string, ...extra }),
    jobs: (): JobView[] => withApp((a) => a.listJobs({ band: ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'], duplicates: true })),
    override: (id: string, status: Fact['status']) => withApp((a) => a.setFactOverride(id, status, clock.t)),
    withApp,
    shaOf: (rel: string) => createHash('sha256').update(readFileSync(join(home, 'out', rel))).digest('hex'),
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

const ready = (js: readonly JobView[]) => js.filter((j) => j.docsState === 'ready').map((j) => j.jobKey).sort();

describe.skipIf(pdftotext === undefined)('I1: documents heal themselves after an A -> B -> A pack history', () => {
  it('verify a fact, then undo the verification: the documents come back ready with no manual rebuild', async () => {
    const h = docsHome();
    try {
      const run1 = await h.run();
      const readyA = ready(h.jobs());
      expect(readyA.length).toBeGreaterThan(0);
      const files = h.withApp((a) => readyA.flatMap((k) => a.getJob(k)?.docs ?? []));
      const shaA = new Map(files.map((d) => [d.path, h.shaOf(d.path)]));

      // verify: the fact becomes citeable, the pack hash changes and every document is rendered again (pack B)
      h.override('f-nw-05', 'verified');
      h.clock.t = '2026-10-09T02:00:00.000Z';
      const run2 = await h.run();
      expect(run2.packHash).not.toBe(run1.packHash);
      expect([...shaA].some(([p, sha]) => h.shaOf(p) !== sha)).toBe(true);

      // undo: pack A again, so the renderer's steps are A's memo; their files on disk are B's
      h.override('f-nw-05', 'derived-unverified');
      h.clock.t = '2026-10-09T02:30:00.000Z';
      const run3 = await h.run();
      expect(run3.packHash).toBe(run1.packHash);
      expect(ready(h.jobs())).toEqual(readyA);
      for (const [p, sha] of shaA) expect(h.shaOf(p)).toBe(sha);
      expect(run3.exitCode).toBe(0);
      expect(run3.problems).toEqual([]);
      const r = run3.counts.byAgent['renderer'];
      expect(r?.done).toBeGreaterThan(0);
      expect(r?.replayed).toBe(0);
      h.withApp((a) => expect(a.kernel.events(run3.runId).filter((e) => e.kind === 'replay-healed').length).toBe(r?.done));
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)('I3: failed commits and QA-blocked documents are problems', () => {
  it('a failed commit is a commit-failed problem with exit 1, the job is blocked, and the next run heals it', async () => {
    const h = docsHome();
    try {
      await h.run();
      const key = ready(h.jobs())[0] as string;
      chmodSync(join(h.home, 'out', key), 0o500);
      h.override('f-nw-01', 'rejected'); // the pack changes, so the renderer writes new bytes
      h.clock.t = '2026-10-09T02:00:00.000Z';
      let s: DailySummary;
      try {
        s = await h.run();
      } finally {
        chmodSync(join(h.home, 'out', key), 0o700);
      }
      const failed = s.problems.filter((p) => p.kind === 'commit-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ agent: 'renderer' });
      expect(failed[0]?.item).toContain(`job ${key}`);
      expect(s.exitCode).toBe(1);
      expect(s.notification).toMatch(/· \d+ problems?$/);
      const job = h.jobs().find((j) => j.jobKey === key);
      expect(job?.docsState).toBe('blocked');
      expect(job?.docsDetail).toMatch(/could not be written/);
      // next day, obstacle gone: the replay finds the files changed and renders again; no manual rebuild
      h.clock.t = '2026-10-10T01:30:00.000Z';
      const next = await h.run();
      expect(next.problems.filter((p) => p.kind === 'commit-failed')).toEqual([]);
      expect(next.exitCode).toBe(0);
      expect(h.jobs().find((j) => j.jobKey === key)?.docsState).toBe('ready');
    } finally {
      h.done();
    }
  }, 240_000);

  const stub = (dir: string, body: string): string => {
    const p = join(dir, 'pdftotext-stub');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  it('documents QA blocks for content (too many pages) are docs-blocked problems that keep exit 0', async () => {
    const h = docsHome();
    try {
      // the real text layer, plus three page breaks: only qa.pages fails (a content cause)
      const s = await h.run({ pdftotext: stub(h.home, `"${pdftotext}" "$@" && printf '\\f\\f\\f'`) });
      const blocked = s.problems.filter((p) => p.kind === 'docs-blocked');
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked.every((p) => p.agent === 'qa-gate' && p.cause === 'content' && /qa\.pages/.test(p.reason))).toBe(true);
      expect(blocked.length).toBe(h.jobs().filter((j) => j.docsState === 'blocked').length);
      expect(s.exitCode).toBe(0);
      expect(s.notification).toContain(`· ${s.problems.length} problem`);
    } finally {
      h.done();
    }
  }, 240_000);

  it('documents QA blocks for a system cause (no text layer) are docs-blocked problems with exit 1', async () => {
    const h = docsHome();
    try {
      const s = await h.run({ pdftotext: stub(h.home, 'exit 0') });
      const blocked = s.problems.filter((p) => p.kind === 'docs-blocked');
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked.every((p) => p.cause === 'system' && /qa\.pdf-text/.test(p.reason))).toBe(true);
      expect(s.exitCode).toBe(1);
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)('I2: documents that cite a fact the user rejected go stale', () => {
  it('a job not seen again is marked stale after the run, listed as a problem, and ready again when the fact is restored', async () => {
    const h = docsHome();
    try {
      await h.run();
      const readyJobs = h.jobs().filter((j) => j.docsState === 'ready');
      expect(readyJobs.length).toBeGreaterThan(1);
      const cited = h.withApp((a) => readyJobs.map((j) => ({ key: j.jobKey, facts: a.getJob(j.jobKey)?.citedFacts ?? [] })));
      for (const c of cited) expect(c.facts.length).toBeGreaterThan(0);
      // a fact cited by some ready jobs but not all, so both outcomes are visible
      const counts = new Map<string, number>();
      for (const c of cited) for (const f of new Set(c.facts)) counts.set(f, (counts.get(f) ?? 0) + 1);
      const fact = [...counts].find(([, n]) => n < cited.length)?.[0] ?? (cited[0]?.facts[0] as string);
      const citing = cited.filter((c) => c.facts.includes(fact)).map((c) => c.key).sort();

      // the boards are not read today (nothing is seen again), and the user rejects the fact
      writeFileSync(join(h.home, 'pack/watchlist.yaml'), 'watchlist: []\n');
      writeFileSync(join(h.home, 'pack/feeds.yaml'), 'enabled: []\n');
      h.override(fact, 'rejected');
      h.clock.t = '2026-10-10T01:30:00.000Z';
      const s = await h.run();
      const after = h.jobs();
      for (const k of citing) {
        const j = after.find((x) => x.jobKey === k);
        expect(j?.docsState).toBe('stale');
        expect(j?.docsDetail).toContain(fact);
      }
      for (const c of cited.filter((x) => !citing.includes(x.key))) expect(after.find((x) => x.jobKey === c.key)?.docsState).toBe('ready');
      const stale = s.problems.filter((p) => p.kind === 'docs-stale');
      expect(stale.map((p) => p.item.match(/job ([0-9a-f]{16})/)?.[1]).sort()).toEqual(citing);
      expect(stale.every((p) => p.reason.includes(fact))).toBe(true);
      expect(s.exitCode).toBe(0);

      // the user restores the fact: the same files are citeable again, so ready again (still not seen)
      h.override(fact, 'verified');
      h.clock.t = '2026-10-11T01:30:00.000Z';
      const back = await h.run();
      for (const k of citing) expect(h.jobs().find((x) => x.jobKey === k)?.docsState).toBe('ready');
      expect(back.problems.filter((p) => p.kind === 'docs-stale')).toEqual([]);
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)('rereview R3: rejecting a fact makes its documents stale at once, with no run in between', () => {
  it('the dashboard reject flips the citing jobs to stale: the job page and list stop saying ready and the files are 404; verify restores them', async () => {
    const h = docsHome();
    try {
      await h.run();
      const job = h.jobs().find((j) => j.docsState === 'ready') as JobView;
      const fact = (job.citedFacts ?? []).find((f) => f.startsWith('f-nw')) ?? (job.citedFacts?.[0] as string);
      expect(fact).toBeDefined();
      const raw = createDashboard({ home: h.home, clock: h.clock });
      const req = (p: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => raw.request(p, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
      let res = await req(`/jobs/${job.jobKey}`);
      const cookie = /jp_sid=[0-9a-f]{32}/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
      const csrf = /name="_csrf" value="([0-9a-f]{64})"/.exec(await res.text())?.[1] ?? '';
      const post = (path: string) => req(path, { method: 'POST', body: new URLSearchParams({ _csrf: csrf }).toString(), headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true', origin: 'http://localhost' } });
      const dl = () => req(`/jobs/${job.jobKey}/files/resume.pdf`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
      expect((await dl()).status).toBe(200);

      expect((await post(`/facts/${fact}/reject`)).status).toBe(200);
      const after = h.jobs().find((j) => j.jobKey === job.jobKey);
      expect(after?.docsState).toBe('stale');
      expect(after?.docsDetail).toContain(fact);
      const page = await (await req(`/jobs/${job.jobKey}`, { headers: { cookie } })).text();
      expect(page).not.toContain('Documents ready');
      expect(page).not.toContain(`/jobs/${job.jobKey}/files/`);
      for (const name of ['resume.pdf', 'resume.docx', 'resume.html', 'cover.pdf']) {
        expect((await req(`/jobs/${job.jobKey}/files/${name}`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(404);
      }
      const list = await (await req('/?band=all', { headers: { cookie } })).text();
      const rowOf = list.split('data-job=').find((x) => x.startsWith(`"${job.jobKey}"`)) ?? '';
      expect(rowOf).not.toContain('Documents ready');
      // every other citing job went stale too, and no job that does not cite it did
      for (const j of h.jobs()) if (j.docsState === 'ready') expect(j.citedFacts ?? []).not.toContain(fact);

      // verifying it again restores the same files (they are unchanged on disk)
      expect((await post(`/facts/${fact}/verify`)).status).toBe(200);
      expect(h.jobs().find((j) => j.jobKey === job.jobKey)?.docsState).toBe('ready');
      expect((await dl()).status).toBe(200);
    } finally {
      h.done();
    }
  }, 240_000);

  it('a reject made while a run is in flight (the run loaded the pack before it) still leaves the citing documents stale', async () => {
    const h = docsHome();
    try {
      let done = false;
      const fact = 'f-nw-01';
      await h.run({
        afterStep: () => {
          if (done) return;
          done = true;
          h.withApp((a) => overrideFact(a, loadPack(join(h.home, 'pack'), {}, { asOf: '2026-10' }).pack.facts, fact, 'rejected', h.clock.t, diskDocCheck(join(h.home, 'out'))));
        },
      });
      const citing = h.jobs().filter((j) => (j.citedFacts ?? []).includes(fact));
      expect(citing.length).toBeGreaterThan(0);
      for (const j of citing) expect(j.docsState).not.toBe('ready');
    } finally {
      h.done();
    }
  }, 240_000);

  it('the CLI reject path does the same (one shared helper): the override and the stale flip are one transaction', async () => {
    const h = docsHome();
    try {
      await h.run();
      const job = h.jobs().find((j) => j.docsState === 'ready') as JobView;
      const fact = job.citedFacts?.[0] as string;
      h.withApp((a) => overrideFact(a, loadPack(join(h.home, 'pack'), {}, { asOf: '2026-10' }).pack.facts, fact, 'rejected', h.clock.t, diskDocCheck(join(h.home, 'out'))));
      expect(h.jobs().find((j) => j.jobKey === job.jobKey)?.docsState).toBe('stale');
      // the next run (nothing re-seen) agrees with the immediate flip: same state, same detail
      const before = h.jobs().map((j) => [j.jobKey, j.docsState, j.docsDetail]);
      writeFileSync(join(h.home, 'pack/watchlist.yaml'), 'watchlist: []\n');
      writeFileSync(join(h.home, 'pack/feeds.yaml'), 'enabled: []\n');
      h.clock.t = '2026-10-10T01:30:00.000Z';
      await h.run();
      expect(h.jobs().map((j) => [j.jobKey, j.docsState, j.docsDetail])).toEqual(before);
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)('I8: glued and look-alike terms edited into the pack after import never reach ready documents', () => {
  // The run refuses to start (loadRunPack runs packTextProblems), so nothing is rendered and nothing becomes ready.
  // Rendered documents are still checked strictly, in case a refused run left any.
  it.each([
    ['a glued term in a fact claim', 'facts.yaml', 'on Kafka handling 40M events a day.', 'on Kafka for InitechPay handling 40M events a day.', /fact f-nw-01 claim holds forbidden term #1/],
    ['a look-alike (Armenian) term in a fact claim', 'facts.yaml', 'on Kafka handling 40M events a day.', 'on Kafka for Iոitech handling 40M events a day.', /fact f-nw-01 claim holds forbidden term #1/],
    ['an -es plural in a fact claim', 'facts.yaml', 'on Kafka handling 40M events a day.', 'on Kafka for the Initeches handling 40M events a day.', /fact f-nw-01 claim holds forbidden term #1/],
    ['a glued term in a lexicon display', 'lexicon.yaml', 'display: Redis}', 'display: InitechRedis}', /lexicon\.yaml: strong\[\d+\]\.display holds forbidden term #1/],
    ['a glued term in a document answer', 'answers.yaml', 'notice_period: 30 days', 'notice_period: 30 days per InitechHR', /answers\.notice_period holds forbidden term #1/],
  ])('%s', async (_what, file, from, to, problem) => {
    const h = docsHome();
    try {
      const text = readFileSync(join(h.home, 'pack', file), 'utf8');
      expect(text).toContain(from);
      writeFileSync(join(h.home, 'pack', file), text.replace(from, to));
      const run = h.run();
      await expect(run).rejects.toThrow(problem);
      const message = await run.then(() => '', (e: unknown) => (e instanceof Error ? e.message : String(e)));
      expect(message).not.toMatch(/initech|\u0578/i);
      const naming = { forbiddenTerms: ['Initech'] };
      for (const j of h.jobs().filter((x) => x.docsState === 'ready')) {
        for (const d of h.withApp((a) => a.getJob(j.jobKey)?.docs ?? [])) {
          const abs = join(h.home, 'out', d.path);
          const body = d.format === 'pdf' ? execFileSync(pdftotext as string, ['-layout', abs, '-'], { encoding: 'utf8' }) : d.format === 'docx' ? docxText(readFileSync(abs)) : readFileSync(abs, 'utf8');
          expect(forbiddenTermStrict(body, naming), `${d.path}`).toBeUndefined();
        }
      }
      expect(h.jobs().filter((x) => x.docsState === 'ready')).toEqual([]);
    } finally {
      h.done();
    }
  }, 240_000);
});

describe.skipIf(pdftotext === undefined)("rereview R12: filters.companyDeny may name a forbidden term, to deny the client's own postings", () => {
  it('a deny entry equal to the forbidden term filters the posting, the run completes, and the term is never shown or rendered', async () => {
    const h = docsHome();
    const fx = mkdtempSync(join(tmpdir(), 'jp-r12-fx-'));
    try {
      cpSync(join(repo, 'tests/fixtures/e2e'), fx, { recursive: true });
      const feed = JSON.parse(readFileSync(join(fx, 'himalayas-1.json'), 'utf8')) as { jobs: Record<string, unknown>[]; totalCount: number };
      feed.jobs.push({
        title: 'Senior Backend Engineer', excerpt: 'Java and Kafka', companyName: 'Initech', companySlug: 'client-co', employmentType: 'Full Time',
        minSalary: null, maxSalary: null, salaryPeriod: 'annual', currency: null, locationRestrictions: ['India'], categories: ['Backend-Engineer'],
        description: '<p>Design microservices in Java with Spring Boot, Kafka and PostgreSQL on AWS. Fully remote from India.</p>',
        pubDate: 1790985600, guid: 'https://himalayas.example.test/companies/client-co/jobs/senior-backend', applicationLink: 'https://himalayas.example.test/companies/client-co/jobs/senior-backend',
      });
      feed.totalCount += 1;
      writeFileSync(join(fx, 'himalayas-1.json'), JSON.stringify(feed));
      const filters = join(h.home, 'pack/filters.yaml');
      writeFileSync(filters, readFileSync(filters, 'utf8').replace('companyDeny:\n', 'companyDeny:\n  - Initech\n'));
      const offline = offlineProviders(fx);
      const s = await h.run({ fetch: offline.fetch, browser: offline.browser });
      expect(s.exitCode).toBe(0);
      const client = h.jobs().filter((j) => j.company === 'Initech');
      expect(client).toHaveLength(1);
      expect(client[0]?.verdict).toBe('rejected');
      expect(client[0]?.reasons).toEqual(['company:Initech']);
      expect(client[0]?.docsState).not.toBe('ready');
      expect(h.withApp((a) => a.getJob(client[0]?.jobKey as string)?.docs ?? [])).toEqual([]);
      // nothing the run prints or keeps for the user names it: summary, problems, warnings, the notification
      expect(JSON.stringify({ problems: s.problems, warnings: s.warnings, notes: h.notes })).not.toMatch(/initech/i);
      expect(formatSummary(s)).not.toMatch(/initech/i);
      // no document anywhere holds it
      for (const j of h.jobs()) for (const d of h.withApp((a) => a.getJob(j.jobKey)?.docs ?? [])) {
        if (d.format === 'html') expect(forbiddenTermStrict(readFileSync(join(h.home, 'out', d.path), 'utf8'), { forbiddenTerms: ['Initech'] })).toBeUndefined();
      }
      // the dashboard hides it: the job page (its reason names the deny entry) and the all-bands list
      const raw = createDashboard({ home: h.home, clock: h.clock });
      const get = async (p: string) => (await raw.request(p, { headers: { host: 'localhost' } })).text();
      expect(await get(`/jobs/${client[0]?.jobKey}`)).not.toMatch(/initech/i);
      expect(await get('/?band=disclosed&band=undisclosed&band=review&band=below-floor&band=rejected')).not.toMatch(/initech/i);
    } finally {
      h.done();
      rmSync(fx, { recursive: true, force: true });
    }
  }, 240_000);

  it('only the deny list is exempt: the same term glued into another filters list still stops the run', async () => {
    const h = docsHome();
    try {
      const filters = join(h.home, 'pack/filters.yaml');
      writeFileSync(filters, readFileSync(filters, 'utf8').replace('employmentDeny:\n', 'employmentDeny:\n  - InitechPay\n'));
      await expect(h.run()).rejects.toThrow(/filters\.yaml: employmentDeny\[0\] holds forbidden term #1/);
    } finally {
      h.done();
    }
  }, 240_000);
});

