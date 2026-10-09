import { z } from 'zod';
import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { profileFor } from '../../ats-profiles.js';
import { assertNoForbidden, ForbiddenTermError } from '../../pack/rules.js';
import { docxText, renderDocx } from '../../render/docx.js';
import { fillCover } from '../../render/fill.js';
import { renderHtml } from '../../render/html.js';
import { coverModel, type DocModel, modelText, normText, RENDER_FILES, renderedPath, resumeModel, unencodable } from '../../render/model.js';
import { renderPdf } from '../../render/pdf.js';
import { CoverPlan, Rendered } from '../../types.js';

/**
 * renderer (spec §5.4, Task 10): turns one grounded cover plan (with its resume plan) into the files the user uploads:
 * `<jobKey>/resume.pdf|docx|html` and `<jobKey>/cover.pdf|docx|html` under the out root. It is the only agent that
 * reads the full pack (`capabilities.pack: 'full'`, enforced by the app allow-list): contact details (P1) are merged
 * in only here, and the cover's p4 placeholders are filled only here, from `answers.yaml` (`render/fill.ts`). Its
 * outputs are P1 (`emits`, and the kernel floors a 'full' pack agent's outputs at P1 whatever it returns).
 *
 * Every line is already grounded; the renderer adds only the contact block, section headings, role dates, the date
 * line, the salutation and the sign-off (`render/model.ts`). Before writing it refuses text the PDF fonts cannot set
 * and any forbidden term in the documents' text, contact block included, and after rendering it checks that the DOCX
 * text layer equals the document text. G-FILL then re-derives the fill and the document text from the plan and the full
 * pack; G-NAMING checks the payload.
 */
export const rendererContract = defineContract({
  id: 'renderer',
  version: '1.0.0',
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
  guardrails: { in: [], out: ['G-FILL', 'G-NAMING'] },
});

/** What the renderer reads from the full pack. */
export const RenderPack = z.object({
  contact: z.object({ name: z.string().min(1), email: z.string(), phone: z.string(), city: z.string(), links: z.array(z.string()) }),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  naming: z.object({ forbiddenTerms: z.array(z.string()) }),
});
export type RenderPack = z.infer<typeof RenderPack>;

export function renderPackOf(pack: unknown): RenderPack {
  const r = RenderPack.safeParse(pack);
  if (!r.success) throw new KernelError('invalid_output', 'renderer: the full pack is missing or lacks contact, answers or naming');
  return r.data;
}

/** The filled plan, both document models and their texts: what the renderer draws, and what G-FILL re-derives. */
export function renderModels(cover: CoverPlan, pack: RenderPack): { plan: CoverPlan; resume: DocModel; cover: DocModel } {
  const plan = fillCover(cover, pack.answers);
  return { plan, resume: resumeModel(plan.resume, pack.contact), cover: coverModel(plan, pack.contact) };
}

const fail = (message: string): KernelError => new KernelError('invalid_output', `renderer: ${message}`);

/** The text checks every document passes before any byte is written. */
function checkText(m: DocModel, pack: RenderPack): void {
  const text = modelText(m);
  const bad = unencodable(text);
  if (bad !== null) throw fail(`the ${m.kind} has a character the PDF fonts cannot set (${bad})`);
  try {
    assertNoForbidden(text, pack.naming);
    assertNoForbidden(m.title, pack.naming);
  } catch (e) {
    if (e instanceof ForbiddenTermError) throw fail(`G-NAMING: forbidden term #${pack.naming.forbiddenTerms.indexOf(e.term) + 1} appears in the ${m.kind}`);
    throw e;
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
  for (const m of [docs.resume, docs.cover]) checkText(m, pack);

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
