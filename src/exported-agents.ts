import { gigEligibility } from './app/freelance/gig-eligibility.js';
import { gigNormalizer } from './app/freelance/gig-normalizer.js';
import { gigRisk } from './app/freelance/gig-risk.js';
import { gigScorer } from './app/freelance/gig-scorer.js';
import { rateNormalizer } from './app/freelance/rate.js';
import { gigSources } from './app/freelance/sources/index.js';
import { dailyAgents } from './app/pipeline.js';
import { demoAgents } from './demo/pipeline.js';

/** Any careers entry includes the careers agents; their contracts name the symbolic egress, so the export is exact. */
const WITH_CAREERS = [{ ats: 'careers', listUrl: 'https://careers.example.com/jobs' }] as const;

/**
 * Every agent whose contract is exported to `contracts-out/` (`contracts export`) and drift-checked (`contracts
 * check`, part of `node --run verify`): the demo agents, every agent of the daily pipeline (sources, normalizer,
 * eligibility, scorer and the writing team) and the freelance sources, gig normalizer, rate normalizer, gig eligibility, gig risk and gig scorer.
 */
export const exportedAgents = [...demoAgents, ...dailyAgents(WITH_CAREERS), ...gigSources, gigNormalizer, rateNormalizer, gigEligibility, gigRisk, gigScorer] as const;
