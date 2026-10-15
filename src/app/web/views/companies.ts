import { countText, dateText } from '../format.js';
import { html, type Html } from '../html.js';
import { csrfField, meta, pager, pill, type Tone } from './common.js';

/**
 * The Companies tab (Task 11, spec §5): the coverage registry in five lists (Verified, Proposed, Failing, Rejected,
 * and "Deferred this week"), the user's picks the board could not verify, the Add company form, and Approve / Reject /
 * Resolve now as plain POST forms (CSRF field included; they work with JavaScript off). Every value here came from the
 * web or the user and is escaped by `html`; the only link out of the dashboard is a company's careers page, https only
 * (`httpsUrl`), with `rel="noopener noreferrer"`. Any other URL (website, board) is shown as text.
 */

/** A URL from the web that may become a link out of the dashboard: https only, no credentials; else undefined (shown as text). */
export function httpsUrl(u: string | null): string | undefined {
  if (u === null) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export type CompanyList = 'verified' | 'proposed' | 'failing' | 'rejected' | 'unverified';
export type CompanySection = 'add' | 'proposed' | 'failing' | 'unverified' | 'verified' | 'rejected' | 'skipped';
/** A9: what needs you first, then what runs; the jump links are generated from this same list. */
export const COMPANY_SECTIONS: readonly CompanySection[] = ['add', 'proposed', 'failing', 'unverified', 'verified', 'rejected', 'skipped'];
const SECTION_LABEL: Readonly<Record<CompanySection, string>> = {
  add: 'Add a company', proposed: 'Proposed', failing: 'Failing', unverified: 'Your picks not verified', verified: 'Verified', rejected: 'Rejected', skipped: 'Skipped this week',
};

/** One registry row as a list shows it; every text already redacted by the route. */
export interface CompanyRowView {
  readonly key: string;
  readonly name: string;
  readonly platform: string | null;
  readonly platformSlug: string | null;
  readonly boardUrl: string | null;
  readonly careersUrl: string | null;
  readonly website: string;
  readonly reasons: readonly string[];
  readonly source: string;
  /** Jobs the board listed at its last check, or null. */
  readonly jobsSeen: number | null;
  readonly lastVerified: string | null;
  /** The coverage week (its Sunday, ISO date) the company started failing, or null. */
  readonly failingSinceWeek: string | null;
  readonly failWeeks: number;
  readonly userOverride: 'approved' | 'rejected' | null;
  /** This company's jobs in your lists: those passing your rules, and those not eligible. */
  readonly jobs: { readonly passing: number; readonly notEligible: number };
  readonly jobsHref: string;
  /** Whether the daily run reads it, in words. */
  readonly effect: string;
  readonly readDaily: boolean;
}

export interface DeferredHost {
  readonly host: string;
  readonly why: string;
  /** Registry companies on that host (by careers page, board or website), by name. */
  readonly companies: readonly string[];
}

export interface AddFormView {
  readonly name: string;
  readonly website: string;
  readonly error: string | null;
}

export interface CompaniesPageData {
  readonly lists: Readonly<Record<CompanyList, readonly CompanyRowView[]>>;
  /** Companies from the seed lists whose board did not pass (not listed: the lists are long). */
  readonly hiddenFailed: number;
  /** This week's skipped sites: the coverage run they come from (its id, or null), how many, and the count by reason in words. */
  readonly skipped: { readonly run: string | null; readonly total: number; readonly byReason: readonly (readonly [why: string, n: number])[] };
  readonly csrf: string;
  readonly flash: { readonly tone: 'info' | 'warn'; readonly text: string; readonly key: string | null } | null;
  readonly add: AddFormView;
  /** Resolve now can run in this dashboard (it has a fetcher). */
  readonly canResolve: boolean;
}

const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  workday: 'Workday', eightfold: 'Eightfold', oracle: 'Oracle Recruiting', icims: 'iCIMS', successfactors: 'SuccessFactors', smartrecruiters: 'SmartRecruiters',
  workable: 'Workable', recruitee: 'Recruitee', teamtailor: 'Teamtailor', personio: 'Personio', bamboohr: 'BambooHR', breezy: 'Breezy', pinpoint: 'Pinpoint',
  rippling: 'Rippling', gem: 'Gem', greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', 'jsonld-sitemap': 'Job pages (JSON-LD)',
};
export const companyPlatformName = (p: string): string => PLATFORM_LABEL[p] ?? p;

