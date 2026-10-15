import type { GigDoc, GigHistoryEntry, GigSnapshot, GigStatus, GigView, NetworkStatus, SourceHealthRow } from '../../store/app-store.js';
import { GIG_STATUSES, NETWORK_STATUSES } from '../../store/schema.js';
import { countText, dateText, scoreText } from '../format.js';
import { externalUrl, html, type Html } from '../html.js';
import { gigReasonText, platformName } from '../copy.js';
import { csrfField, fitChip, meta, pill, techDetail, type Tone } from './common.js';

/**
 * The freelance tab (Task 10, spec §8): Contracts, Gigs, Review, Networks and Sources, one gig's page, and the fragments
 * htmx swaps. Every value is escaped by `html`; the only link out of the dashboard is a gig's source link
 * (`rel="noopener noreferrer"`, new tab). The routes compute the words (copy.ts); these templates only lay them out.
 */

export type FreelanceTab = 'contracts' | 'gigs' | 'review' | 'networks' | 'sources';
export const GIG_TABS = ['contracts', 'gigs', 'review'] as const;

const TAB_LABEL: Readonly<Record<FreelanceTab, string>> = { contracts: 'Contracts', gigs: 'Gigs', review: 'Review', networks: 'Networks', sources: 'Sources' };
const TAB_HREF: Readonly<Record<FreelanceTab, string>> = {
  contracts: '/freelance', gigs: '/freelance?tab=gigs', review: '/freelance?tab=review', networks: '/freelance/networks', sources: '/freelance/sources',
};

export const GIG_STATUS_LABEL: Readonly<Record<GigStatus, string>> = {
  new: 'Not started', shortlisted: 'Shortlisted', applied: 'Applied', replied: 'Replied', interviewing: 'Interviewing', won: 'Won', lost: 'Lost', skipped: 'Not for me',
};
const GIG_STATUS_TONE: Readonly<Record<GigStatus, Tone>> = {
  new: 'neutral', shortlisted: 'accent', applied: 'good', replied: 'good', interviewing: 'good', won: 'good', lost: 'critical', skipped: 'muted',
};
const gigStatusPill = (s: GigStatus): Html => pill(GIG_STATUS_LABEL[s], GIG_STATUS_TONE[s]);

// `passed` reads "Accepted" since freelance-boost (the stored value is unchanged).
const NETWORK_LABEL: Readonly<Record<NetworkStatus, string>> = { todo: 'Not applied', applied: 'Applied', screening: 'In screening', passed: 'Accepted', rejected: 'Not accepted' };
const NETWORK_TONE: Readonly<Record<NetworkStatus, Tone>> = { todo: 'neutral', applied: 'accent', screening: 'accent', passed: 'good', rejected: 'critical' };

/** One gig as a list row or page header shows it; every text already in the user's words. */
export interface GigRowView {
  readonly gig: GigView;
  readonly rate: string;
  readonly hours: string;
  /** The overlap the posting states, or null when it states none. */
  readonly overlap: string | null;
  readonly istWindow: string;
  /** "covered 6/8 · missing: …", or null when no plan is on record. */
  readonly coverage: string | null;
  /** The fit formula's rows, one per line, for the tooltip. */
  readonly fitTitle: string;
  readonly flags: readonly { readonly label: string; readonly tone: Tone; readonly title: string }[];
  /** Each note of the verdict as written; `amber` for a warning note (only one skill backed). */
  readonly notes: readonly { readonly text: string; readonly amber: boolean }[];
  readonly client: readonly string[];
  readonly age: string | null;
  readonly bids: number | null;
  /** freelance-v2: also listed in "Contract roles matching your stack" (a Review row only). */
  readonly alsoInRoles?: boolean;
}

/** The tab counts, plus (freelance-v2) the Contract roles count, a link to the section at the top of the Freelance tab. */
export type TabCounts = Partial<Record<FreelanceTab | 'roles', number>>;

function tabsNav(here: FreelanceTab, counts: TabCounts): Html {
  return html`<nav class="tabs" aria-label="Freelance">${(Object.keys(TAB_LABEL) as FreelanceTab[]).map(
    (t) => html`<a href="${TAB_HREF[t]}"${t === here ? html` aria-current="page"` : ''}>${TAB_LABEL[t]}${counts[t] !== undefined ? html` <span class="num tab-count">${countText(counts[t] as number)}</span>` : ''}</a>`,
  )}${counts.roles !== undefined ? html`<a href="/freelance#contract-roles">Contract roles <span class="num tab-count">${countText(counts.roles)}</span></a>` : ''}</nav>`;
}

function head(here: FreelanceTab, counts: TabCounts, lede: Html | string): Html {
  return html`<div class="page-head">
<h1>Freelance</h1>
<p class="lede">${lede}</p>
${tabsNav(here, counts)}
</div>`;
}

