import { packOf, scorePosting } from '../../agents/scorer-lexicon.js';
import { buildEvidence, type WritingPack } from '../../agents/writing/grounded.js';
import { dedupeKey } from '../../text/norm.js';
import type { Evidence, Posting } from '../../types.js';
import { gigKey } from '../keys.js';

/**
 * The bridge from freelance text to the grounded writing core (spec §7): a synthetic `Posting@1` the evidence matcher
 * and resume planner read as if it were a job. It is never stored or shown; only the documents planned from it are.
 */
export function syntheticPosting(o: { key: string; title: string; company: string; text: string; firstSeen: string }): Posting {
  return {
    jobKey: gigKey('synthetic', o.key),
    dedupeKey: dedupeKey(o.company, o.title, ''),
    source: 'gig',
    sourceId: o.key,
    company: o.company,
    slug: o.key,
    ats: 'feed',
    title: o.title,
    url: '',
    locationText: '',
    remote: { structured: 'remote', countries: ['worldwide'], signals: [] },
    employmentType: null,
    descriptionText: o.text,
    postedAt: o.firstSeen,
    comp: null,
    yearsRequired: null,
  };
}

/**
 * The Evidence of a synthetic posting. The `Scored` is the real lexicon scorer's (`scorePosting`, verdict eligible, no
 * notes), exactly what G-GROUND (`resumeProblems`) re-derives, so the guardrail runs at full strength on the plan.
 * `rawPack` is the public pack: the scorer reads targets the writing view drops. The score is shown nowhere.
 */
export function evidenceFor(posting: Posting, pack: WritingPack, rawPack: unknown = pack): Evidence {
  const scored = scorePosting({ posting, verdict: 'eligible', reasons: [], notes: [] }, packOf(rawPack));
  return buildEvidence(scored, pack);
}
