import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportedAgents } from '../../src/exported-agents.js';
import { checkDrift } from '../../src/kernel/contracts-export.js';
import { Registry } from '../../src/kernel/registry.js';

// The drift check over every exported contract, the app's included, lives on the app side (review M6): the kernel's
// own tests use only the demo agents.
describe('contracts-out', () => {
  it('matches the code for every exported agent', () => {
    const r = new Registry();
    for (const a of exportedAgents) r.register(a);
    expect(r.list().map((a) => a.contract.id)).toEqual([
      'board-verifier', 'careers-locator', 'company-seed', 'cover-writer', 'demo-scorer', 'demo-source', 'eligibility', 'evidence-matcher', 'gig-eligibility', 'gig-normalizer', 'gig-qa', 'gig-renderer', 'gig-risk', 'gig-scorer', 'normalizer', 'platform-detector', 'proposal-planner', 'qa-gate', 'rate-normalizer', 'renderer', 'resume-planner',
      'scorer-lexicon', 'src-ashby', 'src-bamboohr', 'src-board-contracts', 'src-breezy', 'src-careers-job', 'src-careers-list', 'src-draftdev', 'src-eightfold', 'src-fractional-jobs', 'src-freehire-discovery', 'src-freehire-leads', 'src-freelancer', 'src-freshteam', 'src-gem', 'src-gig-mail', 'src-greenhouse', 'src-himalayas', 'src-himalayas-gigs', 'src-hn', 'src-icims', 'src-jazzhr', 'src-jobicy', 'src-jsonld-sitemap', 'src-lever', 'src-manatal',
      'src-oracle', 'src-personio', 'src-pinpoint', 'src-prime-intellect', 'src-recruitee', 'src-remotive', 'src-rippling', 'src-smartrecruiters', 'src-successfactors', 'src-teamtailor', 'src-workable', 'src-workday', 'src-zohorecruit',
    ]);
    expect(checkDrift(r, join(import.meta.dirname, '../../contracts-out'))).toEqual([]);
  });
});