function sourceLink(g: GigView, label: string): Html | '' {
  const url = externalUrl(g.url);
  return url === undefined ? '' : html`<a class="src-link" href="${url}" rel="noopener noreferrer" target="_blank">${label}<span class="visually-hidden"> (opens in a new tab)</span></a>`;
}

const noteLine = (n: GigRowView['notes'][number]): Html => (n.amber ? html`<li class="gig-note warn-note">${n.text}</li>` : html`<li class="gig-note muted">${n.text}</li>`);

const flagPills = (v: GigRowView): Html => html`${v.flags.map((f) => html`<span class="pill pill-${f.tone}" title="${f.title}">${f.label}</span>`)}`;

function factsLine(v: GigRowView): Html {
  return html`<p class="gig-facts">${meta([
    html`<span>Hours: ${v.hours}</span>`,
    html`<span>Overlap: ${v.overlap ?? 'not stated'} <span class="muted">(your hours ${v.istWindow})</span></span>`,
    v.age,
    v.bids === null ? null : html`<span>Bids: <span class="num">${countText(v.bids)}</span></span>`,
  ])}</p>`;
}

function gigRow(v: GigRowView): Html {
  const g = v.gig;
  return html`<li class="gig" data-gig="${g.gigKey}">
<div class="gig-main">
<h2 class="gig-title"><a href="/freelance/${g.gigKey}">${g.title}</a></h2>
<p class="gig-sub">${meta([platformName(g.platform), v.client.length > 0 ? v.client.join(', ') : html`<span class="muted">no client details</span>`, sourceLink(g, 'Open the posting')])}</p>
${factsLine(v)}
${v.flags.length > 0 ? html`<p class="gig-flags">${flagPills(v)}</p>` : ''}
${v.notes.length > 0 ? html`<ul class="plain gig-notes">${v.notes.map(noteLine)}</ul>` : ''}
${v.coverage !== null ? html`<p class="gig-coverage">${v.coverage}</p>` : ''}
${v.alsoInRoles === true ? html`<p class="gig-also"><a class="pill pill-accent" href="/freelance#contract-roles">Also in Contract roles</a></p>` : ''}
</div>
<div class="gig-rate"><span class="rate-label">${v.rate}</span></div>
<div class="gig-fit" title="${v.fitTitle}">${fitChip(g.fit)}</div>
<div class="gig-status">${gigStatusPill(g.status)}</div>
</li>`;
}

/** One row of "Contract roles matching your stack" (freelance-v2): every text already in the user's words. */
export interface ContractRoleView {
  readonly gig: GigView;
  readonly company: string | null;
  /** Where it may be worked from (`scopeText`). */
  readonly scope: string;
  /** The first matched skills the user's facts back (the plan's covered terms, by display), or [] with no plan on record. */
  readonly skills: readonly string[];
  /** What to ask before applying (`askText`). */
  readonly ask: string;
  readonly age: string | null;
  /** The recorded documents when they are ready, else []. */
  readonly files: readonly GigDoc[];
  /** Why there are no documents, when there are none. */
  readonly docsReason: string | null;
}

export interface ContractRolesData {
  readonly rows: readonly ContractRoleView[];
  readonly fitFloor: number;
}

export interface GigListData {
  /** freelance-v2: the Contract roles section, shown at the top of the Contracts tab (the Freelance landing tab). */
  readonly roles?: ContractRolesData;
  readonly tab: (typeof GIG_TABS)[number];
  readonly rows: readonly GigRowView[];
  readonly counts: TabCounts;
  /** "1 below the fit floor and 1 not eligible are not shown", or null. */
  readonly hidden: string | null;
  readonly fitFloor: number;
  readonly lastRun: string | null;
}

const LEDE: Readonly<Record<GigListData['tab'], string>> = {
  contracts: 'Contract roles you can pitch for, best rate first, then fit. Red flags sort last.',
  gigs: 'Project gigs you can bid on, best rate first, then fit. Red flags sort last.',
  review: 'Review holds gigs that need your judgement; the fit floor applies to Contracts and Gigs only.',
};

const ROLE_FILE_LABEL = (d: Pick<GigDoc, 'kind' | 'format'>): string => (d.kind === 'resume' ? (d.format === 'docx' ? 'CV (Word, DOCX)' : 'CV (PDF)') : FILE_LABEL(d));
/** The order the documents are offered in a role row: the CV, the cover letter, then the pitch; never the HTML preview. */
const ROLE_FILE_ORDER = ['resume.pdf', 'resume.docx', 'cover.pdf', 'cover.docx', 'cover.txt', 'pitch.txt', 'proposal.txt'];

