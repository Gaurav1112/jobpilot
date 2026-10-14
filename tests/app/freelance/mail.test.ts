import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { connectGmail, disconnectGmail, gmailStatus } from '../../../src/app/freelance/mail/connect.js';
import { GMAIL_LABEL, GMAIL_MAX_MESSAGES, gmailLabelsUrl, gmailListUrl as listUrl, gmailMessageUrl, makeSrcGigMail, srcGigMail } from '../../../src/app/freelance/mail/gmail.js';
import { GMAIL_HOST, GMAIL_LABEL_MISSING, GMAIL_NOT_CONNECTED, GMAIL_SCOPE, SECRET, TOKEN_HOST, TOKEN_URL } from '../../../src/app/freelance/mail/google.js';
import { parseMail } from '../../../src/app/freelance/mail/mime.js';
import { authUrl, exchangeCode, gmailRunAccess, newPkce, realFormPost, startLoopback, type FormPost, type GmailRunAccess } from '../../../src/app/freelance/mail/oauth.js';
import { ALERT_PARSERS, parserProblems, selectParser } from '../../../src/app/freelance/mail/parsers/index.js';
import { freelanceSeeds, PLATFORM_AGENT } from '../../../src/app/freelance/pipeline.js';
import { runFreelance } from '../../../src/app/freelance/run.js';
import { REMOTIVE_URL } from '../../../src/app/freelance/sources/remotive.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { CAPABILITY_ALLOW_LIST } from '../../../src/app/allow-list.js';
import { exportedAgents } from '../../../src/exported-agents.js';
import type { GigRequest, RawGig } from '../../../src/app/freelance/types.js';
import { FreelanceFile } from '../../../src/app/pack/freelance-schema.js';
import { deleteSecret, getSecret, hasSecret, keychain, setSecret, type SecretsRunner } from '../../../src/app/secrets.js';
import type { Agent } from '../../../src/kernel/agent.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { KernelError } from '../../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { EXAMPLE_FINGERPRINT, EXAMPLE_SENDER, exampleBoardParser } from '../../fixtures/freelance/gmail/example-board.js';

/**
 * Task 13: read-only Gmail alert ingest. Nothing here reaches the real Keychain or Google: the Keychain is a fake
 * runner, Google is a fake form post and a fake fetch, the browser is a fake opener, and the only socket is the
 * loopback server on 127.0.0.1.
 */
const root = join(import.meta.dirname, '../../..');
const EML = readFileSync(join(root, 'tests/fixtures/freelance/gmail/example-board.eml'), 'utf8');
const MSG_ID = '18f0a1b2c3d4e5f6';
const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

