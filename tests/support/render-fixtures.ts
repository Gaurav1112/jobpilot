import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidence, planCover, planResume, type WritingPack } from '../../src/app/agents/writing/grounded.js';
import { scorePosting } from '../../src/app/agents/scorer-lexicon.js';
import { loadPack } from '../../src/app/pack/load.js';
import type { Pack } from '../../src/app/pack/schema.js';
import type { CoverPlan, Posting } from '../../src/app/types.js';
import { freezePack } from '../../src/kernel/broker.js';

/** Fixtures for the renderer and the qa-gate (Task 10): the fictional Asha Rao pack and one grounded cover plan. */

export const root = join(import.meta.dirname, '../..');
export const packDir = join(root, 'tests/fixtures/pack');

export function fullPack(over: Partial<Pack> = {}): Pack {
  return { ...loadPack(packDir).pack, ...over };
}
export function publicPackOf(full: Pack): WritingPack {
  const { contact: _c, answers: _a, ...pub } = full;
  return freezePack(pub) as unknown as WritingPack;
}

export const JD =
  'We build event-driven payments services in Java with Spring Boot, Kafka and PostgreSQL on AWS. ' +
  'You will run Kubernetes, Docker, gRPC and Elasticsearch in production. Scala is a plus.';

export function posting(over: Partial<Posting> = {}): Posting {
  return {
    jobKey: '0123456789abcdef',
    dedupeKey: 'fedcba9876543210',
    source: 'greenhouse',
    sourceId: 'w1',
    company: 'Acme Payments',
    slug: 'acme',
    ats: 'greenhouse',
    title: 'Senior Backend Engineer (Java)',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    locationText: 'Remote - India',
    remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] },
    employmentType: 'Full-time',
    descriptionText: JD,
    postedAt: '2026-10-01T09:00:00Z',
    comp: null,
    yearsRequired: null,
    ...over,
  };
}

/** The grounded cover plan (with its resume plan) of a posting, as the writing team emits it. */
export function coverPlanOf(p: Posting = posting(), full: Pack = fullPack()): CoverPlan {
  const pack = publicPackOf(full);
  const scored = scorePosting({ posting: p, verdict: 'eligible', reasons: [], notes: [] }, pack as unknown as Parameters<typeof scorePosting>[1]);
  const resume = planResume(buildEvidence(scored, pack), pack);
  return planCover(resume, pack);
}

export const tempOut = (): string => mkdtempSync(join(tmpdir(), 'jobpilot-out-'));