function roleRow(r: ContractRoleView): Html {
  const g = r.gig;
  const files = ROLE_FILE_ORDER.flatMap((n) => r.files.filter((f) => f.kind + '.' + f.format === n));
  const sub: Html[] = [
    html`<span>${r.company ?? html`<span class="muted">company not stated</span>`}</span>`,
    html`<span>${r.scope}</span>`,
    html`<span>${platformName(g.platform)}</span>`,
    ...(r.age !== null ? [html`<span>${r.age}</span>`] : []),
  ];
  const url = externalUrl(g.url);
  return html`<li class="role" data-role="${g.gigKey}">
<div class="gig-main">
<h3 class="gig-title"><a href="/freelance/${g.gigKey}">${g.title}</a></h3>
<p class="gig-sub">${meta(sub)}</p>
<p class="role-skills">${r.skills.length > 0 ? html`Matches your facts: ${r.skills.join(', ')}` : html`<span class="muted">Matched skills not on record yet</span>`}</p>
<p class="role-ask">${pill(r.ask, 'warn', 'The posting does not state these: ask the employer before you apply')}</p>
${files.length > 0 ? html`<div class="downloads">${files.map((f) => html`<a class="btn" href="/freelance/${g.gigKey}/files/${f.kind}.${f.format}" download>${ROLE_FILE_LABEL(f)}</a>`)}</div>` : html`<p class="muted">${r.docsReason ?? 'No documents yet.'}</p>`}
${url === undefined ? '' : html`<p><a class="src-link" href="${url}" rel="noopener noreferrer" target="_blank">Apply on the posting<span class="visually-hidden"> (opens in a new tab)</span></a></p>`}
</div>
<div class="gig-fit" title="Fit">${fitChip(g.fit)}</div>
</li>`;
}

/**
 * "Contract roles matching your stack" (freelance-v2, Feature 1; UI only, no rule change): the Review contracts from
 * employer job boards at or above the fit floor, best fit first, then newest. They stay review items (pay or hours not
 * stated); the Review list still shows each, marked "Also in Contract roles".
 */
export function contractRolesSection(d: ContractRolesData): Html {
  return html`<section class="card wide roles" id="contract-roles" aria-labelledby="roles-h">
<h2 id="roles-h">Contract roles matching your stack <span class="num tab-count">${countText(d.rows.length)}</span></h2>
<p class="hint">Contract roles from employer job boards (Himalayas and the daily boards) with fit <span class="num">${scoreText(d.fitFloor)}</span> or more. Their pay or hours are not stated, so they stay in Review: ask before you apply. Best fit first, then newest.</p>
${d.rows.length === 0 ? html`<p class="empty">No contract role from an employer job board is at or above your fit floor yet.</p>` : html`<ol class="roles-list" aria-label="Contract roles">${d.rows.map(roleRow)}</ol>`}
</section>`;
}

export function gigListBody(d: GigListData): Html {
  const lede = html`${LEDE[d.tab]}${d.tab === 'review' ? '' : html` Fit floor <span class="num">${scoreText(d.fitFloor)}</span>.`}${d.lastRun !== null ? html` <span class="muted">Last run ${d.lastRun}.</span>` : ''}`;
  return html`${head(d.tab, d.counts, lede)}
${d.roles !== undefined ? contractRolesSection(d.roles) : ''}
${d.hidden !== null ? html`<p class="note">${d.hidden}</p>` : ''}
${d.rows.length === 0 ? html`<p class="empty">Nothing here yet. The next freelance run fills this list.</p>` : html`<ol class="gigs" aria-label="${TAB_LABEL[d.tab]}">${d.rows.map(gigRow)}</ol>`}
<p class="hint">jobpilot never bids or applies for you: open the posting, paste the text, and mark the status here.</p>`;
}

// ---- one gig --------------------------------------------------------------------------------------------------------

export interface PasteDoc {
  readonly kind: 'proposal' | 'pitch';
  /** The file text split where a line cites facts (`facts` set) so the line gets its provenance tooltip. */
  readonly segments: readonly { readonly text: string; readonly facts: readonly string[] | null }[];
  /** Characters of the text (code points, the final line end excluded), and the platform limit. */
  readonly chars: number;
  readonly max: number | null;
}

export interface GigSentData {
  readonly gigKey: string;
  /** Applied, ready documents and no snapshot: offer to keep a copy now. */
  readonly canKeep: boolean;
  readonly csrf: string;
  readonly snapshots: readonly GigSnapshot[];
  readonly appliedDay: string | null;
}

