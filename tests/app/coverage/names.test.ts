import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { companyNameMatcher, GENERIC_LABELS, normalCompanyName, sameCompany } from '../../../src/app/coverage/names.js';
import { runEval } from '../../../src/evals/runner.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../../..');

describe('normalCompanyName', () => {
  it('drops trailing legal suffixes, case and punctuation', () => {
    expect(normalCompanyName('Okta, Inc.')).toBe('okta');
    expect(normalCompanyName('Microsoft Corporation')).toBe('microsoft');
    expect(normalCompanyName('HCL Technologies')).toBe('hcl');
    expect(normalCompanyName('Zoho Corporation Pvt Ltd')).toBe('zoho');
    expect(normalCompanyName('Wipro Private Limited')).toBe('wipro');
  });
  it('turns & into and, applies NFKC, and keeps accents', () => {
    expect(normalCompanyName('AT&T')).toBe('at and t');
    expect(normalCompanyName('Ｏｋｔａ')).toBe('okta');
    expect(normalCompanyName('Café Nero')).toBe('café nero');
  });
  it('never strips a name to nothing', () => {
    expect(normalCompanyName('Co')).toBe('co');
    expect(normalCompanyName('Inc. Ltd')).toBe('inc');
  });
});

describe('sameCompany', () => {
  it('matches after the fixed normalisation', () => {
    expect(sameCompany('Okta, Inc.', 'Okta')).toBe(true);
    expect(sameCompany('Microsoft Corporation', 'Microsoft')).toBe(true);
    expect(sameCompany('HCL Technologies', 'HCL')).toBe(true);
  });
  it('matches the domain label with spaces removed', () => {
    expect(sameCompany('Pure Storage Inc', 'purestorage', 'purestorage')).toBe(true);
    expect(sameCompany('Pure Storage Inc', 'Pure Storage', 'purestorage')).toBe(true);
    expect(sameCompany('Pure Storage Inc', 'purestorage')).toBe(false);
  });
  it('refuses the domain-label route for a generic label unless the names match by normalCompanyName (carry 2)', () => {
    for (const label of ['jobs', 'careers', 'career', 'app', 'apply', 'work', 'hire', 'hiring', 'team', 'inc', 'join', 'talent', 'recruit', 'people', 'hr', 'boards', 'my', 'get', 'go', 'try', 'the']) {
      expect(GENERIC_LABELS.has(label)).toBe(true);
      expect(sameCompany('Acme Robotics', label, label)).toBe(false);
      expect(sameCompany('Acme Robotics', label.toUpperCase(), label)).toBe(false);
    }
    // the names themselves match: the label plays no part
    expect(sameCompany('Hire Inc', 'Hire', 'hire')).toBe(true);
    expect(sameCompany('Get', 'get', 'get')).toBe(true);
    // a label that is not generic still matches
    expect(sameCompany('Pure Storage Inc', 'purestorage', 'purestorage')).toBe(true);
    // a generic word inside a longer label is not generic
    expect(sameCompany('Acme', 'jobsity', 'jobsity')).toBe(true);
  });
  it('does not match prefixes, aliases or look-alikes', () => {
    expect(sameCompany('Meta', 'Metaverse Labs')).toBe(false);
    expect(sameCompany('Tata Consultancy Services', 'TCS')).toBe(false);
    expect(sameCompany('Okta', 'Оkta')).toBe(false);
  });
});

describe('the coverage-names golden set', () => {
  const lines = readFileSync(join(root, 'evals/datasets/coverage-names.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '');
  it('has at least 40 hand-labelled pairs, both answers present, with Unicode, ampersands and look-alikes', () => {
    const cases = lines.map((l) => JSON.parse(l) as { id: string; input: { a: string; b: string }; expected: { same: boolean } });
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.filter((c) => c.expected.same).length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => !c.expected.same).length).toBeGreaterThanOrEqual(10);
    expect(cases.some((c) => /[^\x00-\x7f]/u.test(c.input.a + c.input.b))).toBe(true);
    expect(cases.some((c) => c.input.a.includes('&'))).toBe(true);
    expect(cases.some((c) => c.id.includes('lookalike') || c.id.includes('zero-for-o'))).toBe(true);
  });
  it('is registered as the coverage-names eval and passes at 1.000', async () => {
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.name === 'coverage-names');
    expect(spec).toBeDefined();
    expect(spec?.agent).toBe(companyNameMatcher);
    const report = await runEval(spec!, { providers: {} as never, policy: PRODUCT_POLICY_V1 });
    expect(report.failures).toEqual([]);
    expect(report.score).toBe(1);
    expect(report.n).toBeGreaterThanOrEqual(40);
  });
});
