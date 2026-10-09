import type { JobView } from '../store/app-store.js';

/**
 * Plain-language copy for the dashboard (Task 13), as strings: the views escape them through `html`. Written from the
 * user's side ("documents you can send"), never in pipeline terms.
 */

export type Tone = 'good' | 'warn' | 'critical' | 'neutral' | 'muted' | 'accent';

const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The remote verdict of a posting as a pill label, tone and the evidence behind it. */
export function remoteText(remote: JobView['remote']): { label: string; tone: Tone; title?: string } {
  if (remote === null) return { label: 'Location unclear', tone: 'warn' };
  const where = remote.countries.slice(0, 2).map(titleCase).join(', ');
  const title = remote.signals.join(', ');
  switch (remote.structured) {
    case 'remote':
      return { label: where === '' ? 'Remote' : `Remote · ${where}`, tone: 'good', title };
    case 'hybrid':
      return { label: 'Hybrid', tone: 'warn', title };
    case 'onsite':
      return { label: 'On-site', tone: 'critical', title };
    default:
      return { label: where === '' ? 'Remote unclear' : `Remote? · ${where}`, tone: 'warn', title };
  }
}

/** Why a job has no documents to send, in plain words. */
export function docsReason(j: Pick<JobView, 'docsState' | 'docsDetail' | 'company' | 'title' | 'location'>): string | null {
  const d = j.docsDetail ?? '';
  switch (j.docsState) {
    case 'ready':
      return null;
    case 'below-floor':
      return 'No documents: this job scored under your minimum fit, so none were made.';
    case 'missing':
      return `Documents are missing on disk (${d.replace(/^documents missing:\s*/, '')}). Run "jobpilot docs rebuild" to make them again.`;
    case 'none':
      return d === '' ? 'No documents yet: the next run makes them if this job qualifies.' : `No documents yet: ${d}`;
    case 'blocked':
      break;
  }
  const glyph = /unrenderable-glyph:U\+([0-9A-F]{4,6})/.exec(d);
  if (glyph) {
    const hex = glyph[1] as string;
    const ch = String.fromCodePoint(Number.parseInt(hex, 16));
    const where = j.company.includes(ch) ? ' in the company name' : j.title.includes(ch) ? ' in the job title' : j.location.includes(ch) ? ' in the location' : ' in the posting';
    return `documents blocked: unrenderable character U+${hex}${where}`;
  }
  if (d.includes('unsafe-posting-text')) return 'documents blocked: the posting text has markup or characters that cannot go into a document safely';
  const naming = /G-NAMING: forbidden term #(\d+)/.exec(d);
  if (naming) return `documents blocked: a forbidden term (#${naming[1] as string} in naming.yaml) would have appeared`;
  if (d.startsWith('qa failed: ')) return `documents blocked: a quality check failed (${d.slice('qa failed: '.length)})`;
  const q = /^(\S+) quarantined: (.*)$/.exec(d);
  if (q) return `documents blocked: a safety check stopped the ${q[1] as string} step (${q[2] as string})`;
  return d === '' ? 'documents blocked' : `documents blocked: ${d}`;
}

/** Readable eligibility reason codes; the code itself is shown beside it. */
export function reasonText(code: string): string {
  if (code === 'remote-unclear') return 'The posting does not say clearly where remote work is allowed';
  if (code === 'onsite-only') return 'On-site only, outside the cities you accept';
  if (code.startsWith('remote-excludes-india')) return 'Remote, but not open to people in India';
  if (code.startsWith('role:')) return 'The title matches a role you filtered out';
  if (code.startsWith('company:')) return 'A company you filtered out';
  if (code.startsWith('employment:')) return 'Not a full-time job';
  if (code.startsWith('years')) return 'Asks for more years than you set as your limit';
  return code;
}

/** A score breakdown label in words. `display` maps a lexicon key to its display name. */
export function breakdownText(label: string, display: (key: string) => string): string {
  if (label === 'base') return 'Starting points';
  if (label === 'title:seniority') return 'Seniority in the title';
  if (label === 'title:family') return 'Job family in the title';
  if (label === 'years>max') return 'Asks for more years than your limit';
  const m = /^(strong|medium|gap):(.+)$/.exec(label);
  if (m) {
    const term = display(m[2] as string);
    return m[1] === 'strong' ? `Core skill: ${term}` : m[1] === 'medium' ? `Skill: ${term}` : `Asks for ${term}, which you don't list`;
  }
  return label;
}
