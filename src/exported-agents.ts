import { writingAgents } from './app/agents/writing/index.js';
import { demoAgents } from './demo/pipeline.js';

/**
 * Every agent whose contract is exported to `contracts-out/` (`contracts export`) and drift-checked (`contracts
 * check`, part of `node --run verify`): the demo agents and the app's writing team. Add an agent here when its
 * contract is final enough to be pinned.
 */
export const exportedAgents = [...demoAgents, ...writingAgents] as const;
