import { srcGigMail } from '../mail/gmail.js';
import { srcBoardContracts } from './board-contracts.js';
import { srcFreelancer } from './freelancer.js';
import { srcHn } from './hn.js';
import { srcHimalayasGigs } from './himalayas-gigs.js';
import { srcRemotive } from './remotive.js';

/** The gig source agents, in a stable order. */
export const gigSources = [srcFreelancer, srcRemotive, srcHn, srcGigMail, srcBoardContracts, srcHimalayasGigs] as const;