const SOURCE_LABEL: Readonly<Record<string, string>> = { pick: 'your pick', remoteintech: 'remote-jobs list', yc: 'YC hiring list', jobs: 'from your jobs' };

/** A host's disable reason in words (gate.ts reasons), the code kept beside it. */
export function deferWhy(why: string): string {
  if (/429/.test(why)) return 'rate-limited (HTTP 429)';
  if (/challenge/.test(why)) return 'answered with a bot challenge';
  if (/robots-forbidden/.test(why)) return 'robots.txt refused';
  if (/robots-unavailable/.test(why)) return 'robots.txt could not be read';
  if (/robots-transient/.test(why)) return 'robots.txt failed for now (asked again within the hour)';
  if (/no-such-host/.test(why)) return 'no such host';
  if (/robots/.test(why)) return 'robots.txt disallows it';
  if (/401|403/.test(why)) return 'refused access';
  return why;
}

const anchor = (key: string): string => 'co-' + key.replace(/[^a-z0-9-]/g, '-');
const action = (key: string, verb: 'approve' | 'reject' | 'resolve' | 'undo', label: string, csrf: string, primary = false): Html =>
  html`<form method="post" action="/companies/${encodeURIComponent(key)}/${verb}">${csrfField(csrf)}<button class="btn${primary ? ' btn-primary' : ''}">${label}</button></form>`;

function careersLink(c: CompanyRowView): Html {
  const url = httpsUrl(c.careersUrl);
  if (url !== undefined) return html`<a class="src-link" href="${url}" rel="noopener noreferrer" target="_blank">Careers page<span class="visually-hidden"> (opens in a new tab)</span></a>`;
  return c.careersUrl === null ? html`<span class="muted">no careers page found</span>` : html`<span class="muted">careers page (not https, not linked): <code>${c.careersUrl}</code></span>`;
}

function jobsLine(c: CompanyRowView): Html {
  const listed = c.jobs.passing + c.jobs.notEligible;
  const board = c.jobsSeen === null ? '' : html`<span class="num">${c.jobsSeen}</span> open on the board at the last check<span class="sep" aria-hidden="true">·</span>`;
  return html`<p class="co-jobs">${board}${
    listed === 0
      ? html`<span class="muted">none in your lists yet</span>`
      : html`<a href="${c.jobsHref}"><span class="num">${c.jobs.passing}</span> passing your rules${c.jobs.notEligible > 0 ? html`, <span class="num">${c.jobs.notEligible}</span> not eligible` : ''}</a>`
  }</p>`;
}

function found(c: CompanyRowView): Html {
  const parts: Html[] = [];
  if (c.platform !== null) parts.push(html`<span>${companyPlatformName(c.platform)}${c.platformSlug !== null ? html` <code>${c.platformSlug}</code>` : ''}</span>`);
  if (c.boardUrl !== null) parts.push(html`<span>board <code>${c.boardUrl}</code></span>`);
  parts.push(html`<span>website <code>${c.website}</code></span>`);
  return html`<p class="co-found">${meta(parts)}</p>`;
}

const reasonsList = (rs: readonly string[], label: string): Html | '' =>
  rs.length === 0 ? '' : html`<ul class="plain co-reasons" aria-label="${label}">${rs.map((r) => html`<li>${r}</li>`)}</ul>`;

