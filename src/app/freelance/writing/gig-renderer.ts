import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import type { RunPack } from '../../kernel.js';
import { forbiddenTermStrict } from '../../pack/rules.js';
import { docxText, renderDocx } from '../../render/docx.js';
import { RenderPack } from '../../render/fill.js';
import { modelText, normText, PAGE_LIMITS, resumeModel } from '../../render/model.js';
import { renderPdf, uncoveredGlyph } from '../../render/pdf.js';
import { GigDocsPlan, GigRendered } from '../types.js';
import { renderHtml } from '../../render/html.js';
import { coverPasteText, gigCoverModel, gigFilesOf, gigTexts, txtBytes } from './gig-text.js';

export { GIG_DIR, gigFilesOf, gigPath, gigTexts } from './gig-text.js';

/**
 * gig-renderer (spec §7, Task 8): writes one gig plan's documents under `gigs/<gigKey>/` in the out root: the
 * paste-ready `proposal.txt` or `pitch.txt` (UTF-8, LF, `{cadence}` filled from `answers.yaml` `updateCadence`,
 * default "two days") and the contract CV `resume.pdf` and `resume.docx`, drawn by the daily renderer's modules
 * (`render/model.ts`, `pdf.ts`, `docx.ts`) with the contact block. The PDF and DOCX metadata date is the plan's
 * `firstSeen` (the gig's `postedAt` date), never now, so a replay is byte-identical.
 *
 * Exactly like the daily renderer it reads the full pack (`capabilities.pack: 'full'`, on the app allow-list) and
 * writes files, so it is an `io` agent (the kernel lets only io agents write) and its outputs are P1. Before writing it
 * refuses a character the embedded font cannot draw in the CV and a forbidden term in any document text (strict), and
 * after rendering it checks the DOCX text layer. G-GROUND then re-renders every text from the plan and the full pack.
 *
 * **Cover letter (freelance-v2).** A plan with a `cover` (a contract role on an employer job board) also gets
 * `cover.txt` (the letter from the salutation to the name, `coverPasteText`), `cover.pdf`, `cover.docx` and `cover.html`,
 * drawn from the daily cover model (`coverModel`) with `{city}` filled from `contact.yaml` (`fillGigCover`): the same
 * glyph, forbidden-term and DOCX text-layer checks as the CV, and G-FILL re-derives the fill.
 *
 * **Step key (Task 9 wiring).** The freelance supervisor must key this agent on the freelance full pack hash, which
 * covers the contact block, the answers and the freelance files (`freelance.yaml`, `platform-rules.yaml`, networks):
 * pass `freelanceDocsPacks(loaded)` to it. The daily `fullPackHash` leaves the freelance files out, so a
 * `freelance.yaml` edit would replay a stale document.
 */
export const gigRendererContract = defineContract({
  id: 'gig-renderer',
  version: '1.7.0',
  description: 'Renders one gig plan into paste-ready documents',
  skills: ['gig-document-rendering'],
  team: 'writing',
  kind: 'io',
  consumes: GigDocsPlan,
  produces: GigRendered,
  capabilities: { pack: 'full', files: { root: 'out', access: 'read-write' } },
  dataClasses: { in: ['P0'], out: ['P1'] },
  emits: 'P1',
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  guardrails: { in: [], out: ['G-GROUND', 'G-FILL', 'G-NAMING'] },
});

/** The pack options the freelance supervisor passes for the gig documents: the freelance hashes, never the daily ones. */
export function freelanceDocsPacks(loaded: Pick<RunPack, 'publicPack' | 'freelancePackHash' | 'fullPack' | 'freelanceFullPackHash'>): {
  pack: RunPack['publicPack'];
  packHash: string;
  fullPack: RunPack['fullPack'];
  fullPackHash: string;
} {
  return { pack: loaded.publicPack, packHash: loaded.freelancePackHash, fullPack: loaded.fullPack, fullPackHash: loaded.freelanceFullPackHash };
}

const fail = (message: string): KernelError => new KernelError('invalid_output', `gig-renderer: ${message}`);

