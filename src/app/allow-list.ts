import type { AnyContract } from '../kernel/contract.js';

/**
 * The app's capability allow-list (Task 10; the pipeline compile of Task 11 calls `capabilityProblems` and refuses to
 * wire on any problem). The kernel lets any contract declare these capabilities; the app narrows them to the one agent
 * each is for:
 * - `capabilities.pack: 'full'` (contact details, answers): only the renderer, which merges contact details into the
 *   documents and fills the cover's p4, and the gig renderer (Task 8), which does the same for the contract CV and
 *   fills the proposal's update cadence;
 * - `capabilities.files` with `access: 'read-write'`: only the two renderers, which write the documents;
 * - `capabilities.pdfText`: only the qa-gate and gig-qa, which check the PDFs' text layer;
 * - the symbolic egress `pack:careers-hosts` (hosts taken from the watchlist): only the two careers agents;
 * - the symbolic egress `coverage:candidate-hosts` (resolved per coverage stage: the candidates' own sites for the
 *   locator, the located careers hosts for the detector, the detected boards' read hosts for the verifier; exact
 *   hosts, never a suffix): only the careers-locator, the platform-detector and the board-verifier, which fetch
 *   through the run's shared politeness gate (`coverage/gate.ts`). Side channel: these three agents write the hosts
 *   they disable (challenge, 401, 403, 429, a robots.txt refusal) to the app's `coverage_host_state` table through
 *   the gate's `HostStateStore` (the `AppStore`), before the step returns. It is run-scoped politeness state keyed by
 *   the coverage run id, never data, and nothing but the gate reads it.
 */
export const CAPABILITY_ALLOW_LIST = {
  fullPack: ['renderer', 'gig-renderer'],
  filesWrite: ['renderer', 'gig-renderer'],
  pdfText: ['qa-gate', 'gig-qa'],
  /** The symbolic egress whose hosts come from the user's watchlist (review R-I3). */
  careersEgress: ['src-careers-list', 'src-careers-job'],
  /** The symbolic egress whose hosts are the coverage run's candidate companies' own sites. */
  candidateEgress: ['careers-locator', 'platform-detector', 'board-verifier'],
} as const satisfies Record<string, readonly string[]>;

/** Every allow-list violation among `contracts`, sorted by agent id; empty when the set is allowed. */
export function capabilityProblems(contracts: readonly AnyContract[]): string[] {
  const allowed = (list: readonly string[], id: string) => list.includes(id);
  const problems: string[] = [];
  for (const c of [...contracts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (c.capabilities.pack === 'full' && !allowed(CAPABILITY_ALLOW_LIST.fullPack, c.id)) {
      problems.push(`${c.id} declares capabilities.pack 'full'; only ${CAPABILITY_ALLOW_LIST.fullPack.join(', ')} may read contact details`);
    }
    if (c.capabilities.files?.access === 'read-write' && !allowed(CAPABILITY_ALLOW_LIST.filesWrite, c.id)) {
      problems.push(`${c.id} declares writable files; only ${CAPABILITY_ALLOW_LIST.filesWrite.join(', ')} may write documents`);
    }
    if (c.egress.includes('pack:careers-hosts') && !allowed(CAPABILITY_ALLOW_LIST.careersEgress, c.id)) {
      problems.push(`${c.id} declares egress pack:careers-hosts; only ${CAPABILITY_ALLOW_LIST.careersEgress.join(', ')} may contact the watchlist's careers sites`);
    }
    if (c.egress.includes('coverage:candidate-hosts') && !allowed(CAPABILITY_ALLOW_LIST.candidateEgress, c.id)) {
      problems.push(`${c.id} declares egress coverage:candidate-hosts; only ${CAPABILITY_ALLOW_LIST.candidateEgress.join(', ')} may contact the coverage candidates' sites`);
    }
    if (c.capabilities.pdfText && !allowed(CAPABILITY_ALLOW_LIST.pdfText, c.id)) {
      problems.push(`${c.id} declares capabilities.pdfText; only ${CAPABILITY_ALLOW_LIST.pdfText.join(', ')} may run pdftotext`);
    }
  }
  return problems;
}