function row(c: CompanyRowView, list: CompanyList, d: CompaniesPageData): Html {
  const status: Readonly<Record<typeof list, [string, Tone]>> = {
    verified: ['Verified', 'good'], proposed: ['Proposed', 'warn'], failing: ['Failing', 'critical'], rejected: ['Rejected', 'muted'], unverified: ['Not verified', 'warn'],
  };
  const [label, tone] = status[list];
  const buttons: Html[] = [];
  if (list === 'proposed' || list === 'rejected') buttons.push(action(c.key, 'approve', 'Approve', d.csrf, list === 'proposed'));
  if (list !== 'rejected') buttons.push(action(c.key, 'reject', 'Reject', d.csrf));
  // Undo clears your choice (it does not approve a rejected company): the status goes back to what coverage decided
  if (c.userOverride !== null) buttons.push(action(c.key, 'undo', c.userOverride === 'approved' ? 'Undo approve' : 'Undo reject', d.csrf));
  if (d.canResolve && list !== 'rejected' && list !== 'verified') buttons.push(action(c.key, 'resolve', 'Resolve now', d.csrf));
  const flash = d.flash !== null && d.flash.key === c.key ? html`<p class="flash" role="status">${d.flash.text}</p>` : '';
  return html`<li class="co" id="${anchor(c.key)}" data-company="${c.key}">
<div class="co-head"><h3 class="co-name">${c.name}</h3>${pill(label, tone)}${c.userOverride !== null ? pill(c.userOverride === 'approved' ? 'Approved by you' : 'Rejected by you', 'accent') : ''}<span class="muted co-key">${c.key} · ${SOURCE_LABEL[c.source] ?? c.source}</span></div>
${found(c)}
<p class="co-links">${careersLink(c)}</p>
${jobsLine(c)}
${list === 'verified' ? html`<p class="hint">Last verified ${c.lastVerified === null ? 'never (approved by you)' : dateText(c.lastVerified)}</p>` : ''}
${list === 'failing' ? html`<p class="co-error"><strong>${c.reasons[0] ?? 'the board stopped answering'}</strong> <span class="muted">failing since the week of ${c.failingSinceWeek === null ? '?' : dateText(c.failingSinceWeek)} (${c.failWeeks} weeks)</span></p>` : ''}
${list === 'failing' ? reasonsList(c.reasons.slice(1), 'More reasons') : reasonsList(list === 'verified' ? [] : c.reasons, 'Why it is not verified')}
<p class="co-effect ${c.readDaily ? 'good-text' : 'muted'}">${c.effect}</p>
${buttons.length > 0 ? html`<div class="btn-row">${buttons}</div>` : ''}
${flash}
</li>`;
}

function section(list: CompanyList, d: CompaniesPageData, lede: string, empty: string): Html {
  const rows = d.lists[list];
  return html`<section class="card wide" aria-labelledby="${list}-h"><h2 id="${list}-h">${SECTION_LABEL[list]} <span class="num tab-count">${countText(rows.length)}</span></h2>
<p class="note">${lede}</p>
${rows.length === 0 ? html`<p class="muted">${empty}</p>` : html`<ul class="cos">${rows.map((c) => row(c, list, d))}</ul>`}
</section>`;
}

function skippedSection(d: CompaniesPageData): Html {
  const n = d.skipped.total;
  return html`<section class="card wide" aria-labelledby="skipped-h"><h2 id="skipped-h">${SECTION_LABEL.skipped} <span class="num tab-count">${countText(n)}</span></h2>
<p class="note">These sites refused or blocked jobpilot this week, so it left them alone. They're tried again next week.</p>
${
  n === 0
    ? html`<p class="muted">${d.skipped.run === null ? 'No coverage run this week yet.' : 'Nothing skipped this week.'}</p>`
    : html`<p>${meta(d.skipped.byReason.map(([why, k]) => html`<span><span class="num">${countText(k)}</span> ${why}</span>`))}</p>
<p><a href="/companies/skipped">See the <span class="num">${countText(n)}</span> sites</a></p>`
}
</section>`;
}