const homes: string[] = [];
const tempHome = (): string => {
  const h = mkdtempSync(join(tmpdir(), 'jobpilot-mail-'));
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** An in-memory Keychain behind the `security` command line, as the real runner sees it. */
function fakeSecurity(): SecretsRunner & { calls: { args: readonly string[]; stdin: string | undefined }[]; items: Map<string, string> } {
  const items = new Map<string, string>();
  const calls: { args: readonly string[]; stdin: string | undefined }[] = [];
  const run: SecretsRunner = (cmd, args, stdin) => {
    calls.push({ args: [...args], stdin });
    expect(cmd).toBe('/usr/bin/security');
    const account = (a: readonly string[]): string => a[a.indexOf('-a') + 1] as string;
    if (args[0] === '-i') {
      const m = /^add-generic-password -U -s jobpilot -a ([a-z0-9._-]+) -w "((?:[^"\\]|\\.)*)"\n$/.exec(stdin ?? '');
      if (m === null) return { status: 1, stdout: '', stderr: 'bad command' };
      items.set(m[1] as string, (m[2] as string).replace(/\\(.)/g, '$1'));
      return { status: 0, stdout: '', stderr: '' };
    }
    expect(args.slice(1, 3)).toEqual(['-s', 'jobpilot']);
    const name = account(args);
    if (args[0] === 'find-generic-password') {
      const v = items.get(name);
      if (v === undefined) return { status: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' };
      return { status: 0, stdout: args.includes('-w') ? `${v}\n` : `keychain: "login"\nclass: "genp"\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') return items.delete(name) ? { status: 0, stdout: '', stderr: 'password has been deleted.' } : { status: 44, stdout: '', stderr: 'not found' };
    return { status: 2, stdout: '', stderr: 'unknown' };
  };
  return Object.assign(run, { calls, items });
}

const req = (platform: GigRequest['platform'] = 'gmail', query = GMAIL_LABEL): GigRequest => ({ platform, query, runDate: '2026-10-12', half: 'am' });

interface Run {
  readonly gigs: readonly RawGig[];
  readonly skips: readonly string[];
}

const PACK = { naming: { forbiddenTerms: ['Initech'], employerDisplay: {} } };

async function runAgent(agent: Agent<GigRequest, RawGig>, fetch: FetchLike, r: GigRequest = req(), pack: unknown = PACK): Promise<Run> {
  const ctx = issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock: fixedClock('2026-10-12T00:00:00Z'),
    signal: new AbortController().signal,
    pack,
  });
  const gigs = await agent.run(r, ctx);
  return { gigs, skips: ctx.skips() };
}

const ok = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
const message = (id: string, eml: string) => ({ id, threadId: id, labelIds: ['Label_7'], raw: b64url(eml), internalDate: '1791792000000' });

const LABEL_ID = 'Label_7';
const gmailListUrl = (pageToken?: string): string => listUrl(LABEL_ID, pageToken);
const LABELS = { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_6', name: 'jobpilot/gigs-old', type: 'user' }, { id: LABEL_ID, name: GMAIL_LABEL, type: 'user' }] };

/** A fake Gmail: the token check, the label list, list pages and raw messages; anything else is a 404. */
function gmail(o: { pages?: { ids: string[]; next?: string }[]; mails?: Record<string, string>; labels?: unknown }): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const pages = o.pages ?? [{ ids: Object.keys(o.mails ?? {}) }];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    if (url === TOKEN_URL) return ok({ token: 'ready', expiresIn: 3599 });
    if (url === gmailLabelsUrl()) return ok(o.labels ?? LABELS);
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i] as { ids: string[]; next?: string };
      if (url === gmailListUrl(i === 0 ? undefined : `page${i}`)) {
        return ok({ ...(page.ids.length > 0 ? { messages: page.ids.map((id) => ({ id, threadId: id })) } : {}), ...(page.next !== undefined ? { nextPageToken: page.next } : {}), resultSizeEstimate: page.ids.length });
      }
    }
    for (const [id, eml] of Object.entries(o.mails ?? {})) if (url === gmailMessageUrl(id)) return ok(message(id, eml));
    return { status: 404, text: async () => '{"error":{"code":404}}' };
  };
  return Object.assign(fetch, { calls });
}

const agentWith = makeSrcGigMail([exampleBoardParser]);

describe('secrets: the macOS Keychain through /usr/bin/security', () => {
  it('reads, stores, tests and deletes through the runner; the value goes through stdin, never argv', () => {
    const sec = fakeSecurity();
    expect(getSecret('gmail.refresh', sec)).toBeUndefined();
    expect(hasSecret('gmail.refresh', sec)).toBe(false);
    setSecret('gmail.refresh', '1//0g-fake "quoted" \\ value', sec);
    expect(getSecret('gmail.refresh', sec)).toBe('1//0g-fake "quoted" \\ value');
    expect(hasSecret('gmail.refresh', sec)).toBe(true);
    expect(sec.calls.find((c) => c.args[0] === '-i')).toEqual({ args: ['-i'], stdin: 'add-generic-password -U -s jobpilot -a gmail.refresh -w "1//0g-fake \\"quoted\\" \\\\ value"\n' });
    expect(sec.calls.some((c) => c.args.some((a) => a.includes('fake')))).toBe(false);
    expect(sec.calls.find((c) => c.args[0] === 'find-generic-password' && c.args.includes('-w'))?.args).toEqual(['find-generic-password', '-s', 'jobpilot', '-a', 'gmail.refresh', '-w']);
    expect(deleteSecret('gmail.refresh', sec)).toBe(true);
    expect(deleteSecret('gmail.refresh', sec)).toBe(false);
    expect(getSecret('gmail.refresh', sec)).toBeUndefined();
  });

  it('refuses a bad name or a value with a line break; a failure never names the value', () => {
    const sec = fakeSecurity();
    expect(() => setSecret('Bad Name', 'x', sec)).toThrow(/name/);
    expect(() => setSecret('gmail.refresh', 'a\nb', sec)).toThrow(/control/);
    expect(() => setSecret('gmail.refresh', '', sec)).toThrow(/empty/);
    const failing: SecretsRunner = () => ({ status: 51, stdout: 'leaked-value', stderr: 'leaked-value' });
    expect(() => setSecret('gmail.refresh', 'leaked-value', failing)).toThrow(/exit 51/);
    try {
      setSecret('gmail.refresh', 'leaked-value', failing);
    } catch (e) {
      expect(String(e)).not.toContain('leaked-value');
    }
    expect(() => getSecret('gmail.refresh', failing)).toThrow(/exit 51/);
  });
});

describe('oauth: the installed-app flow with PKCE and a loopback redirect', () => {
  it('the consent URL asks for gmail.readonly only, with S256 PKCE and a state', () => {
    const pkce = newPkce();
    const url = new URL(authUrl({ clientId: 'client-123.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:53682/cb', pkce }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(GMAIL_SCOPE).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(url.searchParams.get('state')).toBe(pkce.state);
    expect(pkce.state.length).toBeGreaterThanOrEqual(22);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53682/cb');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(newPkce().state).not.toBe(pkce.state);
  });

  const hit = (url: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      request(url, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
        .on('error', reject)
        .end();
    });

  it('the loopback server refuses a reply with the wrong state, then takes the right one', async () => {
    const lb = await startLoopback('right-state', 10_000);
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/);
    let settled = false;
    void lb.code.then(() => (settled = true), () => (settled = true));
    const wrong = await hit(`${lb.redirectUri}?state=wrong-state&code=evil-code`);
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatch(/refused/);
    expect((await hit(lb.redirectUri.replace('/cb', '/other'))).status).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    const right = await hit(`${lb.redirectUri}?state=right-state&code=good-code`);
    expect(right.status).toBe(200);
    expect(right.body).toContain('You can close this tab');
    expect(await lb.code).toBe('good-code');
  });

  it('refuses a reply with a repeated state, code or error', async () => {
    const lb = await startLoopback('s0', 10_000);
    for (const q of ['state=s0&state=s0&code=c', 'state=s0&code=c1&code=c2', 'state=s0&code=c&error=x&error=y', 'state=x&state=s0&code=c']) {
      expect((await hit(`${lb.redirectUri}?${q}`)).status, q).toBe(400);
    }
    expect((await hit(`${lb.redirectUri}?state=s0&code=one`)).status).toBe(200);
    expect(await lb.code).toBe('one');
  });

  it('a Google error reply or no reply in time ends the wait', async () => {
    const lb = await startLoopback('s1', 10_000);
    const denied = expect(lb.code).rejects.toThrow(/access_denied/);
    await hit(`${lb.redirectUri}?state=s1&error=access_denied`);
    await denied;
    const slow = await startLoopback('s2', 50);
    await expect(slow.code).rejects.toThrow(/no reply from Google/);
  });

  it('exchanges the code at the token endpoint with the PKCE verifier (fake post)', async () => {
    const posts: { url: string; form: Record<string, string> }[] = [];
    const post: FormPost = async (url, form) => {
      posts.push({ url, form: { ...form } });
      return { status: 200, text: async () => JSON.stringify({ access_token: 'ya29.fake', expires_in: 3599, refresh_token: '1//fake-refresh', scope: GMAIL_SCOPE, token_type: 'Bearer' }) };
    };
    const got = await exchangeCode(post, { clientId: 'cid', clientSecret: 'csecret', code: 'the-code', redirectUri: 'http://127.0.0.1:1/cb', verifier: 'v'.repeat(43) });
    expect(got).toEqual({ refreshToken: '1//fake-refresh' });
    expect(posts).toEqual([
      { url: TOKEN_URL, form: { grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'http://127.0.0.1:1/cb', client_id: 'cid', client_secret: 'csecret', code_verifier: 'v'.repeat(43) } },
    ]);
    const wider: FormPost = async () => ({ status: 200, text: async () => JSON.stringify({ refresh_token: 'r', scope: `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.modify` }) });
    await expect(exchangeCode(wider, { clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u', verifier: 'v' })).rejects.toThrow(/only gmail.readonly/);
    const refused: FormPost = async () => ({ status: 400, text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }) });
    await expect(exchangeCode(refused, { clientId: 'c', clientSecret: 'csecret-xyz', code: 'x', redirectUri: 'u', verifier: 'v' })).rejects.toThrow(/invalid_grant/);
    const none: FormPost = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'a', scope: GMAIL_SCOPE }) });
    await expect(exchangeCode(none, { clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u', verifier: 'v' })).rejects.toThrow(/no refresh token/);
  });

  it('the real form post reaches only the token endpoint', async () => {
    await expect(realFormPost('https://gmail.googleapis.com/gmail/v1/users/me/messages', {})).rejects.toThrow(/only/);
  });
});

/** Every file under `dir`, with its text. */
function* files(dir: string): Generator<[string, string]> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield [p, readFileSync(p, 'latin1')];
  }
}

describe('jobpilot gmail connect, status and disconnect (all fakes)', () => {
  const PLANT = { id: 'planted-client-id-7f3a.apps.googleusercontent.com', secret: 'FAKE-OAUTH-SECRET-0123456789abcdef', refresh: '1//planted-refresh-token-4d8e', access: 'ya29.planted-access-token-b6' };

  async function connect(answer: string) {
    const home = tempHome();
    mkdirSync(join(home, 'secrets'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'logs'), { recursive: true });
    const json = join(home, 'secrets', 'google-oauth-client.json');
    writeFileSync(json, JSON.stringify({ installed: { client_id: PLANT.id, client_secret: PLANT.secret, redirect_uris: ['http://localhost'], auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token' } }), { mode: 0o600 });
    const sec = fakeSecurity();
    const out: string[] = [];
    const opened: string[] = [];
    const posts: Record<string, string>[] = [];
    await connectGmail({
      home,
      secrets: keychain(sec),
      post: async (_url, form) => {
        posts.push({ ...form });
        return { status: 200, text: async () => JSON.stringify({ access_token: PLANT.access, expires_in: 3599, refresh_token: PLANT.refresh, scope: GMAIL_SCOPE, token_type: 'Bearer' }) };
      },
      open: async (url) => {
        opened.push(url);
        const u = new URL(url);
        // The browser comes back to the loopback redirect with Google's code and the same state.
        await fetch(`${u.searchParams.get('redirect_uri')}?state=${u.searchParams.get('state')}&code=fake-auth-code`);
      },
      ask: async () => answer,
      out: (l) => out.push(l),
    });
    // The log a scheduled run writes would go here; write the CLI output into it as the real CLI would.
    writeFileSync(join(home, 'logs', 'connect.log'), `${out.join('\n')}\n`);
    return { home, json, sec, out, opened, posts };
  }

  it('stores the client and the refresh token in the Keychain only, and deletes the JSON when the user says y', async () => {
    const { home, json, sec, out, opened, posts } = await connect('y');
    expect(sec.items.get(SECRET.clientId)).toBe(PLANT.id);
    expect(sec.items.get(SECRET.clientSecret)).toBe(PLANT.secret);
    expect(sec.items.get(SECRET.refresh)).toBe(PLANT.refresh);
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0] as string).searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(posts[0]?.['code']).toBe('fake-auth-code');
    expect(existsSync(json)).toBe(false);
    // No planted value in any file of the home, in any line printed, or in any argv the Keychain runner saw.
    for (const [p, text] of files(home)) for (const v of Object.values(PLANT)) expect(text.includes(v), `${relative(home, p)} holds a secret`).toBe(false);
    for (const v of Object.values(PLANT)) {
      expect(out.join('\n')).not.toContain(v);
      expect(sec.calls.some((c) => c.args.some((a) => a.includes(v)))).toBe(false);
    }
    expect(out.join('\n')).toMatch(/connected/i);
    expect(gmailStatus({ home, secrets: keychain(sec) }).join('\n')).toMatch(/connected: yes[\s\S]*label: jobpilot\/gigs/);
    for (const v of Object.values(PLANT)) expect(gmailStatus({ home, secrets: keychain(sec) }).join('\n')).not.toContain(v);
  });

  it('keeps the JSON by default, and disconnect deletes every Keychain item', async () => {
    const { home, json, sec, out } = await connect('');
    expect(existsSync(json)).toBe(true);
    expect(out.join('\n')).toMatch(/kept/);
    expect(disconnectGmail({ home, secrets: keychain(sec) }).join('\n')).toMatch(/removed/);
    expect(sec.items.size).toBe(0);
    expect(gmailStatus({ home, secrets: keychain(sec) }).join('\n')).toMatch(/connected: no/);
  });

  it('the run access refreshes the token in memory, adds it only to Gmail reads, and never hands it to the agent', async () => {
    const sec = fakeSecurity();
    const s = keychain(sec);
    expect(gmailRunAccess(s).connected).toBe(false);
    s.set(SECRET.clientId, PLANT.id);
    s.set(SECRET.clientSecret, PLANT.secret);
    s.set(SECRET.refresh, PLANT.refresh);
    const forms: Record<string, string>[] = [];
    const access = gmailRunAccess(s, async (_u, form) => {
      forms.push({ ...form });
      return { status: 200, text: async () => JSON.stringify({ access_token: PLANT.access, expires_in: 3599, scope: GMAIL_SCOPE, token_type: 'Bearer' }) };
    });
    expect(access.connected).toBe(true);
    const seen: { url: string; headers: Readonly<Record<string, string>> }[] = [];
    const wrapped = access.wrap(async (url, init) => {
      seen.push({ url, headers: init.headers });
      return ok({ messages: [] });
    });
    const init = { signal: new AbortController().signal, redirect: 'manual' as const, headers: { 'user-agent': 'jobpilot/0.1 (+local)' } };
    const before = await wrapped(gmailListUrl(), init);
    expect(before.status).toBe(401);
    const token = await wrapped(TOKEN_URL, init);
    const body = await token.text();
    expect(token.status).toBe(200);
    expect(body).not.toContain(PLANT.access);
    expect(forms).toEqual([{ grant_type: 'refresh_token', refresh_token: PLANT.refresh, client_id: PLANT.id, client_secret: PLANT.secret }]);
    await wrapped(gmailListUrl(), init);
    await wrapped('https://remotive.com/api/remote-jobs?category=software-dev', init);
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${PLANT.access}`);
    expect(seen[1]?.headers['authorization']).toBeUndefined();
    await wrapped(gmailLabelsUrl(), init);
    expect(seen.at(-1)?.url).toBe(gmailLabelsUrl());
    await expect(wrapped(`https://${GMAIL_HOST}/gmail/v1/users/me/labels/Label_7`, init)).rejects.toThrow(/not a Gmail read/);
    await expect(wrapped(`https://${GMAIL_HOST}/gmail/v1/users/me/messages?labelIds=a%2Fb`, init)).rejects.toThrow(/not a Gmail read/);
    await expect(wrapped(`https://${GMAIL_HOST}/gmail/v1/users/me/messages/abc/attachments/x`, init)).rejects.toThrow(/not a Gmail read/);
  });
});

