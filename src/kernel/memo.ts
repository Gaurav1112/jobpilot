import { hashOf, sha256 } from './canonical.js';
import { type AnyContract, contractMajor } from './contract.js';
import type { Envelope } from './envelope.js';

/**
 * Same agent major, same input, same handoff, same policy → same key → the
 * step never runs twice. The input envelope id is deliberately excluded:
 * identical content arriving by two routes is one piece of work.
 */
export function computeStepKey(contract: AnyContract, input: Envelope, policyHash: string): string {
  return hashOf({
    agent: `${contract.id}@${contractMajor(contract)}`,
    inputType: input.type,
    input: input.payload,
    handoff: { guarantees: input.handoff.guarantees, dataClass: input.handoff.dataClass, obligations: input.handoff.obligations },
    policyHash,
  });
}

/** Retry delay with jitter derived from the step key, so retry timing is reproducible too. */
export function backoffDelay(stepKey: string, attempt: number, backoffMs: readonly number[]): number {
  const base = backoffMs[attempt] ?? backoffMs.at(-1) ?? 0;
  return base + (Number.parseInt(sha256(`${stepKey}:${attempt}`).slice(0, 4), 16) % 250);
}
