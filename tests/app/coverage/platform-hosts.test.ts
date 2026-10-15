import { describe, expect, it } from 'vitest';
import { PLATFORM_HOSTS, platformForHost } from '../../../src/app/coverage/platform-hosts.js';
import { Platform } from '../../../src/app/coverage/types.js';

describe('platformForHost', () => {
  it('matches the host and its subdomains on a dot boundary, case-insensitively', () => {
    expect(platformForHost('acme.wd5.myworkdayjobs.com')).toBe('workday');
    expect(platformForHost('JOBS.LEVER.CO')).toBe('lever');
    expect(platformForHost('boards.greenhouse.io.')).toBe('greenhouse');
    expect(platformForHost('acme.eu.successfactors.eu')).toBe('successfactors');
    expect(platformForHost('x.oraclecloud.com')).toBe('oracle');
  });
  it('does not match lookalikes, parents or bare vendor domains', () => {
    expect(platformForHost('notmyworkdayjobs.com')).toBeNull();
    expect(platformForHost('lever.co')).toBeNull();
    expect(platformForHost('www.example.test')).toBeNull();
    expect(platformForHost('myworkdayjobs.com.evil.test')).toBeNull();
  });
  it('every entry names a real Platform', () => {
    for (const p of PLATFORM_HOSTS) expect(Platform.safeParse(p.platform).success).toBe(true);
    expect(PLATFORM_HOSTS).toHaveLength(33); // 23 before sources-x Task 1 (+10: jazzhr 1, zohorecruit 4, manatal 1, freshteam 1, ukg 3); was: 22 from Task 3, plus careers.smartrecruiters.com (Task 4 signature table)
  });

  it('bare-domain vendor suffixes need a tenant subdomain: not the apex, not www', () => {
    for (const d of ['icims.com', 'oraclecloud.com', 'bamboohr.com', 'teamtailor.com', 'recruitee.com', 'successfactors.com', 'successfactors.eu', 'eightfold.ai', 'breezy.hr', 'pinpointhq.com']) {
      expect(platformForHost(d)).toBeNull();
      expect(platformForHost(`www.${d}`)).toBeNull();
      expect(platformForHost(`acme.${d}`)).not.toBeNull();
    }
  });
});

describe('sources-x hosts', () => {
  it('knows the five new platforms on a dot boundary', () => {
    expect(platformForHost('acme.applytojob.com')).toBe('jazzhr');
    expect(platformForHost('acme.zohorecruit.com.au')).toBe('zohorecruit');
    expect(platformForHost('www.careers-page.com')).toBe('manatal');
    expect(platformForHost('acme.freshteam.com')).toBe('freshteam');
    expect(platformForHost('recruiting2.ultipro.com')).toBe('ukg');
    expect(platformForHost('acme.rec.pro.ukg.net')).toBe('ukg');
    expect(platformForHost('notfreshteam.com')).toBeNull();
  });
});
