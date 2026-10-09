import type { Band, DocsState, JobStatus, JobView } from '../../store/app-store.js';
import { JOB_STATUSES } from '../../store/schema.js';
import { compText } from '../format.js';
import { remoteText } from '../copy.js';
import { html, type Html } from '../html.js';
import { CSRF_FIELD } from '../security.js';

/** Copy and pills shared by every page. Words are the user's: "documents you can send", never "artifacts". */

export type { Tone } from '../copy.js';
import type { Tone } from '../copy.js';

export const pill = (text: string, tone: Tone, title?: string): Html => html`<span class="pill pill-${tone}"${title !== undefined ? html` title="${title}"` : ''}>${text}</span>`;

export const STATUS_LABEL: Readonly<Record<JobStatus, string>> = {
  new: 'New',
  approved: 'Shortlisted',
  applied: 'Applied',
  interview: 'Interviewing',
  offer: 'Offer',
  rejected: 'Not selected',
  skipped: 'Not for me',
};
const STATUS_TONE: Readonly<Record<JobStatus, Tone>> = {
  new: 'neutral', approved: 'accent', applied: 'good', interview: 'good', offer: 'good', rejected: 'critical', skipped: 'muted',
};
export const STATUSES: readonly JobStatus[] = JOB_STATUSES;
export const statusPill = (s: JobStatus): Html => pill(STATUS_LABEL[s], STATUS_TONE[s]);

export const BAND_LABEL: Readonly<Record<Band, string>> = {
  disclosed: 'Pay at or above your floor',
  undisclosed: 'Pay not disclosed',
  review: 'Needs a look',
  'below-floor': 'Below your floor',
  rejected: 'Not eligible',
};
const BAND_SHORT: Readonly<Record<Band, string>> = {
  disclosed: 'Pay ≥ floor', undisclosed: 'Pay unknown', review: 'Needs a look', 'below-floor': 'Below floor', rejected: 'Not eligible',
};
const BAND_TONE: Readonly<Record<Band, Tone>> = { disclosed: 'good', undisclosed: 'neutral', review: 'warn', 'below-floor': 'muted', rejected: 'critical' };
export const bandPill = (b: Band): Html => pill(BAND_SHORT[b], BAND_TONE[b], BAND_LABEL[b]);

const DOCS_LABEL: Readonly<Record<DocsState, string>> = {
  ready: 'Documents ready', blocked: 'Documents blocked', missing: 'Documents missing', 'below-floor': 'No documents', none: 'No documents yet',
};
const DOCS_TONE: Readonly<Record<DocsState, Tone>> = { ready: 'good', blocked: 'critical', missing: 'warn', 'below-floor': 'muted', none: 'muted' };
export const docsPill = (d: DocsState): Html => pill(DOCS_LABEL[d], DOCS_TONE[d]);

/** "Remote · India", "Hybrid", "Remote unclear", from the posting's structured field and countries. */
export function remotePill(remote: JobView['remote']): Html {
  const r = remoteText(remote);
  return pill(r.label, r.tone, r.title);
}

export function compCell(j: Pick<JobView, 'comp' | 'compMinInr' | 'compMaxInr'>): Html {
  const c = compText(j.comp, j.compMinInr, j.compMaxInr);
  return html`<span class="comp-main num">${c.main}</span>${c.inr !== null ? html`<span class="comp-inr num">${c.inr}</span>` : ''}${
    c.caveat !== null ? html`<span class="comp-caveat">${c.caveat}</span>` : ''
  }`;
}

export const csrfField = (token: string): Html => html`<input type="hidden" name="${CSRF_FIELD}" value="${token}">`;

