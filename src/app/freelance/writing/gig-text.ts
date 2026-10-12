import type { RenderPack } from '../../render/fill.js';
import { modelText, resumeModel } from '../../render/model.js';
import type { GigDocsPlan, GigFile } from '../types.js';
import { pitchText } from './pitch-planner.js';
import { cadenceOf, proposalText } from './proposal-planner.js';

/**
 * The gig documents' text and file list (Task 8), pure so G-GROUND re-derives exactly what the gig renderer writes
 * without loading a render library. Files live under `gigs/<gigKey>/` in the out root, apart from the daily
 * `<jobKey>/` folders: the paste-ready `proposal.txt` (kind gig) or `pitch.txt` (kind contract), then the contract CV
 * `resume.pdf` and `resume.docx`.
 */

export const GIG_DIR = 'gigs';

/** `gigs/<gigKey>/<kind>.<format>`, relative to the out root. */
export const gigPath = (gigKey: string, kind: GigFile['kind'], format: GigFile['format']): string => `${GIG_DIR}/${gigKey}/${kind}.${format}`;

/** The files of one plan, in the order the renderer writes and lists them. */
export function gigFilesOf(plan: Pick<GigDocsPlan, 'gigKey' | 'proposal'>): { kind: GigFile['kind']; format: GigFile['format']; path: string }[] {
  const text = plan.proposal !== null ? 'proposal' : 'pitch';
  return [
    { kind: text, format: 'txt', path: gigPath(plan.gigKey, text, 'txt') },
    { kind: 'resume', format: 'pdf', path: gigPath(plan.gigKey, 'resume', 'pdf') },
    { kind: 'resume', format: 'docx', path: gigPath(plan.gigKey, 'resume', 'docx') },
  ];
}

/**
 * Every document text of one plan: the proposal or the pitch with `{cadence}` filled from `answers.yaml`
 * (`cadenceOf`), and the contract CV's document text with the contact block. Throws on an unusable cadence.
 */
export function gigTexts(plan: GigDocsPlan, full: RenderPack): { proposal: string | null; pitch: string | null; resume: string } {
  const cadence = cadenceOf(full.answers);
  return {
    proposal: plan.proposal === null ? null : proposalText(plan.proposal, cadence),
    pitch: plan.pitch === null ? null : pitchText(plan.pitch, cadence),
    resume: modelText(resumeModel(plan.resume, full.contact)),
  };
}

/** A `.txt` file's bytes: the text, UTF-8, LF line ends, one final LF. */
export const txtBytes = (text: string): Uint8Array => new TextEncoder().encode(`${text.replace(/\r\n?/g, '\n')}\n`);
