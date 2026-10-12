import { z } from 'zod';
import { redactText } from '../../../pack/rules.js';
import { htmlToText } from '../../../text/html.js';
import type { MailMessage } from '../mime.js';

/**
 * The per-sender alert parsers (spec §4.3, Task 13). A parser is chosen by the message's `From` address (exact,
 * lower-case) AND its layout fingerprint: a stable heading or footer string taken from a real sample email, found in
 * the text part or in the text of the HTML part. A message with no parser for its sender, or whose fingerprint is
 * missing, or that the chosen parser refuses (it throws, returns no job or a job that fails `AlertJob`), is
 * quarantined whole: never partly read, no generic fallback.
 *
 * **Real-platform parsers are built only from real samples.** The user drops one alert `.eml` per sender in
 * `~/.jobpilot/secrets/alert-samples/`; a parser is then written in `parsers/<sender>.ts`, tested against that sample
 * (with the user's own name, email and phone redacted to the fixture pack's), and listed in ALERT_PARSERS. This build
 * has none, so every alert is quarantined until then. (The tests use a fictional parser of their own.)
 */

/** One job as a parser reads it from an alert. Every value the email does not state is null; nothing is guessed. */
export const AlertJob = z.strictObject({
  title: z.string().trim().min(1),
  /** The job's own page as the email links it; https only. */
  url: z.url({ protocol: /^https$/ }),
  /** Plain text: the email's summary of the job, or "". */
  description: z.string(),
  company: z.string().min(1).nullable(),
  location: z.string().min(1).nullable(),
  /** The pay as the email states it ("$55/hr"), read by the gig normalizer's pay rule; null when not stated. */
  pay: z.string().min(1).nullable(),
  postedAt: z.string().min(1).nullable(),
  kind: z.enum(['contract', 'gig', 'network-alert']),
});
export type AlertJob = z.infer<typeof AlertJob>;

export interface AlertParser {
  /** Stable id, the file name under parsers/ (`<id>.ts`). */
  readonly id: string;
  /** The exact `From` address, lower-case. */
  readonly sender: string;
  /** A stable heading or footer string from the sample email. */
  readonly fingerprint: string;
  /** The jobs in the email, in document order. Throws on anything it does not recognise. */
  parse(mail: MailMessage): readonly AlertJob[];
}

/** The registered real-platform parsers. Empty: none has been built from a real sample yet. */
export const ALERT_PARSERS: readonly AlertParser[] = [];

const MIN_FINGERPRINT = 12;

/** Registry problems: a sender not lower-case, a fingerprint too short to be a layout, two parsers for one layout. */
export function parserProblems(parsers: readonly AlertParser[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const p of parsers) {
    if (p.sender !== p.sender.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+$/.test(p.sender)) problems.push(`${p.id}: sender ${JSON.stringify(p.sender)} is not one lower-case address`);
    if (p.fingerprint.trim().length < MIN_FINGERPRINT) problems.push(`${p.id}: fingerprint is shorter than ${MIN_FINGERPRINT} characters`);
    const key = `${p.sender}\u0000${p.fingerprint}`;
    const other = seen.get(key);
    if (other !== undefined) problems.push(`two parsers for ${p.sender} with the same fingerprint: ${other}, ${p.id}`);
    else seen.set(key, p.id);
  }
  return problems;
}

/** The one parser for this sender whose fingerprint the message carries, or undefined (none, or more than one). */
export function selectParser(mail: MailMessage, parsers: readonly AlertParser[] = ALERT_PARSERS): AlertParser | undefined {
  const mine = parsers.filter((p) => p.sender === mail.from);
  if (mine.length === 0) return undefined;
  const bodies = [mail.text ?? '', mail.html === null ? '' : htmlToText(mail.html)];
  const hits = mine.filter((p) => bodies.some((b) => b.includes(p.fingerprint)));
  return hits.length === 1 ? hits[0] : undefined;
}

export const SUBJECT_MAX = 60;

/** A subject safe for a problem line: one line, forbidden terms as `[hidden]`, `"` as `'`, cut at SUBJECT_MAX characters. */
export function redactSubject(subject: string, forbiddenTerms: readonly string[]): string {
  const line = subject.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/"/g, "'");
  const safe = redactText(line, { forbiddenTerms: [...forbiddenTerms] });
  const cps = [...safe];
  return cps.length <= SUBJECT_MAX ? safe : `${cps.slice(0, SUBJECT_MAX).join('')}…`;
}

/** The quarantine note for a message: `unrecognised alert: <sender domain> "<subject redacted>"`, plus why when a parser refused it. */
export function unrecognisedNote(mail: Pick<MailMessage, 'fromDomain' | 'subject'>, forbiddenTerms: readonly string[], refusedBy?: string): string {
  const domain = redactText(mail.fromDomain, { forbiddenTerms: [...forbiddenTerms] });
  return `unrecognised alert: ${domain} "${redactSubject(mail.subject, forbiddenTerms)}"${refusedBy === undefined ? '' : ` (parser ${refusedBy} refused it)`}`;
}

export const UNRECOGNISED_PREFIX = 'unrecognised alert: ';
