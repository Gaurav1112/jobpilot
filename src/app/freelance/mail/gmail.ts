import { z } from 'zod';
import { defineAgent, type AgentContext } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { finishGigs, isRecord } from '../sources/common.js';
import { GigRequest, RawGig } from '../types.js';
import { GMAIL_API, GMAIL_HOST, GMAIL_LABEL, TOKEN_HOST, TOKEN_URL } from './google.js';
import { base64Binary, parseMail, type MailMessage } from './mime.js';
import { ALERT_PARSERS, AlertJob, selectParser, unrecognisedNote, type AlertParser } from './parsers/index.js';

export { GMAIL_LABEL } from './google.js';

/**
 * `src-gig-mail` (spec §4.3, Task 13): the user's own alert emails under ONE Gmail label, read-only.
 *
 * One GigRequest `{platform: 'gmail', query: GMAIL_LABEL}` per run (seeded only when Gmail is connected). Steps:
 * 1. `GET TOKEN_URL`: the run's authorised fetch (`gmailRunAccess`) refreshes the access token from the Keychain's
 *    refresh token, in memory; the agent sees only "ready" or Google's error code (then the step fails, naming the fix).
 * 2. The message list `q=label:jobpilot/gigs newer_than:3d`, GMAIL_PAGE_SIZE a page, every page read. More than
 *    GMAIL_MAX_MESSAGES messages fails the step (`invalid_output`) before any message is fetched: never a silent cut.
 * 3. Each message, in id order, with `format=raw`, parsed (`mime.ts`), and given to the one parser its sender and
 *    layout fingerprint select (`parsers/index.ts`). That parser's jobs become one RawGig each, sourceId
 *    `<message id>:<n>` (n from 1, in the email's order). A message nothing recognises, or that its parser refuses,
 *    is quarantined whole: `ctx.skipped('unrecognised alert: <sender domain> "<subject redacted>"')`, which the run
 *    lists as a problem. A message gone between list and fetch (404) is skipped with a note.
 *
 * Only GETs leave this agent (the broker makes no other kind) and only to the list and message paths: the authorised
 * fetch refuses any other Gmail path. Nothing is ever changed in the mailbox, and no message is marked read.
 * `raw` keeps the parser's fields plus `messageId, parser, sender, receivedAt`; the email body itself is not kept.
 * The pack is read for `naming.forbiddenTerms` only (the subject redaction).
 */
export const GMAIL_QUERY = `label:${GMAIL_LABEL} newer_than:3d`;
export const GMAIL_PAGE_SIZE = 100;
export const GMAIL_MAX_MESSAGES = 200;
const MAX_PAGES = Math.ceil(GMAIL_MAX_MESSAGES / GMAIL_PAGE_SIZE) + 1;
/** The token check, every list page and every message: the most requests one step makes. */
export const GMAIL_MAX_REQUESTS = 1 + MAX_PAGES + GMAIL_MAX_MESSAGES;
/** 20 minutes: GMAIL_MAX_REQUESTS paced requests at up to GMAIL_MAX_INTERVAL_MS each, with room for the responses. */
export const GMAIL_TIMEOUT_MS = 1_200_000;
export const GMAIL_MAX_INTERVAL_MS = Math.floor((GMAIL_TIMEOUT_MS * 0.75) / GMAIL_MAX_REQUESTS);

export const gmailListUrl = (pageToken?: string): string =>
  `${GMAIL_API}/messages?q=${encodeURIComponent(GMAIL_QUERY)}&maxResults=${GMAIL_PAGE_SIZE}${pageToken === undefined ? '' : `&pageToken=${encodeURIComponent(pageToken)}`}`;
export const gmailMessageUrl = (id: string): string => `${GMAIL_API}/messages/${id}?format=raw`;

const MESSAGE_ID = /^[A-Za-z0-9]{1,64}$/;
const NamingView = z.object({ naming: z.object({ forbiddenTerms: z.array(z.string()) }) });

const fail = (why: string): KernelError => new KernelError('invalid_output', `gmail: ${why}`);
const errorOf = (json: unknown): string => {
  const e = isRecord(json) ? json.error : undefined;
  const code = typeof e === 'string' ? e : isRecord(e) && typeof e.status === 'string' ? e.status : undefined;
  return code !== undefined && /^[A-Za-z_ ]{1,40}$/.test(code) ? code : 'no detail';
};

