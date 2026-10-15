import { countText, periodText } from '../format.js';
import { html, type Html } from '../html.js';
import { csrfField, meta, pill, type Tone } from './common.js';

export interface FactRow {
  readonly id: string;
  /** False when the id itself holds a forbidden term: it is hidden and has no buttons. */
  readonly idShown: boolean;
  readonly claim: string;
  readonly kind: string;
  readonly employer: string;
  readonly period: string;
  /** The effective status (the pack's, or the user's override). */
  readonly status: string;
  /** The status in facts.yaml, when an override replaces it. */
  readonly packStatus: string | null;
}

const STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  verified: { label: 'Verified', tone: 'good' },
  'user-stated': { label: 'Stated by you', tone: 'good' },
  'derived-unverified': { label: 'Not verified', tone: 'warn' },
  'user-cannot-confirm': { label: 'You cannot confirm', tone: 'muted' },
  rejected: { label: 'Rejected', tone: 'critical' },
};
const statusPill = (s: string): Html => {
  const v = STATUS[s];
  return v === undefined ? pill(s, 'neutral') : pill(v.label, v.tone);
};
export const factStatusLabel = (s: string): string => STATUS[s]?.label ?? s;

const used = (s: string): boolean => s === 'verified' || s === 'user-stated';

export function factRow(f: FactRow, csrf: string, flash?: string): Html {
  const unverified = f.status === 'derived-unverified';
  const id = encodeURIComponent(f.id);
  const action = (verb: 'verify' | 'reject', label: string, primary: boolean, danger = false) =>
    html`<form method="post" action="/facts/${id}/${verb}" hx-post="/facts/${id}/${verb}" hx-target="closest li" hx-swap="outerHTML" hx-disabled-elt="find button">${csrfField(csrf)}<button id="fact-${f.id}-${verb}" class="btn${primary ? ' btn-primary' : ''}${danger ? ' btn-danger' : ''}">${label}</button></form>`;
  return html`<li class="fact${unverified ? ' fact-unverified' : ''}${used(f.status) ? '' : ' fact-unused'}" id="fact-${f.idShown ? f.id : ''}" data-live="Saved: ${factStatusLabel(f.status)}.">
<p class="fact-claim">${f.claim}</p>
<p class="fact-sub">${meta([f.kind, f.employer, html`<span class="num">${periodText(f.period)}</span>`, html`<code class="fact-id">${f.idShown ? f.id : '[hidden]'}</code>`])}</p>
<p class="fact-state">${statusPill(f.status)}${f.packStatus !== null ? html` <span class="muted">your change (facts.yaml says ${factStatusLabel(f.packStatus)})</span>` : ''}</p>
${unverified ? html`<p class="fact-warn">Not used in documents until you verify it.</p>` : ''}
${!used(f.status) && !unverified ? html`<p class="hint">Not used in documents.</p>` : ''}
${
  f.idShown
    ? html`<div class="btn-row">${f.status !== 'verified' ? action('verify', 'Verify', unverified) : ''}${f.status !== 'rejected' ? action('reject', 'Reject', false, true) : ''}</div>`
    : html`<p class="fact-warn">This fact's id contains a forbidden term; rename it in facts.yaml to change its status here.</p>`
}
${flash !== undefined ? html`<p class="flash" role="status">${flash}</p>` : ''}
</li>`;
}

export interface FactsPageData {
  readonly facts: readonly FactRow[];
  readonly csrf: string;
  readonly packError: string | null;
}

export function factsBody(d: FactsPageData): Html {
  const waiting = d.facts.filter((f) => f.status === 'derived-unverified');
  const pending = waiting.length;
  const ordered = [...waiting, ...d.facts.filter((f) => f.status !== 'derived-unverified')];
  return html`<div class="page-head">
<h1>Your facts</h1>
<p class="lede">Every claim your documents can make comes from one of these. Only verified facts and facts you stated go into a resume or cover letter.${
    pending > 0 ? html` <strong><span class="num">${countText(pending)}</span> waiting for you to verify.</strong>` : ''
  }</p>
<p class="note">Verify and Reject change only the fact's status here (your facts.yaml is never edited). The next run makes the affected documents again.</p>
</div>
${
  d.packError !== null
    ? html`<p class="blocked">Your pack could not be read: ${d.packError}</p>`
    : html`<ol class="facts" aria-label="Facts">${ordered.map((f) => factRow(f, d.csrf))}</ol>`
}`;
}
