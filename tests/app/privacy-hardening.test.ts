import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privacyHomes, privacyProblemsOf, privacyTermsOf, scanFolder, scanForTerms } from '../../src/app/privacy.js';
import { createProfile } from '../../src/app/profiles/commands.js';

// Fictional fixture values only: Asha Rao, asha.rao@example.com, +91 90000 00000, https://example.com/asha-rao,
// Initech, floor 1200000 INR. Asha's terms: #1 initech, #2 name, #3 email, #4 phone, #5 link, #6-8 floor.
const repo = join(import.meta.dirname, '../..');
const clock = { now: () => '2026-10-15T08:00:00.000Z' };
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobpilot-privh-'));
  createProfile({ root, id: 'asha', clock, fromPack: join(repo, 'tests/fixtures/pack') });
  dir = join(root, 'repo');
  mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const homes = () => privacyHomes({ JOBPILOT_ROOT: root, HOME: '/Users/x' });
const hitsFor = (text: string): string[] => {
  writeFileSync(join(dir, 'f.md'), text);
  return scanForTerms(dir, homes()).map((h) => h.replace(/^f\.md \(asha, (term #\d+)\)$/, '$1'));
};
const term = (n: number) => [`term #${n}`];

describe('the phone, written the ways people write it', () => {
  it.each(['90000 00000', '090000 00000', '0091 90000 00000', '+91/90000/00000', '+91 90000 00000', '+91&nbsp;90000&nbsp;00000', '+91_90000_00000', '+91 (0) 90000 00000', 'tel:+919000000000', '9000000000'])('%s', (t) => {
    expect(hitsFor(`call ${t} today\n`)).toEqual(term(4));
  });
  it('never inside a longer number', () => {
    expect(hitsFor('id 19000000000123 and 990000000001\n')).toEqual([]);
  });
});

describe('the pay floor, written the ways people write it', () => {
  it.each(['1200000.00', '1,200,000.00', '12,00,000.00', '1 200 000', '1 200 000', '12_00_000', '1.200.000', '1.200.000,00', '१२,००,०००', '１２０００００'])('%s', (t) => {
    expect(hitsFor(`pay ${t} INR\n`).length).toBeGreaterThan(0);
  });
  it.each(['12 lakh', '12 Lakhs', '12L', '₹12 LPA', '12 lac', '1.2M', '1.2 million', '1200k'])('%s', (t) => {
    expect(hitsFor(`pay ${t} a year\n`)).toEqual(term(6));
  });
  it.each(['INR12L', '(1.2M)', 'Rs.12 lakh', 'CTC: 12L'])('%s', (t) => {
    expect(hitsFor(`pay ${t}\n`)).toEqual(term(6));
  });
  it.each(['sha512-ab1.2m+Qz', 'x\u00011.2m\u0002', 'q12l/', 'v1.2mn=', '1200kb', 'a12 lakh'])('not the short unit form inside %j', (t) => {
    expect(hitsFor(`${t}\n`)).toEqual([]);
  });
  it.each(['1200000.5', '0.1200000', '71200000098', '112,00,000', '1,200,000,000', '12 lines', '120 lakh', '1.25M'])('not %s', (t) => {
    expect(hitsFor(`x ${t} y\n`)).toEqual([]);
  });
});

describe('names, emails, links', () => {
  it.each(['asha-rao', 'asha_rao', 'Asha  Rao', 'Asha\nRao', 'Asha\tRao', 'Asha Rao', '**Asha** Rao', 'Asha&nbsp;Rao', 'Rao, Asha', 'RAO ASHA'])('name %j', (t) => {
    expect(hitsFor(`by ${t}\n`)).toEqual(term(2));
  });
  it.each(['asha.rao%40example.com', 'asha.rao&#64;example.com', 'asha.rao [at] example [dot] com', 'asha.rao at example dot com', 'Asha.Rao@Example.com'])('email %j', (t) => {
    expect(hitsFor(`mail ${t}\n`)).toContain('term #3'); // the local part also reads as the name (#2)
  });
  it.each(['example.com/asha-rao', 'http://example.com/asha-rao', 'https://www.example.com/asha-rao/'])('link %s', (t) => {
    expect(hitsFor(`see ${t}\n`)).toContain('term #5'); // the slug also reads as the name (#2)
  });
  it('zero-width characters do not hide a term', () => {
    expect(hitsFor('Ini\u200btech and Ini\u00adtech\n')).toEqual(term(1));
  });
});

describe('short terms', () => {
  it('a 3-letter forbidden term is checked as a whole word, not dropped', () => {
    writeFileSync(join(root, 'profiles/asha/pack/naming.yaml'), 'employerDisplay: {}\nforbiddenTerms: [Initech, IBX]\n');
    expect(privacyTermsOf(join(root, 'profiles/asha'))).toContain('ibx');
    expect(hitsFor('work at IBX now\n')).toEqual(term(2));
    expect(hitsFor('ibxtra and fibx\n')).toEqual([]);
  });
});

describe('the folder walk', () => {
  it('file and folder names are scanned, and the hit hides the matching name', () => {
    mkdirSync(join(dir, 'asha-rao'));
    writeFileSync(join(dir, 'asha-rao', 'x.md'), 'clean\n');
    writeFileSync(join(dir, 'initech-notes.md'), 'clean\n');
    const r = scanFolder(dir, homes());
    expect(r.hits).toEqual(['[hidden] (asha, term #1, in the path)', '[hidden] (asha, term #2, in the path)']);
  });
  it('gzip and UTF-16 files are read', () => {
    writeFileSync(join(dir, 'a.json.gz'), gzipSync('{"who":"Asha Rao"}'));
    writeFileSync(join(dir, 'b.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Initech', 'utf16le')]));
    expect(scanFolder(dir, homes()).hits).toEqual(['a.json.gz (asha, term #2)', 'b.txt (asha, term #1)']);
  });
  it('symlinks are not followed, and are listed as not scanned', () => {
    symlinkSync('/', join(dir, 'up'));
    writeFileSync(join(dir, 'r.pdf'), '%PDF-1.4 binary');
    const r = scanFolder(dir, homes());
    expect(r.hits).toEqual([]);
    expect(r.notScanned).toEqual(['r.pdf (a document format whose text may be compressed)', 'up (a symlink, not followed)']);
  });
});

describe('a home the scan cannot check is a problem, never "clean"', () => {
  it('no pack, a pack file that does not parse, no terms', () => {
    expect(privacyProblemsOf(join(root, 'nowhere'))).toEqual(['no pack folder']);
    writeFileSync(join(root, 'profiles/asha/pack/contact.yaml'), 'name: [unclosed\n');
    expect(privacyProblemsOf(join(root, 'profiles/asha'))).toEqual(['contact.yaml does not parse']);
    const empty = join(root, 'empty');
    mkdirSync(join(empty, 'pack'), { recursive: true });
    expect(privacyProblemsOf(empty)).toEqual(['no terms to check']);
    expect(privacyProblemsOf(join(root, 'profiles/asha')).length).toBeGreaterThan(0);
  });
  it('the fixture pack has no problems', () => {
    expect(privacyProblemsOf(join(root, 'profiles/asha'))).toEqual([]);
  });
  it('a pack phone with an extension still matches the number without it', () => {
    writeFileSync(join(root, 'profiles/asha/pack/contact.yaml'), 'name: Asha Rao\nemail: asha.rao@example.com\nphone: "+91 90000 00000 ext 12"\ncity: Pune\nlinks: []\n');
    expect(hitsFor('call +91 90000 00000\n')).toEqual(term(4));
  });
  it('JOBPILOT_HOME naming one profile of a root still scans every profile', () => {
    createProfile({ root, id: 'lena', clock, fromPack: join(repo, 'tests/fixtures/pack') });
    expect(privacyHomes({ JOBPILOT_HOME: join(root, 'profiles/asha'), HOME: '/Users/x' }).map((h) => h.label)).toEqual(['asha', 'lena']);
  });
  it('a stray file in removed/ is not a home', () => {
    mkdirSync(join(root, 'removed'));
    writeFileSync(join(root, 'removed', '.DS_Store'), '');
    expect(homes().map((h) => h.label)).toEqual(['asha']);
  });
});