async function messageIds(ctx: AgentContext): Promise<string[]> {
  const http = ctx.http as NonNullable<AgentContext['http']>;
  const ids: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { status, json } = await http.getJson(gmailListUrl(token));
    if (status !== 200) throw fail(`the message list answered ${status} (${errorOf(json)})`);
    if (!isRecord(json)) throw fail('the message list is not an object');
    const messages = json.messages ?? [];
    if (!Array.isArray(messages)) throw fail('the message list has no messages array');
    for (const m of messages) {
      const id = isRecord(m) && typeof m.id === 'string' && MESSAGE_ID.test(m.id) ? m.id : undefined;
      if (id === undefined) throw fail('the message list holds an entry without a valid id');
      ids.push(id);
    }
    const next = typeof json.nextPageToken === 'string' && json.nextPageToken !== '' ? json.nextPageToken : undefined;
    if (ids.length > GMAIL_MAX_MESSAGES || (next !== undefined && ids.length >= GMAIL_MAX_MESSAGES)) {
      throw fail(`more than ${GMAIL_MAX_MESSAGES} messages match ${GMAIL_QUERY}; refusing to read a cut list (narrow the Gmail filters)`);
    }
    if (next === undefined) return [...new Set(ids)].sort();
    token = next;
  }
  throw fail(`the message list did not end within ${MAX_PAGES} pages`);
}

/** The jobs of one message and the parser that read them, or the quarantine note. */
function jobsOf(mail: MailMessage, parsers: readonly AlertParser[], terms: readonly string[]): { jobs: AlertJob[]; parser: AlertParser } | { note: string } {
  const parser = selectParser(mail, parsers);
  if (parser === undefined) return { note: unrecognisedNote(mail, terms) };
  let out: readonly unknown[];
  try {
    out = parser.parse(mail);
  } catch {
    return { note: unrecognisedNote(mail, terms, parser.id) };
  }
  const jobs: AlertJob[] = [];
  for (const j of out) {
    const p = AlertJob.safeParse(j);
    if (!p.success) return { note: unrecognisedNote(mail, terms, parser.id) };
    jobs.push(p.data);
  }
  return jobs.length === 0 ? { note: unrecognisedNote(mail, terms, parser.id) } : { jobs, parser };
}

/** Builds `src-gig-mail` over a parser registry; the shipped agent uses ALERT_PARSERS, tests pass their own. */
export function makeSrcGigMail(parsers: readonly AlertParser[] = ALERT_PARSERS) {
  const contract = defineContract({
    id: 'src-gig-mail',
    version: '1.0.0',
    description: 'Reads gig alert emails under one Gmail label, read-only',
    skills: ['gig-sourcing'],
    team: 'sourcing',
    kind: 'io',
    consumes: GigRequest,
    produces: RawGig,
    capabilities: { http: true, pack: true },
    egress: [TOKEN_HOST, GMAIL_HOST],
    dataClasses: { in: ['P0'], out: ['P0'] },
    budget: { usdPerCall: 0, usdPerRun: 0 },
    timeoutMs: GMAIL_TIMEOUT_MS,
    // A timeout is not retried: a second pass would take as long again.
    retry: { max: 2, on: ['rate_limit', 'overloaded', 'network'], backoffMs: [2000, 8000] },
  });
  return defineAgent(contract, async (req, ctx) => {
    if (req.platform !== 'gmail') return [];
    if (req.query !== GMAIL_LABEL) throw new KernelError('input_rejected', `gmail: only the label ${GMAIL_LABEL} is read, not ${JSON.stringify(req.query)}`);
    const http = ctx.http;
    if (http === undefined) throw new KernelError('policy_denied', 'gmail: no http capability');
    const view = NamingView.safeParse(ctx.pack);
    if (!view.success) throw fail('the pack has no naming rules, so subjects cannot be redacted');
    const terms = view.data.naming.forbiddenTerms;

    // getText, not getJson: a refusal (401) carries Google's error code in its body.
    const signIn = await http.getText(TOKEN_URL);
    let answer: unknown;
    try {
      answer = JSON.parse(signIn.body);
    } catch {
      answer = undefined;
    }
    if (signIn.status !== 200 || !isRecord(answer) || answer.token !== 'ready') {
      throw fail(`Google refused the stored sign-in (${errorOf(answer)}); run jobpilot gmail connect again`);
    }

    const gigs: RawGig[] = [];
    const skipped: string[] = [];
    for (const id of await messageIds(ctx)) {
      const { status, json } = await http.getJson(gmailMessageUrl(id));
      if (status === 404) {
        skipped.push(`gmail message ${id}: gone before it was read`);
        continue;
      }
      if (status !== 200) throw fail(`message ${id} answered ${status} (${errorOf(json)})`);
      if (!isRecord(json) || typeof json.raw !== 'string') throw fail(`message ${id} has no raw body`);
      const internalDate = typeof json.internalDate === 'string' ? json.internalDate : null;
      const mail = parseMail(id, base64Binary(json.raw), internalDate);
      const got = jobsOf(mail, parsers, terms);
      if ('note' in got) {
        skipped.push(got.note);
        continue;
      }
      got.jobs.forEach((job, i) => {
        gigs.push({ platform: 'gmail', sourceId: `${id}:${i + 1}`, raw: { ...job, messageId: id, parser: got.parser.id, sender: mail.from, receivedAt: mail.receivedAt } });
      });
    }
    if (skipped.length > 0) ctx.skipped(skipped);
    return finishGigs(gigs);
  });
}

export const srcGigMail = makeSrcGigMail();
