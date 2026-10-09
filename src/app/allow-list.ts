import type { AnyContract } from '../kernel/contract.js';

/**
 * The app's capability allow-list (Task 10; the pipeline compile of Task 11 calls `capabilityProblems` and refuses to
 * wire on any problem). The kernel lets any contract declare these capabilities; the app narrows them to the one agent
 * each is for:
 * - `capabilities.pack: 'full'` (contact details, answers): only the renderer, which merges contact details into the
 *   documents and fills the cover's p4;
 * - `capabilities.files` with `access: 'read-write'`: only the renderer, which writes the documents;
 * - `capabilities.pdfText`: only the qa-gate, which checks the PDFs' text layer.
 */
export const CAPABILITY_ALLOW_LIST = {
  fullPack: ['renderer'],
  filesWrite: ['renderer'],
  pdfText: ['qa-gate'],
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
    if (c.capabilities.pdfText && !allowed(CAPABILITY_ALLOW_LIST.pdfText, c.id)) {
      problems.push(`${c.id} declares capabilities.pdfText; only ${CAPABILITY_ALLOW_LIST.pdfText.join(', ')} may run pdftotext`);
    }
  }
  return problems;
}
