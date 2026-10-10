import { describe, expect, it } from 'vitest';
import { squashChars } from '../../src/app/pack/rules.js';
import { HIDDEN, redactor } from '../../src/app/web/server.js';

/**
 * Rereview R6: the dashboard's strict redaction must stay exactly as strict while costing far less. `squashChars`
 * gained an ASCII fast path; it must agree with the per-character fold it replaces on every input.
 */

const CONFUSABLE_SAMPLE = 'аеорсухіјѕтнһԁԛԝӏүАВЕКМНОРСТУХІЈЅҺԀԚԜӀΑΒΕΖΗΙΚΜΝΟΡΤΧΥϹοικρνεταυϲագզհոսցօլԼՍՏՕᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢɑɡɩȷı';

/** The pre-R6 squashChars, verbatim in behaviour: fold every character on its own. */
function referenceSquash(s: string, fold: (ch: string) => string, standIns: Readonly<Record<string, string>>): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  let i = 0;
  for (const ch of s) {
    for (const c of fold(ch)) {
      const m = standIns[c] ?? c;
      if (/[\p{L}\p{N}]/u.test(m)) {
        text += m;
        at.push(i);
      }
    }
    i += ch.length;
  }
  return { text, at };
}

describe('rereview R6: squashChars fast path', () => {
  it('agrees with the slow per-character fold on every BMP code point and on mixed text', async () => {
    const { foldForTests, STAND_INS_FOR_TESTS } = await import('../../src/app/pack/rules.js');
    const ref = (s: string) => referenceSquash(s, foldForTests, STAND_INS_FOR_TESTS);
    const singles: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) singles.push(String.fromCharCode(cp));
    for (const ch of singles) expect(squashChars(ch), `U+${ch.charCodeAt(0).toString(16)}`).toEqual(ref(ch));
    const mixed = [
      'Ini-tech', 'In1tech Labs', 'lnitech', 'İnitech', 'Іnitech', 'I n i t e c h', 'Café ß straße', '𝐈𝐧𝐢𝐭𝐞𝐜𝐡', 'ﬁnance',
      `x${CONFUSABLE_SAMPLE}y`, 'a­b​c', 'Ｉｎｉｔｅｃｈ', 'Kubernetes @ $5 | 7!', '😀 emoji 👍🏽 text',
      singles.slice(0, 2000).join(''),
    ];
    for (const s of mixed) expect(squashChars(s)).toEqual(ref(s));
  });

  it('redacting 2,000 jobs with long descriptions still hides glued terms and leaves clean text alone', () => {
    const naming = { forbiddenTerms: ['Initech'] };
    const jd = 'Build distributed Go services with Kafka and PostgreSQL across regions; own reliability. '.repeat(70);
    const jobs = Array.from({ length: 2_000 }, (_, i) => ({ jobKey: String(i), company: i % 500 === 0 ? 'InitechPay Labs' : `Company ${i % 37}`, title: 'Senior Engineer', jdText: jd + String(i) }));
    const out = redactor(naming).deep(jobs);
    expect(out.filter((j) => j.company === HIDDEN)).toHaveLength(4);
    expect(out[1]?.jdText).toBe(jd + '1');
  });

  it('the fast path is several times quicker than the per-character fold, measured side by side (rereview-2 M1)', async () => {
    // A ratio against the reference measured in the same loop, not a wall-clock bound: a loaded machine slows both
    // paths alike. Interleaved rounds and the best time of each keep one scheduler hiccup from deciding the result.
    const { foldForTests, STAND_INS_FOR_TESTS } = await import('../../src/app/pack/rules.js');
    const text = 'Build distributed Go services with Kafka and PostgreSQL across regions; own reliability. '.repeat(700);
    let fast = Infinity;
    let slow = Infinity;
    for (let round = 0; round < 7; round++) {
      let t = performance.now();
      squashChars(text);
      fast = Math.min(fast, performance.now() - t);
      t = performance.now();
      referenceSquash(text, foldForTests, STAND_INS_FOR_TESTS);
      slow = Math.min(slow, performance.now() - t);
    }
    // measured ~9x; 3x leaves wide room for noise while still failing if the fast path stops being taken
    expect(slow / fast).toBeGreaterThan(3);
  });
});

describe('rereview R7: problem lists and the notification use the strict matcher', () => {
  const naming = { forbiddenTerms: ['Initech'] };
  it('a glued company is hidden in a stale problem, a problem line and the notification', async () => {
    const { staleProblems, safeLine } = await import('../../src/app/problems.js');
    const { notificationFor } = await import('../../src/app/notify.js');
    const items = staleProblems([{ jobKey: 'a', company: 'InitechPay Labs', title: 'Engineer', docsState: 'stale', docsDetail: null }], naming);
    expect(JSON.stringify(items)).not.toMatch(/initech/i);
    expect(safeLine('Ini-\ntech Labs — Engineer', naming)).toBe('[hidden: contains a forbidden term]');
    expect(safeLine('InitechPay — Engineer', naming)).toBe('[hidden: contains a forbidden term]');
    expect(safeLine('Acme — Engineer', naming)).toBe('Acme — Engineer');
    expect(notificationFor([{ score: 90, company: 'InitechPay Labs', title: 'Engineer' }], naming)).toBe('1 new match');
    expect(notificationFor([{ score: 90, company: 'Acme', title: 'In1tech-ops Engineer' }], naming, 2)).toBe('1 new match · 2 problems');
  });

  it('no problem or notification surface keeps the word-bounded matcher', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of ['src/app/problems.ts', 'src/app/notify.ts']) {
      expect(readFileSync(join(import.meta.dirname, '../..', f), 'utf8')).not.toMatch(/\bassertNoForbidden\b/);
    }
  });
});