export interface GigPageData {
  readonly row: GigRowView;
  readonly csrf: string;
  /** The paste-ready text, or why it is not shown. */
  readonly paste: PasteDoc | null;
  readonly pasteProblem: string | null;
  /** freelance-v2: the cover letter's paste text (`cover.txt`) or why it is not shown, and its files; null without a cover. */
  readonly cover?: { readonly text: string | null; readonly problem: string | null; readonly files: readonly GigDoc[] } | null;
  readonly files: readonly GigDoc[];
  readonly docsReason: string | null;
  readonly history: readonly GigHistoryEntry[];
  readonly sent: GigSentData;
  readonly breakdown: readonly { readonly label: string; readonly points: number; readonly shown: boolean }[];
  readonly reasons: readonly string[];
  readonly duplicateOf: string | null;
  readonly istDay: (iso: string) => string;
  readonly flash?: string;
}

const FILE_LABEL = (d: Pick<GigDoc, 'kind' | 'format'>): string =>
  d.kind === 'cover'
    ? d.format === 'txt' ? 'Cover letter (.txt)' : d.format === 'pdf' ? 'Cover letter (PDF)' : d.format === 'docx' ? 'Cover letter (Word, DOCX)' : 'Cover letter (web page, HTML)'
    : d.format === 'txt' ? (d.kind === 'pitch' ? 'Pitch (.txt)' : 'Proposal (.txt)') : d.format === 'pdf' ? 'Contract CV (PDF)' : 'Contract CV (Word, DOCX)';

/** freelance-v2: the cover letter card, with Copy (the exact `cover.txt`) and its downloads (PDF, DOCX, .txt, HTML). */
function coverSection(d: GigPageData): Html | '' {
  const c = d.cover;
  if (c === undefined || c === null) return '';
  const g = d.row.gig;
  const files = ['pdf', 'docx', 'txt', 'html'].flatMap((f) => c.files.filter((x) => x.kind === 'cover' && x.format === f));
  if (c.text === null) return html`<section class="card wide" aria-labelledby="cover-h"><h2 id="cover-h">Your cover letter</h2><p class="blocked">${c.problem ?? 'No cover letter yet.'}</p></section>`;
  return html`<section class="card wide" aria-labelledby="cover-h">
<h2 id="cover-h">Your cover letter</h2>
<div class="paste-bar">
<button type="button" class="btn btn-primary copy-btn" data-copy-src="/freelance/${g.gigKey}/files/cover.txt" data-copy-target="cover-text" hidden>Copy</button>
<span class="copy-status" role="status" aria-live="polite"></span>
</div>
<pre class="paste" id="cover-text">${c.text}</pre>
<p class="hint">Built only from your verified facts, for the employer's own application form. Copy pastes exactly the .txt file; the letter never states pay or hours.</p>
<div class="downloads">${files.map((f) => html`<a class="btn" href="/freelance/${g.gigKey}/files/${f.kind}.${f.format}" download>${FILE_LABEL(f)}</a>`)}</div>
</section>`;
}

function pasteSection(d: GigPageData): Html {
  const g = d.row.gig;
  const p = d.paste;
  const title = p?.kind === 'pitch' || g.kind === 'contract' ? 'Your pitch' : 'Your proposal';
  if (p === null) {
    return html`<section class="card wide" aria-labelledby="paste-h"><h2 id="paste-h">${title}</h2><p class="blocked">${d.pasteProblem ?? d.docsReason ?? 'No documents yet.'}</p></section>`;
  }
  const over = p.max !== null && p.chars > p.max;
  const txt = d.files.find((f) => f.format === 'txt' && f.kind !== 'cover');
  return html`<section class="card wide" aria-labelledby="paste-h">
<h2 id="paste-h">${title}</h2>
<div class="paste-bar">
<button type="button" class="btn btn-primary copy-btn" data-copy-src="/freelance/${g.gigKey}/files/${txt?.kind ?? p.kind}.txt" data-copy-target="paste" hidden>Copy</button>
<span class="copy-status" role="status" aria-live="polite"></span>
<span class="char-count num${over ? ' over' : ''}">${countText(p.chars)}${p.max !== null ? html` / ${countText(p.max)}` : ''} characters</span>
</div>
<pre class="paste" id="paste">${p.segments.map((s) => (s.facts === null ? s.text : html`<span class="fact-src" data-fact="${s.facts.join(' ')}" title="Fact${s.facts.length === 1 ? '' : 's'} ${s.facts.join(', ')}">${s.text}</span>`))}</pre>
<p class="hint">Copy pastes exactly the .txt file.${p.segments.some((x) => x.facts !== null) ? ' Hover an underlined line to see the fact it comes from.' : ''} Paste it on ${platformName(g.platform)} yourself: jobpilot never sends it.</p>
<div class="downloads">${d.files.filter((f) => f.kind !== 'cover').map((f) => html`<a class="btn" href="/freelance/${g.gigKey}/files/${f.kind}.${f.format}" download>${FILE_LABEL(f)}</a>`)}</div>
</section>`;
}

