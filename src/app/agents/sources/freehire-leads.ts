import { defineAgent, type Agent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { DiscoveryRequest, knownAts, RawPosting } from '../../types.js';

/**
 * `src-freehire-leads` (sources expansion, Task 9): the postings the weekly freehire discovery stored as leads (a posting
 * on a platform jobpilot cannot read), turned into raw postings for the daily REVIEW band. It fetches nothing: the app
 * layer reads the leads from the store (SELECT only) and injects them, so the agent holds no store and no capability.
 *
 * - One RawPosting per lead, `source: 'freehire'`, `sourceId` the lead key (`<freehire source>:<external id>`, the
 *   discovery's identity for it), `slug: 'leads'`; `raw` keeps the url (already stripped of tracking by the discovery),
 *   title, company, location, date and the freehire source it came through (`via`). A lead without a company is
 *   `Unknown company`.
 * - Only the seed `{ats: 'freehire', slug: 'leads'}` is answered; every other request gets an empty list.
 * - Sorted by lead key. Over LEADS_MAX_PER_DAY the first 200 by lead key are read and the rest is a named skip note
 *   (`freehire-leads: N more leads not read today (cap 200)`), never a silent truncation.
 * - Eligibility caps every `ats: 'freehire'` posting at `review` (agents/eligibility.ts), so a lead is never `eligible`.
 */
export const LEADS_MAX_PER_DAY = 200;

/** A stored lead as this agent reads it (the app layer's `FreehireLead` satisfies it; agent code imports no store). */
export interface StoredLead {
  readonly leadKey: string;
  readonly source: string;
  readonly url: string;
  readonly title: string;
  readonly company: string | null;
  readonly location: string | null;
  readonly postedAt: string | null;
}

export const srcFreehireLeadsContract = defineContract({
  id: 'src-freehire-leads',
  version: '1.0.0',
  description: 'Turns the stored freehire leads into raw postings for the review band, fetching nothing',
  skills: ['job-sourcing'],
  team: 'sourcing-freehire',
  kind: 'deterministic',
  consumes: DiscoveryRequest,
  produces: RawPosting,
  requires: [knownAts],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The leads are injected by the app layer (the agent reads no store). */
export function makeSrcFreehireLeads(leads: readonly StoredLead[]): Agent<DiscoveryRequest, RawPosting> {
  const sorted = [...leads].sort((a, b) => cmp(a.leadKey, b.leadKey));
  return defineAgent(srcFreehireLeadsContract, async (req, ctx) => {
    if (req.ats !== 'freehire' || req.slug !== 'leads') return [];
    const read = sorted.slice(0, LEADS_MAX_PER_DAY);
    if (sorted.length > read.length) ctx.skipped([`freehire-leads: ${sorted.length - read.length} more leads not read today (cap ${LEADS_MAX_PER_DAY})`]);
    return read.map((lead) => ({
      source: 'freehire',
      sourceId: lead.leadKey,
      company: lead.company ?? 'Unknown company',
      slug: 'leads',
      raw: { url: lead.url, title: lead.title, company: lead.company, location: lead.location, postedAt: lead.postedAt, via: lead.source },
    }));
  });
}
