import type { Band, DocsState, JobStatus, JobView } from '../../store/app-store.js';
import { JOB_STATUSES } from '../../store/schema.js';
import { compText } from '../format.js';
import { remoteText } from '../copy.js';
import { Html, html } from '../html.js';
import { CSRF_FIELD } from '../security.js';
import { NOTE_B2B, NOTE_OFFICE_PREFIX } from '../../agents/eligibility.js';

/** Copy and pills shared by every page. Words are the user's: "documents you can send", never "artifacts". */

export type { Tone } from '../copy.js';
import type { Tone } from '../copy.js';

export const pill = (text: string, tone: Tone, title?: string): Html => html`<span class="pill pill-${tone}"${title !== undefined ? html` title="${title}"` : ''}>${text}</span>`;

export const STATUS_LABEL: Readonly<Record<JobStatus, string>> = {
  new: 'Not started',
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
  ready: 'Documents ready', blocked: 'Documents blocked', missing: 'Documents missing', 'below-floor': 'No documents', none: 'No documents yet', stale: 'Documents out of date',
};
const DOCS_TONE: Readonly<Record<DocsState, Tone>> = { ready: 'good', blocked: 'critical', missing: 'warn', 'below-floor': 'muted', none: 'muted', stale: 'warn' };
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

/** Freelance spec D2: the verdict note for a full-time B2B contractor role, as a badge; an empty string when the job has none. */
export const b2bPill = (notes: readonly string[]): Html | '' =>
  notes.includes(NOTE_B2B) ? pill(NOTE_B2B, 'accent') : '';

/** The verdict note for an onsite or hybrid role in one of the pack's office cities, as a badge; an empty string when the job has none. */
export const officePill = (notes: readonly string[]): Html | '' => {
  const note = notes.find((n) => n.startsWith(NOTE_OFFICE_PREFIX));
  return note === undefined ? '' : pill(note, 'accent');
};

/** Parts joined by a middle dot; empty parts are dropped, so a separator never dangles ("GitLab · · via …", A6). */
export function meta(parts: readonly (Html | string | null | undefined | false)[]): Html {
  const kept = parts.filter((p): p is Html | string => (typeof p === 'string' ? p.trim() !== '' : p instanceof Html && p.value.trim() !== ''));
  return html`${kept.map((p, i) => html`${i > 0 ? html`<span class="sep" aria-hidden="true">·</span>` : ''}${typeof p === 'string' ? html`<span>${p}</span>` : p}`)}`;
}

/** The raw codes behind a verdict, for whoever wants them: closed by default, never the first thing read. */
export const techDetail = (codes: readonly string[]): Html | '' =>
  codes.length === 0 ? '' : html`<details class="tech"><summary>Technical detail</summary><ul class="plain">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ul></details>`;