export function gigSentSection(d: GigSentData, oob = false): Html {
  return html`<section id="sent" class="card wide"${oob ? html` hx-swap-oob="true"` : ''} aria-labelledby="sent-h"${d.snapshots.length > 0 || d.canKeep ? '' : html` hidden`}>
<h2 id="sent-h">Documents you sent</h2>
${
  d.canKeep
    ? html`<p class="hint">You marked this gig applied, but no copy of its documents was kept. A copy made now is today's version, which may differ from what you sent.</p>
<form method="post" action="/freelance/${d.gigKey}/keep" hx-post="/freelance/${d.gigKey}/keep" hx-target="#sent" hx-swap="outerHTML">${csrfField(d.csrf)}<button class="btn btn-primary">Keep a copy of these documents now</button></form>`
    : ''
}
${d.snapshots.map(
  (s) => html`<div class="sent"><h3>${s.day === d.appliedDay ? 'Applied' : 'Copy kept'} ${dateText(s.day)}</h3><p class="hint">Kept read-only, exactly as they were that day; later runs never change them.</p>
<ul class="plain sent-files">${s.files.map((f) => html`<li><a href="/freelance/${d.gigKey}/sent/${s.day}/${f.kind}.${f.format}" download>${FILE_LABEL(f)}</a></li>`)}</ul></div>`,
)}
</section>`;
}

/** The status block: a button per status in flow order, and the last change. Returned alone to htmx. */
export function gigStatusSection(g: Pick<GigView, 'gigKey' | 'status' | 'appliedAt'>, history: readonly GigHistoryEntry[], csrf: string, istDay: (iso: string) => string, flash?: string): Html {
  const last = history.at(-1);
  return html`<section id="status" class="card" aria-labelledby="status-h">
<h2 id="status-h">Your status ${gigStatusPill(g.status)}</h2>
${g.appliedAt !== null ? html`<p class="muted">Applied ${dateText(istDay(g.appliedAt))}</p>` : ''}
<form class="status-form" method="post" action="/freelance/${g.gigKey}/status" hx-post="/freelance/${g.gigKey}/status" hx-target="#status" hx-swap="outerHTML">
${csrfField(csrf)}
<div class="btn-row">${GIG_STATUSES.map(
    (s) => html`<button class="btn${s === g.status ? ' btn-current' : ''}" name="to" value="${s}" aria-pressed="${s === g.status ? 'true' : 'false'}">${GIG_STATUS_LABEL[s]}</button>`,
  )}</div>
</form>
<p class="hint">New → Shortlisted → Applied → Replied → Interviewing → Won, Lost or Not for me. Applied keeps a read-only copy of what you sent.</p>
${flash !== undefined ? html`<p class="flash" role="status">${flash}</p>` : ''}
${last !== undefined ? html`<p class="hint">Last change: ${last.from === null ? '' : html`${GIG_STATUS_LABEL[last.from]} → `}${GIG_STATUS_LABEL[last.to]} on ${dateText(istDay(last.at))}</p>` : ''}
</section>`;
}

function fitSection(d: GigPageData): Html {
  const g = d.row.gig;
  if (d.breakdown.length === 0) return html`<section class="card" aria-labelledby="fit-h"><h2 id="fit-h">Fit</h2><p class="muted">Not scored${g.verdict === 'rejected' ? ': this gig is not eligible.' : '.'}</p></section>`;
  const counted = d.breakdown.filter((b) => b.shown === false);
  const shown = d.breakdown.filter((b) => b.shown);
  return html`<section class="card" aria-labelledby="fit-h"><h2 id="fit-h">Fit <span class="num">${g.fit === null ? '–' : scoreText(g.fit)}</span></h2>
<div class="table-wrap"><table class="breakdown"><thead><tr><th scope="col">What counted</th><th scope="col" class="num">Points</th></tr></thead>
<tbody>${counted.map((b) => html`<tr${b.points < 0 ? html` class="neg"` : ''}><td>${b.label}</td><td class="num">${b.points > 0 ? '+' : ''}${scoreText(b.points)}</td></tr>`)}</tbody></table></div>
${shown.length > 0 ? html`<p class="hint">Shown, not counted in the fit: ${shown.map((b, i) => html`${i > 0 ? ', ' : ''}${b.label} ${scoreText(b.points)}`)}</p>` : ''}
</section>`;
}

function checksSection(d: GigPageData): Html {
  const v = d.row;
  const empty = v.flags.length === 0 && v.notes.length === 0 && d.reasons.length === 0;
  return html`<section class="card" aria-labelledby="checks-h"><h2 id="checks-h">Before you bid</h2>
${v.flags.length > 0 ? html`<p class="gig-flags">${flagPills(v)}</p>` : ''}
${d.reasons.length > 0 ? html`<ul class="plain">${[...new Set(d.reasons.map(gigReasonText))].map((t) => html`<li>${t}</li>`)}</ul>${techDetail(d.reasons)}` : ''}
${v.notes.length > 0 ? html`<ul class="plain gig-notes">${v.notes.map(noteLine)}</ul>` : ''}
${empty ? html`<p class="muted">Nothing to flag.</p>` : ''}
${v.client.length > 0 ? html`<p class="hint">Client: ${v.client.join(', ')}</p>` : html`<p class="hint">The platform states nothing about the client.</p>`}
</section>`;
}

