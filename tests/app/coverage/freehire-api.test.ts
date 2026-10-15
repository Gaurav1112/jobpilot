import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appEvalSpecs } from '../../../src/app/evals.js';
import { boardOfRow, checkPage, classifyRow, evidenceOf, freehireRowClassifier, stripTracking } from '../../../src/app/coverage/freehire-api.js';
import { freehireCompanyKey, isRealCompanyName, refOfFreehireBoard } from '../../../src/app/coverage/freehire-boards.js';
import type { Platform } from '../../../src/app/coverage/types.js';
import { runEval } from '../../../src/evals/runner.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';

const root = join(import.meta.dirname, '../../..');
const fx = (name: string): string => readFileSync(join(root, 'tests/fixtures/sx', name), 'utf8');

describe('checkPage', () => {
  it('reads rows and the total; never the enrichment', () => {
    const r = checkPage(fx('freehire/search-ok.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(152);
    expect(r.rows).toHaveLength(12);
    expect(r.malformed).toEqual([]);
    expect(fx('freehire/search-ok.json')).toContain('"enrichment"');
    expect(r.rows[0]).not.toHaveProperty('enrichment');
    expect(r.rows[0]).not.toHaveProperty('countries');
  });
  it('a non-empty ignored_params is a shape change', () => {
    expect(checkPage(fx('freehire/search-ignored.json'))).toEqual({ ok: false, why: 'freehire ignored parameters: q_feilds' });
  });
  it('a body without data/meta, or not JSON, is a shape change', () => {
    expect(checkPage('{"jobs":[]}').ok).toBe(false);
    expect(checkPage('<html>').ok).toBe(false);
  });
  it('rows that all fail the row shape are a shape change', () => {
    expect(checkPage(fx('freehire/search-shape.json')).ok).toBe(false);
  });
  it('one bad row is a named malformed entry, the rest are read', () => {
    const body = JSON.parse(fx('freehire/search-ok.json')) as { data: Record<string, unknown>[] };
    delete body.data[3]?.title;
    const r = checkPage(JSON.stringify(body));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(11);
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]).toMatch(/^row 3: title/u);
  });
});

it('stripTracking drops utm_* only', () => {
  expect(stripTracking('https://job-boards.greenhouse.io/twilio/jobs/8236865?utm_source=freehire.me')).toBe('https://job-boards.greenhouse.io/twilio/jobs/8236865');
  expect(stripTracking('https://a.example/j?id=4&utm_medium=api&utm_source=freehire.me')).toBe('https://a.example/j?id=4');
  expect(stripTracking('https://a.example/j?id=4#top')).toBe('https://a.example/j?id=4#top');
});

it.each([
  [{ title: 'Staff Software Engineer (L4)', location: 'Remote - India' }, 'india'],
  [{ title: 'Senior Software Engineer', location: 'Bengaluru, Karnataka, India' }, 'india'],
  [{ title: 'Senior Shopify Developer', location: 'Anywhere in the World' }, 'worldwide'],
  [{ title: 'Senior Software Engineer, Security Platform', location: 'Argentina, Remote' }, null], // freehire tagged it IN; jobpilot does not
  [{ title: 'Business Development Representative', location: 'Remote - India' }, null],
  [{ title: 'Senior Systems Engineer', location: 'In-Office' }, null],
  [{ title: 'Software Engineer', location: 'Indianapolis, IN' }, null],
  [{ title: 'Software Engineer', location: null }, null],
  [{ title: 'Software Engineer', location: 'Worldwide (excluding India)' }, null],
  [{ title: 'Software Engineer', location: 'Remote - Anywhere except India' }, null],
  [{ title: 'Software Engineer', location: 'Global (excl. India)' }, null],
])('evidenceOf(%o) = %s', (row, want) => expect(evidenceOf(row)).toBe(want));

