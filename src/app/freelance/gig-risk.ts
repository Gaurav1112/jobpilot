import { defineAgent } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { GigVerdict, RiskedGig } from './types.js';

/**
 * Gig risk: fixed red-flag rules on one verdict. A flag is a warning for the reader; it never changes the verdict,
 * its reasons or its notes, and a rejected gig is flagged like any other. The flag's `detail` is fixed text, never an
 * excerpt of the post, so nothing a post says (a forbidden term, a phone number) is repeated.
 *
 * Like the eligibility rules these are allow-lists of confirming wording: a messenger counts as an off-platform
 * contact when the post asks to be contacted there ("contact me on WhatsApp", "my Skype: ...", "join our Telegram group"),
 * not when the product is a Telegram bot; a coin counts as unusual payment next to a payment word ("paid in USDT"),
 * not as a project topic ("a crypto dashboard").
 *
 * - `payment-unverified`: the client's payment method is stated as not verified (`client.paymentVerified === false`).
 * - `off-platform`: asks to continue contact or payment outside the platform.
 * - `unusual-payment`: crypto, gift cards or a money-transfer service as the way to pay.
 * - `upfront-fee`: a registration, joining, security (and similar) fee, or "pay us first"; a negated fee ("no registration fee") is not one.
 * - `unpaid-test`: a free or unpaid test, trial or sample, or a test task estimated above 2 hours with no mention of pay.
 * - `thin-brief`: no client history (no reviews, spend, hire rate or join date, or `reviews === 0`) and a description
 *   under 300 characters.
 * - `duplicate-text` is set by the projector (same description, different client, same run). This agent never sets it.
 */

type Flag = RiskedGig['flags'][number];

const DETAIL: Readonly<Record<string, string>> = {
  'payment-unverified': 'the client payment method is not verified',
  'off-platform': 'asks to continue contact or payment outside the platform',
  'unusual-payment': 'names crypto, gift cards or a money transfer as the way to pay',
  'upfront-fee': 'asks the freelancer to pay a fee first',
  'unpaid-test': 'asks for free or long unpaid test work',
  'thin-brief': 'no client history and a very short description',
};

const MESSENGER = '(?:whats\\s?app|telegram|skype|signal)';
const OFF_PLATFORM = new RegExp(
  [
    `\\b(?:contact|reach|message|text|dm|add|ping|call|chat with|talk to|write to|email|mail)\\s+(?:me|us)\\b[^.;\\n]{0,40}?\\b${MESSENGER}\\b`,
    `\\b(?:my|our)\\s+${MESSENGER}\\s*(?:(?:id|handle|username)?\\s*:\\s*\\S|is\\s+\\+?\\d)`,
    '\\b(?:whats\\s?app|telegram|skype)\\s*(?:me\\b|(?:id|handle|username)?\\s*:\\s*\\S|@\\w)',
    '\\b(?:join|add|follow|enter)\\b[^.;\\n]{0,25}?\\b(?:whats\\s?app|telegram|signal)\\s+(?:group|channel|chat|community)\\b',
    '\\boutside (?:of )?(?:the )?(?:platform|freelancer(?:\\.com)?|site)\\b',
    '\\boff[- ]platform\\b',
    '[\\w.+-]+@gmail\\.com\\b',
  ].join('|'),
  'i',
);

const COIN = '(?:crypto(?:currency|currencies)?|usdt|usdc|bitcoin|btc|ethereum|eth|gift\\s?cards?)';
const UNUSUAL_PAYMENT = new RegExp(
  [
    `\\b(?:pa(?:y|id|ying|yments?|youts?)|compensat\\w*|remunerat\\w*|salary|reward\\w*|settle\\w*)\\b[^.;\\n]{0,12}?\\b(?:in|via|by|through|with|using|as)\\s+(?:the\\s+)?${COIN}\\b`,
    `\\b${COIN}\\s+(?:payments?|payouts?)\\s+only\\b`,
    '\\bwestern\\s?union\\b|\\bmoney\\s?gram\\b',
  ].join('|'),
  'i',
);