export function gigBody(d: GigPageData): Html {
  const v = d.row;
  const g = v.gig;
  return html`<header class="job-head">
<p class="crumbs"><a href="/freelance">Freelance</a></p>
<h1>${g.title}</h1>
<p class="job-sub">${meta([platformName(g.platform), g.kind === 'contract' ? 'Contract' : g.kind === 'gig' ? 'Gig' : g.kind, v.age, v.bids !== null ? html`<span class="num">${v.bids} bid${v.bids === 1 ? '' : 's'}</span>` : null])}</p>
<div class="head-facts">
<div class="fact-box"><span class="label">Rate</span><span class="rate-label">${v.rate}</span></div>
<div class="fact-box"><span class="label">Hours</span><span>${v.hours}</span></div>
<div class="fact-box"><span class="label">IST overlap</span><span>${v.overlap ?? 'not stated'}</span><span class="hint">your window ${v.istWindow}</span></div>
<div class="fact-box"><span class="label">Fit</span><span class="big num" aria-hidden="true" title="${v.fitTitle}">${g.fit === null ? '–' : scoreText(g.fit)}</span><span class="hint" aria-hidden="true">out of 100</span><span class="visually-hidden">${g.fit === null ? 'Not scored' : html`Fit score ${scoreText(g.fit)} out of 100`}</span></div>
</div>
${v.coverage !== null ? html`<p class="gig-coverage">${v.coverage}</p>` : ''}
<p>${sourceLink(g, 'Open the original posting')}</p>
</header>
${d.duplicateOf !== null ? html`<p class="note">This is another listing of <a href="/freelance/${d.duplicateOf}">the same gig</a>.</p>` : ''}
<div class="job-grid">
${pasteSection(d)}
${coverSection(d)}
${gigSentSection(d.sent)}
${checksSection(d)}
${gigStatusSection(g, d.history, d.csrf, d.istDay, d.flash)}
${fitSection(d)}
<section class="card wide" aria-labelledby="desc-h"><h2 id="desc-h">The posting</h2>
<details><summary>Show the full text</summary><div class="jd">${g.description}</div></details></section>
</div>`;
}

// ---- networks -------------------------------------------------------------------------------------------------------

export interface NetworkCard {
  readonly id: string;
  readonly name: string;
  /** Whether the user's pack has a network file for it (screening stages, application pack). */
  readonly hasFile: boolean;
  readonly checkedByUser: boolean;
  readonly stages: readonly string[];
  readonly status: NetworkStatus;
  readonly updatedAt: string | null;
  /** When the user last marked it applied (the logged action), or null. */
  readonly appliedAt: string | null;
  /** What the research verified (the catalogue), or null for a network only the user's pack knows. */
  readonly facts: {
    readonly applyUrl: string;
    readonly india: 'open' | 'not-open' | 'unverified';
    readonly indiaNote: string;
    readonly rates: string;
    readonly hours: string;
    readonly process: string;
    readonly order: number | null;
  } | null;
  /** The pack files on disk (`resume.pdf`, …), in NETWORK_FILES order. */
  readonly files: readonly string[];
  /** checklist.md as written, or null when there is no pack yet. */
  readonly checklist: string | null;
}

const NETWORK_FILE_LABEL: Readonly<Record<string, string>> = {
  'resume.pdf': 'CV (PDF)', 'resume.docx': 'CV (Word, DOCX)', 'profile.txt': 'Profile text', 'checklist.md': 'Vetting checklist',
};

/**
 * The status block, returned alone to htmx: the status with its date ("Applied on 15 Oct 2026"; a later status keeps
 * "applied on …"), a one-click "Mark applied" while not applied yet (never for a network not open to India), and every
 * status as a button. Each POST carries the CSRF token and is logged (`network.status`).
 */
