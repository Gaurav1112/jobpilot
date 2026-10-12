import { srcBoardContracts } from './board-contracts.js';
import { srcFreelancer } from './freelancer.js';
import { srcHn } from './hn.js';
import { srcRemotive } from './remotive.js';

/** The gig source agents, in a stable order. */
export const gigSources = [srcFreelancer, srcRemotive, srcHn, srcBoardContracts] as const;
