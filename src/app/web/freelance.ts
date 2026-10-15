import type { Context, Hono } from 'hono';
import { termDisplay } from '../agents/writing/grounded.js';
import { NETWORK_FILES } from '../freelance/networks-command.js';
import { catalogueEntry, NETWORKS_CHECKED, orderedNetworkIds } from '../freelance/network-catalogue.js';
import { isoWeek } from '../freelance/health.js';
import { ALERT_PARSERS } from '../freelance/mail/parsers/index.js';
import { PLATFORM_AGENT, ROBOTS_OFF } from '../freelance/pipeline.js';
import { presetTierUsd } from '../freelance/gig-eligibility.js';
import { NOTE_ONE_SKILL } from '../freelance/project.js';
import { rankGigs } from '../freelance/rank.js';
import { rankable } from '../freelance/run.js';
import { Platform, type GigRendered } from '../freelance/types.js';
import { COVER_PLATFORMS } from '../freelance/writing/gig-cover.js';
import { FreelanceFile } from '../pack/freelance-schema.js';
import type { NamingRules } from '../pack/rules.js';
import type { Pack } from '../pack/schema.js';
import type { homePaths } from '../pack/paths.js';
import { istDate } from '../run.js';
import type { AppStore, GigDoc, GigStatus, GigView, NetworkStatus } from '../store/app-store.js';
import { GIG_STATUSES, NETWORK_STATUSES } from '../store/schema.js';
import { askText, breakdownText, clientSignals, coverageText, DISABLED_REASON, flagText, GMAIL_NO_PARSERS, gigDocsReason, hoursText, rateLabel, scopeText, type GigRate } from './copy.js';
import { readConfined, readRecorded, snapshotGigApplied, type ReadResult } from './files.js';
import { ageText, istTimeText } from './format.js';
import { html, type Html } from './html.js';
import { FILE_CSP } from './security.js';
import {
  GIG_TABS,
  gigBody,
  gigListBody,
  gigSentSection,
  gigStatusSection,
  networksBody,
  networkStatusBlock,
  sourcesBody,
  type ContractRoleView,
  type FreelanceTab,
  type GigPageData,
  type GigRowView,
  type NetworkCard,
  type PasteDoc,
  type SourceTable,
  type TabCounts,
} from './views/freelance.js';
import type { Banner, Nav } from './views/layout.js';

/**
 * The freelance tab (Task 10, spec §8), mounted by `server.ts` with the dashboard's own helpers, so the security rules
 * (127.0.0.1 Host, session, same origin AND the CSRF token on every POST, no external asset) are the same middleware
 * that guards the jobs pages: nothing here can bypass it.
 *
 * Routes: `GET /freelance?tab=contracts|gigs|review|networks|sources` (contracts by default), `GET /freelance/networks`,
 * `GET /freelance/sources`, `GET /freelance/:key` one gig, `POST /freelance/:key/status`,
 * `GET /freelance/:key/files/:name` a current document, `GET /freelance/:key/sent/:day/:name` an applied snapshot file,
 * `GET /freelance/networks/:id/files/:name` a network pack file, `POST /freelance/networks/:id/status`.
 *
 * - **Order.** Each list is `rankGigs(rows, pack.freelance.fitFloor)` (the projector's and the notification's order) on
 *   the stored rows; duplicate listings are left out, as on the jobs page.
 * - **Honest about uncertainty.** The rate always says how it was reached (`rateLabel`); a value the posting does not
 *   state says "not stated"; each note of the verdict is shown as written.
 * - **Copy.** The proposal or pitch is shown in a `<pre>` read from the recorded `.txt` file (sha256 checked); the Copy
 *   button (static/app.js) fetches that same file and copies its exact text. A text that names a forbidden term is not
 *   shown and cannot be copied or downloaded here.
 * - **Applied** copies the gig's current documents into `gigs/<key>/applied-<day>/`, read-only, once, like v1.
 */

type Env = { Variables: { sid: string } };

export interface FreelanceDeps {
  readonly paths: ReturnType<typeof homePaths>;
  readonly now: () => string;
  readonly withStore: <T>(fn: (s: AppStore) => T) => T;
  readonly packState: (now: string) => { readonly pack: Pack | undefined; readonly error: string | undefined; readonly naming: NamingRules };
  readonly redactor: (naming: NamingRules) => { text: (s: string) => string; deep: <T>(v: T) => T };
  readonly page: (c: Context<Env>, nav: Nav, title: string, banners: readonly Banner[], body: Html, status?: 200 | 404) => Response | Promise<Response>;
  readonly csrf: (c: Context<Env>) => string;
  readonly isHx: (c: Context<Env>) => boolean;
  readonly isBusy: (e: unknown) => boolean;
  readonly beforeSnapshot?: () => void;
  /** Whether Gmail is connected (a refresh token in the Keychain, checked without reading it). Absent: not connected. */
  readonly gmailConnected?: () => boolean;
}