export function networkStatusBlock(n: Pick<NetworkCard, 'id' | 'status' | 'updatedAt' | 'appliedAt'> & { readonly notOpen?: boolean }, csrf: string, istDay: (iso: string) => string): Html {
  const since =
    n.status === 'applied' && (n.appliedAt ?? n.updatedAt) !== null ? html` <span>on ${dateText(istDay((n.appliedAt ?? n.updatedAt) as string))}</span>`
    : n.status !== 'todo' && n.appliedAt !== null ? html` <span class="hint">since ${n.updatedAt !== null ? dateText(istDay(n.updatedAt)) : ''}; applied on ${dateText(istDay(n.appliedAt))}</span>`
    : n.updatedAt !== null && n.status !== 'todo' ? html` <span class="hint">since ${dateText(istDay(n.updatedAt))}</span>`
    : '';
  const action = "/freelance/networks/" + n.id + "/status";
  const quick = n.status === 'todo' && n.notOpen !== true
    ? html`<form class="net-quick" method="post" action="${action}" hx-post="${action}" hx-target="#net-status-${n.id}" hx-swap="outerHTML">
${csrfField(csrf)}<button class="btn btn-primary" name="to" value="applied">Mark applied</button></form>`
    : '';
  return html`<div class="net-status" id="net-status-${n.id}">
<p>${pill(NETWORK_LABEL[n.status], NETWORK_TONE[n.status])}${since}</p>
${quick}
<form method="post" action="${action}" hx-post="${action}" hx-target="#net-status-${n.id}" hx-swap="outerHTML">${csrfField(csrf)}
<div class="btn-row">${NETWORK_STATUSES.map((s) => html`<button class="btn${s === n.status ? ' btn-current' : ''}" name="to" value="${s}" aria-pressed="${s === n.status ? 'true' : 'false'}">${NETWORK_LABEL[s]}</button>`)}</div>
</form></div>`;
}

const INDIA_PILL: Readonly<Record<'open' | 'not-open' | 'unverified', Html>> = {
  open: pill('Open to India', 'good'),
  'not-open': pill('Not open to India', 'critical'),
  unverified: pill('India not confirmed', 'warn'),
};

