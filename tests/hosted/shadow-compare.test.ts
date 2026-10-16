import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareDay, counts, dates, readDigests } from '../../src/app/hosted/shadow/compare.js';
import { DAYS, buildShadowFixture, type ShadowFixture } from '../support/shadow-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'jp-shadow-'));
  dirs.push(d);
  return d;
};
const day = (fx: ShadowFixture, date: string) =>
  compareDay(date, { mac: fx.mac.get(date)?.daily, hosted: fx.hosted.get(date)?.daily, macGigs: fx.mac.get(date)?.freelance, hostedGigs: fx.hosted.get(date)?.freelance });
const c = (r: { mac: number; hosted: number; both: number; macOnly: number; hostedOnly: number; recall: number | null }) => [r.mac, r.hosted, r.both, r.macOnly, r.hostedOnly, r.recall];

describe('shadow comparator core', () => {
  it('counts per source on day 1', () => {
    const fx = buildShadowFixture(tmp());
    const r = day(fx, DAYS[0]);
    expect(r.sources.map((s) => s.source)).toEqual(['greenhouse', 'himalayas', 'lever']);
    const by = Object.fromEntries(r.sources.map((s) => [s.source, s]));
    expect(c(by['greenhouse']!)).toEqual([10, 10, 10, 0, 0, 1]);
    expect(c(by['himalayas']!)).toEqual([6, 4, 4, 2, 0, 4 / 6]);
    expect(c(by['lever']!)).toEqual([2, 0, 0, 2, 0, 0]);
    expect(by['himalayas']!.problems).toEqual({ mac: [], hosted: ['challenged'] });
    expect(r.comparable).toBe(true);
    expect(r.why).toBeNull();
    expect(r.codeDiffers).toBe(false);
  });

  it('eligible, toDecide and gigs; every day comparable', () => {
    const fx = buildShadowFixture(tmp());
    expect(c(day(fx, DAYS[6]).eligible)).toEqual([5, 4, 4, 1, 0, 0.8]);
    expect(c(day(fx, DAYS[6]).toDecide)).toEqual([5, 4, 4, 1, 0, 0.8]);
    expect(c(day(fx, DAYS[0]).eligible)).toEqual([5, 5, 5, 0, 0, 1]);
    expect(c(day(fx, DAYS[0]).gigs)).toEqual([4, 4, 4, 0, 0, 1]);
    expect(DAYS.every((d) => day(fx, d).comparable)).toBe(true);
  });

  it('a differing pack hash, a missing side and a differing code sha', () => {
    const fx = buildShadowFixture(tmp(), (f) => {
      f.hosted.get(DAYS[0])!.daily = { ...f.hosted.get(DAYS[0])!.daily!, packHash: 'c'.repeat(64) };
      f.mac.get(DAYS[1])!.daily = undefined;
      f.hosted.get(DAYS[2])!.daily = undefined;
      f.hosted.get(DAYS[3])!.daily = { ...f.hosted.get(DAYS[3])!.daily!, codeSha: 'd'.repeat(40) };
    });
    expect(day(fx, DAYS[0])).toMatchObject({ comparable: false, why: 'pack-differs' });
    expect(day(fx, DAYS[1])).toMatchObject({ comparable: false, why: 'mac-missing' });
    expect(day(fx, DAYS[2])).toMatchObject({ comparable: false, why: 'hosted-missing' });
    expect(day(fx, DAYS[3])).toMatchObject({ comparable: true, why: null, codeDiffers: true });
  });

  it('gigs are zero when a freelance digest is missing', () => {
    const r = compareDay(DAYS[0], {});
    expect(c(r.gigs)).toEqual([0, 0, 0, 0, 0, null]);
  });

  it('readDigests reads the folder and rejects a wrong env', () => {
    const dir = tmp();
    buildShadowFixture(dir);
    expect(readDigests(join(dir, 'hosted'), 'hosted').size).toBe(14);
    expect(readDigests(join(dir, 'mac'), 'local').get('2026-11-02-daily')?.env).toBe('local');
    expect(() => readDigests(join(dir, 'mac'), 'hosted')).toThrow(/2026-11-0\d-(daily|freelance)\.json/);
    writeFileSync(join(dir, 'hosted', '2026-11-09-daily.json'), '{}');
    expect(() => readDigests(join(dir, 'hosted'), 'hosted')).toThrow(/2026-11-09-daily\.json/);
  });

  it('counts and dates', () => {
    expect(counts([], []).recall).toBeNull();
    expect(counts(['a', 'b'], ['b', 'c'])).toMatchObject({ both: 1, macOnly: 1, hostedOnly: 1, recall: 0.5 });
    expect(dates('2026-11-28', 4)).toEqual(['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01']);
  });
});
