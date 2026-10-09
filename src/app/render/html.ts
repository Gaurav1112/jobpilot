import { BULLET, type Block, type DocModel } from './model.js';

/**
 * The HTML preview (Task 10): one standalone page per document for the dashboard, no script, no external resource,
 * system fonts only, readable in light and dark mode. Every text is HTML-escaped; each bullet carries the fact it
 * cites in `data-fact` (cover paragraphs list theirs in `data-facts`). Bullets are a literal "•" in the text, never a
 * CSS pseudo-element, and nothing floats. Pure: no imports beyond the model.
 */

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const STYLE = [
  ':root{color-scheme:light dark;--fg:#111;--bg:#fff;--muted:#444;--rule:#ccc}',
  '@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#bbb;--rule:#444}}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
  'main{max-width:46rem;margin:0 auto;padding:2rem 1.25rem}',
  'h1{font-size:1.6rem;margin:0}',
  'h2{font-size:.95rem;letter-spacing:.04em;margin:1.25rem 0 .25rem;border-bottom:1px solid var(--rule)}',
  'p{margin:.2rem 0 .6rem}',
  '.contact,.meta{color:var(--muted)}',
  '.title{font-weight:700;margin:.6rem 0 0}',
  'ul{list-style:none;margin:0 0 .4rem;padding:0}',
  'li{padding-left:1.1rem;text-indent:-1.1rem;margin:.15rem 0}',
].join('\n');

function blockHtml(b: Block): string {
  const t = escapeHtml(b.text);
  switch (b.kind) {
    case 'name':
      return `<h1>${t}</h1>`;
    case 'contact':
      return `<p class="contact">${t}</p>`;
    case 'heading':
      return `<h2>${t}</h2>`;
    case 'title':
      return `<p class="title">${t}</p>`;
    case 'meta':
      return `<p class="meta">${t}</p>`;
    case 'para':
      return b.factIds.length > 0 ? `<p data-facts="${escapeHtml(b.factIds.join(' '))}">${t}</p>` : `<p>${t}</p>`;
    case 'line':
      return `<p>${t}</p>`;
    case 'bullet':
      return `<li data-fact="${escapeHtml(b.factId)}">${BULLET} ${t}</li>`;
  }
}

export function renderHtml(m: DocModel): string {
  const body: string[] = [];
  let inList = false;
  for (const b of m.blocks) {
    if (b.kind === 'bullet' && !inList) body.push('<ul>');
    if (b.kind !== 'bullet' && inList) body.push('</ul>');
    inList = b.kind === 'bullet';
    body.push(blockHtml(b));
  }
  if (inList) body.push('</ul>');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="jobpilot">`,
    `<title>${escapeHtml(m.title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    `<main data-doc="${m.kind}">`,
    ...body,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