export const gigRenderer = defineAgent(gigRendererContract, async (plan, ctx) => {
  const parsed = RenderPack.safeParse(ctx.pack);
  if (!parsed.success) throw fail('the full pack is missing or lacks contact, answers or naming');
  const pack = parsed.data;
  const write = ctx.files?.write;
  if (write === undefined) throw new KernelError('policy_denied', 'gig-renderer: no writable files capability');
  let texts: ReturnType<typeof gigTexts>;
  try {
    texts = gigTexts(plan, pack);
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
  const model = resumeModel(plan.resume, pack.contact);
  const bad = uncoveredGlyph([modelText(model), model.title, model.author]);
  if (bad !== null) throw fail(`unrenderable-glyph:${bad} (the contract CV has a character the embedded font cannot draw)`);
  const doc = texts.proposal ?? texts.pitch;
  if (doc === null) throw fail('the plan has neither a proposal nor a pitch');
  for (const [what, t] of [['the proposal text', doc], ['the contract CV', `${model.title}\n${modelText(model)}`]] as const) {
    const term = forbiddenTermStrict(t, pack.naming);
    if (term !== undefined) throw fail(`G-NAMING: forbidden term #${pack.naming.forbiddenTerms.indexOf(term) + 1} appears in ${what}`);
  }
  const pdf = await renderPdf(model);
  const docx = await renderDocx(model);
  if (normText(docxText(docx)) !== normText(modelText(model))) throw fail('the contract CV DOCX text layer differs from the document text');
  const bytes = [
    { data: txtBytes(doc), pages: null as number | null },
    { data: pdf.bytes, pages: pdf.pages as number | null },
    { data: docx, pages: null as number | null },
  ];
  // freelance-v2: the cover letter, drawn exactly as the daily renderer draws a job's (`coverModel`, PDF, DOCX, HTML).
  // Contained (review): any reason it cannot be drawn blocks the letter alone, named in `coverBlocked`; the pitch and
  // CV are written either way.
  let coverBlocked = texts.coverBlocked;
  if (plan.cover !== undefined && texts.cover !== undefined) {
    try {
      bytes.push(...(await drawCover(plan.cover, pack, texts.cover)));
    } catch (e) {
      coverBlocked = e instanceof Error ? e.message : String(e);
    }
  }
  const withCover = plan.cover !== undefined && coverBlocked === undefined;
  const files: GigRendered['files'] = [];
  for (const [i, f] of gigFilesOf(plan, withCover).entries()) {
    const b = bytes[i];
    if (b === undefined) throw fail(`no ${f.kind}.${f.format} was rendered`);
    const res = await write(f.path, b.data);
    files.push({ kind: f.kind, format: f.format, path: res.path, sha256: res.sha256, pages: b.pages });
  }
  const text = { proposal: texts.proposal, pitch: texts.pitch, resume: texts.resume, ...(withCover && texts.cover !== undefined ? { cover: texts.cover } : {}) };
  return [{ gigKey: plan.gigKey, files, plan, text, ...(plan.cover !== undefined && coverBlocked !== undefined ? { coverBlocked } : {}) }];
});

/**
 * The cover letter's four files (cover.txt, .pdf, .docx, .html), or a throw naming why it cannot be drawn: a glyph the
 * font lacks, a forbidden term, more than `PAGE_LIMITS.cover` page, or a DOCX text layer that differs. Each reason
 * starts with one of `RENDER_TIME_BLOCKS`.
 */
async function drawCover(cover: NonNullable<GigDocsPlan['cover']>, pack: RenderPack, text: string): Promise<{ data: Uint8Array; pages: number | null }[]> {
  const letter = gigCoverModel(cover, pack);
  const glyph = uncoveredGlyph([modelText(letter), letter.title, letter.author]);
  if (glyph !== null) throw new Error(`unrenderable-glyph:${glyph} (the cover letter has a character the embedded font cannot draw)`);
  const term = forbiddenTermStrict(`${letter.title}\n${modelText(letter)}`, pack.naming);
  if (term !== undefined) throw new Error(`G-NAMING: forbidden term #${pack.naming.forbiddenTerms.indexOf(term) + 1} appears in the cover letter`);
  const cPdf = await renderPdf(letter);
  if (cPdf.pages > PAGE_LIMITS.cover) throw new Error(`the cover letter has ${cPdf.pages} pages, the limit is ${PAGE_LIMITS.cover}`);
  const cDocx = await renderDocx(letter);
  if (normText(docxText(cDocx)) !== normText(modelText(letter))) throw new Error('the cover letter DOCX text layer differs from the document text');
  return [
    { data: txtBytes(coverPasteText(text)), pages: null },
    { data: cPdf.bytes, pages: cPdf.pages },
    { data: cDocx, pages: null },
    { data: new TextEncoder().encode(renderHtml(letter)), pages: null },
  ];
}
