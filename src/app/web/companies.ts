import type { Context, Hono } from 'hono';
import { hostDenied, mergePolicy, PRODUCT_POLICY_V1 } from '../../kernel/policy.js';
import type { FetchLike } from '../../kernel/providers.js';
import { GENERIC_LABELS, normalCompanyName } from '../coverage/names.js';
import { resolveCompany, type ResolveResult } from '../coverage/resolve.js';
import type { RunGate } from '../coverage/gate.js';
import { registrableDomain, resolveWebsite, seedItemsFromJobs, SHARED_HOSTS } from '../coverage/seed.js';
import { coverageWeek } from '../due.js';
import type { NamingRules } from '../pack/rules.js';
import type { Pack } from '../pack/schema.js';
import { registryBoards } from '../pipeline.js';
import { istDate } from '../run.js';
import type { AppStore, Band, Company } from '../store/app-store.js';
import type { Html } from './html.js';
import { companiesBody, companyPlatformName, deferWhy, type AddFormView, type CompaniesPageData, type CompanyRowView, type DeferredHost } from './views/companies.js';
import type { Banner, Nav } from './views/layout.js';

/**
 * The Companies tab (Task 11, spec §5), mounted by `server.ts` with the dashboard's own helpers, so the security rules
 * (127.0.0.1 Host, session, same origin AND the CSRF token on every POST, no external asset) are the same middleware
 * that guards every other page.
 *
 * Routes: `GET /companies`, `POST /companies/add`, `POST /companies/:key/approve|reject|resolve`. Every POST answers a
 * 303 back to `/companies` with a notice (`done`), so the page reads fully with JavaScript off.
 *
 * - **Read-only on daily data.** It writes only the registry (`companies`: an override, an added pick, a resolved
 *   verdict) and the user-action log; never the pack, never a job.
 * - **Overrides win.** Approve and Reject call `setCompanyOverride` (the registry's own rule: approving a proposed or
 *   rejected company that has a board makes it verified, so `verifiedCompanies()` hands it to the next daily run;
 *   rejecting removes it and no coverage verdict brings it back). Undo is the other button. Each is logged
 *   (`company.override`, the event chain).
 * - **Add company** validates (length limits, https only, a registrable domain that is not a job board or ATS, the name
 *   through `normalCompanyName`), then writes a `pick` row as Proposed (`addCompanyPick`); an existing key is refused
 *   with a message and no row.
 * - **Resolve now** is `resolveCompany` (coverage/resolve.ts): the run lock without waiting, the coverage yield rule,
 *   a fresh gate and run key per request. The dashboard holds no run state.
 * - Untrusted text (names, reasons, URLs from the web) is escaped by `html` and checked against the forbidden terms.
 */

type Env = { Variables: { sid: string } };

/** What resolve-now needs from the process (the CLI passes the real fetcher; tests pass recorded fixtures). */
export interface ResolveDeps {
  readonly fetch: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly codeHash?: string;
  readonly timeLimitMs?: number;
  /** Tests: sees each request's gate and run key. */
  readonly onGate?: (gate: RunGate, runId: string) => void;
}

export interface CompaniesDeps {
  readonly home: string;
  readonly now: () => string;
  readonly clock: { now: () => string };
  readonly withStore: <T>(fn: (s: AppStore) => T) => T;
  readonly packState: (now: string) => { readonly pack: Pack | undefined; readonly error: string | undefined; readonly naming: NamingRules };
  readonly redactor: (naming: NamingRules) => { text: (s: string) => string; deep: <T>(v: T) => T };
  readonly page: (c: Context<Env>, nav: Nav, title: string, banners: readonly Banner[], body: Html, status?: 200 | 400 | 404 | 409) => Response | Promise<Response>;
  readonly csrf: (c: Context<Env>) => string;
  readonly resolve?: ResolveDeps;
}

/** A company key as the registry stores it: a lowercase registrable domain. */
const COMPANY_KEY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const MAX_NAME = 100;
export const MAX_WEBSITE = 300;
const ALL_BANDS: readonly Band[] = ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'];

