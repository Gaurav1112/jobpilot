import type { Platform } from './types.js';

/**
 * Hosts of the known career-site platforms, one entry per host suffix. The careers locator uses it to accept a link
 * or redirect that leaves the company's own domain for its ATS; the platform detector (Task 4) imports it too.
 * A suffix matches the host itself and any subdomain of it, on a dot boundary: `acme.wd5.myworkdayjobs.com` matches
 * `myworkdayjobs.com`, `notmyworkdayjobs.com` does not.
 */
export const PLATFORM_HOSTS: ReadonlyArray<{ readonly platform: Platform; readonly hostSuffix: string }> = [
  { platform: 'workday', hostSuffix: 'myworkdayjobs.com' },
  { platform: 'workday', hostSuffix: 'myworkdaysite.com' },
  { platform: 'eightfold', hostSuffix: 'eightfold.ai' },
  { platform: 'oracle', hostSuffix: 'oraclecloud.com' },
  { platform: 'icims', hostSuffix: 'icims.com' },
  { platform: 'successfactors', hostSuffix: 'successfactors.com' },
  { platform: 'successfactors', hostSuffix: 'successfactors.eu' },
  { platform: 'smartrecruiters', hostSuffix: 'jobs.smartrecruiters.com' },
  { platform: 'workable', hostSuffix: 'apply.workable.com' },
  { platform: 'recruitee', hostSuffix: 'recruitee.com' },
  { platform: 'teamtailor', hostSuffix: 'teamtailor.com' },
  { platform: 'personio', hostSuffix: 'jobs.personio.de' },
  { platform: 'personio', hostSuffix: 'jobs.personio.com' },
  { platform: 'bamboohr', hostSuffix: 'bamboohr.com' },
  { platform: 'breezy', hostSuffix: 'breezy.hr' },
  { platform: 'pinpoint', hostSuffix: 'pinpointhq.com' },
  { platform: 'rippling', hostSuffix: 'ats.rippling.com' },
  { platform: 'gem', hostSuffix: 'jobs.gem.com' },
  { platform: 'greenhouse', hostSuffix: 'boards.greenhouse.io' },
  { platform: 'greenhouse', hostSuffix: 'job-boards.greenhouse.io' },
  { platform: 'lever', hostSuffix: 'jobs.lever.co' },
  { platform: 'ashby', hostSuffix: 'jobs.ashbyhq.com' },
];

/** The platform a host belongs to (lower-cased, suffix match on a dot boundary), or null. */
export function platformForHost(host: string): Platform | null {
  const h = host.trim().toLowerCase().replace(/\.+$/u, '');
  for (const p of PLATFORM_HOSTS) {
    if (h === p.hostSuffix || h.endsWith(`.${p.hostSuffix}`)) return p.platform;
  }
  return null;
}
