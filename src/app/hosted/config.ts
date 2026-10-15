import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { IsoDate } from '../types.js';

export const HostedConfig = z
  .strictObject({
    version: z.literal(1),
    owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
    view: z.strictObject({ repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), url: z.url() }),
    budget: z.strictObject({
      monthlyMinutes: z.number().int().min(1).max(50_000),
      safetyMinutes: z.number().int().min(0).max(1_000),
      cycleStartDay: z.number().int().min(1).max(28),
      dailyEstimateMinutes: z.number().int().min(1).max(350),
    }),
    freelance: z.strictObject({ windows: z.array(z.enum(['am', 'pm'])).min(0).max(2) }),
    coverage: z.strictObject({
      everyWeeks: z.number().int().min(1).max(8),
      anchor: IsoDate,
      maxSliceMinutes: z.number().int().min(10).max(350),
      endBy: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    }),
    state: z.strictObject({
      keepGenerations: z.number().int().min(2).max(30),
      keepWeekly: z.number().int().min(0).max(12),
      archiveDays: z.number().int().min(1).max(365),
      warnCompressedMB: z.number().int().min(1),
      hardCompressedMB: z.number().int().min(1).max(2000),
    }),
    snapshot: z.strictObject({ budgetMB: z.number().int().min(1).max(1000), staleHours: z.number().int().min(1).max(240) }),
    skipSources: z
      .array(z.string().regex(/^(?:[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9._-]{1,100})?|freelance:[a-z][a-z0-9-]{0,31})$/))
      .max(50),
  })
  .refine((c) => c.state.warnCompressedMB < c.state.hardCompressedMB, 'state.warnCompressedMB must be below hardCompressedMB');
export type HostedConfig = z.infer<typeof HostedConfig>;

/** Issues as `path: message`, never the offending value (zod messages for regex/enum/type carry none). */
export function issueLines(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

export function loadHostedConfig(file: string): HostedConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${file}: cannot read the hosted config`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new Error(`${file}: not valid YAML`);
  }
  const r = HostedConfig.safeParse(raw);
  if (!r.success) throw new Error(`${file}: ${issueLines(r.error)}`);
  return r.data;
}

export function parseCodeLock(text: string): string {
  const m = /^([0-9a-f]{40})\n?$/.exec(text);
  if (!m?.[1]) throw new Error('code.lock must hold exactly one lowercase 40-hex commit SHA');
  return m[1];
}

/** The hosted pack's retention (spec S5), written into the pack bundle as retention.yaml by `hosted pack push`. */
export const HOSTED_RETENTION_YAML = 'version: 1\nkeep: {daily: 1, freelance: 1, coverage: 1, rebuild: 1}\n';
