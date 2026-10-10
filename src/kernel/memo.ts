import { hashOf, sha256 } from './canonical.js';
import { type AnyContract, contractMajor } from './contract.js';
import type { Envelope } from './envelope.js';

/**
 * Same agent major, same input, same handoff, same policy → same key → the
 * step never runs twice. The input envelope id is deliberately excluded:
 * identical content arriving by two routes is one piece of work.
 *
 * `packHash` is hashed only when the contract declares `capabilities.pack`, so a
 * pack edit re-runs only the agents that read the pack; every other key is unchanged.
 *
 * `codeHash` (review I4) fingerprints the implementation behind every agent (the app passes a hash of its sources and
 * fonts). It is in every key when given, so a code change re-runs every step once instead of presenting the stored
 * output of old code as current. 'none' (the default, kernel and demo) leaves the key exactly as before.
 */
export function computeStepKey(contract: AnyContract, input: Envelope, policyHash: string, packHash = 'none', codeHash = 'none'): string {
  return hashOf({
    agent: `${contract.id}@${contractMajor(contract)}`,
    inputType: input.type,
    input: input.payload,
    handoff: { guarantees: input.handoff.guarantees, dataClass: input.handoff.dataClass, obligations: input.handoff.obligations },
    policyHash,
    ...(contract.capabilities.pack ? { packHash } : {}),
    ...(codeHash !== 'none' ? { codeHash } : {}),
  });
}

/** Retry delay with jitter derived from the step key, so retry timing is reproducible too. */
export function backoffDelay(stepKey: string, attempt: number, backoffMs: readonly number[]): number {
  const base = backoffMs[attempt] ?? backoffMs.at(-1) ?? 0;
  return base + (Number.parseInt(sha256(`${stepKey}:${attempt}`).slice(0, 4), 16) % 250);
}
