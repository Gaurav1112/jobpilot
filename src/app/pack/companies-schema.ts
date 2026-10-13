import { z } from 'zod';

/**
 * companies.yaml: the user's own company picks for the career-site coverage (spec §3, highest-priority seed source).
 * Only `name` is required; the website and the careers URL help the locator when the user knows them.
 */
export const CompanyPick = z.strictObject({
  name: z.string().min(1),
  website: z.string().min(1).optional(),
  careersUrl: z.string().min(1).optional(),
});
export type CompanyPick = z.infer<typeof CompanyPick>;

export const CompaniesFile = z.strictObject({ companies: z.array(CompanyPick).default([]) });
export type CompaniesFile = z.infer<typeof CompaniesFile>;