describe('mime: one raw alert email', () => {
  it('decodes headers, quoted-printable text and base64 html', () => {
    const m = parseMail(MSG_ID, EML, '1791792000000');
    expect(m.from).toBe(EXAMPLE_SENDER);
    expect(m.fromDomain).toBe('example-board.test');
    expect(m.subject).toBe('2 new contract jobs · TypeScript, Go');
    expect(m.receivedAt).toBe('2026-10-12T08:00:00.000Z');
    expect(m.text).toContain(EXAMPLE_FINGERPRINT);
    expect(m.text).toContain('with a long sentence that wraps past');
    expect(m.html).toContain('<h1>Example Board &middot; contract alerts digest</h1>');
  });
});

describe('src-gig-mail', () => {
  it('contract: io, platform gmail, egress the token endpoint and Gmail only, no model, no effect', () => {
    const c = srcGigMail.contract;
    expect(c.id).toBe('src-gig-mail');
    expect(c.kind).toBe('io');
    expect(c.team).toBe('sourcing');
    expect([...c.egress].sort()).toEqual([GMAIL_HOST, TOKEN_HOST].sort());
    expect(c.capabilities.llm).toBeUndefined();
    expect(c.description).not.toMatch(/\band\b/i);
    expect(PLATFORM_AGENT.gmail).toBe('src-gig-mail');
  });

  it('the fictional parser turns one message into one RawGig per job, ids <msgId>:<n>', async () => {
    const fetch = gmail({ mails: { [MSG_ID]: EML } });
    const { gigs, skips } = await runAgent(agentWith, fetch);
    expect(skips).toEqual([]);
    expect(fetch.calls).toEqual([TOKEN_URL, gmailLabelsUrl(), gmailListUrl(), gmailMessageUrl(MSG_ID)]);
    expect(gmailLabelsUrl()).toBe('https://gmail.googleapis.com/gmail/v1/users/me/labels');
    expect(gmailListUrl()).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=Label_7&q=newer_than%3A3d&maxResults=100');
    expect(gigs.map((g) => g.sourceId)).toEqual([`${MSG_ID}:1`, `${MSG_ID}:2`]);
    expect(gigs.every((g) => g.platform === 'gmail')).toBe(true);
    expect(gigs[0]?.raw).toEqual({
      title: 'Senior TypeScript Engineer (contract)', url: 'https://jobs.example-board.test/j/1001',
      description: 'Build a Node.js API for 15 hours per week over 8 weeks, with a long sentence that wraps past the quoted-printable line limit.',
      company: 'Fictional Widgets Ltd', location: 'Remote, worldwide', pay: '$55/hr', postedAt: null, kind: 'contract',
      messageId: MSG_ID, parser: 'example-board', sender: EXAMPLE_SENDER, receivedAt: '2026-10-12T08:00:00.000Z',
    });
    const gig = normalizeGig(gigs[0] as RawGig);
    expect(gig).toMatchObject({ platform: 'gmail', url: 'https://jobs.example-board.test/j/1001', title: 'Senior TypeScript Engineer (contract)', kind: 'contract' });
    expect(gig.budget).toMatchObject({ type: 'hourly', min: 55, max: 55, currency: 'USD' });
    expect(gig.hoursPerWeek).toEqual({ min: 15, max: 15, source: 'text' });
    expect(gig.client.name).toBe('Fictional Widgets Ltd');
    expect(normalizeGig(gigs[1] as RawGig).budget.type).toBe('unknown');
  });

  it('an altered fingerprint quarantines the whole message: skipped with a note, nothing parsed', async () => {
    // The heading changes in both parts: the text part (quoted-printable) and the HTML part (base64).
    const html = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(EML)?.[1] as string;
    const newHtml = Buffer.from(Buffer.from(html, 'base64').toString('utf8').replace('Example Board &middot; contract alerts digest', 'Example Board weekly roundup'), 'utf8').toString('base64');
    const altered = EML.replace('Example Board =C2=B7 contract alerts digest', 'Example Board weekly roundup').replace(html, newHtml);
    expect(altered).not.toBe(EML.replace('Example Board =C2=B7 contract alerts digest', 'Example Board weekly roundup'));
    const { gigs, skips } = await runAgent(agentWith, gmail({ mails: { [MSG_ID]: altered } }));
    expect(gigs).toEqual([]);
    expect(skips).toEqual(['1 unrecognised alert from example-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/']);
  });

  it('an unknown sender is quarantined the same way, and so is a message the parser refuses', async () => {
    const stranger = EML.replace('From: Example Board <alerts@example-board.test>', 'From: "Someone" <news@other-board.test>');
    const broken = EML.replace('Link: https://jobs.example-board.test/j/1002', 'Link: (see the website)');
    const { gigs, skips } = await runAgent(agentWith, gmail({ mails: { aaa1: stranger, bbb2: broken } }));
    expect(gigs).toEqual([]);
    expect(skips).toEqual([
      '1 unrecognised alert from example-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
      '1 unrecognised alert from other-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
    ]);
  });

  it('the shipped registry has no parser: every alert is quarantined, never guessed', async () => {
    expect(ALERT_PARSERS).toEqual([]);
    expect(parserProblems([exampleBoardParser])).toEqual([]);
    expect(parserProblems([exampleBoardParser, { ...exampleBoardParser, id: 'copy' }])).toEqual([`two parsers for ${EXAMPLE_SENDER} with the same fingerprint: example-board, copy`]);
    expect(parserProblems([{ ...exampleBoardParser, sender: 'Alerts@Example-Board.test' }])).toHaveLength(1);
    const { gigs, skips } = await runAgent(srcGigMail, gmail({ mails: { [MSG_ID]: EML } }));
    expect(gigs).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(selectParser(parseMail(MSG_ID, EML, null), [exampleBoardParser])).toBe(exampleBoardParser);
    expect(selectParser(parseMail(MSG_ID, EML, null), [])).toBeUndefined();
  });

  it('collapses unrecognised alerts to one note per sender domain, a forbidden domain hidden', async () => {
    const other = EML.replace('From: Example Board <alerts@example-board.test>', 'From: "Someone" <news@other-board.test>');
    const banned = EML.replace('From: Example Board <alerts@example-board.test>', 'From: jobs@initech.test');
    const { skips } = await runAgent(srcGigMail, gmail({ mails: { a1: EML, a2: EML, a3: EML, b1: other, b2: other, c1: banned } }));
    // In sender-domain order.
    expect(skips).toEqual([
      '1 unrecognised alert from [hidden] - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
      '3 unrecognised alerts from example-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
      '2 unrecognised alerts from other-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
    ]);
  });

  it('finds the label by its exact name and lists by its id; a missing label is a note, never 0 alerts', async () => {
    const missing = gmail({ mails: { [MSG_ID]: EML }, labels: { labels: [{ id: 'Label_6', name: 'jobpilot/gigs-old' }, { id: 'Label_9', name: 'JobPilot/Gigs' }] } });
    const r = await runAgent(agentWith, missing);
    expect(r.gigs).toEqual([]);
    expect(r.skips).toEqual([GMAIL_LABEL_MISSING]);
    expect(GMAIL_LABEL_MISSING).toBe('label jobpilot/gigs not found in Gmail - create it and a filter');
    expect(missing.calls).toEqual([TOKEN_URL, gmailLabelsUrl()]);
    const twice = gmail({ labels: { labels: [{ id: 'L1', name: GMAIL_LABEL }, { id: 'L2', name: GMAIL_LABEL }] } });
    await expect(runAgent(agentWith, twice)).rejects.toThrow(/more than one label/);
    const badId = gmail({ labels: { labels: [{ id: 'a/b', name: GMAIL_LABEL }] } });
    await expect(runAgent(agentWith, badId)).rejects.toThrow(/no valid id/);
  });

  it('reads every page of the list, and fails loudly above the cap instead of truncating', async () => {
    const paged = gmail({ pages: [{ ids: ['m1'], next: 'page1' }, { ids: ['m2'] }], mails: { m1: EML, m2: EML } });
    const { gigs } = await runAgent(agentWith, paged);
    expect(paged.calls).toEqual([TOKEN_URL, gmailLabelsUrl(), gmailListUrl(), gmailListUrl('page1'), gmailMessageUrl('m1'), gmailMessageUrl('m2')]);
    expect(gigs.map((g) => g.sourceId)).toEqual(['m1:1', 'm1:2', 'm2:1', 'm2:2']);
    const ids = (from: number) => Array.from({ length: 100 }, (_, i) => `x${from + i}`);
    const over = gmail({ pages: [{ ids: ids(0), next: 'page1' }, { ids: ids(100), next: 'page2' }, { ids: ids(200) }] });
    const err = await runAgent(agentWith, over).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as KernelError).code).toBe('invalid_output');
    expect((err as KernelError).message).toMatch(new RegExp(`more than ${GMAIL_MAX_MESSAGES} messages`));
    expect(over.calls.filter((u) => u.includes('format=raw'))).toEqual([]);
  });

  it('answers only its own platform and only the one label', async () => {
    const fetch = gmail({ mails: {} });
    expect((await runAgent(agentWith, fetch, req('freelancer', 'java'))).gigs).toEqual([]);
    expect(fetch.calls).toEqual([]);
    await expect(runAgent(agentWith, fetch, req('gmail', 'INBOX'))).rejects.toMatchObject({ code: 'input_rejected' });
  });

  it('a refused sign-in fails the step and says how to fix it', async () => {
    const fetch: FetchLike = async (url) => (url === TOKEN_URL ? { status: 401, text: async () => '{"error":"invalid_grant"}' } : { status: 404, text: async () => '' });
    await expect(runAgent(agentWith, fetch)).rejects.toThrow(/invalid_grant.*jobpilot gmail connect/);
  });
});

