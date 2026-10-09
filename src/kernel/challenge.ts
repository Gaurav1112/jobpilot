/**
 * The challenge stop (G-NO-EVASION): decides whether a document is a CAPTCHA or bot wall. A challenged render
 * fails with `challenged`, which is never retried; jobpilot stops, it does not try to get past the wall.
 *
 * The browser provider applies this to the raw document response *before* the page is allowed to run (so no
 * challenge script executes or re-requests the page), and the broker applies it again to the rendered page.
 * A challenge is any of:
 *   A. status 403 or 429;
 *   B. a bot-vendor header on the document: `cf-mitigated: challenge`, `server: DataDome` or any `x-datadome*`,
 *      `x-px-blocked`, `x-amzn-waf-action: captcha|challenge`;
 *   C. a vendor interstitial marker in the document (markers of the wall itself, not of widgets or of the passive
 *      scripts the same vendors inject into ordinary pages);
 *   D. the `<title>` or first `<h1>` worded as a wall ("Just a moment", "Attention required", "Access denied",
 *      "Are you a robot", "Verify you are human", "Security check", "Pardon our interruption");
 *   E. the word captcha in the visible text, only on a short page (< 2 KB of text) with no JobPosting JSON-LD and
 *      no form holding two or more inputs: a CAPTCHA widget inside an apply form is never a challenge.
 */

export interface ChallengeInput {
  readonly status: number;
  /** Response headers of the document, any case. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly html: string;
}

const VENDOR_MARKERS =
  /_cf_chl_opt|\/cdn-cgi\/challenge-platform\/h\/[a-z]\/orchestrate\/|id=["']?challenge-(form|running|stage)|cf-browser-verification|captcha-delivery\.com|_pxCaptcha|px-captcha|Incapsula incident ID|gokuProps/i;

const WALL_WORDING = /^(just a moment|attention required|access denied|are you a robot|verify (you are|you're) (a )?human|security check|pardon our interruption)/i;

const decode = (s: string): string =>
  s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');

/** The text a reader would see: scripts, styles and tags removed, whitespace collapsed. */
export function visibleText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const firstText = (html: string, tag: 'title' | 'h1'): string => {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(html);
  return m ? visibleText(m[1] ?? '') : '';
};

const hasJobPostingLd = (html: string): boolean =>
  /<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?JobPosting[\s\S]*?<\/script\s*>/i.test(html);

const hasInputForm = (html: string): boolean => {
  for (const m of html.matchAll(/<form\b[\s\S]*?<\/form\s*>/gi)) {
    if ((m[0].match(/<(input|textarea|select)\b/gi) ?? []).length >= 2) return true;
  }
  return false;
};

/** Why `doc` is a challenge (rule letter plus detail), or null when it is an ordinary page. */
export function challengeReason(doc: ChallengeInput): string | null {
  if (doc.status === 403 || doc.status === 429) return `A: status ${doc.status}`;
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc.headers ?? {})) h[k.toLowerCase()] = String(v);
  if (/challenge/i.test(h['cf-mitigated'] ?? '')) return 'B: cf-mitigated';
  if (/datadome/i.test(h['server'] ?? '') || Object.keys(h).some((k) => k.startsWith('x-datadome'))) return 'B: DataDome';
  if (h['x-px-blocked'] !== undefined) return 'B: x-px-blocked';
  if (/captcha|challenge/i.test(h['x-amzn-waf-action'] ?? '')) return 'B: x-amzn-waf-action';
  const marker = VENDOR_MARKERS.exec(doc.html);
  if (marker) return `C: ${marker[0]}`;
  for (const tag of ['title', 'h1'] as const) {
    const t = firstText(doc.html, tag);
    if (WALL_WORDING.test(t)) return `D: ${tag} "${t.slice(0, 60)}"`;
  }
  const text = visibleText(doc.html);
  if (/captcha/i.test(text) && text.length < 2048 && !hasJobPostingLd(doc.html) && !hasInputForm(doc.html)) return 'E: captcha on a short page';
  return null;
}
