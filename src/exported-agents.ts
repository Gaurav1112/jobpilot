import { coverageExportAgents } from './app/coverage/pipeline.js';
import { freelanceAgents } from './app/freelance/pipeline.js';
import { dailyAgents } from './app/pipeline.js';
import { demoAgents } from './demo/pipeline.js';

/** Any careers entry includes the careers agents; their contracts name the symbolic egress, so the export is exact. */
const WITH_CAREERS = [{ ats: 'careers', listUrl: 'https://careers.example.com/jobs' }] as const;
/** Any verified Workday company includes `src-workday`; its contract names the symbolic egress, so the export is exact. */
const WITH_WORKDAY = [{ platform: 'workday', company: 'Example', ref: 'example.wd1.myworkdayjobs.com/example/External' }] as const;

/**
 * Every agent whose contract is exported to `contracts-out/` (`contracts export`) and drift-checked (`contracts
 * check`, part of `node --run verify`): the demo agents, every agent of the daily pipeline (sources, src-workday, normalizer,
 * eligibility, scorer and the writing team) and every agent of the freelance pipeline (`freelanceAgents`: the gig
 * sources, gig normalizer, rate normalizer, gig eligibility, gig risk, gig scorer and the gig writing team) and every
 * agent of the weekly coverage pipeline (company-seed, careers-locator, platform-detector, board-verifier).
 */
export const exportedAgents = [...demoAgents, ...dailyAgents(WITH_CAREERS, WITH_WORKDAY), ...freelanceAgents(), ...coverageExportAgents()] as const;
