import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_COMMIT, CATALOGUE_CONTENT_SHA256, CATALOGUE_FILES, EVIDENCE_QUERIES, contentDigest, evidenceUrl, run, type Deps } from '../../scripts/freehire-catalogue.js';
import { buildTar } from '../support/tar.js';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'sx', 'freehire');
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

const LICENSE = 'MIT License\n\nCopyright (c) 2026 freehire contributors\n\nPermission is hereby granted, free of charge, to any person.\n';
const YAMLS: Record<string, string> = {
  greenhouse: [
    '- company: Twilio\n  board: twilio\n  extra: ignored',
    '- company: Northwind Labs\n  board: northwind',
    '- company: tilthq\n  board: tilthq',
    '- company: Contoso Cloud Inc\n  board: contoso',
    '- company: Contoso Cloud\n  board: contoso',
  ].join('\n') + '\n',
  lever: '- company: Fabrikam Systems\n  board: fabrikam\n',
  icims: '- company: Litware Group\n  board: careers.litware.example\n',
};
const fileText = (name: string): string => YAMLS[name] ?? '[]\n';
const root = `freehire-${CATALOGUE_COMMIT}`;
const TAR = buildTar([
  { name: 'pax_global_header', type: 'g', data: `52 comment=${CATALOGUE_COMMIT}\n` },
  { name: `${root}/`, type: '5' },
  { name: `${root}/LICENSE`, data: LICENSE },
  ...CATALOGUE_FILES.map((n) => ({ name: `${root}/sources/${n}.yml`, data: fileText(n) })),
  { name: `${root}/sources/README.md`, data: 'not a catalogue file' },
]);
const DIGEST = contentDigest(CATALOGUE_FILES.map((n) => ({ name: `${n}.yml`, data: Buffer.from(fileText(n)) })));

const tmp = (): string => mkdtempSync(join(tmpdir(), 'fh-cat-'));
function setup(): { dir: string; cache: string; out: string; tarball: string } {
  const dir = tmp();
  const cache = join(dir, 'cache');
  cpSync(join(FIX, 'evidence'), cache, { recursive: true });
  const tarball = join(dir, 'fh.tar');
  writeFileSync(tarball, TAR);
  return { dir, cache, out: join(dir, 'out'), tarball };
}
const noNet: Deps['fetch'] = () => Promise.reject(new Error('network used'));
const quiet = (extra: Partial<Deps> = {}): Partial<Deps> => ({ fetch: noNet, sleep: () => Promise.resolve(), log: () => {}, env: { NODE_ENV: 'test' }, ...extra });
const args = (s: ReturnType<typeof setup>, more: string[] = []): string[] => ['--date', '2026-10-16', '--cache', s.cache, '--tarball', s.tarball, '--out', s.out, '--content-sha256-override', DIGEST, ...more];

