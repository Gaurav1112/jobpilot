import { z } from 'zod';
import { definePredicate } from '../kernel/predicates.js';
import { defineType } from '../kernel/types.js';

export const DemoRequest = defineType(
  'DemoRequest',
  1,
  z.object({ count: z.number().int().min(1).max(50), prefix: z.string().regex(/^[a-z]+$/) }).strict(),
);
export type DemoRequest = z.infer<typeof DemoRequest.schema>;

export const DemoItem = defineType('DemoItem', 1, z.object({ id: z.string(), text: z.string() }).strict());
export type DemoItem = z.infer<typeof DemoItem.schema>;

export const DemoScore = defineType(
  'DemoScore',
  1,
  z.object({ id: z.string(), score: z.number().int(), reason: z.string() }).strict(),
);
export type DemoScore = z.infer<typeof DemoScore.schema>;

export const countPositive = definePredicate<DemoRequest>('request.count-positive', 'count is at least 1', (r) => r.count >= 1);
export const itemIdSet = definePredicate<DemoItem>('item.id-nonempty', 'item id is not empty', (i) => i.id.length > 0);
export const scoreInRange = definePredicate<DemoScore>('score.in-range', 'score is between 0 and 10', (s) => s.score >= 0 && s.score <= 10);
