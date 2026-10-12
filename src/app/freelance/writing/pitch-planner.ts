import type { GigDocsPlan } from '../types.js';
import type { GigSlots } from './proposal-planner.js';

/**
 * The contract pitch (spec §7, Task 8): five lines from the same slots as a proposal (`proposal-planner.ts`
 * `gigSlots`), in this order: the hook, two evidence lines (fewer when fewer bullets meet the covered terms), the
 * availability line and the question. Only evidence lines carry fact ids. Pure.
 */

type Pitch = NonNullable<GigDocsPlan['pitch']>;

export function pitchOf(s: GigSlots): Pitch {
  return {
    lines: [
      { text: s.hook.text, factIds: [] },
      ...s.evidence.slice(0, 2).map((e) => ({ text: e.text, factIds: [...e.factIds] })),
      { text: s.availability, factIds: [] },
      { text: s.question, factIds: [] },
    ],
  };
}

/** The pitch's text: one line each, `{cadence}` filled. */
export const pitchText = (p: Pitch, cadence: string): string =>
  p.lines
    .map((l) => l.text)
    .join('\n')
    .split('{cadence}')
    .join(cadence);
