import { availabilityClause } from '../../agents/writing/templates.js';
import { noticeAnswer, type RenderPack, unsafeCity } from '../../render/fill.js';
import { coverModel, type DocModel, modelText, resumeModel } from '../../render/model.js';
import type { CoverPlan } from '../../types.js';
import type { GigDocsPlan, GigFile } from '../types.js';
import { fillGigCoverP4 } from './gig-cover.js';
import { pitchText } from './pitch-planner.js';
import { cadenceOf, proposalText } from './proposal-planner.js';

/**
 * The gig documents' text and file list (Task 8), pure so G-GROUND re-derives exactly what the gig renderer writes
 * without loading a render library. Files live under `gigs/<gigKey>/` in the out root, apart from the daily
 * `<jobKey>/` folders: the paste-ready `proposal.txt` (kind gig) or `pitch.txt` (kind contract), then the contract CV
 * `resume.pdf` and `resume.docx`; and for a contract role on an employer job board (freelance-v2) the cover letter
 * `cover.txt` (paste-ready), `cover.pdf`, `cover.docx` and `cover.html` (the daily cover letter's three formats).
 */

export const GIG_DIR = 'gigs';

/** `gigs/<gigKey>/<kind>.<format>`, relative to the out root. */
export const gigPath = (gigKey: string, kind: GigFile['kind'], format: GigFile['format']): string => `${GIG_DIR}/${gigKey}/${kind}.${format}`;

/** The cover letter's files (freelance-v2), after the pitch and the CV: the paste-ready text, then the daily three. */
const COVER_FORMATS = ['txt', 'pdf', 'docx', 'html'] as const;

/**
 * The files of one plan, in the order the renderer writes and lists them. `withCover` (default: the plan has a cover)
 * is false when the cover letter was blocked at render time (`GigRendered.coverBlocked`): the pitch and CV only.
 */
export function gigFilesOf(
  plan: Pick<GigDocsPlan, 'gigKey' | 'proposal'> & { readonly cover?: unknown },
  withCover: boolean = plan.cover !== undefined,
): { kind: GigFile['kind']; format: GigFile['format']; path: string }[] {
  const text = plan.proposal !== null ? 'proposal' : 'pitch';
  return [
    { kind: text, format: 'txt', path: gigPath(plan.gigKey, text, 'txt') },
    { kind: 'resume', format: 'pdf', path: gigPath(plan.gigKey, 'resume', 'pdf') },
    { kind: 'resume', format: 'docx', path: gigPath(plan.gigKey, 'resume', 'docx') },
    ...(!withCover ? [] : COVER_FORMATS.map((format) => ({ kind: 'cover' as const, format, path: gigPath(plan.gigKey, 'cover', format) }))),
  ];
}

/**
 * The cover plan with its availability paragraph filled (`fillGigCoverP4`) from `contact.yaml` city and `answers.yaml`
 * notice_period (`noticeAnswer`, phrased as the job letters phrase it: `availabilityClause`); a missing one drops its
 * clause. Throws when the city or the notice cannot go into a document (the daily rules) or the last paragraph is not the
 * planned one. Every other paragraph, and the resume plan, unchanged.
 */
export function fillGigCover(cover: CoverPlan, city: string, answers: Readonly<Record<string, unknown>>): CoverPlan {
  const place = city.trim();
  if (place !== '') {
    const why = unsafeCity(place);
    if (why !== null) throw new Error(`contact.yaml city cannot go into the cover letter (${why})`);
  }
  const notice = noticeAnswer(answers);
  const available = notice === undefined ? undefined : availabilityClause(notice);
  const last = cover.paragraphs.length - 1;
  return { ...cover, paragraphs: cover.paragraphs.map((p, i) => ({ text: i === last ? fillGigCoverP4(p.text, place, available) : p.text, factIds: [...p.factIds] })) };
}

/** The gig cover letter's document model: the daily one (`coverModel`), from the filled plan and the contact block. */
export const gigCoverModel = (cover: CoverPlan, full: RenderPack): DocModel => coverModel(fillGigCover(cover, full.contact.city, full.answers), full.contact);

/**
 * The reasons a cover letter is blocked only at render time (the renderer finds them drawing it): G-GROUND accepts one
 * of these as `coverBlocked` though the texts re-derive; any other reason must be the one `gigTexts` gives.
 */
export const RENDER_TIME_BLOCKS = ['unrenderable-glyph:', 'G-NAMING:', 'the cover letter has ', 'the cover letter DOCX'] as const;
export const isRenderTimeBlock = (reason: string): boolean => RENDER_TIME_BLOCKS.some((p) => reason.startsWith(p));

/**
 * The paste-ready cover letter (`cover.txt`): the document text from the salutation to the signed name, without the
 * name and contact lines at the top (a form's cover-letter box already knows who sends it).
 */
export const coverPasteText = (coverText: string): string => coverText.split('\n').slice(2).join('\n');

/**
 * Every document text of one plan: the proposal or the pitch with `{cadence}` filled from `answers.yaml`
 * (`cadenceOf`), the contract CV's document text with the contact block, and (only with a planned cover) the cover
 * letter's document text (`gigCoverModel`) or, when it cannot be filled, `coverBlocked` with the reason. Throws on an
 * unusable cadence.
 */
export function gigTexts(plan: GigDocsPlan, full: RenderPack): { proposal: string | null; pitch: string | null; resume: string; cover?: string; coverBlocked?: string } {
  const cadence = cadenceOf(full.answers);
  const base = {
    proposal: plan.proposal === null ? null : proposalText(plan.proposal, cadence),
    pitch: plan.pitch === null ? null : pitchText(plan.pitch, cadence),
    resume: modelText(resumeModel(plan.resume, full.contact)),
  };
  if (plan.cover === undefined) return base;
  // A cover letter that cannot be filled (an unsafe city or notice) is blocked alone: the pitch and CV stay.
  try {
    return { ...base, cover: modelText(gigCoverModel(plan.cover, full)) };
  } catch (e) {
    return { ...base, coverBlocked: e instanceof Error ? e.message : String(e) };
  }
}

/** A `.txt` file's bytes: the text, UTF-8, LF line ends, one final LF. */
export const txtBytes = (text: string): Uint8Array => new TextEncoder().encode(`${text.replace(/\r\n?/g, '\n')}\n`);