/** Gmail write calls, as literal paths, quoted method names or joined path parts. */
const WRITE_PATTERNS = [
  /batchModify/i, /batchDelete/i, /\/modify\b/, /\/trash\b/, /\/untrash\b/, /\/send\b/, /messages\.send/, /\/drafts\b/,
  /messages\/(?:import|insert)\b/, /\b(?:add|remove)LabelIds\b/, /['"`]UNREAD['"`]/, /gmail\.(?:modify|send|compose|insert|labels|metadata)\b/,
  /mail\.google\.com\//, /threads\/[^\s'"`]*\/(?:modify|trash)/, /['"`]trash['"`]/, /['"`](?:modify|send|untrash|batchModify|batchDelete)['"`]/,
];
const METHOD = /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/g;
/** The one request with a non-GET method anywhere in src/ outside the broker: realFormPost to the token endpoint. */
const ALLOWED_METHOD = { file: 'src/app/freelance/mail/oauth.ts', count: 1, near: 'export const realFormPost' };
/**
 * The broker's `postJson` (Task 6, Workday's CXS search): the kernel's one POST, issued only to a contract declaring
 * `capabilities.httpPost`, which the allow-list grants to the two Workday readers alone (asserted below), never to the
 * Gmail source.
 */
const BROKER_POST = { file: 'src/kernel/broker.ts', count: 1, near: 'const fetchBody = async' };

function writeHits(file: string, text: string): string[] {
  const hits = WRITE_PATTERNS.filter((re) => re.test(text)).map((re) => `${file}: ${re}`);
  const methods = [...text.matchAll(METHOD)];
  if (methods.length > 0) {
    const oauth = file === ALLOWED_METHOD.file && methods.length === ALLOWED_METHOD.count && text.lastIndexOf(ALLOWED_METHOD.near, methods[0]?.index) >= 0 && text.slice(text.lastIndexOf(ALLOWED_METHOD.near, methods[0]?.index), methods[0]?.index).includes('TOKEN_URL');
    const broker = file === BROKER_POST.file && methods.length === BROKER_POST.count && text.lastIndexOf(BROKER_POST.near, methods[0]?.index) >= 0 && text.includes("capabilities.httpPost !== true) throw deny(");
    if (!oauth && !broker) hits.push(`${file}: ${methods.length} non-GET method(s)`);
  }
  return hits;
}

describe('read-only: the broker POST is not the Gmail source\'s', () => {
  it('only the Workday readers may POST; the Gmail source and every other agent read by GET only', () => {
    expect(CAPABILITY_ALLOW_LIST.httpPost).toEqual(['src-workday', 'board-verifier']);
    for (const a of exportedAgents) if (a.contract.capabilities.httpPost === true) expect(CAPABILITY_ALLOW_LIST.httpPost, a.contract.id).toContain(a.contract.id);
    expect(exportedAgents.find((a) => a.contract.id === 'src-gig-mail')?.contract.capabilities.httpPost).toBeUndefined();
  });
});

describe('read-only: no Gmail write endpoint anywhere in src/', () => {
  it('finds no modify, trash, delete, send, draft, import or label-change call, and no non-GET but the token POST', () => {
    const hits: string[] = [];
    for (const [p, text] of files(join(root, 'src'))) hits.push(...writeHits(relative(root, p), text));
    expect(hits).toEqual([]);
  });

  it('catches planted write calls: a joined path, a quoted method name, a DELETE, a second POST', () => {
    const oauth = readFileSync(join(root, ALLOWED_METHOD.file), 'utf8');
    expect(writeHits(ALLOWED_METHOD.file, oauth)).toEqual([]);
    expect(writeHits('src/x.ts', "const u = [GMAIL_API, 'messages', id, 'trash'].join('/');")).not.toEqual([]);
    expect(writeHits('src/x.ts', 'const u = `${GMAIL_API}/messages/${id}` + `/modify`;')).not.toEqual([]);
    expect(writeHits('src/x.ts', "call(id, 'batchModify')")).not.toEqual([]);
    expect(writeHits('src/x.ts', "await fetch(u, { method: 'DELETE' })")).not.toEqual([]);
    expect(writeHits(ALLOWED_METHOD.file, `${oauth}\nawait fetch(gmailUrl, { method: 'POST' });\n`)).not.toEqual([]);
  });
});

describe('not connected: the source is disabled, never failed', () => {
  const rules = FreelanceFile.parse({});
  it('seeds gmail only when connected', () => {
    expect(freelanceSeeds(rules, '2026-10-12', 'am', []).some((s) => s.platform === 'gmail')).toBe(false);
    expect(freelanceSeeds(rules, '2026-10-12', 'am', [], { gmailConnected: true }).filter((s) => s.platform === 'gmail')).toEqual([{ platform: 'gmail', query: GMAIL_LABEL, runDate: '2026-10-12', half: 'am' }]);
    const off = FreelanceFile.parse({ platforms: { gmail: { enabled: false } } });
    expect(freelanceSeeds(off, '2026-10-12', 'am', [], { gmailConnected: true }).some((s) => s.platform === 'gmail')).toBe(false);
  });

  const onlyGmail = (home: string): void => {
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    const off = { enabled: false, queries: [] };
    writeFileSync(join(home, 'pack', 'freelance.yaml'), `${JSON.stringify({ platforms: { freelancer: off, remotive: off, 'hn-freelancer': off, 'hn-hiring': off, boards: off, himalayas: off, gmail: { enabled: true, queries: [] } } })}\n`);
  };
  const connectedTo = (fake: FetchLike): (() => GmailRunAccess) => () => ({ connected: true, reason: null, wrap: () => fake });
  const noNet: FetchLike = async () => {
    throw new Error('no network in this test');
  };

  it('a run without a connection names the reason, fetches nothing and exits 0', async () => {
    const home = tempHome();
    onlyGmail(home);
    const s = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: noNet, sleep: async () => {}, pdftotext: '/usr/bin/false' });
    expect(s.exitCode).toBe(0);
    expect(s.warnings).toContain(GMAIL_NOT_CONNECTED);
    expect(GMAIL_NOT_CONNECTED).toBe('Gmail not connected - run jobpilot gmail connect');
    expect(s.counts.byAgent['src-gig-mail']?.failed ?? 0).toBe(0);
    expect(s.problems).toEqual([]);
  });

  it('a connected run lists each unrecognised alert as a problem, not a failure', async () => {
    const home = tempHome();
    onlyGmail(home);
    const fake = gmail({ mails: { [MSG_ID]: EML } });
    const s = await runFreelance({
      home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: noNet, sleep: async () => {}, pdftotext: '/usr/bin/false',
      gmail: connectedTo(fake),
    });
    expect(s.exitCode).toBe(0);
    expect(s.problems).toEqual([{ kind: 'mail-quarantined', agent: 'src-gig-mail', item: 'gmail alert', reason: '1 unrecognised alert from example-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/' }]);
    expect(s.warnings.join('\n')).not.toMatch(/skipped by src-gig-mail/);
  });

  it('5 unrecognised alerts from 2 domains are 2 problem lines', async () => {
    const home = tempHome();
    onlyGmail(home);
    const other = EML.replace('From: Example Board <alerts@example-board.test>', 'From: news@other-board.test');
    const fake = gmail({ mails: { a1: EML, a2: EML, a3: EML, b1: other, b2: other } });
    const s = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: noNet, sleep: async () => {}, pdftotext: '/usr/bin/false', gmail: connectedTo(fake) });
    expect(s.problems.map((p) => p.reason)).toEqual([
      '3 unrecognised alerts from example-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
      '2 unrecognised alerts from other-board.test - save one as .eml in ~/.jobpilot/secrets/alert-samples/',
    ]);
  });

  it('4 weeks of runs where no parser read anything never make Gmail look dead', async () => {
    const home = tempHome();
    onlyGmail(home);
    const fake = gmail({ mails: { [MSG_ID]: EML } });
    const runIds: string[] = [];
    for (const day of ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']) {
      const s = await runFreelance({ home, clock: { now: () => `${day}T03:00:00.000Z` }, fetch: noNet, sleep: async () => {}, pdftotext: '/usr/bin/false', gmail: connectedTo(fake) });
      expect(s.problems.filter((p) => p.kind === 'source-dead')).toEqual([]);
      runIds.push(s.runId);
    }
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.sourceHealth('gmail')).toEqual([]);
      for (const id of runIds) expect(app.sourceRunNotes(id)).toEqual(['gmail:no-parser']);
    } finally {
      app.close();
    }
  });

  it('a missing label is a warning: the run fetches no message, lists no problem and exits 0', async () => {
    const home = tempHome();
    onlyGmail(home);
    const fake = gmail({ mails: { [MSG_ID]: EML }, labels: { labels: [] } });
    const s = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: noNet, sleep: async () => {}, pdftotext: '/usr/bin/false', gmail: connectedTo(fake) });
    expect(s.exitCode).toBe(0);
    expect(s.warnings).toContain(GMAIL_LABEL_MISSING);
    expect(s.problems).toEqual([]);
    expect(fake.calls.some((u) => u.includes('/messages'))).toBe(false);
  });

  it('a Keychain error (exit 36) skips Gmail with a warning; the other sources run and the run exits 0', async () => {
    const home = tempHome();
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    const off = { enabled: false, queries: [] };
    writeFileSync(join(home, 'pack', 'freelance.yaml'), `${JSON.stringify({ platforms: { freelancer: off, remotive: { enabled: true, queries: [] }, 'hn-freelancer': off, 'hn-hiring': off, boards: off, himalayas: off, gmail: { enabled: true, queries: [] } } })}\n`);
    const locked: SecretsRunner = () => ({ status: 36, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' });
    const fetched: string[] = [];
    const fetch: FetchLike = async (url) => {
      fetched.push(url);
      return url === REMOTIVE_URL ? ok({ jobs: [] }) : { status: 404, text: async () => '' };
    };
    const s = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch, sleep: async () => {}, pdftotext: '/usr/bin/false', gmail: () => gmailRunAccess(keychain(locked)) });
    expect(s.exitCode).toBe(0);
    expect(s.warnings).toContain('Keychain could not be read (security exit 36); Gmail skipped');
    expect(fetched).toEqual([REMOTIVE_URL]);
    expect(s.counts.byAgent['src-remotive']?.done).toBe(1);
    expect(s.problems).toEqual([]);
  });

  it('with gmail turned off the Keychain is never asked', async () => {
    const home = tempHome();
    onlyGmail(home);
    writeFileSync(join(home, 'pack', 'freelance.yaml'), `${JSON.stringify({ platforms: { freelancer: { enabled: false, queries: [] }, remotive: { enabled: false, queries: [] }, 'hn-freelancer': { enabled: false, queries: [] }, 'hn-hiring': { enabled: false, queries: [] }, boards: { enabled: false, queries: [] }, himalayas: { enabled: false, queries: [] }, gmail: { enabled: false, queries: [] } } })}\n`);
    let asked = 0;
    const s = await runFreelance({ home, clock: { now: () => '2026-10-12T03:00:00.000Z' }, fetch: noNet, sleep: async () => {}, pdftotext: '/usr/bin/false', gmail: () => (asked++, gmailRunAccess(keychain(() => ({ status: 36, stdout: '', stderr: '' })))) });
    expect(asked).toBe(0);
    expect(s.exitCode).toBe(0);
    expect(s.warnings.join('\n')).not.toMatch(/Gmail/);
  });
});
