import { z } from 'zod';
import { canonicalJson } from '../../kernel/canonical.js';
import { issueLines } from './config.js';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Hex40 = z.string().regex(/^[0-9a-f]{40}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const LastDone = z.strictObject({ daily: Day.nullable(), freelance: Day.nullable(), coverage: Day.nullable() });
export const GenRecord = z.strictObject({
  gen: z.number().int().min(1),
  tag: z.string(),
  asset: z.string(),
  sha256: Hex64,
  bytes: z.number().int().min(1),
  schema: z.strictObject({ kernel: z.number().int().min(0), app: z.number().int().min(0) }),
  codeSha: Hex40,
  packHash: z.string().min(1),
  lastDone: LastDone,
  at: z.iso.datetime(),
});
export const Lease = z.strictObject({ holder: z.string().regex(/^(?:actions:\d{1,20}|laptop:[0-9a-f]{8})$/), until: z.iso.datetime() });
export const Pointer = z.strictObject({
  v: z.literal(1),
  gen: z.number().int().min(0), // 0: no generation yet
  current: GenRecord.nullable(), // the record of `gen` (null iff gen = 0)
  lease: Lease.nullable(),
  budget: z.strictObject({ month: z.string().regex(/^\d{4}-\d{2}$/), level: z.enum(['L0', 'L1', 'L2', 'L3', 'L4']) }).nullable(),
  sizeHard: z.boolean(), // the last commit crossed hardCompressedMB: the next run refuses (spec 3.3)
  history: z.array(GenRecord).max(30), // newest first, `current` included (P6)
});
export type Pointer = z.infer<typeof Pointer>;
export const EMPTY_POINTER: Pointer = { v: 1, gen: 0, current: null, lease: null, budget: null, sizeHard: false, history: [] };
export const pointerJson = (p: Pointer): string => `${canonicalJson(Pointer.parse(p))}\n`;

/** JSON + schema, then the cross-field rules: current.gen === gen (null iff 0), history strictly newest-first. */
export function parsePointer(text: string): Pointer {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('pointer.json: not valid JSON');
  }
  const r = Pointer.safeParse(raw);
  if (!r.success) throw new Error(`pointer.json: ${issueLines(r.error)}`);
  const p = r.data;
  if ((p.current === null) !== (p.gen === 0)) throw new Error('pointer.json: current must be null exactly when gen is 0');
  if (p.current && p.current.gen !== p.gen) throw new Error('pointer.json: current.gen must equal gen');
  for (let i = 1; i < p.history.length; i++) {
    if ((p.history[i - 1]?.gen ?? 0) <= (p.history[i]?.gen ?? 0)) throw new Error('pointer.json: history must be newest first with unique generations');
  }
  return p;
}