function networkFacts(n: NetworkCard): Html {
  const f = n.facts;
  if (f === null) return html`<p class="muted">Not in jobpilot's network list: only your network file is known.</p>`;
  const url = externalUrl(f.applyUrl);
  return html`<p>${INDIA_PILL[f.india]}${f.order !== null ? html` <span class="hint">#${f.order} in the recommended order</span>` : ''}</p>
<p class="hint">${f.indiaNote}</p>
<dl class="net-facts"><dt>Typical rates</dt><dd>${f.rates}</dd><dt>Hours</dt><dd>${f.hours}</dd><dt>How</dt><dd>${f.process}</dd></dl>
${url === undefined ? '' : html`<p><a class="src-link" href="${url}" rel="noopener noreferrer" target="_blank">Apply on ${n.name}<span class="visually-hidden"> (opens in a new tab)</span></a></p>`}`;
}

function networkCard(n: NetworkCard, csrf: string, istDay: (iso: string) => string): Html {
  const unchecked = n.hasFile && !n.checkedByUser;
  return html`<section class="card net" id="net-${n.id}" data-network="${n.id}" aria-labelledby="net-h-${n.id}">
<h2 id="net-h-${n.id}">${n.name}</h2>
${unchecked ? html`<p class="net-flag">${pill('check before use', 'warn')}</p>` : ''}
${networkFacts(n)}
${unchecked ? html`<p class="fact-warn">The screening stages are a starter file you have not checked yet: check before use.</p>` : ''}
${networkStatusBlock({ ...n, notOpen: n.facts?.india === 'not-open' }, csrf, istDay)}
<h3>Your pack</h3>
${
  !n.hasFile
    ? html`<p class="muted">No network file: add <code>pack/networks/${n.id}.yaml</code> to build an application pack for it.</p>`
    : n.files.length === 0
    ? html`<p class="muted">No pack yet: run <code>jobpilot networks pack ${n.id}</code>.</p>`
    : html`<div class="downloads">${n.files.map((f) => html`<a class="btn" href="/freelance/networks/${n.id}/files/${f}" download>${NETWORK_FILE_LABEL[f] ?? f}</a>`)}</div>`
}
${
  !n.hasFile
    ? ''
    : html`<h3>Checklist</h3>
${
  n.checklist !== null
    ? html`<pre class="checklist">${n.checklist}</pre>`
    : n.stages.length > 0
      ? html`<ol class="stages">${n.stages.map((s) => html`<li>${s}</li>`)}</ol>`
      : html`<p class="muted">No screening stages in the network file.</p>`
}`
}
</section>`;
}

export interface NetworksData {
  /** The date the catalogue's facts were checked (NETWORKS_CHECKED). */
  readonly checked: string;
  readonly cards: readonly NetworkCard[];
  readonly counts: TabCounts;
  readonly csrf: string;
  readonly istDay: (iso: string) => string;
  readonly packError: string | null;
}

export function networksBody(d: NetworksData): Html {
  const lede = html`Vetted networks you apply to once; after that they send you matching work. Each pack is built only from your verified facts.`;
  return html`${head('networks', d.counts, lede)}
<p class="note">Recommended order (research of ${dateText(d.checked)}): micro1, Mercor and Alignerr first (hourly AI-evaluation work at 10–20 h/week, quick to apply), then Arc, Braintrust, Toptal and Proxify, then the rest. A network that does not take people in India is last and has no “Mark applied”.</p>
${d.packError !== null ? html`<p class="blocked">Your pack could not be read: ${d.packError}</p>` : ''}
<div class="net-grid">${d.cards.map((c) => networkCard(c, d.csrf, d.istDay))}</div>`;
}

// ---- sources --------------------------------------------------------------------------------------------------------

export interface SourceTable {
  readonly platform: string;
  readonly rows: readonly (SourceHealthRow & { readonly outcomes: { applied: number; replied: number; won: number } })[];
  readonly probeFailures: number;
}

export interface SourcesData {
  readonly tables: readonly SourceTable[];
  readonly disabled: readonly { readonly platform: string; readonly reason: string }[];
  readonly problems: readonly { readonly kind: string; readonly line: string }[];
  readonly lastRun: string | null;
  readonly counts: TabCounts;
}

const PROBLEM_LABEL: Readonly<Record<string, string>> = {
  failed: 'Failed', gone: 'Gone', input_rejected: 'Input rejected', quarantined: 'Quarantined', skipped: 'Skipped', 'commit-failed': 'Not written',
  'docs-blocked': 'Documents blocked', 'source-dead': 'Source looks dead', 'mail-quarantined': 'Alert email set aside',
};

const HEALTH_COLUMNS = [
  ['runs', 'Runs'], ['failedRuns', 'Failed runs'], ['fetched', 'Fetched'], ['eligible', 'Eligible'], ['aboveFloor', 'Above floor'], ['shortlisted', 'Shortlisted'],
] as const;

function sourceTable(t: SourceTable): Html {
  return html`<section class="card wide" aria-labelledby="src-${t.platform}"><h2 id="src-${t.platform}">${platformName(t.platform)}${t.probeFailures > 0 ? pill(String(t.probeFailures) + (t.probeFailures === 1 ? ' failed run in a row' : ' failed runs in a row'), 'critical') : ''}</h2>
<div class="table-wrap"><table class="counts"><thead><tr><td></td><th scope="colgroup" colspan="2">Runs</th><th scope="colgroup" colspan="4">Shortlisted and the rest: summed per run</th><th scope="colgroup" colspan="3">Applied and the rest: distinct gigs, from your status changes</th></tr>
<tr><th scope="col">Week</th>${HEALTH_COLUMNS.map(([, l]) => html`<th scope="col" class="num">${l}</th>`)}<th scope="col" class="num">Applied</th><th scope="col" class="num">Replied</th><th scope="col" class="num">Won</th></tr></thead>
<tbody>${t.rows.map(
    (r) => html`<tr><th scope="row" class="num">${r.week}</th>${HEALTH_COLUMNS.map(([k]) => html`<td class="num${r[k] === 0 ? ' zero' : ''}${k === 'failedRuns' && r[k] > 0 ? ' bad' : ''}">${countText(r[k])}</td>`)}${(['applied', 'replied', 'won'] as const).map((k) => html`<td class="num${r.outcomes[k] === 0 ? ' zero' : ''}">${countText(r.outcomes[k])}</td>`)}</tr>`,
  )}</tbody></table></div></section>`;
}

export function sourcesBody(d: SourcesData): Html {
  // Final review M8: the two kinds of count are labelled apart, so a shortlisted figure is never read as distinct gigs.
  const lede = html`What each source found in the last 8 weeks (IST weeks). Fetched, eligible, above floor and shortlisted are summed per run: a gig seen in two runs counts twice. Applied, replied and won count distinct gigs, from your own status changes.`;
  return html`${head('sources', d.counts, lede)}
<div class="stack">
<section class="card wide" aria-labelledby="disabled-h"><h2 id="disabled-h">Not fetched</h2>
${d.disabled.length === 0 ? html`<p class="muted">Every source is on.</p>` : html`<ul class="plain">${d.disabled.map((x) => html`<li><strong>${platformName(x.platform)}</strong> ${x.reason}</li>`)}</ul>`}
</section>
<section class="card wide" aria-labelledby="probs-h"><h2 id="probs-h">Problems in the last run${d.lastRun !== null ? html` <span class="hint">${d.lastRun}</span>` : ''}</h2>
${d.lastRun === null ? html`<p class="muted">No freelance run yet.</p>` : d.problems.length === 0 ? html`<p class="good-text">No problems.</p>` : html`<ul class="plain problems-list">${d.problems.map((p) => html`<li><span class="problem-kind">${PROBLEM_LABEL[p.kind] ?? p.kind}</span> ${p.line}</li>`)}</ul>`}
</section>
${d.tables.length === 0 ? html`<p class="empty">No source has been counted yet.</p>` : d.tables.map(sourceTable)}
</div>`;
}
