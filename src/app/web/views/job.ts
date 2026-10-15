import type { JobDetail, JobStatus, Snapshot } from '../../store/app-store.js';
import { appliedAgo, countText, dateText, scoreText } from '../format.js';
import { isFollowUpDue } from '../../triage.js';
import { externalUrl, html, type Html } from '../html.js';
import { breakdownText, docsReason, reasonText, sourceName } from '../copy.js';
import { b2bPill, officePill, bandPill, compCell, csrfField, meta, pill, remotePill, STATUS_LABEL, STATUSES, statusPill, techDetail } from './common.js';

export interface Recommended {
  readonly format: 'pdf' | 'docx';
  /** Who it is for, mid-sentence: "Greenhouse", "most applicant systems", "a careers site". */
  readonly for: string;
}

export interface JobPageData {
  readonly job: JobDetail;
  readonly sent: SentData;
  readonly csrf: string;
  /** Screening answers from the pack, as label and value; null when the pack could not be read. */
  readonly answers: readonly (readonly [string, string])[] | null;
  /** A lexicon key's display name. */
  readonly display: (key: string) => string;
  readonly recommended: Recommended;
  /** The preferred listing, when this row is another listing of it. */
  readonly preferred: { readonly jobKey: string; readonly source: string } | null;
  readonly istDay: (iso: string) => string;
  /** The current instant (A14: how long ago it was applied). */
  readonly now: string;
  /** A one-off message after a status change (a snapshot that could not be made). */
  readonly flash?: string;
  /** A8: the list this job was opened from, and the row after it. */
  readonly back?: { readonly from: string; readonly next?: string };
  /** A2: the facts the current documents cite, with their claims; null when unknown. */
  readonly cited?: readonly { readonly id: string; readonly claim: string }[] | null;
}

const FORMAT_NAME = { pdf: 'PDF', docx: 'Word (DOCX)', html: 'HTML' } as const;
const KIND_NAME = { resume: 'Resume', cover: 'Cover letter' } as const;

function header(j: JobDetail, back?: JobPageData['back']): Html {
  const url = externalUrl(j.url);
  return html`<header class="job-head">
<p class="crumbs"><a href="${back?.from ?? '/'}#job-${j.jobKey}">← Jobs</a></p>
<h1>${j.title}</h1>
<p class="job-sub">${meta([
  j.company === '' ? null : html`<span class="job-company">${j.company}</span>`,
  j.location,
  html`<span>via ${sourceName(j.source)}${j.ats !== j.source && j.ats !== 'feed' ? html` (applies on ${sourceName(j.ats)})` : ''}</span>`,
])}</p>
<div class="head-facts">
<div class="fact-box"><span class="label">Pay</span>${compCell(j)}</div>
<div class="fact-box"><span class="label">Fit score</span><span class="big num" aria-hidden="true">${j.score === null ? '–' : scoreText(j.score)}</span><span class="hint" aria-hidden="true">out of 100</span><span class="visually-hidden">${j.score === null ? 'Not scored' : html`Fit score ${scoreText(j.score)} out of 100`}</span></div>
<div class="fact-box"><span class="label">Band</span>${bandPill(j.band)}</div>
<div class="fact-box"><span class="label">Where</span>${remotePill(j.remote)}</div>
</div>
${url !== undefined ? html`<p><a class="btn btn-primary" href="${url}" rel="noopener noreferrer" target="_blank">Open the posting ↗<span class="visually-hidden"> (opens in a new tab)</span></a></p>` : ''}
</header>`;
}

function duplicates(j: JobDetail, preferred: JobPageData['preferred']): Html | '' {
  if (preferred !== null) {
    return html`<p class="note">This is another listing of <a href="/jobs/${preferred.jobKey}">the same job on ${sourceName(preferred.source)}</a>; status and note are shared.</p>`;
  }
  if (j.alsoListedOn.length === 0) return '';
  return html`<p class="note">Also listed on ${j.alsoListedOn.map(sourceName).join(', ')}. Status and note are shared across the listings.</p>`;
}

