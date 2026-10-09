import { dailyAgents } from './app/pipeline.js';
import { demoAgents } from './demo/pipeline.js';

/**
 * The careers agents' contracts are built per watchlist (their egress is the exact careers hosts), so the exported
 * pair is built for this one fictional host; a real pack compiles its own hosts at run time. Everything else in the
 * export is the contract the daily run uses.
 */
export const EXPORT_CAREERS_WATCHLIST = [{ ats: 'careers', listUrl: 'https://careers.example.com/jobs' }] as const;

/**
 * Every agent whose contract is exported to `contracts-out/` (`contracts export`) and drift-checked (`contracts
 * check`, part of `node --run verify`): the demo agents and every agent of the daily pipeline (sources, normalizer,
 * eligibility, scorer and the writing team).
 */
export const exportedAgents = [...demoAgents, ...dailyAgents(EXPORT_CAREERS_WATCHLIST)] as const;