const GIG_KEY = /^[0-9a-f]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GIG_FILE = /^(?:(proposal|pitch)\.txt|resume\.(pdf|docx)|cover\.(txt|pdf|docx|html))$/;
const NETWORK_ID = /^[a-z][a-z0-9-]*$/;
const CONTENT_TYPE: Readonly<Record<string, string>> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html; charset=utf-8',
};
/** Breakdown rows the scorer shows but never counts in `fit` (gig-scorer.ts). */
const SHOWN_ONLY: Readonly<Record<string, string>> = { client: 'Client signals', fresh: 'Hours since posted', bids: 'Bids so far' };
const DEFAULT_RULES = FreelanceFile.parse({});

const NOTICE: Readonly<Record<string, string>> = {
  nodocs: 'Marked applied. No documents were kept: this gig had no ready documents.',
  keepfail: "Marked applied, but the documents could not be kept as sent. They are unchanged; see the reason in the log, then use 'Keep a copy' below.",
  keepbusy: "Status saved. Couldn't keep a copy of the documents just now; use 'Keep a copy' below.",
};

/** Code-unit order (locale independent, as every sort in the app). */
const codeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Where a stored budget was read (`Gig.budget.from`), or null when it does not say. */
const budgetFromOf = (b: unknown): string | null => (isObj(b) && typeof b['from'] === 'string' ? b['from'] : null);

/** A stored rate, or null when the gig was never rated. */
function rateOf(v: unknown): GigRate | null {
  if (!isObj(v) || typeof v['method'] !== 'string') return null;
  return {
    minUsdH: numOrNull(v['minUsdH']), maxUsdH: numOrNull(v['maxUsdH']), method: v['method'], budgetUsd: numOrNull(v['budgetUsd']),
    fxDate: typeof v['fxDate'] === 'string' ? v['fxDate'] : null, fxSource: typeof v['fxSource'] === 'string' ? v['fxSource'] : null,
  };
}

/**
 * A breakdown row in words; a skill row whose term the user's facts do not back (not in the plan's `covered`) says so,
 * so the fit table never contradicts the coverage line. Without a plan on record nothing is marked.
 */
function rowLabel(k: string, display: (k: string) => string, covered: ReadonlySet<string> | null): string {
  const label = breakdownText(k, display);
  const m = /^(strong|medium):(.+)$/.exec(k);
  return m !== null && covered !== null && !covered.has(m[2] as string) ? `${label} (not backed by your facts)` : label;
}

const coveredOf = (x: { readonly rendered: GigRendered | null }): ReadonlySet<string> | null =>
  Array.isArray(x.rendered?.plan?.covered) ? new Set(x.rendered.plan.covered) : null;

interface Extras {
  readonly gig: Record<string, unknown> | null;
  readonly rendered: GigRendered | null;
}

