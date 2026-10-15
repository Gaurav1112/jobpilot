import { coverageExportAgents } from './app/coverage/pipeline.js';
import { freelanceAgents } from './app/freelance/pipeline.js';
import { dailyAgents } from './app/pipeline.js';
import { demoAgents } from './demo/pipeline.js';

/** Any careers entry includes the careers agents; their contracts name the symbolic egress, so the export is exact. */
const WITH_CAREERS = [{ ats: 'careers', listUrl: 'https://careers.example.com/jobs' }] as const;
/** Any verified Workday company includes `src-workday`; its contract names the symbolic egress, so the export is exact. */
const WITH_WORKDAY = [{ platform: 'workday', company: 'Example', ref: 'example.wd1.myworkdayjobs.com/example/External' }] as const;
/** Likewise one verified Eightfold and one Oracle company include `src-eightfold` and `src-oracle` (Task 7). */
const WITH_PLATFORMS = [
  ...WITH_WORKDAY,
  { platform: 'eightfold', company: 'Example', ref: 'example.eightfold.ai/example.com' },
  { platform: 'oracle', company: 'Example', ref: 'example.fa.oraclecloud.com/CX_1' },
  // Task 8, the page adapters
  { platform: 'icims', company: 'Example', ref: 'careers-example.icims.com' },
  { platform: 'successfactors', company: 'Example', ref: 'careers.example.com' },
  { platform: 'smartrecruiters', company: 'Example', ref: 'Example' },
  { platform: 'jsonld-sitemap', company: 'Example', ref: 'www.example.com' },
  // Task 9, the small platforms
  { platform: 'workable', company: 'Example', ref: 'example' },
  { platform: 'recruitee', company: 'Example', ref: 'example' },
  { platform: 'teamtailor', company: 'Example', ref: 'career.example.com' },
  { platform: 'personio', company: 'Example', ref: 'example.jobs.personio.de' },
  { platform: 'bamboohr', company: 'Example', ref: 'example' },
  { platform: 'breezy', company: 'Example', ref: 'example' },
  { platform: 'pinpoint', company: 'Example', ref: 'example' },
  { platform: 'rippling', company: 'Example', ref: 'example' },
  { platform: 'gem', company: 'Example', ref: 'example' },
  // Sources expansion, Task 2, the listing-pages adapters
  { platform: 'jazzhr', company: 'Example', ref: 'example' },
  { platform: 'freshteam', company: 'Example', ref: 'example' },
  // Sources expansion, Task 3, the Zoho Recruit feed board
  { platform: 'zohorecruit', company: 'Example', ref: 'example.zohorecruit.com' },
] as const;

/**
 * Every agent whose contract is exported to `contracts-out/` (`contracts export`) and drift-checked (`contracts
 * check`, part of `node --run verify`): the demo agents, every agent of the daily pipeline (sources, src-workday, src-eightfold, src-oracle, the Task 8 page adapters, normalizer,
 * eligibility, scorer and the writing team) and every agent of the freelance pipeline (`freelanceAgents`: the gig
 * sources, gig normalizer, rate normalizer, gig eligibility, gig risk, gig scorer and the gig writing team) and every
 * agent of the weekly coverage pipeline (company-seed, careers-locator, platform-detector, board-verifier).
 */
export const exportedAgents = [...demoAgents, ...dailyAgents(WITH_CAREERS, WITH_PLATFORMS), ...freelanceAgents(), ...coverageExportAgents()] as const;
