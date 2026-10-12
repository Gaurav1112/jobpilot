import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { termDisplay, type WritingPack } from '../agents/writing/grounded.js';
import { check, type Check, contactProblems, hasTerm, hyphenProblems, namingProblem, pdfPages, readDocxText, sameText } from '../agents/writing/qa-checks.js';
import type { RunPack } from '../kernel.js';
import { redactText } from '../pack/rules.js';
import { renderDocx } from '../render/docx.js';
import { RenderPack } from '../render/fill.js';
import { modelText, normText, PAGE_LIMITS, resumeModel } from '../render/model.js';
import { renderPdf, uncoveredGlyph } from '../render/pdf.js';
import { checklistMarkdown, networkPack, profileText } from './networks.js';

/**
 * `jobpilot networks pack` (spec §7): writes `out/networks/<id>/{resume.pdf,resume.docx,profile.txt,checklist.md}` for
 * each chosen network. A network with any `networkPack` problem (G-GROUND, G-NAMING on its keywords or titles, a
 * profile field over its limit) is refused and nothing is written for it. The files are written to a temporary folder
 * first, checked with the qa-gate's own text-layer checks (`qa-checks.ts`: pages, hyphens, PDF and DOCX text equal to
 * the document text, contact tokens intact, covered terms present, the strict naming scan on every file), and only
 * then moved into place, so a failed check never leaves a half-checked pack behind. Every message is redacted.
 */

export interface NetworksDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Absolute path of pdftotext (`resolvePdftotext`). */
  readonly pdftotext: string;
}

export const NETWORK_FILES = ['resume.pdf', 'resume.docx', 'profile.txt', 'checklist.md'] as const;

/** One line per network: id, name, whether the user checked the file, and the screening stage count. */
export function networksList(loaded: Pick<RunPack, 'pack'>): string[] {
  return loaded.pack.networks.map((n) => `${n.id}  ${n.name}  ${n.checkedByUser ? 'checked' : 'not checked by you'}  ${n.screening.length} stages`);
}

const pdfTextOf = (binary: string, path: string): string => execFileSync(binary, ['-layout', path, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/** Writes one network's pack; returns its problems (empty when written). */
async function writeOne(id: string, loaded: RunPack, outRoot: string, d: NetworksDeps): Promise<string[]> {
  const net = loaded.pack.networks.find((n) => n.id === id);
  if (net === undefined) return [`unknown network ${id} (known: ${loaded.pack.networks.map((n) => n.id).join(', ') || 'none'})`];
  const pub = loaded.publicPack as unknown as WritingPack;
  const r = networkPack(net, pub, loaded.asOf, loaded.publicPack);
  if (r.problems.length > 0) return r.problems;

  const full = RenderPack.safeParse(loaded.fullPack);
  if (!full.success) return ['the full pack lacks contact, answers or naming'];
  const naming = full.data.naming;
  const model = resumeModel(r.resume, full.data.contact);
  const text = modelText(model);
  const bad = uncoveredGlyph([text, model.title, model.author]);
  if (bad !== null) return [`unrenderable-glyph:${bad} (the resume has a character the embedded font cannot draw)`];
  const profile = profileText(net, r);
  const checklist = checklistMarkdown(net, r, pub);
  const pre = [namingProblem('the resume text', `${model.title}\n${text}`, naming), namingProblem('profile.txt', profile, naming), namingProblem('checklist.md', checklist, naming)];
  const preProblems = pre.filter((p): p is string => p !== undefined);
  if (preProblems.length > 0) return preProblems.map((p) => `G-NAMING: ${p}`);

  const pdf = await renderPdf(model);
  const docx = await renderDocx(model);
  const dir = join(outRoot, id);
  const tmp = join(outRoot, `.${id}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    writeFileSync(join(tmp, 'resume.pdf'), pdf.bytes);
    writeFileSync(join(tmp, 'resume.docx'), docx);
    writeFileSync(join(tmp, 'profile.txt'), profile);
    writeFileSync(join(tmp, 'checklist.md'), checklist);

    // The qa-gate's checks, on what was written (read back from disk, never from the bytes in hand).
    const layer = pdfTextOf(d.pdftotext, join(tmp, 'resume.pdf'));
    const pages = pdfPages(layer);
    const docxRead = readDocxText('resume.docx', new Uint8Array(readFileSync(join(tmp, 'resume.docx'))));
    const naming1 = [
      namingProblem('resume.pdf', layer, naming),
      'text' in docxRead ? namingProblem('resume.docx', docxRead.text, naming) : undefined,
      namingProblem('profile.txt', readFileSync(join(tmp, 'profile.txt'), 'utf8'), naming),
      namingProblem('checklist.md', readFileSync(join(tmp, 'checklist.md'), 'utf8'), naming),
    ].filter((p): p is string => p !== undefined);
    const resumeText = normText(layer);
    const checks: Check[] = [
      check('qa.pages', [
        ...(pages > PAGE_LIMITS.resume ? [`resume has ${pages} pages, the limit is ${PAGE_LIMITS.resume}`] : []),
        ...(pages !== pdf.pages ? [`resume.pdf has ${pages} pages, the renderer recorded ${pdf.pages}`] : []),
      ]),
      check(
        'qa.terms',
        r.resume.covered.flatMap((k) => (hasTerm(resumeText, termDisplay(k, pub)) ? [] : [`${termDisplay(k, pub)} is not in the resume PDF text`])),
      ),
      check('qa.hyphen', hyphenProblems(layer, text).map((p) => `resume.pdf ${p}`)),
      check('qa.docx-text', 'problem' in docxRead ? [docxRead.problem] : sameText(docxRead.text, text) ? [] : ['resume.docx text differs from the document text']),
      check('qa.pdf-text', sameText(layer, text) ? [] : ['resume.pdf text differs from the document text']),
      check('qa.naming', naming1),
      check('qa.contact-intact', contactProblems(layer, text).map((p) => `resume.pdf: ${p}`)),
    ];
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) return failed.map((c) => `${c.id}: ${c.detail}`);

    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  }
  const fields = r.profile.map((p) => `${p.id} ${p.text.length}/${net.profileFields.find((f) => f.id === p.id)?.maxChars ?? '?'}`).join(', ');
  d.out(`${id}: wrote out/networks/${id}/ (resume ${pdf.pages} page${pdf.pages === 1 ? '' : 's'}; ${fields}; ${r.missing.length} missing keyword${r.missing.length === 1 ? '' : 's'})`);
  return [];
}

/**
 * Packs the chosen networks (`all`: every one, by id) under `<outRoot>/<id>/`. Returns 0 when every one was written, 1
 * when any was refused (its problems printed, redacted, one per line).
 */
export async function networksPack(ids: readonly string[] | 'all', loaded: RunPack, outRoot: string, d: NetworksDeps): Promise<0 | 1> {
  const chosen = ids === 'all' ? loaded.pack.networks.map((n) => n.id) : [...new Set(ids)].sort();
  if (chosen.length === 0) {
    d.err(ids === 'all' ? 'no network files in pack/networks/ (add <id>.yaml files there)' : 'name a network id, or pass --all');
    return 1;
  }
  const terms = { forbiddenTerms: loaded.pack.naming.forbiddenTerms };
  mkdirSync(outRoot, { recursive: true });
  let code: 0 | 1 = 0;
  for (const id of chosen) {
    const problems = await writeOne(id, loaded, outRoot, d);
    if (problems.length === 0) continue;
    code = 1;
    d.err(redactText(`${id}: refused, nothing written:`, terms));
    for (const p of problems) d.err(redactText(`  - ${p}`, terms));
  }
  return code;
}
