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

  it('redacting 2,000 jobs with long descriptions takes well under the old cost, and still hides glued terms', () => {
    const naming = { forbiddenTerms: ['Initech'] };
    const jd = 'Build distributed Go services with Kafka and PostgreSQL across regions; own reliability. '.repeat(70);
    const jobs = Array.from({ length: 2_000 }, (_, i) => ({ jobKey: String(i), company: i % 500 === 0 ? 'InitechPay Labs' : `Company ${i % 37}`, title: 'Senior Engineer', jdText: jd + String(i) }));
    const t = performance.now();
    const out = redactor(naming).deep(jobs);
    const ms = performance.now() - t;
    expect(out.filter((j) => j.company === HIDDEN)).toHaveLength(4);
    expect(out[1]?.jdText).toBe(jd + '1');
    // ~12M characters: the per-character fold took ~2.5 s here; the fast path is several times quicker
    expect(ms).toBeLessThan(1_200);
  });
});
