/**
 * The networks catalogue (freelance-boost, research C3 and B2, 2026-10-14): the vetted talent networks worth one
 * application, with what the research verified about each (India eligibility, typical rates and hours, where to
 * apply) and the recommended application order. Engine data, never personal: the user's own network files
 * (`pack/networks/<id>.yaml`, screening stages for the application packs) are joined to it by `id`, and the user's
 * status lives in the `network_status` table.
 *
 * Order (research C3, value x acceptance odds from India x fit with at most 20 h/week): micro1, Mercor, Alignerr first
 * (hourly AI-evaluation work, 10-20 h/week, apply in a day), then Arc, Braintrust, Toptal, Proxify; the rest after,
 * and a network that does not take people in India last, marked so.
 *
 * Every figure is the research's, dated 2026-10-14; "not stated" is written where the research found nothing. Links
 * were checked once on 2026-10-15 with the honest user agent; Toptal and Proxify refuse automated requests (403), so
 * their links are the networks' own public pages, unverified by a machine.
 */

export type IndiaEligibility = 'open' | 'not-open' | 'unverified';

export interface CatalogueNetwork {
  readonly id: string;
  readonly name: string;
  /** Where to apply (the network's own page; opened in the user's browser, never fetched by a run). */
  readonly applyUrl: string;
  readonly india: IndiaEligibility;
  /** Why, in one line, with the research's source. */
  readonly indiaNote: string;
  readonly rates: string;
  readonly hours: string;
  /** How the application works, one line. */
  readonly process: string;
  /** 1 = apply first; null = after the ordered ones (or not at all, for a network not open to India). */
  readonly order: number | null;
}

export const NETWORKS_CHECKED = '2026-10-14';

export const NETWORK_CATALOGUE: readonly CatalogueNetwork[] = [
  {
    id: 'micro1', name: 'micro1', applyUrl: 'https://www.micro1.ai/experts/opportunities', india: 'open',
    indiaNote: 'Hires from anywhere outside its published excluded-country list; listings are posted for India (Himalayas, 2026-10-14)',
    rates: '$50–100/h for software engineering', hours: '15–20 h/week typical', process: 'One application with an AI interview (Zara)', order: 1,
  },
  {
    id: 'mercor', name: 'Mercor', applyUrl: 'https://work.mercor.com/', india: 'open',
    indiaNote: 'India variants of its listings are posted (work.mercor.com and Himalayas, 2026-10-14)',
    rates: 'up to $50–150/h', hours: 'varies by project', process: 'One application, then per-listing matches', order: 2,
  },
  {
    id: 'alignerr', name: 'Alignerr', applyUrl: 'https://www.alignerr.com/', india: 'open',
    indiaNote: 'India is listed among its 14 countries (aigigjobs.com, annotation.academy)',
    rates: '$60–120/h for professional software tracks (India may be scaled)', hours: 'not stated', process: 'One application per country listing', order: 3,
  },
  {
    id: 'arc', name: 'Arc', applyUrl: 'https://arc.dev/', india: 'open',
    indiaNote: 'Global network, 190+ countries', rates: 'stated on each gig', hours: 'part-time freelance filter', process: 'Application, then gig matches and job alert emails', order: 4,
  },
  {
    id: 'braintrust', name: 'Braintrust', applyUrl: 'https://www.usebraintrust.com/', india: 'open',
    indiaNote: 'Open to India', rates: 'stated on most jobs', hours: 'often stated', process: 'Application; saved searches can email new matches. Watch for fake-client scams', order: 5,
  },
  {
    id: 'toptal', name: 'Toptal', applyUrl: 'https://www.toptal.com/talent/apply', india: 'open',
    indiaNote: 'Open to India', rates: '$60–100+/h', hours: 'part-time engagements exist', process: 'Multi-stage vetting', order: 6,
  },
  {
    id: 'proxify', name: 'Proxify', applyUrl: 'https://proxify.io/', india: 'open',
    indiaNote: 'Pays via Deel; Indian members exist (knowledge.proxify.io)', rates: 'monthly or hourly', hours: 'part-time about 20 h/week exists; clients mostly in the EU (good IST overlap)', process: 'Application (about 1% accepted)', order: 7,
  },
  {
    id: 'a-team', name: 'A.Team', applyUrl: 'https://a.team/', india: 'unverified',
    indiaNote: 'Global builder network; India not confirmed by the research', rates: 'set per mission', hours: 'part-time missions common', process: 'Builder application', order: 8,
  },
  {
    id: 'turing', name: 'Turing', applyUrl: 'https://www.turing.com/jobs', india: 'open',
    indiaNote: 'Its largest pool is in India', rates: 'hourly', hours: 'often 40 h/week: take only matches at 20 h or less', process: 'Application, then matches by email', order: 9,
  },
  {
    id: 'contra', name: 'Contra', applyUrl: 'https://contra.com/', india: 'open',
    indiaNote: 'Open to India', rates: 'budgets stated', hours: 'not stated', process: 'Profile and opportunities feed (Replit bounties moved here)', order: 10,
  },
  {
    id: 'flexiple', name: 'Flexiple', applyUrl: 'https://flexiple.com/', india: 'open',
    indiaNote: 'India-first network', rates: 'hourly or monthly', hours: 'not stated', process: 'Application', order: 11,
  },
  {
    id: 'gunio', name: 'Gun.io', applyUrl: 'https://gun.io/', india: 'unverified',
    indiaNote: 'Officially global; reports say US and EU are favoured (remoty.work)', rates: '$100–200/h', hours: 'not stated', process: 'Application', order: 12,
  },
  {
    id: 'lemon', name: 'Lemon.io', applyUrl: 'https://lemon.io/for-developers/', india: 'not-open',
    indiaNote: 'Does not accept developers in India: in Asia only the Philippines and Indonesia, per its own posts (nodesk.co, lemon.io/llm-info, read 2026-10-14)',
    rates: 'not stated', hours: 'not stated', process: 'Do not apply from India', order: null,
  },
];

export const catalogueEntry = (id: string): CatalogueNetwork | undefined => NETWORK_CATALOGUE.find((n) => n.id === id);

/**
 * The networks in the recommended order: the ordered catalogue entries by `order`, then the user's own network files
 * that the catalogue does not know (by name, then id), then the catalogue entries without an order (not open to
 * India) last.
 */
export function orderedNetworkIds(packIds: readonly { id: string; name: string }[]): string[] {
  const known = new Set(NETWORK_CATALOGUE.map((n) => n.id));
  const ordered = NETWORK_CATALOGUE.filter((n) => n.order !== null).sort((a, b) => (a.order as number) - (b.order as number)).map((n) => n.id);
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const own = packIds.filter((n) => !known.has(n.id)).sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id)).map((n) => n.id);
  const last = NETWORK_CATALOGUE.filter((n) => n.order === null).map((n) => n.id);
  return [...ordered, ...own, ...last];
}