function whyMatched(j: JobDetail, display: (k: string) => string): Html {
  if (j.breakdown === null || j.breakdown.length === 0) {
    return html`<section class="card" aria-labelledby="why"><h2 id="why">Why it matched</h2><p class="muted">Not scored: ${j.verdict === 'rejected' ? 'this job is not eligible.' : 'no run has scored it yet.'}</p></section>`;
  }
  return html`<section class="card" aria-labelledby="why"><h2 id="why">Why it matched</h2>
<div class="table-wrap"><table class="breakdown">
<thead><tr><th scope="col">What counted</th><th scope="col" class="num">Points</th></tr></thead>
<tbody>${j.breakdown.map(
    (b) => html`<tr${b.points < 0 ? html` class="neg"` : ''}><td>${breakdownText(b.label, display)}</td><td class="num">${b.points > 0 ? '+' : ''}${scoreText(b.points)}</td></tr>`,
  )}</tbody>
<tfoot><tr><th scope="row">Score</th><td class="num">${j.score === null ? '–' : scoreText(j.score)}</td></tr></tfoot>
</table></div></section>`;
}

function eligibility(j: JobDetail): Html {
  const verdict = j.verdict === 'eligible' ? pill('Eligible', 'good') : j.verdict === 'review' ? pill('Needs a look', 'warn') : j.verdict === 'rejected' ? pill('Not eligible', 'critical') : pill('Not assessed yet', 'muted');
  return html`<section class="card" aria-labelledby="elig"><h2 id="elig">Eligibility</h2>
<p>${verdict}${b2bPill(j.notes)}${officePill(j.notes)}</p>
${j.reasons.length > 0 ? html`<ul class="plain">${[...new Set(j.reasons.map(reasonText))].map((t) => html`<li>${t}</li>`)}</ul>${techDetail(j.reasons)}` : ''}
${j.notes.length > 0 ? html`<ul class="plain notes">${j.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}
${j.reasons.length === 0 && j.notes.length === 0 ? html`<p class="muted">Nothing to flag.</p>` : ''}
</section>`;
}

function downloads(j: JobDetail, kind: 'resume' | 'cover', rec: Recommended): Html {
  const files = j.docs.filter((d) => d.kind === kind && d.format !== 'html').sort((a, b) => Number(b.format === rec.format) - Number(a.format === rec.format));
  return html`<div class="downloads">${files.map((d) => {
    const isRec = d.format === rec.format;
    return html`<a class="btn" href="/jobs/${j.jobKey}/files/${d.kind}.${d.format}" download>Download ${FORMAT_NAME[d.format]}<span class="visually-hidden"> of the ${kind === 'resume' ? 'resume' : 'cover letter'}</span>${isRec ? ' (recommended)' : ''}</a>`;
  })}</div>`;
}

function preview(j: JobDetail, kind: 'resume' | 'cover'): Html {
  const h = j.docs.find((d) => d.kind === kind && d.format === 'html');
  if (!h) return html`<p class="muted">No preview for this document.</p>`;
  const src = ['/jobs', j.jobKey, 'files', [h.kind, h.format].join('.')].join('/');
  const name = kind === 'resume' ? 'resume' : 'cover letter';
  // amendment 3: closed everywhere; a lazy frame inside a closed <details> loads when opened, on a phone too
  return html`<details class="preview-box"><summary>Preview the ${name}</summary>
<p class="preview-open"><a href="${src}" target="_blank" rel="noopener">Open full preview ↗<span class="visually-hidden"> of the ${name} (opens in a new tab)</span></a></p>
<iframe class="preview preview-${kind}" sandbox="" src="${src}" title="${KIND_NAME[kind]} preview" loading="lazy" referrerpolicy="no-referrer"></iframe>
</details>`;
}

function citedFacts(c: JobPageData['cited']): Html | '' {
  if (c === undefined || c === null || c.length === 0) return '';
  return html`<details class="cited"><summary>Facts these documents cite (${countText(c.length)})</summary>
<ul class="plain">${c.map((f) => html`<li><code class="fact-id">${f.id}</code> ${f.claim}</li>`)}</ul></details>`;
}

function terms(j: JobDetail, display: (k: string) => string): Html | '' {
  if (j.terms === null) return '';
  const list = (xs: readonly string[], tone: 'good' | 'muted') =>
    xs.length === 0 ? html`<span class="muted">none</span>` : html`${xs.map((t) => html`<span class="term term-${tone}">${display(t)}</span>`)}`;
  return html`<div class="terms">
<div><h3>Covered by your facts</h3><p class="term-list">${list(j.terms.covered, 'good')}</p></div>
<div><h3>Missing</h3><p class="term-list">${list(j.terms.missing, 'muted')}</p><p class="hint">Missing terms are never added to your resume. Only facts from your pack are used.</p></div>
</div>`;
}

function sendCard(d: JobPageData): Html {
  const j = d.job;
  const reason = docsReason(j);
  return html`<section class="card wide" id="apply-kit" aria-labelledby="apply-kit-h"><h2 id="apply-kit-h">Send your application</h2>
${
  reason !== null || j.docs.length === 0
    ? html`<p class="blocked">${reason ?? 'No documents yet.'}</p>`
    : html`<p class="hint">Recommended for ${d.recommended.for}: ${FORMAT_NAME[d.recommended.format]}.</p>
<div class="doc-grid"><div class="doc"><h3>Resume</h3>${downloads(j, 'resume', d.recommended)}</div><div class="doc"><h3>Cover letter</h3>${downloads(j, 'cover', d.recommended)}</div></div>`
}
</section>`;
}

function documents(d: JobPageData): Html | '' {
  const j = d.job;
  const previewable = docsReason(j) === null && j.docs.length > 0;
  const t = terms(j, d.display);
  if (!previewable && t === '') return '';
  return html`<section class="card wide" aria-labelledby="docs"><h2 id="docs">Your documents</h2>
${
  previewable
    ? html`<p class="hint">Every line comes from one of your facts, listed under “Facts these documents cite”.</p>
<div class="doc-grid">
<div class="doc"><h3>Resume</h3>${preview(j, 'resume')}</div>
<div class="doc"><h3>Cover letter</h3>${preview(j, 'cover')}</div>
</div>
${citedFacts(d.cited)}`
    : ''
}
${t}
</section>`;
}

export interface SentData {
  readonly jobKey: string;
  readonly snapshots: readonly Snapshot[];
  /** Per snapshot day: the date of the last download before it whose file differs from the kept copy, if any. */
  readonly changedSince: Readonly<Record<string, string>>;
  /** Applied, ready documents and no snapshot: offer to keep a copy now. */
  readonly canKeep: boolean;
  /** The IST day the job was marked applied, if known. */
  readonly appliedDay: string | null;
  readonly csrf: string;
  readonly istDay: (iso: string) => string;
}

/** The applied snapshots: the exact files the user sent. An htmx status change swaps it out of band. */
export function sentSection(d: SentData, oob = false): Html {
  const shown = d.snapshots.length > 0 || d.canKeep;
  return html`<section id="sent" class="card wide" data-live="A copy of your documents is kept."${oob ? html` hx-swap-oob="true"` : ''} aria-labelledby="sent-h"${shown ? '' : html` hidden`}>
<h2 id="sent-h">Documents you sent</h2>
${
  d.canKeep
    ? html`<p class="hint">You marked this job applied, but no copy of its documents was kept. A copy made now is today's version, which may differ from what you sent.</p>
<form method="post" action="/jobs/${d.jobKey}/keep" hx-post="/jobs/${d.jobKey}/keep" hx-target="#sent" hx-swap="outerHTML" hx-disabled-elt="find button">${csrfField(d.csrf)}<button id="keep-copy" class="btn">Keep a copy of these documents now</button></form>`
    : ''
}
${d.snapshots.map(
  (s) => html`<div class="sent">${
    s.day === d.appliedDay
      ? html`<h3>Applied ${dateText(s.day)}</h3><p class="hint">Kept read-only, exactly as they were that day; later runs never change them.</p>`
      : html`<h3>Copy kept ${dateText(s.day)} (made after you applied${d.appliedDay !== null ? html` on ${dateText(d.appliedDay)}` : ''})</h3><p class="hint">Kept read-only as they were on ${dateText(s.day)}, which may differ from what you sent; later runs never change them.</p>`
  }${
    d.changedSince[s.day] !== undefined
      ? html`<p class="fact-warn">These documents changed after you downloaded them on ${dateText(d.istDay(d.changedSince[s.day] as string))}: the copy kept here is the current version.</p>`
      : ''
  }<ul class="plain sent-files">${s.files.map(
    (f) =>
      html`<li><a href="/jobs/${d.jobKey}/sent/${s.day}/${f.kind}.${f.format}"${f.format === 'html' ? '' : html` download`}>${KIND_NAME[f.kind]} · ${FORMAT_NAME[f.format]}</a>${
        f.format === 'html' ? html` <span class="muted">(preview)</span>` : ''
      }</li>`,
  )}</ul></div>`,
)}
</section>`;
}

/** The status block: the current status, a button per status, and any message. Returned alone to htmx. */
export function statusSection(
  j: Pick<JobDetail, 'jobKey' | 'status' | 'appliedAt' | 'history' | 'company'>,
  o: { csrf: string; istDay: (iso: string) => string; now: string; flash?: string; back?: JobPageData['back'] },
): Html {
  const { csrf, istDay, flash, back } = o;
  const last = j.history.at(-1);
  return html`<section id="status" class="card" data-live="Status set to ${STATUS_LABEL[j.status]}." aria-labelledby="status-h">
<h2 id="status-h">Your status ${statusPill(j.status)}</h2>
${j.appliedAt !== null ? html`<p class="muted">You applied to ${j.company} ${appliedAgo(j.appliedAt, o.now)} (${dateText(istDay(j.appliedAt))}).${j.status === 'applied' && isFollowUpDue(j.appliedAt, null, o.now) ? html` <strong>Follow-up due.</strong>` : ''}</p>` : ''}
<form class="status-form" method="post" action="/jobs/${j.jobKey}/status" hx-post="/jobs/${j.jobKey}/status" hx-target="#status" hx-swap="outerHTML" hx-disabled-elt="#status button">
${csrfField(csrf)}
${back !== undefined ? html`<input type="hidden" name="from" value="${back.from}">${back.next !== undefined ? html`<input type="hidden" name="next" value="${back.next}">` : ''}` : ''}
<div class="btn-row">${STATUSES.map(
    (s: JobStatus) => html`<button id="status-to-${s}" class="btn${s === j.status ? ' btn-current' : ''}" name="to" value="${s}"${s === j.status ? html` aria-pressed="true"` : html` aria-pressed="false"`}>${STATUS_LABEL[s]}</button>`,
  )}</div>
</form>
${flash !== undefined ? html`<p class="flash" role="status">${flash}</p>` : ''}
${last !== undefined ? html`<p class="hint">Last change: ${last.from === null ? '' : html`${STATUS_LABEL[last.from]} → `}${STATUS_LABEL[last.to]} on ${dateText(istDay(last.at))}${last.by === 'migration' ? ' (from your Application Desk)' : ''}</p>` : ''}
</section>`;
}

export function noteSection(j: Pick<JobDetail, 'jobKey' | 'note'>, csrf: string): Html {
  return html`<section class="card" aria-labelledby="note-h"><h2 id="note-h">Your note</h2>
<form method="post" action="/jobs/${j.jobKey}/note" hx-post="/jobs/${j.jobKey}/note" hx-target="#note-saved" hx-swap="innerHTML" hx-disabled-elt="find button">
${csrfField(csrf)}
<label class="visually-hidden" for="note">Note</label>
<textarea id="note" name="note" rows="4" maxlength="4000">${j.note}</textarea>
<div class="btn-row"><button id="note-save" class="btn">Save note</button><span id="note-saved" class="saved" role="status"></span></div>
</form></section>`;
}

function answers(a: JobPageData['answers']): Html {
  return html`<section class="card" aria-labelledby="ans"><h2 id="ans">Screening answers</h2>
${
  a === null
    ? html`<p class="muted">Your pack could not be read, so the answers are not shown.</p>`
    : a.length === 0
      ? html`<p class="muted">No answers in answers.yaml yet.</p>`
      : html`<p class="hint">From your answers.yaml, to copy into the application form; when this job has a cover letter, the short cover note is taken from it. Only the notice period goes into your documents.</p><dl class="answers">${a.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`
}
</section>`;
}

export function jobBody(d: JobPageData): Html {
  const j = d.job;
  return html`${header(j, d.back)}
${duplicates(j, d.preferred)}
<div class="job-grid">
${statusSection(j, { csrf: d.csrf, istDay: d.istDay, now: d.now, ...(d.flash !== undefined ? { flash: d.flash } : {}), ...(d.back !== undefined ? { back: d.back } : {}) })}
${sendCard(d)}
${answers(d.answers)}
${whyMatched(j, d.display)}
${eligibility(j)}
${documents(d)}
${sentSection(d.sent)}
${noteSection(j, d.csrf)}
<section class="card wide" aria-labelledby="jd"><h2 id="jd">The job description</h2>
<details><summary>Show the full text</summary><div class="jd">${j.jdText}</div></details></section>
</div>`;
}
