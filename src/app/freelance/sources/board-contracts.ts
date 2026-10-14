import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { Posting } from '../../types.js';
import { GigRequest, RawGig } from '../types.js';

/**
 * Contract postings the daily pipeline already stored. The freelance run seeds one `platform: 'boards'` request per
 * stored daily job whose reasons include `employment:contract`, `employment:freelance` or `employment:part-time`
 * (read through AppStore in the app layer). `item` must be a daily Posting@1; anything else is `invalid_output`.
 * Emits `RawGig{platform: 'boards', sourceId: posting.jobKey, raw: posting}`. Fetches nothing.
 */
export const srcBoardContractsContract = defineContract({
  id: 'src-board-contracts',
  version: '1.1.0',
  description: 'Converts a stored daily contract posting into a raw gig',
  skills: ['gig-sourcing'],
  team: 'sourcing',
  kind: 'deterministic',
  consumes: GigRequest,
  produces: RawGig,
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const srcBoardContracts = defineAgent(srcBoardContractsContract, async (req) => {
  if (req.platform !== 'boards') return [];
  const parsed = Posting.schema.safeParse(req.item);
  if (!parsed.success) throw new KernelError('invalid_output', `board contract item is not a Posting@1: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return [{ platform: 'boards' as const, sourceId: parsed.data.jobKey, raw: parsed.data }];
});