export function skippedBody(d: { readonly hosts: readonly DeferredHost[]; readonly total: number; readonly page: number; readonly pages: number }): Html {
  return html`<div class="page-head">
<p class="crumbs"><a href="/companies#skipped-h">Companies</a></p>
<h1>Sites skipped this week</h1>
<p class="lede"><span class="num">${countText(d.total)}</span> site${d.total === 1 ? '' : 's'} refused or blocked jobpilot this week. They're tried again next week.</p>
</div>
${
  d.hosts.length === 0
    ? html`<p class="empty">Nothing skipped this week.</p>`
    : html`<ul class="plain co-deferred">${d.hosts.map(
        (h) => html`<li data-host="${h.host}">${meta([html`<span><code>${h.host}</code> ${deferWhy(h.why)} <span class="muted">(${h.why})</span></span>`, h.companies.length > 0 ? h.companies.join(', ') : null])}</li>`,
      )}</ul>${pager({ page: d.page, pages: d.pages, href: (k) => (k === 1 ? '/companies/skipped' : '/companies/skipped?page=' + String(k)) })}`
}`;
}

function addForm(d: CompaniesPageData): Html {
  return html`<section class="card wide" aria-labelledby="add-h" id="add"><h2 id="add-h">Add a company</h2>
<p class="note">Give its website (https), and a name if you like. It is added to Proposed and found on the next coverage run, or now with Resolve now. Your companies.yaml is never edited.</p>
${d.add.error !== null ? html`<p class="blocked" role="alert">${d.add.error}</p>` : ''}
<form class="filters co-add" method="post" action="/companies/add">${csrfField(d.csrf)}
<div class="filter-row">
<label class="field grow"><span>Website</span><input type="url" name="website" value="${d.add.website}" placeholder="https://example.com" maxlength="300" inputmode="url"></label>
<label class="field grow"><span>Name (optional)</span><input type="text" name="name" value="${d.add.name}" placeholder="Example Co" maxlength="100"></label>
<div class="filter-actions"><button class="btn btn-primary">Add</button></div>
</div>
</form>
</section>`;
}

export function companiesBody(d: CompaniesPageData): Html {
  const countOf = (s: CompanySection): number => (s === 'add' ? 0 : s === 'skipped' ? d.skipped.total : d.lists[s].length);
  const LEDE: Readonly<Record<CompanyList, readonly [string, string]>> = {
    proposed: ['Found, but a check did not pass, so nothing is read until you approve. The reasons say what did not match.', 'Nothing waiting for you.'],
    failing: ['Verified companies whose board stopped answering 3 weeks running. Still tried daily so they can recover; never removed without you.', 'No board is failing.'],
    unverified: ['Companies you picked whose board did not pass the check; the weekly run tries again.' + (d.hiddenFailed > 0 ? ' ' + String(d.hiddenFailed) + (d.hiddenFailed === 1 ? ' company' : ' companies') + ' from the seed lists did not pass either (not listed).' : ''), 'None.'],
    verified: ['Read by the daily run. Reject one to stop reading it from the next run.', 'No verified company yet.'],
    rejected: ['Never read and never verified again. Undo reject puts one back in Proposed; Approve makes it read daily.', 'You have rejected none.'],
  };
  return html`<div class="page-head">
<h1>Companies</h1>
<p class="lede">The companies whose own career sites jobpilot reads. The weekly coverage run finds and checks them; the daily run reads the verified ones (and the ones you approved).</p>
<nav class="tabs" aria-label="Company lists">${COMPANY_SECTIONS.map((s) => html`<a href="#${s}-h">${SECTION_LABEL[s]}${s === 'add' ? '' : html` <span class="num tab-count">${countText(countOf(s))}</span>`}</a>`)}</nav>
</div>
${d.flash !== null && d.flash.key === null ? html`<p class="banner banner-${d.flash.tone}" role="status">${d.flash.text}</p>` : ''}
<div class="stack">
${COMPANY_SECTIONS.map((s) => (s === 'add' ? addForm(d) : s === 'skipped' ? skippedSection(d) : section(s, d, LEDE[s][0], LEDE[s][1])))}
</div>`;
}
