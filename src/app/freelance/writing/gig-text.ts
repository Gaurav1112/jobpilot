import { type RenderPack, unsafeCity } from '../../render/fill.js';
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

/** The files of one plan, in the order the renderer writes and lists them. */
export function gigFilesOf(plan: Pick<GigDocsPlan, 'gigKey' | 'proposal'> & { readonly cover?: unknown }): { kind: GigFile['kind']; format: GigFile['format']; path: string }[] {
  const text = plan.proposal !== null ? 'proposal' : 'pitch';
  return [
    { kind: text, format: 'txt', path: gigPath(plan.gigKey, text, 'txt') },
    { kind: 'resume', format: 'pdf', path: gigPath(plan.gigKey, 'resume', 'pdf') },
    { kind: 'resume', format: 'docx', path: gigPath(plan.gigKey, 'resume', 'docx') },
    ...(plan.cover === undefined ? [] : COVER_FORMATS.map((format) => ({ kind: 'cover' as const, format, path: gigPath(plan.gigKey, 'cover', format) }))),
  ];
}

/**
 * The cover plan with its availability paragraph filled from `contact.yaml` city (`fillGigCoverP4`; an empty city drops
 * the city clause). Throws when the city cannot go into a document (`unsafeCity`, the daily rule) or the last paragraph
 * is not the planned one. Every other paragraph, and the resume plan, unchanged.
 */
export function fillGigCover(cover: CoverPlan, city: string): CoverPlan {
  const place = city.trim();
  if (place !== '') {
    const why = unsafeCity(place);
    if (why !== null) throw new Error(`contact.yaml city cannot go into the cover letter (${why})`);
  }
  const last = cover.paragraphs.length - 1;
  return { ...cover, paragraphs: cover.paragraphs.map((p, i) => ({ text: i === last ? fillGigCoverP4(p.text, place) : p.text, factIds: [...p.factIds] })) };
}

/** The gig cover letter's document model: the daily one (`coverModel`), from the filled plan and the contact block. */
export const gigCoverModel = (cover: CoverPlan, full: RenderPack): DocModel => coverModel(fillGigCover(cover, full.contact.city), full.contact);

/**
 * The paste-ready cover letter (`cover.txt`): the document text from the salutation to the signed name, without the
 * name and contact lines at the top (a form's cover-letter box already knows who sends it).
 */
export const coverPasteText = (coverText: string): string => coverText.split('\n').slice(2).join('\n');

/**
 * Every document text of one plan: the proposal or the pitch with `{cadence}` filled from `answers.yaml`
 * (`cadenceOf`), the contract CV's document text with the contact block, and (only with a planned cover) the cover
 * letter's document text (`gigCoverModel`). Throws on an unusable cadence or city.
 */
export function gigTexts(plan: GigDocsPlan, full: RenderPack): { proposal: string | null; pitch: string | null; resume: string; cover?: string } {
  const cadence = cadenceOf(full.answers);
  return {
    proposal: plan.proposal === null ? null : proposalText(plan.proposal, cadence),
    pitch: plan.pitch === null ? null : pitchText(plan.pitch, cadence),
    resume: modelText(resumeModel(plan.resume, full.contact)),
    ...(plan.cover === undefined ? {} : { cover: modelText(gigCoverModel(plan.cover, full)) }),
  };
}

/** A `.txt` file's bytes: the text, UTF-8, LF line ends, one final LF. */
export const txtBytes = (text: string): Uint8Array => new TextEncoder().encode(`${text.replace(/\r\n?/g, '\n')}\n`);