/** The jobs list of one company, every band (so the not-eligible ones show with their reasons). */
export function companyJobsHref(name: string): string {
  const qs = new URLSearchParams({ company: name });
  for (const b of ALL_BANDS) qs.append('band', b);
  return `/?${qs.toString()}`;
}

/** The notices a POST redirects with: fixed words, the only variable part a registry row the page reads itself. */
type Done =
  | 'approved' | 'rejected' | 'added' | 'resolved' | 'resolve-busy' | 'resolve-due-daily' | 'resolve-due-freelance' | 'resolve-deferred'
  | 'resolve-stopped' | 'resolve-unknown' | 'resolve-rejected' | 'resolve-off';
const DONE: readonly Done[] = ['approved', 'rejected', 'added', 'resolved', 'resolve-busy', 'resolve-due-daily', 'resolve-due-freelance', 'resolve-deferred', 'resolve-stopped', 'resolve-unknown', 'resolve-rejected', 'resolve-off'];

/** Whether the daily run reads the company, and why, in words. */
function effectOf(c: Company): { readonly readDaily: boolean; readonly text: string } {
  const rejected = c.status === 'rejected' || c.userOverride === 'rejected';
  if (rejected) return { readDaily: false, text: 'Not read: you rejected it, and the weekly run never verifies it again.' };
  const live = c.status === 'verified' || c.status === 'failing';
  const board = registryBoards([c]).length > 0;
  if (live && board) return { readDaily: true, text: c.status === 'failing' ? 'Still read daily, so it can recover.' : 'Read daily.' };
  if (live && (c.platform === null || c.boardUrl === null)) return { readDaily: false, text: 'Not read daily: no board is known for it yet (the next coverage run, or Resolve now, looks again).' };
  if (live) return { readDaily: false, text: `Not read daily: its ${companyPlatformName(c.platform as string)} board is not one the daily run reads in this build.` };
  if (c.status === 'proposed' && c.userOverride === 'approved') return { readDaily: false, text: 'Approved; nothing is read until a board is found (the next coverage run, or Resolve now).' };
  if (c.status === 'proposed') return { readDaily: false, text: 'Not read until you approve it.' };
  return { readDaily: false, text: 'Not read: its board did not pass the check.' };
}

