import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decideGig } from '../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../src/app/freelance/gig-normalizer.js';
import { riskFlags } from '../../src/app/freelance/gig-risk.js';
import { gigScorer } from '../../src/app/freelance/gig-scorer.js';
import { gigKey } from '../../src/app/freelance/keys.js';
import { rateOf } from '../../src/app/freelance/rate.js';
import { makeSrcHimalayasGigs, srcHimalayasGigsContract } from '../../src/app/freelance/sources/himalayas-gigs.js';
import type { Gig, RawGig, ScoredGig } from '../../src/app/freelance/types.js';
import { planGigDocs } from '../../src/app/freelance/writing/proposal-planner.js';
import { offlineProviders } from '../../src/app/offline.js';
import { loadPack } from '../../src/app/pack/load.js';
import type { Posting } from '../../src/app/types.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';

/**
 * The generator of `evals/datasets/gig-cover-grounding.jsonl` (freelance-v2). Regenerate with
 * `node --import tsx tests/support/gig-cover-eval.ts`; tests/app/freelance/gig-cover.test.ts checks the committed file
 * equals what this gives. Fictional only (the repo is public):
 *
 * - Himalayas: the scrubbed recordings (`tests/fixtures/freelance/himalayas`, fictional "Example Co N" companies) through
 *   the real source, normalizer, rate, eligibility, risk and scorer chain, each description replaced by fictional text
 *   (`FICTIONAL`), so no third-party posting text is kept;
 * - boards: fictional daily contract postings;
 * - edge cases edited from one boards case.
 *
 * Each case's `expected` is `{pass: true, cover}`: every plan must pass the gate, and `cover` records whether a letter is
 * planned (the edge cases fix it by construction).
 */

const ROOT = join(import.meta.dirname, '../..');
const NOW = '2026-10-14T15:00:00Z';

/** Fictional descriptions, one per recording in turn: stack terms the fixture lexicon knows, nothing from a real posting. */
export const FICTIONAL: readonly string[] = [
  'Example Co is hiring a contractor for this role. You will build backend services and APIs in Java and Go, run them on AWS, and work with Kafka and PostgreSQL. We need someone who can own production services.',
  'This is a contract engagement with a fictional team. We need help building LLM agents and RAG pipelines in Python and TypeScript, exposed as APIs, with tests and clear documentation.',
  'A fictional product team needs a contractor to design distributed systems, improve microservices on Kubernetes, and help with observability and on-call.',
  'We are looking for a contract engineer to maintain a payments platform: event-driven services, PostgreSQL, Redis and AWS. Remote work across time zones is fine.',
];

export interface CoverEvalCase {
  readonly id: string;
  readonly input: ScoredGig;
  readonly expected: { readonly pass: true; readonly cover: boolean };
}

