import type { RunSummary } from '../../store/app-store.js';
import { html, type Html } from '../html.js';
import { pill } from './common.js';

export type ChainStatus = { readonly ok: true; readonly events: number } | { readonly ok: false; readonly reason: string };

export interface RunsPageData {
  readonly runs: readonly RunSummary[];
  readonly chain: ChainStatus;
  readonly istTime: (iso: string) => string;
}

const COLUMNS: readonly (readonly [key: string, label: string])[] = [
  ['done', 'Done'],
  ['replayed', 'Replayed'],
  ['failed', 'Failed'],
  ['gone', 'Gone'],
  ['skipped', 'Skipped'],
  ['quarantined', 'Quarantined'],
  ['inputRejected', 'Input rejected'],
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '?');

const PROBLEM_LABEL: Readonly<Record<string, string>> = {
  failed: 'Failed', gone: 'Gone from the source', input_rejected: 'Input rejected', quarantined: 'Quarantined', skipped: 'Skipped',
};

function counts(c: unknown): Html {
  const by = isObj(c) && isObj(c['byAgent']) ? c['byAgent'] : {};
  const agents = Object.keys(by).sort();
  if (agents.length === 0) return html`<p class="muted">No steps recorded.</p>`;
  const totals = isObj(c) && isObj(c['totals']) ? c['totals'] : {};
  return html`<div class="table-wrap"><table class="counts">
<thead><tr><th scope="col">Agent</th>${COLUMNS.map(([, l]) => html`<th scope="col" class="num">${l}</th>`)}</tr></thead>
<tbody>${agents.map((a) => {
    const r = isObj(by[a]) ? (by[a] as Record<string, unknown>) : {};
    return html`<tr><th scope="row"><code>${a}</code></th>${COLUMNS.map(([k]) => {
      const v = n(r[k]);
      const bad = v > 0 && (k === 'failed' || k === 'quarantined');
      return html`<td class="num${v === 0 ? ' zero' : ''}${bad ? ' bad' : ''}">${v}</td>`;
    })}</tr>`;
  })}</tbody>
<tfoot><tr><th scope="row">Total</th>${COLUMNS.map(([k]) => html`<td class="num">${n(totals[k])}</td>`)}</tr></tfoot>
</table></div>`;
}

function problems(ps: readonly unknown[] | undefined): Html {
  const list = (ps ?? []).filter(isObj);
  if (list.length === 0) return html`<p class="good-text">No problems.</p>`;
  return html`<h3>Problems <span class="num">(${list.length})</span></h3><ul class="problems">${list.map(
    (p) =>
      html`<li><span class="problem-kind">${PROBLEM_LABEL[s(p['kind'])] ?? s(p['kind'])}</span> <code>${s(p['agent'])}</code> <span class="problem-item">${s(p['item'])}</span><span class="problem-reason">${s(p['reason'])}</span></li>`,
  )}</ul>`;
}

function run(r: RunSummary, istTime: (iso: string) => string): Html {
  const probs = r.problems ?? [];
  const warns = r.warnings ?? [];
  return html`<section class="card wide run" aria-labelledby="run-${r.runId}">
<h2 id="run-${r.runId}"><code>${r.runId}</code> ${probs.length > 0 ? pill(String(probs.length) + (probs.length === 1 ? ' problem' : ' problems'), 'critical') : pill('Clean', 'good')}</h2>
<p class="run-meta"><span>${istTime(r.at)}</span><span class="sep" aria-hidden="true">·</span><span>pack <code title="${r.packHash}">${r.packHash.slice(0, 12)}</code></span><span class="sep" aria-hidden="true">·</span><span>policy <code title="${r.policyHash}">${r.policyHash.slice(0, 12)}</code></span></p>
${counts(r.counts)}
${problems(probs)}
${warns.length > 0 ? html`<h3>Warnings</h3><ul class="plain warnings">${warns.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
</section>`;
}

export function runsBody(d: RunsPageData): Html {
  return html`<div class="page-head">
<h1>Runs</h1>
<p class="lede">The last ${d.runs.length === 14 ? '14' : String(d.runs.length)} run${d.runs.length === 1 ? '' : 's'}, newest first.</p>
<p class="${d.chain.ok ? 'chain chain-ok' : 'chain chain-bad'}" role="status">${
    d.chain.ok ? html`Audit log intact: <span class="num">${d.chain.events}</span> events, every one chained to the last.` : html`Audit log broken: ${d.chain.reason}`
  }</p>
</div>
${d.runs.length === 0 ? html`<p class="empty">No runs yet. Run "jobpilot run" to fetch today's jobs.</p>` : d.runs.map((r) => run(r, d.istTime))}`;
}