/** The add form's input, checked; the website's origin and registry key, or a message for the user. */
export function validateAdd(
  rawName: string,
  rawWebsite: string,
  o: { readonly text: (s: string) => string; readonly policy: Parameters<typeof hostDenied>[0]; readonly jobSites: readonly { readonly name: string; readonly website: string | null }[] },
): { readonly ok: true; readonly name: string; readonly website: string; readonly key: string } | { readonly ok: false; readonly error: string } {
  const name = rawName.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  let website = rawWebsite.trim();
  if (name.length > MAX_NAME) return { ok: false, error: `The name is longer than ${MAX_NAME} characters.` };
  if (website.length > MAX_WEBSITE) return { ok: false, error: `The website is longer than ${MAX_WEBSITE} characters.` };
  if (/\p{Cc}/u.test(name)) return { ok: false, error: 'The name has control characters in it.' };
  const norm = normalCompanyName(name);
  if (name !== '' && (norm === '' || GENERIC_LABELS.has(norm.replace(/ /gu, '')))) return { ok: false, error: 'That name does not say which company it is; give the company’s own name.' };
  if (name !== '' && o.text(name) !== name) return { ok: false, error: 'That name contains a term your naming rules hide, so it was not added.' };
  if (website === '') {
    if (name === '') return { ok: false, error: 'Give the company’s website (https://…), and a name if you like.' };
    // a name alone: the website of a careers page you already have jobs from, by the same name; else ask for it
    const seen = o.jobSites.find((j) => j.website !== null && normalCompanyName(j.name) === norm);
    if (seen?.website === undefined || seen.website === null) {
      return { ok: false, error: 'jobpilot needs the company’s website to find its careers site (it never searches the web for a name). Add its https:// address.' };
    }
    website = seen.website;
  }
  let u: URL;
  try {
    u = new URL(website);
  } catch {
    return { ok: false, error: 'The website is not a web address; write it as https://example.com.' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// websites are accepted.' };
  if (u.username !== '' || u.password !== '') return { ok: false, error: 'The website must not carry a user name or password.' };
  const site = resolveWebsite(u.origin);
  const key = 'key' in site ? site.key : null;
  if (key === null || registrableDomain(u.hostname) === null) return { ok: false, error: 'That address is not a company website (no registrable domain).' };
  if (SHARED_HOSTS.has(key) || hostDenied(o.policy, u.hostname)) return { ok: false, error: `${u.hostname} is a job board or applicant system, not the company’s own website.` };
  const label = key.split('.')[0] as string;
  return { ok: true, name: name === '' ? label : name, website: 'origin' in site ? site.origin : u.origin, key };
}

export function mountCompanies(app: Hono<Env>, d: CompaniesDeps): void {
  const view = (c: Company, counts: Map<string, { passing: number; notEligible: number }>, text: (s: string) => string): CompanyRowView => {
    const e = effectOf(c);
    const shown = text(c.name);
    return {
      key: c.companyKey, name: shown, platform: c.platform, platformSlug: c.platformSlug === null ? null : text(c.platformSlug), boardUrl: c.boardUrl === null ? null : text(c.boardUrl),
      careersUrl: c.careersUrl === null ? null : text(c.careersUrl), website: text(c.website), reasons: c.reasons.map(text), source: c.source, jobsSeen: c.jobsSeen,
      lastVerified: c.lastVerified === null ? null : istDate(c.lastVerified), failingSinceWeek: c.failingSince === null ? null : coverageWeek(c.failingSince),
      failWeeks: c.failWeeks, userOverride: c.userOverride, jobs: counts.get(normalCompanyName(c.name)) ?? { passing: 0, notEligible: 0 }, jobsHref: companyJobsHref(shown),
      effect: e.text, readDaily: e.readDaily,
    };
  };

  /** This week's weekly coverage run (the newest), or undefined. */
  const weekRun = (s: AppStore, now: string): string | undefined => {
    const week = coverageWeek(now);
    const rows = s.kernel.db.prepare(`SELECT run_id FROM runs WHERE pipeline = 'jobpilot-coverage' ORDER BY started_at DESC, run_id DESC`).all() as { run_id: string }[];
    return rows.map((r) => r.run_id).find((id) => {
      const date = /^coverage-(\d{4}-\d{2}-\d{2})(?:-\d+)?$/.exec(id)?.[1];
      return date !== undefined && coverageWeek(`${date}T12:00:00.000Z`) === week;
    });
  };

  const hostOf = (u: string | null): string | null => {
    if (u === null) return null;
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const render = (c: Context<Env>, add: AddFormView, flash: CompaniesPageData['flash'], status: 200 | 400 | 409 = 200) => {
    const at = d.now();
    const ps = d.packState(at);
    const r = d.redactor(ps.naming);
    const data = d.withStore((s) => {
      const companies = s.listCompanies();
      const counts = new Map<string, { passing: number; notEligible: number }>();
      for (const j of s.listJobs({ band: ALL_BANDS })) {
        const k = normalCompanyName(j.company);
        const cur = counts.get(k) ?? { passing: 0, notEligible: 0 };
        counts.set(k, j.band === 'rejected' ? { ...cur, notEligible: cur.notEligible + 1 } : { ...cur, passing: cur.passing + 1 });
      }
      const run = weekRun(s, at);
      const hosts = run === undefined ? new Map<string, string>() : s.coverageHostState(run);
      return { companies, counts, run, hosts };
    });
    const by = (pred: (c: Company) => boolean): CompanyRowView[] => data.companies.filter(pred).map((c) => view(c, data.counts, r.text));
    const deferred: DeferredHost[] = [...data.hosts].map(([host, why]) => ({
      host: r.text(host),
      why: r.text(why),
      companies: data.companies.filter((c) => [c.careersUrl, c.boardUrl, c.website].some((u) => hostOf(u) === host)).map((c) => r.text(c.name)),
    }));
    const body = companiesBody({
      lists: {
        verified: by((c) => c.status === 'verified'),
        proposed: by((c) => c.status === 'proposed'),
        failing: by((c) => c.status === 'failing'),
        rejected: by((c) => c.status === 'rejected'),
        unverified: by((c) => c.status === 'failed' && c.source === 'pick'),
      },
      hiddenFailed: data.companies.filter((c) => c.status === 'failed' && c.source !== 'pick').length,
      deferred,
      deferredRun: data.run ?? null,
      csrf: d.csrf(c),
      flash,
      add,
      canResolve: d.resolve !== undefined,
    });
    const banners: Banner[] = ps.error !== undefined ? [{ tone: 'critical', text: `Your pack could not be read: ${ps.error}` }] : [];
    return d.page(c, 'companies', 'Companies', banners, body, status);
  };

  const flashOf = (done: Done, key: string | null, run: string | null): CompaniesPageData['flash'] => {
    const company = key === null ? undefined : d.withStore((s) => s.getCompany(key));
    const k = company === undefined ? null : company.companyKey;
    const text = d.redactor(d.packState(d.now()).naming).text;
    const name = company === undefined ? 'the company' : text(company.name);
    const effect = company === undefined ? '' : effectOf(company);
    switch (done) {
      case 'approved':
        return { tone: 'info', key: k, text: effect !== '' && effect.readDaily ? `Approved: ${name} is read daily from the next run.` : `Approved. ${effect === '' ? '' : effect.text}` };
      case 'rejected':
        return { tone: 'info', key: k, text: `Rejected: ${name} is not read from the next run, and never verified again. Approve undoes it.` };
      case 'added':
        return { tone: 'info', key: k, text: `Added ${name} to Proposed: it resolves on the next coverage run, or now with Resolve now.` };
      case 'resolved':
        return { tone: 'info', key: k, text: `Resolved now: ${company === undefined ? '' : company.status}. ${effect === '' ? '' : effect.text}` };
      case 'resolve-busy':
        return { tone: 'warn', key: null, text: 'Resolve now did not run: another jobpilot run holds the lock. Try again when it has finished.' };
      case 'resolve-due-daily':
        return { tone: 'warn', key: null, text: 'Resolve now did not run: the daily run is due now or within 5 minutes, and it goes first. Try again after it.' };
      case 'resolve-due-freelance':
        return { tone: 'warn', key: null, text: 'Resolve now did not run: the freelance run is due now or within 5 minutes, and it goes first. Try again after it.' };
      case 'resolve-deferred': {
        const hosts = run === null ? [] : [...d.withStore((s) => s.coverageHostState(run))].map(([h, why]) => `${text(h)} (${deferWhy(text(why))})`);
        return { tone: 'warn', key: k, text: `Resolve now stopped: ${hosts.length > 0 ? hosts.join(', ') : 'a host'} refused, so nothing was changed. The weekly run asks again.` };
      }
      case 'resolve-stopped':
        return { tone: 'warn', key: k, text: 'Resolve now stopped before it finished (its time limit, or a run became due); nothing was changed. The weekly run resolves it.' };
      case 'resolve-unknown':
        return { tone: 'warn', key: null, text: 'There is no such company.' };
      case 'resolve-rejected':
        return { tone: 'warn', key: k, text: 'You rejected this company; approve it first.' };
      case 'resolve-off':
        return { tone: 'warn', key: null, text: 'Resolve now is not available in this dashboard; the weekly coverage run resolves it.' };
    }
  };

  const EMPTY_ADD: AddFormView = { name: '', website: '', error: null };

  app.get('/companies', (c) => {
    const doneRaw = c.req.query('done');
    const done = doneRaw !== undefined && (DONE as readonly string[]).includes(doneRaw) ? (doneRaw as Done) : undefined;
    const keyRaw = c.req.query('key');
    const key = keyRaw !== undefined && COMPANY_KEY.test(keyRaw) ? keyRaw : null;
    const runRaw = c.req.query('run');
    const run = runRaw !== undefined && /^resolve-[a-z0-9-]{1,300}$/.test(runRaw) ? runRaw : null;
    return render(c, EMPTY_ADD, done === undefined ? null : flashOf(done, key, run));
  });

  const back = (done: Done, key?: string, run?: string): string => {
    const qs = new URLSearchParams({ done });
    if (key !== undefined) qs.set('key', key);
    if (run !== undefined) qs.set('run', run);
    return `/companies?${qs.toString()}${key !== undefined ? `#co-${key.replace(/[^a-z0-9-]/g, '-')}` : ''}`;
  };

  for (const [verb, to] of [['approve', 'approved'], ['reject', 'rejected']] as const) {
    app.post(`/companies/:key/${verb}`, (c) => {
      const key = c.req.param('key');
      if (!COMPANY_KEY.test(key)) return c.text('Bad request', 400);
      const at = d.now();
      const ok = d.withStore((s) =>
        s.tx(() => {
          const before = s.getCompany(key);
          if (before === undefined) return false;
          s.setCompanyOverride(key, to, at);
          const after = s.getCompany(key) as Company;
          s.logUserAction('company.override', { companyKey: key, from: before.userOverride, to, statusBefore: before.status, statusAfter: after.status }, at);
          return true;
        }),
      );
      if (!ok) return c.text('No such company', 404);
      return c.redirect(back(to, key), 303);
    });
  }

  app.post('/companies/add', async (c) => {
    const body = await c.req.parseBody();
    const rawName = typeof body['name'] === 'string' ? body['name'] : '';
    const rawWebsite = typeof body['website'] === 'string' ? body['website'] : '';
    // what is echoed back into the form is cut to the limits (it is escaped like any value)
    const echo: AddFormView = { name: rawName.slice(0, MAX_NAME + 1), website: rawWebsite.slice(0, MAX_WEBSITE + 1), error: null };
    const at = d.now();
    const ps = d.packState(at);
    const policy = mergePolicy(PRODUCT_POLICY_V1, ps.pack?.policyUser ?? {});
    const jobSites = rawWebsite.trim() === '' ? d.withStore((s) => seedItemsFromJobs(s)) : [];
    const v = validateAdd(rawName, rawWebsite, { text: d.redactor(ps.naming).text, policy, jobSites });
    if (!v.ok) return render(c, { ...echo, error: v.error }, null, 400);
    const added = d.withStore((s) =>
      s.tx(() => {
        const existing = s.getCompany(v.key);
        if (existing !== undefined) return existing;
        s.addCompanyPick({ companyKey: v.key, name: v.name, website: v.website }, at);
        s.logUserAction('company.add', { companyKey: v.key, name: v.name, website: v.website }, at);
        return undefined;
      }),
    );
    if (added !== undefined) {
      const r = d.redactor(ps.naming);
      return render(c, { ...echo, error: `${r.text(added.name)} (${added.companyKey}) is already in your companies, under ${added.status === 'failed' ? 'not verified' : added.status}; nothing was added.` }, null, 409);
    }
    return c.redirect(back('added', v.key), 303);
  });

  app.post('/companies/:key/resolve', async (c) => {
    const key = c.req.param('key');
    if (!COMPANY_KEY.test(key)) return c.text('Bad request', 400);
    if (d.resolve === undefined) return c.redirect(back('resolve-off'), 303);
    const res: ResolveResult = await resolveCompany({
      home: d.home, clock: d.clock, fetch: d.resolve.fetch, companyKey: key,
      ...(d.resolve.sleep !== undefined ? { sleep: d.resolve.sleep } : {}),
      ...(d.resolve.codeHash !== undefined ? { codeHash: d.resolve.codeHash } : {}),
      ...(d.resolve.timeLimitMs !== undefined ? { timeLimitMs: d.resolve.timeLimitMs } : {}),
      ...(d.resolve.onGate !== undefined ? { onGate: d.resolve.onGate } : {}),
    });
    switch (res.kind) {
      case 'resolved':
        return c.redirect(back('resolved', key), 303);
      case 'deferred':
        return c.redirect(back('resolve-deferred', key, res.runId), 303);
      case 'stopped':
        return c.redirect(back('resolve-stopped', key), 303);
      case 'refused':
        if (res.why === 'busy') return c.redirect(back('resolve-busy'), 303);
        if (res.why === 'due') return c.redirect(back(/freelance/.test(res.reason) ? 'resolve-due-freelance' : 'resolve-due-daily'), 303);
        if (res.why === 'rejected') return c.redirect(back('resolve-rejected', key), 303);
        return c.redirect(back('resolve-unknown'), 303);
    }
  });

}
