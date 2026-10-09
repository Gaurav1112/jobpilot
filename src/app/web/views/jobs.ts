import type { Band, HistoryEntry, JobStatus, JobView } from '../../store/app-store.js';
import { dateText, scoreText } from '../format.js';
import { html, type Html } from '../html.js';
import { BAND_LABEL, bandPill, compCell, docsPill, remotePill, STATUS_LABEL, STATUSES, statusPill } from './common.js';

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
}

export interface JobsPageData {
  readonly jobs: readonly ListedJob[];
  readonly filter: JobsFilterView;
  /** True when no band filter was given (rejected and below-floor jobs are hidden). */
  readonly defaultBands: boolean;
  readonly hiddenCount: number;
  readonly istDay: (iso: string) => string;
}

const ALL_BANDS: readonly Band[] = ['disclosed', 'undisclosed', 'review', 'below-floor', 'rejected'];

const check = (name: string, value: string, label: string, on: boolean): Html =>
  html`<label class="chip"><input type="checkbox" name="${name}" value="${value}"${on ? html` checked` : ''}><span>${label}</span></label>`;

function filterForm(f: JobsFilterView, defaultBands: boolean): Html {
  const bandsOn = defaultBands ? (['disclosed', 'undisclosed', 'review'] as Band[]) : f.band;
  return html`<form class="filters" method="get" action="/" role="search" aria-label="Filter jobs">
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
    j.alsoListedOn.length > 0 ? html`<span class="sep" aria-hidden="true">·</span><span class="muted">also listed on ${j.alsoListedOn.join(', ')}</span>` : ''
  }</p>
<p class="job-pills">${remotePill(j.remote)}${docsPill(j.docsState)}</p>
${historyLine(j, istDay)}
</div>
<div class="job-status">${statusPill(j.status)}</div>
</li>`;
}

export function jobsBody(d: JobsPageData): Html {
  const newCount = d.jobs.filter((j) => j.isNew).length;
  return html`<div class="page-head">
<h1>Jobs</h1>
<p class="lede"><span class="num">${d.jobs.length}</span> job${d.jobs.length === 1 ? '' : 's'} shown${
    newCount > 0 ? html`, <span class="num">${newCount}</span> new since your last visit` : ''
  }. Best pay first, then fit.${
    d.defaultBands && d.hiddenCount > 0
      ? html` <span class="muted"><span class="num">${d.hiddenCount}</span> not-eligible or below-floor job${d.hiddenCount === 1 ? ' is' : 's are'} hidden; tick their bands to see them.</span>`
      : ''
  }</p>
</div>
${filterForm(d.filter, d.defaultBands)}
${
  d.jobs.length === 0
    ? html`<p class="empty">No jobs match these filters.</p>`
    : html`<ol class="jobs" aria-label="Jobs">${d.jobs.map((j) => row(j, d.istDay))}</ol>`
}`;
}
