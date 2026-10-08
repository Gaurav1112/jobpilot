/**
 * P0 public job data · P1 contact PII · P2 offers and salary · P3 mailbox bodies.
 * Ordered by sensitivity for taint propagation: an output inherits the most
 * sensitive class among its inputs unless its agent is a declared redactor.
 */
export const DATA_CLASSES = ['P0', 'P1', 'P2', 'P3'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export function maxClass(classes: readonly DataClass[]): DataClass {
  let max: DataClass = 'P0';
  for (const c of classes) if (DATA_CLASSES.indexOf(c) > DATA_CLASSES.indexOf(max)) max = c;
  return max;
}