describe('freehire catalogue script', () => {
  it('pins the commit, the content digest and the 22 platform files', () => {
    expect(CATALOGUE_COMMIT).toBe('96b53a2c7b1e545bbad0868e16ec85a2eba4f36a');
    expect(CATALOGUE_CONTENT_SHA256).toBe('384b6c4fbdd22e75e25bf6f0d8903c897e7be569359a9cf1da72b889cd13c084');
    expect(CATALOGUE_FILES).toHaveLength(22);
    expect([...CATALOGUE_FILES]).toEqual([...CATALOGUE_FILES].sort());
    expect(EVIDENCE_QUERIES).toEqual(['india bengaluru bangalore', 'worldwide anywhere global international']);
  });

  it('refuses a tarball whose content digest differs, naming both digests', async () => {
    const s = setup();
    const a = args(s).slice(0, -2);
    await expect(run(a, quiet())).rejects.toThrow(new RegExp(`${CATALOGUE_CONTENT_SHA256}[\\s\\S]*${DIGEST}|${DIGEST}[\\s\\S]*${CATALOGUE_CONTENT_SHA256}`, 'u'));
    expect(existsSync(s.out)).toBe(false);
  });

  it('refuses --content-sha256-override outside NODE_ENV=test', async () => {
    const s = setup();
    await expect(run(args(s), quiet({ env: {} }))).rejects.toThrow(/NODE_ENV=test/u);
  });

  it('writes the expected seed byte for byte, and a second run is byte-identical', async () => {
    const s = setup();
    const r = await run(args(s, ['--offline']), quiet());
    const seed = readFileSync(join(s.out, 'catalogue-seed.jsonl'), 'utf8');
    expect(seed).toBe(readFileSync(join(FIX, 'expected-seed.jsonl'), 'utf8'));
    const manifest = readFileSync(join(s.out, 'manifest.json'), 'utf8');
    const notice = readFileSync(join(s.out, 'NOTICE'), 'utf8');
    expect(notice).toContain(`commit ${CATALOGUE_COMMIT}`);
    expect(notice.endsWith(`\n\n${LICENSE}`)).toBe(true);
    expect(r.bytes).toBe(Buffer.byteLength(seed));
    await run(args(s, ['--offline']), quiet());
    expect(readFileSync(join(s.out, 'catalogue-seed.jsonl'), 'utf8')).toBe(seed);
    expect(readFileSync(join(s.out, 'manifest.json'), 'utf8')).toBe(manifest);
    expect(readFileSync(join(s.out, 'NOTICE'), 'utf8')).toBe(notice);
  });

  it('counts unnamed, untranslatable (a vanity iCIMS host), no-evidence and duplicate entries in the manifest', async () => {
    const s = setup();
    await run(args(s, ['--offline']), quiet());
    const m = JSON.parse(readFileSync(join(s.out, 'manifest.json'), 'utf8')) as Record<string, any>;
    expect(m['platforms']['greenhouse']).toEqual({ entries: 5, unnamed: 1, untranslatable: 0, noEvidence: 1, duplicates: 1, kept: 2 });
    expect(m['platforms']['lever']).toEqual({ entries: 1, unnamed: 0, untranslatable: 0, noEvidence: 0, duplicates: 0, kept: 1 });
    expect(m['platforms']['icims']).toEqual({ entries: 1, unnamed: 0, untranslatable: 1, noEvidence: 0, duplicates: 0, kept: 0 });
    expect(Object.keys(m['platforms'])).toEqual(['greenhouse', 'icims', 'lever']);
    expect(m['requests']).toBe(m['responses'].length);
    expect(m['responses']).toHaveLength(6);
    expect(m['generatedOn']).toBe('2026-10-16');
    expect(m['contentSha256']).toBe(DIGEST);
    expect(m['windowCapped']).toEqual([]);
    const lines = readFileSync(join(s.out, 'catalogue-seed.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines.map((l) => `${l['platform']} ${l['ref']} ${l['evidence']}`)).toEqual(['greenhouse contoso 1', 'greenhouse twilio 3', 'lever fabrikam 1']);
    expect(lines.find((l) => l['ref'] === 'contoso')?.['company']).toBe('Contoso Cloud');
    expect(lines.find((l) => l['ref'] === 'twilio')?.['example'].url).not.toContain('utm_');
  });

  it('--offline with a missing page aborts naming its URL, before writing anything', async () => {
    const s = setup();
    const url = evidenceUrl('lever', EVIDENCE_QUERIES[1] as string, 0);
    rmCache(s.cache, url);
    await expect(run(args(s, ['--offline']), quiet())).rejects.toThrow(url);
    expect(existsSync(s.out)).toBe(false);
  });

  it('a page with ignored_params aborts naming the URL', async () => {
    const s = setup();
    const url = evidenceUrl('lever', EVIDENCE_QUERIES[0] as string, 0);
    writeFileSync(join(s.cache, `${sha(url)}.json`), JSON.stringify({ data: [], meta: { total: 0, limit: 100, offset: 0, ignored_params: ['q_fields'] } }));
    await expect(run(args(s, ['--offline']), quiet())).rejects.toThrow(new RegExp(`${escape(url)}[\\s\\S]*ignored parameters: q_fields|ignored parameters: q_fields[\\s\\S]*${escape(url)}`, 'u'));
    expect(existsSync(s.out)).toBe(false);
  });

  it('aborts when the seed exceeds 2 MB, writing nothing', async () => {
    const s = setup();
    const big = buildTar([
      { name: `${root}/LICENSE`, data: LICENSE },
      ...CATALOGUE_FILES.map((n) => ({ name: `${root}/sources/${n}.yml`, data: n === 'lever' ? `- company: "${'Fabrikam Systems '.repeat(130_000)}"\n  board: fabrikam\n` : '[]\n' })),
    ]);
    const digest = contentDigest(CATALOGUE_FILES.map((n) => ({ name: `${n}.yml`, data: Buffer.from(n === 'lever' ? `- company: "${'Fabrikam Systems '.repeat(130_000)}"\n  board: fabrikam\n` : '[]\n') })));
    writeFileSync(s.tarball, big);
    await expect(run(['--date', '2026-10-16', '--cache', s.cache, '--tarball', s.tarball, '--out', s.out, '--content-sha256-override', digest, '--offline'], quiet())).rejects.toThrow(/seed over the 2 MB budget: \d+ bytes/u);
    expect(existsSync(s.out)).toBe(false);
  });

  it('requires --date and rejects a malformed one', async () => {
    const s = setup();
    await expect(run(['--cache', s.cache], quiet())).rejects.toThrow(/--date/u);
    await expect(run(['--date', 'tomorrow', '--cache', s.cache], quiet())).rejects.toThrow(/--date/u);
  });

  describe('the live pass (stubbed fetch)', () => {
    const page = (total: number, offset: number, n: number): string =>
      JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ source: 'lever', external_id: `fabrikam:${offset + i}`, url: `https://jobs.lever.co/fabrikam/${offset + i}?utm_source=freehire.me`, title: 'Software Engineer', company: 'Fabrikam Systems', location: 'India', posted_at: null, created_at: `2026-10-0${1 + ((offset + i) % 9)}T00:00:00Z` })), meta: { total, limit: 100, offset } });

    it('pages 100 at a time, waits 2 s between requests, sends the honest UA, and records a window-capped total loudly', async () => {
      const dir = tmp();
      const tarball = join(dir, 'fh.tar');
      const only = buildTar([
        { name: `${root}/LICENSE`, data: LICENSE },
        ...CATALOGUE_FILES.map((n) => ({ name: `${root}/sources/${n}.yml`, data: n === 'lever' ? '- company: Fabrikam Systems\n  board: fabrikam\n' : '[]\n' })),
      ]);
      writeFileSync(tarball, only);
      const digest = contentDigest(CATALOGUE_FILES.map((n) => ({ name: `${n}.yml`, data: Buffer.from(n === 'lever' ? '- company: Fabrikam Systems\n  board: fabrikam\n' : '[]\n') })));
      const urls: string[] = [];
      const uas: string[] = [];
      const sleeps: number[] = [];
      const logs: string[] = [];
      const fetchStub: Deps['fetch'] = (u, init) => {
        const url = String(u);
        urls.push(url);
        uas.push(String((init?.headers as Record<string, string>)['User-Agent']));
        const offset = Number(new URL(url).searchParams.get('offset'));
        const q = new URL(url).searchParams.get('q');
        const total = q === EVIDENCE_QUERIES[0] ? 250 : 25_000;
        return Promise.resolve(new Response(page(total, offset, q === EVIDENCE_QUERIES[0] ? Math.min(100, total - offset) : 100)));
      };
      const out = join(dir, 'out');
      await run(['--date', '2026-10-16', '--cache', join(dir, 'c'), '--tarball', tarball, '--out', out, '--content-sha256-override', digest], quiet({ fetch: fetchStub, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, log: (l) => logs.push(l) }));
      expect(urls).toHaveLength(3 + 100);
      expect(urls[0]).toBe(evidenceUrl('lever', EVIDENCE_QUERIES[0] as string, 0));
      expect(urls[2]).toBe(evidenceUrl('lever', EVIDENCE_QUERIES[0] as string, 200));
      expect(urls.at(-1)).toBe(evidenceUrl('lever', EVIDENCE_QUERIES[1] as string, 9900));
      expect(new Set(uas)).toEqual(new Set(['jobpilot/0.1 (+local)']));
      expect(sleeps).toHaveLength(urls.length - 1);
      expect(new Set(sleeps)).toEqual(new Set([2000]));
      const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Record<string, any>;
      expect(m['windowCapped']).toEqual([{ platform: 'lever', query: EVIDENCE_QUERIES[1], total: 25_000 }]);
      expect(logs.join('\n')).toMatch(/window-capped/u);
      // the replay from the cache it just wrote needs no network and is byte-identical
      const seed = readFileSync(join(out, 'catalogue-seed.jsonl'), 'utf8');
      await run(['--date', '2026-10-16', '--cache', join(dir, 'c'), '--tarball', tarball, '--out', out, '--content-sha256-override', digest, '--offline'], quiet());
      expect(readFileSync(join(out, 'catalogue-seed.jsonl'), 'utf8')).toBe(seed);
    });

    it.each([401, 403, 429, 503])('a %i answer aborts at once, never retried, writing nothing', async (status) => {
      const s = setup();
      rmCache(s.cache, evidenceUrl('greenhouse', EVIDENCE_QUERIES[0] as string, 0));
      let calls = 0;
      const fetchStub: Deps['fetch'] = () => {
        calls += 1;
        return Promise.resolve(new Response('no', { status, headers: { 'Retry-After': '1' } }));
      };
      await expect(run(args(s), quiet({ fetch: fetchStub }))).rejects.toThrow(new RegExp(`HTTP ${status}`, 'u'));
      expect(calls).toBe(1);
      expect(existsSync(s.out)).toBe(false);
    });

    it('a challenge page (not JSON) aborts naming the URL', async () => {
      const s = setup();
      const url = evidenceUrl('greenhouse', EVIDENCE_QUERIES[0] as string, 0);
      rmCache(s.cache, url);
      await expect(run(args(s), quiet({ fetch: () => Promise.resolve(new Response('<html>Just a moment...</html>')) }))).rejects.toThrow(url);
    });

    it('downloads the tarball once into the cache when --tarball is absent (honest UA, 120 s timeout)', async () => {
      const s = setup();
      let seen: { url: string; ua: string; signal: boolean } | null = null;
      const fetchStub: Deps['fetch'] = (u, init) => {
        seen = { url: String(u), ua: String((init?.headers as Record<string, string>)['User-Agent']), signal: init?.signal !== undefined };
        return Promise.resolve(new Response(new Uint8Array(TAR)));
      };
      const a = args(s, ['--offline']);
      a.splice(a.indexOf('--tarball'), 2);
      await expect(run(a, quiet({ fetch: fetchStub }))).rejects.toThrow(/offline/u);
      const b = args(s);
      b.splice(b.indexOf('--tarball'), 2);
      await run(b, quiet({ fetch: fetchStub }));
      expect(seen).toEqual({ url: `https://codeload.github.com/strelov1/freehire/tar.gz/${CATALOGUE_COMMIT}`, ua: 'jobpilot/0.1 (+local)', signal: true });
      expect(readdirSync(s.cache).some((f) => f.endsWith('.tar.gz'))).toBe(true);
    });
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function rmCache(cache: string, url: string): void {
  const p = join(cache, `${sha(url)}.json`);
  if (!existsSync(p)) throw new Error(`fixture missing: ${url}`);
  unlinkSync(p);
}