/** Every case of the dataset, in file order. */
export async function gigCoverEvalCases(): Promise<CoverEvalCase[]> {
  const { pack: full } = loadPack(join(ROOT, 'tests/fixtures/pack'));
  const { contact: _c, answers: _a, ...pub } = full;
  const unfloored = { ...pub, freelance: { ...pub.freelance, fitFloor: 0 } };
  const frozen = freezePack(unfloored);
  const score = async (gig: Gig): Promise<readonly ScoredGig[]> => {
    const rate = rateOf(gig, pub.fx, pub.freelance.maxHoursPerWeek);
    const d = decideGig({ gig, rate }, pub as unknown as Parameters<typeof decideGig>[1]);
    const verdict = { rated: { gig, rate }, ...d };
    const ctx = issueContext({
      contract: gigScorer.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
      clock: fixedClock(NOW), signal: AbortSignal.timeout(10_000), pack: frozen,
    });
    return gigScorer.run({ verdict, flags: riskFlags(verdict) }, ctx);
  };
  const cases: CoverEvalCase[] = [];
  const push = (id: string, s: ScoredGig): void => {
    const p = planGigDocs(s, unfloored);
    if (p !== undefined) cases.push({ id, input: s, expected: { pass: true, cover: p.cover !== undefined } });
  };

  const fetch = offlineProviders(join(ROOT, 'tests/fixtures/freelance/himalayas')).fetch;
  const seen = new Set<string>();
  let n = 0;
  for (const query of ['backend', 'llm']) {
    const ctx = issueContext({
      contract: srcHimalayasGigsContract(), policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch }, clock: fixedClock(NOW),
      signal: AbortSignal.timeout(30_000), hostPacer: { wait: async () => {} },
    });
    for (const raw of await makeSrcHimalayasGigs().run({ platform: 'himalayas', query, runDate: '2026-10-14', half: 'pm' }, ctx)) {
      const fictional: RawGig = { ...raw, raw: { ...(raw.raw as Record<string, unknown>), description: `<p>${FICTIONAL[n % FICTIONAL.length] as string}</p>` } };
      n += 1;
      const gig = normalizeGig(fictional);
      if (seen.has(gig.gigKey)) continue;
      seen.add(gig.gigKey);
      for (const s of await score(gig)) push(`himalayas-${query}-${gig.sourceId.replace(/[^a-z0-9]+/gi, '-').slice(-40)}`, s);
    }
  }

  const JD = 'This is a 6-month contract role. We build event-driven payments services in Java with Spring Boot, Kafka and PostgreSQL on AWS. You will design APIs and run Kubernetes in production.';
  const posting = (i: number, over: Partial<Posting> = {}): Posting => ({
    jobKey: `ec00000000000${String(i).padStart(3, '0')}`, dedupeKey: `ed00000000000${String(i).padStart(3, '0')}`, source: 'himalayas', sourceId: `example-${i}`,
    company: `Example Contracting ${i}`, slug: `example-${i}`, ats: 'feed', title: 'Senior Backend Engineer (Java, 6-month contract)', url: `https://jobs.example.com/roles/${i}`,
    locationText: 'Remote - India', remote: { structured: 'remote', countries: ['india'], signals: [] }, employmentType: 'Contract', descriptionText: JD,
    postedAt: '2026-10-10T09:00:00Z', comp: null, yearsRequired: null, ...over,
  });
  const boards: [string, Partial<Posting>][] = [
    ['boards-java-contract', {}],
    ['boards-go-platform', { title: 'Backend Engineer - Go / Kafka (contract)', descriptionText: 'Fixed-term contract. We need a backend engineer to build Go services on Kafka and AWS, with gRPC APIs and PostgreSQL. Experience with Kubernetes is welcome.' }],
    ['boards-llm-agents', { title: 'AI Agents Engineer (Contractor)', descriptionText: 'Contractor engagement. You will build LLM agents and RAG pipelines in Python and TypeScript, exposed as APIs on AWS, with Kafka for events.' }],
    ['boards-accented-company', { company: `Example Caf${String.fromCodePoint(0xe9)} Systems` }],
    ['boards-no-company-dash', { company: 'Example Contracting 5', title: `Senior Backend Engineer ${String.fromCodePoint(0x2013)} Payments (contract)` }],
  ];
  for (const [i, [id, over]] of boards.entries()) {
    const p = posting(i, over);
    for (const s of await score(normalizeGig({ platform: 'boards', sourceId: p.jobKey, raw: p }))) push(id, s);
  }

  const base = cases.find((c) => c.id === 'boards-java-contract')?.input;
  if (base === undefined) throw new Error('no base boards case');
  const edit = (id: string, f: (g: Gig) => Gig, cover = false): void => {
    const s = structuredClone(base);
    const gig = f(structuredClone(s.risked.verdict.rated.gig));
    cases.push({ id, input: { ...s, risked: { ...s.risked, verdict: { ...s.risked.verdict, rated: { ...s.risked.verdict.rated, gig } } } }, expected: { pass: true, cover } });
  };
  const named = (g: Gig, name: string | null): Gig => ({ ...g, client: { ...g.client, name } });
  edit('edge-board-no-company', (g) => named(g, null));
  edit('edge-board-forbidden-company', (g) => named(g, 'Initech Contracting'));
  edit('edge-board-email-company', (g) => named(g, 'Mail cv@example.com'));
  edit('edge-board-cjk-company', (g) => named(g, `Example ${String.fromCodePoint(0x6771, 0x4eac)}`));
  edit('edge-marketplace-contract', (g) => ({ ...g, platform: 'freelancer', gigKey: gigKey('freelancer', 'e1'), sourceId: 'e1' }));
  edit('edge-hn-hiring-contract', (g) => ({ ...g, platform: 'hn-hiring', gigKey: gigKey('hn-hiring', 'e2'), sourceId: 'e2' }));
  edit('edge-board-gig-kind', (g) => ({ ...g, kind: 'gig' }));
  edit('edge-board-forbidden-in-description', (g) => ({ ...g, description: `${g.description} The platform is run by Initech.` }), true);
  edit('edge-board-pay-in-title', (g) => ({ ...g, title: 'Senior Backend Engineer - $60/hr contract' }));
  edit('edge-board-hours-in-title', (g) => ({ ...g, title: 'Senior Backend Engineer (20 hours per week)' }));
  return cases;
}

/** The dataset file's text: one case per line. */
export const gigCoverEvalText = (cases: readonly CoverEvalCase[]): string => `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`;

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(ROOT, 'evals/datasets/gig-cover-grounding.jsonl'), gigCoverEvalText(await gigCoverEvalCases()));
}