export function mountFreelance(app: Hono<Env>, d: FreelanceDeps): void {
  const rulesOf = (pack: Pack | undefined) => pack?.freelance ?? DEFAULT_RULES;
  const displayOf = (pack: Pack | undefined, text: (s: string) => string) => (k: string): string => {
    if (pack === undefined) return text(k);
    try {
      return text(termDisplay(k, pack as unknown as Parameters<typeof termDisplay>[1]));
    } catch {
      return text(k);
    }
  };

  /** Everything a row shows, in the user's words (redacted by the caller). */
  const rowView = (g: GigView, x: Extras, pack: Pack | undefined, now: string, text: (s: string) => string): GigRowView => {
    const rules = rulesOf(pack);
    const duration = x.gig !== null && isObj(x.gig['duration']) ? x.gig['duration'] : {};
    const timezone = x.gig !== null && isObj(x.gig['timezone']) ? x.gig['timezone'] : {};
    const hours = isObj(g.hours) ? { min: numOrNull(g.hours['min']), max: numOrNull(g.hours['max']) } : null;
    const budgetType = isObj(g.budget) && typeof g.budget['type'] === 'string' ? g.budget['type'] : 'unknown';
    const display = displayOf(pack, text);
    const plan = x.rendered?.plan;
    const fitRows = Object.entries(g.breakdown ?? {}).filter(([k]) => !Object.hasOwn(SHOWN_ONLY, k));
    const overlap = typeof timezone['overlapText'] === 'string' && timezone['overlapText'].trim() !== '' ? timezone['overlapText'] : typeof timezone['required'] === 'string' ? timezone['required'] : null;
    const bids = numOrNull(g.breakdown?.['bids']) ?? numOrNull(x.gig?.['bids']);
    return {
      gig: g,
      rate: rateLabel(rateOf(g.rate), { description: g.description, weeks: numOrNull(duration['weeks']), hours: hours?.max ?? null, budgetType, presetTier: presetTierUsd(g), budgetFrom: budgetFromOf(g.budget) }),
      hours: hoursText(hours),
      overlap: overlap === null ? null : text(overlap),
      istWindow: `${rules.istWindow.replace('-', '–')} IST`,
      coverage: plan !== undefined && Array.isArray(plan.covered) && Array.isArray(plan.missing) ? coverageText(plan.covered, plan.missing, display) : null,
      fitTitle: fitRows.length === 0 ? 'Not scored' : fitRows.map(([k, p]) => `${rowLabel(k, display, coveredOf(x))} ${p > 0 ? '+' : ''}${p}`).join('\n'),
      flags: g.flags.map(flagText),
      notes: g.notes.map((n) => ({ text: n, amber: n === NOTE_ONE_SKILL })),
      client: clientSignals(isObj(g.client) ? g.client : null),
      age: ageText(g.postedAt, now),
      bids,
    };
  };

  const extrasOf = (s: AppStore, keys: readonly string[]): Record<string, Extras> => {
    const raw = s.gigExtras(keys);
    return Object.fromEntries(
      keys.map((k) => {
        const e = raw[k];
        return [k, { gig: isObj(e?.gig) ? e.gig : null, rendered: isObj(e?.rendered) ? (e.rendered as GigRendered) : null }];
      }),
    );
  };

  const countsOf = (gigs: readonly GigView[], fitFloor: number): TabCounts => ({
    ...Object.fromEntries(GIG_TABS.map((t) => [t, ranked(gigs, t, fitFloor).length])),
    roles: contractRoles(gigs, fitFloor).length,
  });

  /**
   * "Contract roles matching your stack" (freelance-v2, Feature 1; a view, no rule): the Review contracts from employer
   * job boards (`COVER_PLATFORMS`: boards, Himalayas) with a fit at or above the fit floor, best fit first, then newest
   * posted (unknown last), then gig key. Duplicate listings are already left out by `listGigs`.
   */
  const contractRoles = (gigs: readonly GigView[], fitFloor: number): GigView[] =>
    gigs
      .filter((g) => g.list === 'review' && g.kind === 'contract' && COVER_PLATFORMS.includes(g.platform as Platform) && g.fit !== null && g.fit >= fitFloor)
      .sort((a, b) => (b.fit as number) - (a.fit as number) || codeUnits(b.postedAt ?? '', a.postedAt ?? '') || codeUnits(a.gigKey, b.gigKey));

  /** One Contract roles row, in the user's words (redacted by the caller). */
  const roleView = (g: GigView, x: Extras, docs: readonly GigDoc[], pack: Pack | undefined, now: string, text: (s: string) => string): ContractRoleView => {
    const covered = x.rendered?.plan?.covered;
    const name = isObj(g.client) && typeof g.client['name'] === 'string' && g.client['name'].trim() !== '' ? text(g.client['name']) : null;
    return {
      gig: g,
      company: name,
      scope: text(scopeText(x.gig?.['location'])),
      skills: Array.isArray(covered) ? covered.slice(0, 3).map(displayOf(pack, text)) : [],
      ask: askText(g),
      age: ageText(g.postedAt, now),
      files: g.docsState === 'ready' ? docs : [],
      docsReason: gigDocsReason(g.docsState, g.docsDetail, g.list),
    };
  };

  /** The rows of one list, in rankGigs order. */
  const ranked = (gigs: readonly GigView[], list: (typeof GIG_TABS)[number], fitFloor: number): GigView[] => {
    const mine = gigs.filter((g) => g.list === list && g.fit !== null);
    const byKey = new Map(mine.map((g) => [g.gigKey, g]));
    return rankGigs(mine.map((g) => rankable(g, list)), fitFloor)[list].map((s) => byKey.get(s.risked.verdict.rated.gig.gigKey) as GigView);
  };

  const hiddenText = (gigs: readonly GigView[], tab: (typeof GIG_TABS)[number]): string | null => {
    if (tab === 'review') return null;
    const kind = tab === 'contracts' ? 'contract' : 'gig';
    const mine = gigs.filter((g) => g.kind === kind);
    const below = mine.filter((g) => g.list === 'below-floor').length;
    const rejected = mine.filter((g) => g.list === null && g.verdict === 'rejected').length;
    const unscored = mine.filter((g) => g.list === null && g.verdict !== 'rejected').length;
    const parts = [below > 0 ? `${below} below the fit floor` : '', rejected > 0 ? `${rejected} not eligible` : '', unscored > 0 ? `${unscored} not scored` : ''].filter((p) => p !== '');
    if (parts.length === 0) return null;
    const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) as string}`;
    return `${joined} ${below + rejected + unscored === 1 ? 'is' : 'are'} not shown.`;
  };

  const lastRunText = (s: AppStore): string | null => {
    const r = s.latestGigRun();
    return r === undefined ? null : istTimeText(r.at);
  };

  // --- the three gig lists, and the tab switch -------------------------------------------------------------------------
  app.get('/freelance', (c) => {
    const tab = c.req.query('tab') ?? 'contracts';
    if (tab === 'networks') return networksPage(c);
    if (tab === 'sources') return sourcesPage(c);
    const list = (GIG_TABS as readonly string[]).includes(tab) ? (tab as (typeof GIG_TABS)[number]) : 'contracts';
    const at = d.now();
    const ps = d.packState(at);
    const r = d.redactor(ps.naming);
    const fitFloor = rulesOf(ps.pack).fitFloor;
    const data = d.withStore((s) => {
      const gigs = s.listGigs();
      const rows = ranked(gigs, list, fitFloor);
      // The Contract roles section heads the Contracts tab (the Freelance landing tab).
      const roles = list === 'contracts' ? contractRoles(gigs, fitFloor) : [];
      const keys = [...new Set([...rows, ...roles].map((g) => g.gigKey))];
      return { gigs, rows, roles, extras: extrasOf(s, keys), docs: s.gigDocsFor(roles.map((g) => g.gigKey)), lastRun: lastRunText(s) };
    });
    const inRoles = new Set(contractRoles(data.gigs, fitFloor).map((g) => g.gigKey));
    const rows = data.rows.map((g) => ({ ...rowView(r.deep(g), data.extras[g.gigKey] as Extras, ps.pack, at, r.text), ...(list === 'review' && inRoles.has(g.gigKey) ? { alsoInRoles: true } : {}) }));
    const roles = data.roles.map((g) => roleView(r.deep(g), data.extras[g.gigKey] as Extras, data.docs[g.gigKey] ?? [], ps.pack, at, r.text));
    const body = gigListBody({
      tab: list, rows, counts: countsOf(data.gigs, fitFloor), hidden: hiddenText(data.gigs, list), fitFloor, lastRun: data.lastRun,
      ...(list === 'contracts' ? { roles: { rows: roles, fitFloor } } : {}),
    });
    return d.page(c, 'freelance', 'Freelance', packBanner(ps), body);
  });

  const packBanner = (ps: { error: string | undefined }): Banner[] => (ps.error !== undefined ? [{ tone: 'critical', text: `Your pack could not be read: ${ps.error}` }] : []);

  // --- networks --------------------------------------------------------------------------------------------------------
  /**
   * The Networks section (freelance-boost): the catalogue's networks and the user's own network files, joined by id, in
   * the recommended order (`orderedNetworkIds`). A catalogue network without a file has no application pack; a file the
   * catalogue does not know has no verified facts.
   */
  const networkCards = (
    pack: Pack | undefined,
    statuses: Record<string, { status: NetworkStatus; updatedAt: string }>,
    applied: ReadonlyMap<string, string>,
    text: (s: string) => string,
  ): NetworkCard[] => {
    const files = new Map((pack?.networks ?? []).map((n) => [n.id, n]));
    return orderedNetworkIds(pack?.networks ?? []).map((id) => {
      const n = files.get(id);
      const c = catalogueEntry(id);
      const onDisk = n === undefined ? [] : NETWORK_FILES.filter((f) => readConfined(d.paths.out, `networks/${id}/${f}`).ok);
      const cl = n === undefined ? { ok: false as const } : readConfined(d.paths.out, `networks/${id}/checklist.md`);
      return {
        id, name: text(n?.name ?? c?.name ?? id), hasFile: n !== undefined, checkedByUser: n?.checkedByUser ?? false, stages: (n?.screening ?? []).map((s) => text(s.stage)),
        status: statuses[id]?.status ?? 'todo', updatedAt: statuses[id]?.updatedAt ?? null, appliedAt: applied.get(id) ?? null, files: onDisk,
        checklist: cl.ok ? text(Buffer.from(cl.bytes).toString('utf8')) : null,
        facts: c === undefined ? null : { applyUrl: c.applyUrl, india: c.india, indiaNote: c.indiaNote, rates: c.rates, hours: c.hours, process: c.process, order: c.order },
      };
    });
  };
  /** When each network was last marked applied, from the logged `network.status` actions (the latest wins). */
  const appliedDates = (s: AppStore): Map<string, string> => {
    const out = new Map<string, string>();
    for (const a of s.userActions()) {
      const x = a.data as { networkId?: unknown; to?: unknown } | null;
      if (a.kind === 'network.status' && x !== null && typeof x.networkId === 'string' && x.to === 'applied') out.set(x.networkId, a.at);
    }
    return out;
  };
  /** A network the dashboard knows: one of the user's files or one of the catalogue's. */
  const knownNetwork = (pack: Pack | undefined, id: string): boolean => (pack?.networks.some((n) => n.id === id) ?? false) || catalogueEntry(id) !== undefined;

  const networksPage = (c: Context<Env>) => {
    const at = d.now();
    const ps = d.packState(at);
    const r = d.redactor(ps.naming);
    const { statuses, gigs, applied } = d.withStore((s) => ({ statuses: s.networkStatuses(), gigs: s.listGigs(), applied: appliedDates(s) }));
    const cards = networkCards(ps.pack, statuses, applied, r.text);
    const counts = { ...countsOf(gigs, rulesOf(ps.pack).fitFloor), networks: cards.length };
    const body = networksBody({ checked: NETWORKS_CHECKED, cards, counts, csrf: d.csrf(c), istDay: istDate, packError: ps.error ?? null });
    return d.page(c, 'freelance', 'Freelance networks', packBanner(ps), body);
  };
  app.get('/freelance/networks', (c) => networksPage(c));

  app.get('/freelance/networks/:id/files/:name', (c) => {
    const { id, name } = c.req.param();
    if (!NETWORK_ID.test(id) || !(NETWORK_FILES as readonly string[]).includes(name)) return c.text('Not found', 404);
    const ps = d.packState(d.now());
    if (!ps.pack?.networks.some((n) => n.id === id)) return c.text('Not found', 404);
    return sendFile(c, readConfined(d.paths.out, `networks/${id}/${name}`), name, `${id}-${name}`);
  });

  app.post('/freelance/networks/:id/status', async (c) => {
    const id = c.req.param('id');
    const to = (await c.req.parseBody())['to'];
    if (!NETWORK_ID.test(id) || typeof to !== 'string' || !(NETWORK_STATUSES as readonly string[]).includes(to)) return c.text('Bad request', 400);
    const at = d.now();
    const ps = d.packState(at);
    if (!knownNetwork(ps.pack, id)) return c.text('No such network', 404);
    // A network that does not take people in India cannot be marked applied (the page offers no button either).
    if (to === 'applied' && catalogueEntry(id)?.india === 'not-open') return c.text('This network is not open to India', 409);
    const { st, applied } = d.withStore((s) =>
      s.tx(() => {
        const from = s.networkStatuses()[id]?.status ?? 'todo';
        if (from !== to) {
          s.setNetworkStatus(id, to as NetworkStatus, at);
          // Logged in the hash-chained user-action log, like every other dashboard action.
          s.logUserAction('network.status', { networkId: id, from, to }, at);
        }
        return { st: s.networkStatuses()[id], applied: appliedDates(s).get(id) ?? null };
      }),
    );
    if (!d.isHx(c)) return c.redirect(`/freelance/networks#net-${id}`, 303);
    const notOpen = catalogueEntry(id)?.india === 'not-open';
    return c.html(networkStatusBlock({ id, status: st?.status ?? 'todo', updatedAt: st?.updatedAt ?? null, appliedAt: applied, notOpen }, d.csrf(c), istDate).value);
  });

  // --- sources ---------------------------------------------------------------------------------------------------------
  const sourcesPage = (c: Context<Env>) => {
    const at = d.now();
    const ps = d.packState(at);
    const r = d.redactor(ps.naming);
    const rules = rulesOf(ps.pack);
    const data = d.withStore((s) => ({ health: s.sourceHealth(), transitions: s.gigTransitions(), run: s.latestGigRun(), gigs: s.listGigs() }));
    // The user's outcomes per platform and IST week: distinct gigs that entered each status that week.
    const outcome = new Map<string, Set<string>>();
    for (const t of data.transitions) {
      if (t.to !== 'applied' && t.to !== 'replied' && t.to !== 'won') continue;
      const k = `${t.platform}\u0000${isoWeek(istDate(t.at))}\u0000${t.to}`;
      outcome.set(k, (outcome.get(k) ?? new Set()).add(t.gigKey));
    }
    const count = (p: string, w: string, to: string): number => outcome.get(`${p}\u0000${w}\u0000${to}`)?.size ?? 0;
    const platforms = [...new Set(data.health.map((h) => h.platform))].sort();
    const tables: SourceTable[] = platforms.map((p) => {
      const rows = data.health.filter((h) => h.platform === p).slice(-8).reverse();
      return { platform: p, probeFailures: rows[0]?.probeFailures ?? 0, rows: rows.map((h) => ({ ...h, outcomes: { applied: count(p, h.week, 'applied'), replied: count(p, h.week, 'replied'), won: count(p, h.week, 'won') } })) };
    });
    const disabled = Platform.options.flatMap((p) => {
      const robots = ROBOTS_OFF[p];
      if (robots !== undefined) return [{ platform: p, reason: robots }];
      const known = DISABLED_REASON[p];
      if (known !== undefined && PLATFORM_AGENT[p] === undefined) return [{ platform: p, reason: known }];
      if (!rules.platforms[p].enabled) return [{ platform: p, reason: 'turned off in your freelance.yaml' }];
      if (PLATFORM_AGENT[p] === undefined) return [{ platform: p, reason: 'no source in this build yet' }];
      if (p === 'gmail' && d.gmailConnected?.() !== true) return [{ platform: p, reason: DISABLED_REASON.gmail as string }];
      if (p === 'gmail' && ALERT_PARSERS.length === 0) return [{ platform: p, reason: GMAIL_NO_PARSERS }];
      return [];
    });
    const problems = collapseProblems(data.run?.problems ?? []).map((p) => ({ kind: p.kind, line: r.text(p.line) }));
    const counts = { ...countsOf(data.gigs, rules.fitFloor), networks: ps.pack?.networks.length ?? 0 };
    const body = sourcesBody({ tables, disabled, problems, lastRun: data.run === undefined ? null : istTimeText(data.run.at), counts });
    return d.page(c, 'freelance', 'Freelance sources', packBanner(ps), body);
  };
  app.get('/freelance/sources', (c) => sourcesPage(c));

  // --- one gig ---------------------------------------------------------------------------------------------------------
  const notFound = (c: Context<Env>) => d.page(c, 'freelance', 'Not found', [], html`<h1>Not found</h1><p>No such gig.</p><p><a href="/freelance">Back to freelance</a></p>`, 404);

  /** The paste-ready text from the recorded `.txt` file, split where a line cites facts. */
  const pasteOf = (g: GigView & { docs: GigDoc[] }, x: Extras, pack: Pack | undefined, text: (s: string) => string): { paste: PasteDoc | null; problem: string | null } => {
    const txt = g.docs.find((f) => f.format === 'txt' && (f.kind === 'pitch' || f.kind === 'proposal'));
    if (g.docsState !== 'ready' || txt === undefined) return { paste: null, problem: null };
    const read = readRecorded(d.paths.out, txt.path, txt.sha256);
    if (!read.ok) return { paste: null, problem: read.why === 'changed' ? 'The text file changed on disk after it was made, so it is not shown. The next run makes it again.' : 'The text file is not on disk. The next run makes it again.' };
    const body = Buffer.from(read.bytes).toString('utf8');
    if (text(body) !== body) return { paste: null, problem: 'The text names a forbidden term, so it is not shown here and cannot be copied. Check naming.yaml and the posting.' };
    const plan = x.rendered?.plan;
    const cited = (plan?.proposal?.evidence ?? plan?.pitch?.lines ?? []).filter((l) => l.factIds.length > 0 && l.text !== '');
    const segments: { text: string; facts: string[] | null }[] = [];
    let at = 0;
    for (const l of cited) {
      const i = body.indexOf(l.text, at);
      if (i < 0) continue;
      if (i > at) segments.push({ text: body.slice(at, i), facts: null });
      segments.push({ text: l.text, facts: [...l.factIds] });
      at = i + l.text.length;
    }
    if (at < body.length) segments.push({ text: body.slice(at), facts: null });
    const rule = pack?.platformRules[g.platform as Platform];
    return { paste: { kind: txt.kind === 'pitch' ? 'pitch' : 'proposal', segments, chars: [...body.replace(/\n$/, '')].length, max: rule?.maxChars ?? null }, problem: null };
  };

  /**
   * freelance-v2: the cover letter card's data: null when the gig has no cover file; else the recorded `cover.txt`
   * (sha256 checked; a text naming a forbidden term is not shown), or why not, and the gig's cover files.
   */
  const coverOf = (g: GigView & { docs: GigDoc[] }, text: (s: string) => string): NonNullable<GigPageData['cover']> | null => {
    const files = g.docs.filter((f) => f.kind === 'cover');
    const txt = files.find((f) => f.format === 'txt');
    if (txt === undefined) return null;
    if (g.docsState !== 'ready') return { text: null, problem: gigDocsReason(g.docsState, g.docsDetail, g.list), files: [] };
    const read = readRecorded(d.paths.out, txt.path, txt.sha256);
    if (!read.ok) return { text: null, problem: read.why === 'changed' ? 'The cover letter file changed on disk after it was made, so it is not shown. The next run makes it again.' : 'The cover letter file is not on disk. The next run makes it again.', files: [] };
    const body = Buffer.from(read.bytes).toString('utf8');
    if (text(body) !== body) return { text: null, problem: 'The cover letter names a forbidden term, so it is not shown here and cannot be copied. Check naming.yaml and the posting.', files: [] };
    return { text: body, problem: null, files };
  };

  /** Applied, documents ready and no snapshot yet: the keep-now offer (as v1 `keepable`). */
  const keepable = (g: GigView & { docs: GigDoc[] }, snapshots: number): boolean => g.status === 'applied' && snapshots === 0 && g.docsState === 'ready' && g.docs.length > 0;
  const sentOf = (s: AppStore, g: GigView & { docs: GigDoc[] }, c: Context<Env>) => {
    const snapshots = s.gigSnapshots(g.gigKey);
    return { gigKey: g.gigKey, snapshots, appliedDay: g.appliedAt === null ? null : istDate(g.appliedAt), canKeep: keepable(g, snapshots.length), csrf: d.csrf(c) };
  };

  app.get('/freelance/:key', (c) => {
    const key = c.req.param('key');
    if (!GIG_KEY.test(key)) return notFound(c);
    const at = d.now();
    const ps = d.packState(at);
    const r = d.redactor(ps.naming);
    const data = d.withStore((s) => {
      const g = s.getGig(key);
      if (!g) return undefined;
      return { g, extras: extrasOf(s, [key])[key] as Extras, history: s.gigHistory(key), sent: sentOf(s, g, c) };
    });
    if (!data) return notFound(c);
    const g = r.deep(data.g);
    const row = rowView(g, data.extras, ps.pack, at, r.text);
    const { paste, problem } = pasteOf(data.g, data.extras, ps.pack, r.text);
    const display = displayOf(ps.pack, r.text);
    const notice = c.req.query('notice');
    const flash = notice !== undefined && Object.hasOwn(NOTICE, notice) ? NOTICE[notice] : undefined;
    const body = gigBody({
      row, csrf: d.csrf(c), paste, pasteProblem: problem, cover: coverOf(data.g, r.text), files: paste === null ? [] : data.g.docs, docsReason: gigDocsReason(g.docsState, g.docsDetail, g.list),
      history: data.history, sent: data.sent, reasons: g.reasons, duplicateOf: g.duplicateOf, istDay: istDate,
      breakdown: Object.entries(g.breakdown ?? {}).map(([k, p]) => ({ label: SHOWN_ONLY[k] ?? rowLabel(k, display, coveredOf(data.extras)), points: p, shown: Object.hasOwn(SHOWN_ONLY, k) })),
      ...(flash !== undefined ? { flash } : {}),
    });
    return d.page(c, 'freelance', g.title, packBanner(ps), body);
  });

  app.post('/freelance/:key/status', async (c) => {
    const key = c.req.param('key');
    const to = (await c.req.parseBody())['to'];
    if (!GIG_KEY.test(key) || typeof to !== 'string' || !(GIG_STATUSES as readonly string[]).includes(to)) return c.text('Bad request', 400);
    const at = d.now();
    const day = istDate(at);
    const result = d.withStore((s) => {
      const before = s.getGig(key);
      if (!before) return undefined;
      // The status first (its own transaction): a busy store answers 503 before any file is written.
      const set = s.setGigStatus(key, to as GigStatus, at);
      let notice: 'nodocs' | 'keepfail' | 'keepbusy' | undefined;
      // "The documents you sent": made once, on a real transition INTO applied, for a gig that has none yet.
      if (set?.changed === true && to === 'applied' && s.gigSnapshots(key).length === 0) {
        if (before.docsState !== 'ready' || before.docs.length === 0) notice = 'nodocs';
        else {
          try {
            const files = snapshotGigApplied(d.paths.out, key, before.docs, day);
            d.beforeSnapshot?.();
            s.putGigSnapshot(key, day, files, at);
          } catch (e) {
            notice = d.isBusy(e) ? 'keepbusy' : 'keepfail';
            console.error(`jobpilot dashboard: could not keep the applied documents of gig ${key}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      const g = s.getGig(key) as GigView & { docs: GigDoc[] };
      return { g, history: s.gigHistory(key), sent: sentOf(s, g, c), notice };
    });
    if (!result) return c.text('No such gig', 404);
    if (!d.isHx(c)) return c.redirect(`/freelance/${key}${result.notice !== undefined ? `?notice=${result.notice}` : ''}#status`, 303);
    const flash = result.notice !== undefined ? NOTICE[result.notice] : undefined;
    return c.html(html`${gigStatusSection(result.g, result.history, d.csrf(c), istDate, flash)}${gigSentSection(result.sent, true)}`.value);
  });

  // "Keep a copy of these documents now": the snapshot an apply could not make (a failed or busy copy). Same confined
  // helper, same rule: an applied gig with ready documents and no snapshot yet; a second keep is refused (409).
  app.post('/freelance/:key/keep', (c) => {
    const key = c.req.param('key');
    if (!GIG_KEY.test(key)) return c.text('Bad request', 400);
    const at = d.now();
    const result = d.withStore((s) => {
      const g = s.getGig(key);
      if (!g) return { status: 404 as const, text: 'No such gig' };
      if (!keepable(g, s.gigSnapshots(key).length)) return { status: 409 as const, text: 'Nothing to keep: the gig is not applied, its documents are not ready, or a copy is already kept.' };
      try {
        s.putGigSnapshot(key, istDate(at), snapshotGigApplied(d.paths.out, key, g.docs, istDate(at)), at);
      } catch (e) {
        if (d.isBusy(e)) throw e;
        return { status: 409 as const, text: `The documents could not be kept: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { status: 200 as const, sent: sentOf(s, s.getGig(key) as GigView & { docs: GigDoc[] }, c) };
    });
    if (result.status !== 200) return c.text(d.redactor(d.packState(at).naming).text(result.text), result.status);
    if (!d.isHx(c)) return c.redirect(`/freelance/${key}#sent-h`, 303);
    return c.html(gigSentSection(result.sent).value);
  });

  // --- files: only names the store recorded for this gig --------------------------------------------------------------
  const sendFile = (c: Context<Env>, read: ReadResult, name: string, downloadName: string) => {
    if (!read.ok) {
      if (read.why === 'changed') return c.text('This file changed on disk after it was made, so it is not served. The next run makes it again.', 409);
      if (read.why === 'absent') return c.text('This file is not on disk.', 404);
      return c.text('This file is not served: it is not a plain file inside the documents folder.', 403);
    }
    const ext = name.slice(name.lastIndexOf('.') + 1);
    return c.body(new Uint8Array(read.bytes), 200, {
      'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy': FILE_CSP,
      'content-disposition': `attachment; filename="${downloadName}"`,
    });
  };

  /**
   * Whether the gig's files may NOT be served: a paste text (any `.txt` among `files`) names a forbidden term, or
   * cannot be read as recorded (absent, changed, refused). Fail closed: then none of its files is served (403), the PDF
   * and DOCX included, since they were written from the same plan. Files without any `.txt` are judged by their own read.
   */
  const tainted = (files: readonly Pick<GigDoc, 'format' | 'path' | 'sha256'>[], text: (s: string) => string): boolean =>
    // every .txt among them (the pitch or proposal, and the cover letter's, freelance-v2): one bad text refuses all
    files.filter((f) => f.format === 'txt').some((txt) => {
      const read = readRecorded(d.paths.out, txt.path, txt.sha256);
      if (!read.ok) return true;
      const body = Buffer.from(read.bytes).toString('utf8');
      return text(body) !== body;
    });
  const TAINTED = 'Not served: the text of this gig names a forbidden term, or is missing or changed on disk, so none of its documents leave the dashboard. The next run makes them again; check naming.yaml and the posting.';

  app.get('/freelance/:key/files/:name', (c) => {
    const { key, name } = c.req.param();
    if (!GIG_KEY.test(key) || !GIG_FILE.test(name)) return c.text('Not found', 404);
    const g = d.withStore((s) => s.getGig(key));
    const doc = g?.docs.find((f) => f.path === `gigs/${key}/${name}`);
    if (!g || !doc || g.docsState !== 'ready') return c.text('Not found', 404);
    const ps = d.packState(d.now());
    if (tainted(g.docs, d.redactor(ps.naming).text)) return c.text(TAINTED, 403);
    return sendFile(c, readRecorded(d.paths.out, doc.path, doc.sha256), name, `${doc.kind}-${key}.${doc.format}`);
  });

  app.get('/freelance/:key/sent/:day/:name', (c) => {
    const { key, day, name } = c.req.param();
    if (!GIG_KEY.test(key) || !DAY.test(day) || !GIG_FILE.test(name)) return c.text('Not found', 404);
    const snap = d.withStore((s) => s.gigSnapshots(key).find((x) => x.day === day));
    const f = snap?.files.find((x) => x.path === `gigs/${key}/applied-${day}/${name}`);
    if (!snap || !f) return c.text('Not found', 404);
    const ps = d.packState(d.now());
    if (tainted(snap.files, d.redactor(ps.naming).text)) return c.text(TAINTED, 403);
    return sendFile(c, readRecorded(d.paths.out, f.path, f.sha256), name, `${f.kind}-${key}-sent-${day}.${f.format}`);
  });
}

/**
 * The problems of the latest run as lines, breaker skips collapsed (a review minor): every request a source's breaker
 * skipped becomes one line per platform, "freelancer: 3 requests skipped after 5 failures"; every other problem is its
 * own line ("item: reason").
 */
export function collapseProblems(problems: readonly unknown[]): { kind: string; line: string }[] {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '?');
  const list = problems.filter(isObj);
  const isBreakerSkip = (p: Record<string, unknown>): boolean => p['kind'] === 'skipped' && /breaker/.test(s(p['reason']));
  const out: { kind: string; line: string }[] = [];
  const done = new Set<string>();
  for (const p of list) {
    if (!isBreakerSkip(p)) {
      out.push({ kind: s(p['kind']), line: `${s(p['item'])}: ${s(p['reason'])}` });
      continue;
    }
    const agent = s(p['agent']);
    if (done.has(agent)) continue;
    done.add(agent);
    const skipped = list.filter((q) => isBreakerSkip(q) && q['agent'] === agent).length;
    const failed = list.filter((q) => q['agent'] === agent && q['kind'] === 'failed').length;
    const platform = agent.replace(/^src-/, '');
    out.push({ kind: 'skipped', line: `${platform}: ${skipped} request${skipped === 1 ? '' : 's'} skipped after ${failed} failure${failed === 1 ? '' : 's'}` });
  }
  return out;
}
