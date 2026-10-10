import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { profileFor } from '../../ats-profiles.js';
import { forbiddenTermStrict } from '../../pack/rules.js';
import { docxText, renderDocx } from '../../render/docx.js';
import { RenderPack, renderModels } from '../../render/fill.js';
import { renderHtml } from '../../render/html.js';
import { coverModel, type DocModel, modelText, normText, RENDER_FILES, renderedPath, resumeModel } from '../../render/model.js';
import { renderPdf, uncoveredGlyph } from '../../render/pdf.js';
import { CoverPlan, Rendered } from '../../types.js';
import { postingSlots } from './grounded.js';

/**
 * renderer (spec §5.4, Task 10): turns one grounded cover plan (with its resume plan) into the files the user uploads:
 * `<jobKey>/resume.pdf|docx|html` and `<jobKey>/cover.pdf|docx|html` under the out root. It is the only agent that
 * reads the full pack (`capabilities.pack: 'full'`, enforced by the app allow-list): contact details (P1) are merged
 * in only here, and the cover's p4 placeholders are filled only here, from `contact.yaml` city and `answers.yaml`
 * notice_period (`render/fill.ts`). Its
 * outputs are P1 (`emits`, and the kernel floors a 'full' pack agent's outputs at P1 whatever it returns).
 *
 * Every line is already grounded; the renderer adds only the contact block, section headings, role dates, the
 * salutation and the sign-off (`render/model.ts`); the cover has no date line (L5). Before writing it refuses any character the embedded font
 * has no glyph for (`unrenderable-glyph:U+XXXX`, a named reason the projector shows)
 * and any forbidden term in the documents' text, contact block included, and after rendering it checks that the DOCX
 * text layer equals the document text. G-GROUND then re-renders the letter from recomputed slots byte for byte, G-FILL
 * re-derives the fill and the document text from the plan and the full pack, and G-NAMING checks the payload.
 */
export const rendererContract = defineContract({
  id: 'renderer',
  version: '1.1.0',
  description: 'Renders one cover plan into ATS-ready documents',
  skills: ['document-rendering'],
  team: 'writing',
  kind: 'io',
  consumes: CoverPlan,
  produces: Rendered,
  capabilities: { pack: 'full', files: { root: 'out', access: 'read-write' } },
  dataClasses: { in: ['P0'], out: ['P1'] },
  emits: 'P1',
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  guardrails: { in: [], out: ['G-GROUND', 'G-FILL', 'G-NAMING'] },
});

export { RenderPack, renderModels } from '../../render/fill.js';

export function renderPackOf(pack: unknown): RenderPack {
  const r = RenderPack.safeParse(pack);
  if (!r.success) throw new KernelError('invalid_output', 'renderer: the full pack is missing or lacks contact, answers or naming');
  return r.data;
}

const fail = (message: string): KernelError => new KernelError('invalid_output', `renderer: ${message}`);

/**
 * The text checks every document passes before any byte is written. A refusal caused by the posting's own title or
 * company (the only posting text in the documents) is `input_rejected`: it is this job's, re-running would refuse
 * again, and it must not trip the breaker for the other jobs. The same refusal from the pack (contact block, facts)
 * hits every job, so it stays `invalid_output`.
 */
function checkText(m: DocModel, pack: RenderPack, slots: readonly string[]): void {
  const text = modelText(m);
  const inPosting = uncoveredGlyph(slots);
  if (inPosting !== null) {
    throw new KernelError('input_rejected', `renderer: unrenderable-glyph:${inPosting} (in the posting title or company; the embedded font cannot draw it)`);
  }
  const bad = uncoveredGlyph([text, m.title, m.author]);
  if (bad !== null) throw fail(`unrenderable-glyph:${bad} (the ${m.kind} has a character the embedded font cannot draw)`);
  // final I8: the strict check (glued, split, plural, look-alike), on the posting slots too, so a posting that names a
  // term is refused as this job's input before the same text fails the document as a whole.
  const term = (s: string): number | undefined => {
    const t = forbiddenTermStrict(s, pack.naming);
    return t === undefined ? undefined : pack.naming.forbiddenTerms.indexOf(t) + 1;
  };
  for (const s of slots) {
    const n = term(s);
    if (n !== undefined) throw new KernelError('input_rejected', `renderer: G-NAMING: forbidden term #${n} appears in the posting title or company`);
  }
  for (const s of [text, m.title]) {
    const n = term(s);
    if (n !== undefined) throw fail(`G-NAMING: forbidden term #${n} appears in the ${m.kind}`);
  }
}

export const renderer = defineAgent(rendererContract, async (cover, ctx) => {
  const pack = renderPackOf(ctx.pack);
  const write = ctx.files?.write;
  if (write === undefined) throw new KernelError('policy_denied', 'renderer: no writable files capability');
  let models: ReturnType<typeof renderModels>;
  try {
    models = renderModels(cover, pack);
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
  const docs = { resume: models.resume, cover: models.cover };
  const { title, company } = postingSlots(cover.resume.evidence.scored.posting);
  for (const m of [docs.resume, docs.cover]) checkText(m, pack, [title, company]);

  const bytes = new Map<string, { data: Uint8Array; pages: number | null }>();
  for (const kind of ['resume', 'cover'] as const) {
    const m = docs[kind];
    const pdf = await renderPdf(m);
    const docx = await renderDocx(m);
    if (normText(docxText(docx)) !== normText(modelText(m))) throw fail(`the ${kind} DOCX text layer differs from the document text`);
    bytes.set(`${kind}.pdf`, { data: pdf.bytes, pages: pdf.pages });
    bytes.set(`${kind}.docx`, { data: docx, pages: null });
    bytes.set(`${kind}.html`, { data: new TextEncoder().encode(renderHtml(m)), pages: null });
  }

  const files: Rendered['files'] = [];
  for (const f of RENDER_FILES) {
    const b = bytes.get(`${f.kind}.${f.format}`);
    if (b === undefined) throw fail(`no ${f.kind}.${f.format} was rendered`);
    const res = await write(renderedPath(cover.jobKey, f.kind, f.format), b.data);
    files.push({ kind: f.kind, format: f.format, path: res.path, sha256: res.sha256, pages: b.pages });
  }
  const posting = cover.resume.evidence.scored.posting;
  return [
    {
      jobKey: cover.jobKey,
      files,
      recommended: profileFor(cover.resume.ats, posting.url).recommended,
      plan: models.plan,
      text: { resume: modelText(docs.resume), cover: modelText(docs.cover) },
    },
  ];
});