it.each([
  [{ source: 'greenhouse', external_id: 'twilio:8236865' }, { platform: 'greenhouse', board: 'twilio' }],
  [{ source: 'workday', external_id: 'magnitudesoftware.wd1.myworkdayjobs.com/external:/job/India---Hyderabad/X_REQ1' }, { platform: 'workday', board: 'magnitudesoftware.wd1.myworkdayjobs.com/external' }],
  [{ source: 'oracle', external_id: 'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com/CX_1:4080' }, { platform: 'oracle', board: 'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com/CX_1' }],
  [{ source: 'remotedotcom', external_id: ':staff-engineer-backend-j1wocvrk' }, null],
  [{ source: 'ukg', external_id: 'recruiting.ultipro.com/epr1000epsus/1065…:4547' }, null],
  [{ source: 'greenhouse', external_id: ':123' }, null],
])('boardOfRow(%o)', (row, want) => expect(boardOfRow(row)).toEqual(want));

it.each([
  ['workday', 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite'],
  ['icims', 'berrydunn', 'careers-berrydunn.icims.com'],
  ['icims', 'careers.docusign.com', null],
  ['personio', 'desotec', 'desotec.jobs.personio.de'],
  ['lever', 'Voltus', 'voltus'],
  ['jazzhr', 'baxterplanning', 'baxterplanning'],
  ['zohorecruit', '2basetechnologies.zohorecruit.in', '2basetechnologies.zohorecruit.in'],
])('refOfFreehireBoard(%s, %s) = %s', (p, b, want) => expect(refOfFreehireBoard(p as Platform, b)).toBe(want));

it.each([
  ['Twilio', 'twilio', true],
  ['tilthq', 'tilthq', false],
  ['12jlkfsk', '12jlkfsk', false],
  ['egug.fa.us2.oraclecloud.com/CX', 'egug.fa.us2.oraclecloud.com/CX', false],
  ['American Express', 'egug.fa.us2.oraclecloud.com/CX', true],
  [null, 'x', false],
  ['Getinz People', 'getinz-people', false],
])('isRealCompanyName(%s, %s) = %s', (c, b, want) => expect(isRealCompanyName(c, b)).toBe(want));

it('the company key is stable, never a domain label anyone has', () => {
  expect(freehireCompanyKey('greenhouse', 'twilio')).toMatch(/^fh-[0-9a-f]{16}\.freehire$/u);
  expect(freehireCompanyKey('greenhouse', 'twilio')).toBe(freehireCompanyKey('greenhouse', 'twilio'));
  expect(freehireCompanyKey('greenhouse', 'twilio')).not.toBe(freehireCompanyKey('lever', 'twilio'));
});

describe('classifyRow', () => {
  const row = (source: string, external_id: string, title: string, location: string | null) => ({ source, external_id, title, location, closed_at: null });
  it('classes a supported-platform row with evidence as a board', () => {
    expect(classifyRow(row('greenhouse', 'twilio:1', 'Staff Software Engineer', 'Remote - India'))).toBe('board');
  });
  it('a supported board jobpilot cannot read is a lead, not a guess', () => {
    expect(classifyRow(row('icims', 'careers.docusign.com:7', 'Software Engineer', 'India'))).toBe('lead');
  });
  it('an unsupported platform with evidence is a lead; re-syndicated sources and unproven rows drop', () => {
    expect(classifyRow(row('ukg', 'recruiting.ultipro.com/x/y:1', 'Software Engineer', 'Bangalore, India'))).toBe('lead');
    expect(classifyRow(row('adzuna', 'it-jobs:1', 'Software Engineer', 'India'))).toBe('drop');
    expect(classifyRow(row('whatjobs-in', 'java developer:1', 'Software Engineer', 'India'))).toBe('drop');
    expect(classifyRow(row('greenhouse', 'sezzle:1', 'Software Engineer', 'Argentina, Remote'))).toBe('drop');
    expect(classifyRow({ ...row('greenhouse', 'twilio:1', 'Software Engineer', 'India'), closed_at: '2026-10-01T00:00:00Z' })).toBe('drop');
  });
});

describe('the freehire-rows eval', () => {
  it('is registered and scores 1.000', async () => {
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.name === 'freehire-rows');
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(spec.agent).toBe(freehireRowClassifier);
    expect(spec.cases.length).toBeGreaterThanOrEqual(40);
    const labels = new Set(spec.cases.map((c) => (c.expected as { class: string }).class));
    expect([...labels].sort()).toEqual(['board', 'drop', 'lead']);
    const report = await runEval(spec, { providers: {} as never, policy: PRODUCT_POLICY_V1 });
    expect(report.failures).toEqual([]);
    expect(report.score).toBe(1);
  });
});
