import type { Band, HistoryEntry, JobStatus, JobView } from '../../store/app-store.js';
import { dateText, scoreText } from '../format.js';
import { html, type Html } from '../html.js';
import { reasonText, sourceName } from '../copy.js';
import { b2bPill, officePill, BAND_LABEL, bandPill, compCell, docsPill, remotePill, STATUS_LABEL, STATUSES, statusPill } from './common.js';

export interface ListedJob extends JobView {
  /** First seen after the user's previous visit. */
  readonly isNew: boolean;
  readonly history: readonly HistoryEntry[];
}

export interface JobsFilterView {
  readonly status: readonly JobStatus[];
  readonly band: readonly Band[];
  readonly min: number | undefined;
  readonly q: string;
  /** One registry company's jobs only (the Companies tab's links): its key and its shown name. */
  readonly company?: { readonly key: string; readonly name: string };
}

export interface JobsPageData {
  readonly jobs: readonly ListedJob[];
  readonly filter: JobsFilterView;
  /** True when no band filter was given (rejected and below-floor jobs are hidden). */
  readonly defaultBands: boolean;
  /** True when no status filter was given (Not for me and Not selected are hidden). */
  readonly defaultStatuses: boolean;
  readonly hiddenCount: number;
  /** Listed rows that are To decide (U9). */
  readonly toDecide: number;
  /** New since the last visit, across all pages. */
  readonly newCount: number;
  readonly istDay: (iso: string) => string;
  /** Pagination: this page (1-based), the page count, the total shown across pages, and the href of a page. */
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly pageHref: (page: number) => string;
}

const ALL_BANDS: readonly Band[] = ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'];

const check = (name: string, value: string, label: string, on: boolean): Html =>
  html`<label class="chip"><input type="checkbox" name="${name}" value="${value}"${on ? html` checked` : ''}><span>${label}</span></label>`;

function filterForm(f: JobsFilterView, defaultBands: boolean): Html {
  const bandsOn = defaultBands ? (['disclosed', 'undisclosed', 'review'] as Band[]) : f.band;
  const company = f.company;
  return html`<form class="filters" method="get" action="/" role="search" aria-label="Filter jobs">
${company !== undefined ? html`<input type="hidden" name="companyKey" value="${company.key}"><p class="filter-company">Jobs at <strong>${company.name}</strong> only <a href="/">Show every company</a></p>` : ''}
<div class="filter-row">
<label class="field grow"><span>Search</span><input type="search" name="q" value="${f.q}" placeholder="Company or title" maxlength="100"></label>
<label class="field narrow"><span>Min score</span><input type="number" name="min" value="${f.min ?? ''}" min="0" max="200" step="1" inputmode="numeric"></label>
<div class="filter-actions"><button class="btn btn-primary">Apply</button><a class="btn" href="/">Reset</a></div>
</div>
<fieldset><legend>Pay band</legend>${ALL_BANDS.map((b) => check('band', b, BAND_LABEL[b], bandsOn.includes(b)))}</fieldset>
<fieldset><legend>Status</legend>${STATUSES.map((s) => check('status', s, STATUS_LABEL[s], f.status.includes(s)))}</fieldset>
</form>`;
}

function historyLine(j: ListedJob, istDay: (iso: string) => string): Html | '' {
  const imported = j.history.filter((h) => h.by === 'migration');
  if (imported.length === 0) return '';
  return html`<p class="job-history">From your Application Desk: ${imported.map(
    (h, i) => html`${i > 0 ? ', ' : ''}${STATUS_LABEL[h.to]} on ${dateText(istDay(h.at))}`,
  )}${j.history.length > imported.length ? html` · ${j.history.length - imported.length} change${j.history.length - imported.length === 1 ? '' : 's'} since` : ''}</p>`;
}

function row(j: ListedJob, istDay: (iso: string) => string): Html {
  return html`<li class="job" data-job="${j.jobKey}">
<div class="job-comp">${compCell(j)}<span class="job-band">${bandPill(j.band)}</span></div>
<div class="job-score num" title="Fit score">${j.score === null ? '–' : scoreText(j.score)}</div>
<div class="job-main">
<h2 class="job-title"><a href="/jobs/${j.jobKey}">${j.title}</a>${j.isNew ? html` <span class="new">New since your last visit</span>` : ''}</h2>
<p class="job-sub"><span class="job-company">${j.company}</span><span class="sep" aria-hidden="true">·</span><span>${j.location}</span>${
    j.alsoListedOn.length > 0 ? html`<span class="sep" aria-hidden="true">·</span><span class="muted">also listed on ${j.alsoListedOn.map(sourceName).join(', ')}</span>` : ''
  }</p>
<p class="job-pills">${remotePill(j.remote)}${b2bPill(j.notes)}${officePill(j.notes)}${docsPill(j.docsState)}</p>
${j.band === 'rejected' && j.reasons.length > 0 ? html`<p class="job-reasons">Not eligible: ${j.reasons.map((r, i) => html`${i > 0 ? '; ' : ''}${reasonText(r)} <code>${r}</code>`)}</p>` : ''}
${historyLine(j, istDay)}
</div>
<div class="job-status">${statusPill(j.status)}</div>
</li>`;
}

function pager(d: JobsPageData): Html | '' {
  if (d.pages <= 1) return '';
  return html`<nav class="pager" aria-label="Pages">${
    d.page > 1 ? html`<a class="btn" href="${d.pageHref(d.page - 1)}" rel="prev">Previous</a>` : html`<span class="btn btn-disabled" aria-disabled="true">Previous</span>`
  }<span class="num">Page ${d.page} of ${d.pages}</span>${
    d.page < d.pages ? html`<a class="btn" href="${d.pageHref(d.page + 1)}" rel="next">Next</a>` : html`<span class="btn btn-disabled" aria-disabled="true">Next</span>`
  }</nav>`;
}

export function jobsBody(d: JobsPageData): Html {
  const newCount = d.newCount;
  return html`<div class="page-head">
<h1>Jobs</h1>
<p class="lede"><span class="num">${d.total}</span> job${d.total === 1 ? '' : 's'} · <span class="num">${d.toDecide}</span> to decide${
    newCount > 0 ? html`, <span class="num">${newCount}</span> new since your last visit` : ''
  } · sorted by best fit, then pay.${
    d.defaultBands && d.hiddenCount > 0
      ? html` <span class="muted"><span class="num">${d.hiddenCount}</span> not-eligible or below-floor job${d.hiddenCount === 1 ? ' is' : 's are'} hidden; tick their bands to see them.</span>`
      : ''
  }${d.defaultStatuses ? html` <span class="muted">Not for me and Not selected are hidden: <a href="/?status=skipped&amp;status=rejected">show them</a>.</span>` : ''}</p>
</div>
${filterForm(d.filter, d.defaultBands)}
${
  d.jobs.length === 0
    ? html`<p class="empty">No jobs match these filters.</p>`
    : html`<ol class="jobs" aria-label="Jobs">${d.jobs.map((j) => row(j, d.istDay))}</ol>${pager(d)}`
}`;
}