const FEE = /\b(?:registration|joining|security|training|verification|onboarding|activation)\s+fees?\b|\bpay\s+(?:us|a fee)\s+(?:first|upfront|up front)\b/gi;
const NEGATED = /\b(?:no|without|zero|never)\s+(?:any\s+)?(?:\w+\s+){0,2}$/i;

const FREE_TEST = /\b(?:unpaid|free)\s+(?:test|trial|sample)\b|\b(?:test|trial|sample)\s+(?:task|project|assignment|work)\b[^.;\n]{0,40}\b(?:unpaid|for free|free of charge|without (?:pay|payment|compensation))/i;
const TEST_THEN_TIME = /\b(?:test|trial|sample)\s+(?:task|project|assignment)\b[^.;\n]{0,60}?(\d+(?:\.\d+)?)(?:\s?-\s?(\d+(?:\.\d+)?))?\s?(hours?|hrs?|h|days?)\b/gi;
const TIME_THEN_TEST = /(\d+(?:\.\d+)?)()[\s-]?(hours?|hrs?|h|days?)[\s-]+(?:long\s+)?(?:test|trial|sample)\b/gi;
const PAID = /(?<!un)\bpaid\b/i;
const MAX_TEST_HOURS = 2;
const THIN_CHARS = 300;

function sentenceAt(text: string, at: number): string {
  const lo = Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('\n', at));
  const rest = text.slice(at);
  const hi = rest.search(/[.!?]\s|\n/);
  return text.slice(lo + 1, hi === -1 ? text.length : at + hi + 1);
}

function longUnpaidTest(text: string): boolean {
  for (const re of [TEST_THEN_TIME, TIME_THEN_TEST]) {
    for (const m of text.matchAll(re)) {
      const hi = Number(m[2] !== undefined && m[2] !== '' ? m[2] : m[1]);
      const hours = /^d/i.test(m[3] as string) ? hi * 8 : hi;
      if (hours > MAX_TEST_HOURS && !PAID.test(sentenceAt(text, m.index ?? 0))) return true;
    }
  }
  return false;
}

function upfrontFee(text: string): boolean {
  for (const m of text.matchAll(FEE)) {
    const at = m.index ?? 0;
    if (!NEGATED.test(text.slice(Math.max(0, at - 25), at))) return true;
  }
  return false;
}

/** The flags for one verdict, sorted by id. Pure. */
export function riskFlags(v: GigVerdict): Flag[] {
  const g = v.rated.gig;
  const text = `${g.title}\n${g.description}`;
  const c = g.client;
  const ids: string[] = [];
  if (c.paymentVerified === false) ids.push('payment-unverified');
  if (OFF_PLATFORM.test(text)) ids.push('off-platform');
  if (UNUSUAL_PAYMENT.test(text)) ids.push('unusual-payment');
  if (upfrontFee(text)) ids.push('upfront-fee');
  if (FREE_TEST.test(text) || longUnpaidTest(text)) ids.push('unpaid-test');
  const noHistory = (c.hireRate === null && c.spendUsd === null && c.reviews === null && c.since === null) || c.reviews === 0;
  if (noHistory && g.description.trim().length < THIN_CHARS) ids.push('thin-brief');
  return ids.sort().map((id) => ({ id, detail: DETAIL[id] as string }));
}

export const gigRiskContract = defineContract({
  id: 'gig-risk',
  version: '1.0.0',
  description: 'Flags payment or scam risk signals on one gig',
  skills: ['gig-risk-flags'],
  team: 'evaluation',
  kind: 'deterministic',
  consumes: GigVerdict,
  produces: RiskedGig,
  // The rules are fixed; the pack is declared so the flags can later follow the same pack hash as the verdicts.
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
});

export const gigRisk = defineAgent(gigRiskContract, async (verdict) => [{ verdict, flags: riskFlags(verdict) }]);
