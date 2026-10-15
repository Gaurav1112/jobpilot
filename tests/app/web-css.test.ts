import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** UX upgrade A12 (D7 1.4.11, 2.4.7, 2.5.8, forced colors; §5.2 weights): what the stylesheet must hold. */
const css = readFileSync(join(import.meta.dirname, '../../src/app/web/static/app.css'), 'utf8');
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = css.slice(0, darkStart);
const dark = css.slice(darkStart, css.indexOf('\n}\n', darkStart));
const token = (block: string, name: string): string => {
  const v = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1];
  if (v === undefined) throw new Error(`no --${name}`);
  return v;
};
const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const rule = (selector: string): string => {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no rule ${selector}`);
  return css.slice(i, css.indexOf('}', i));
};

describe('A12: the stylesheet', () => {
  it('control borders are at least 3:1 against the page and the surface, light and dark', () => {
    for (const [name, block] of [['light', light], ['dark', dark]] as const) {
      const c = token(block, 'border-control');
      expect(contrast(c, token(block, 'surface')), `${name} surface`).toBeGreaterThanOrEqual(3);
      expect(contrast(c, token(block, 'bg')), `${name} page`).toBeGreaterThanOrEqual(3);
    }
    expect([token(light, 'border-control'), token(dark, 'border-control')]).toEqual(['#8a8d92', '#7a7e85']);
    for (const sel of ['.btn', 'input[type="search"], input[type="number"], textarea', 'input[type="url"], input[type="text"]']) expect(rule(sel), sel).toContain('var(--border-control)');
  });
  it('uses only the weights 400, 500 and 600', () => {
    const weights = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1]);
    expect(weights.filter((w) => !['400', '500', '600'].includes(w as string))).toEqual([]);
  });
  it('shows pressed and current states in forced colors, each unlike the focus ring', () => {
    const block = css.slice(css.indexOf('@media (forced-colors: active) {'), css.indexOf('@media (pointer: coarse) {'));
    // the nav and tab links (`.top nav a`, `.tabs a`) set text-decoration: none at higher specificity: they are named
    expect(block).toMatch(/\[aria-current\], \.top nav a\[aria-current\], \.tabs a\[aria-current\] \{ text-decoration: underline 2px;/);
    expect(block).toMatch(/\[aria-pressed="true"\] \{ border: 3px double Highlight; \}/);
    expect(block).toMatch(/:focus-visible \{ outline: 3px solid Highlight; outline-offset: 3px; \}/);
    // WCAG 2.4.7 / F78: no state is drawn as an outline, so the focus ring stays the one outline and always shows
    expect(block.replace(/:focus-visible \{[^}]*\}/, '')).not.toMatch(/outline/);
  });
  it('draws the forced-colors focus ring after the pressed and current states, so it wins at equal specificity', () => {
    const block = css.slice(css.indexOf('@media (forced-colors: active) {'), css.indexOf('@media (pointer: coarse) {'));
    expect(block.indexOf(':focus-visible')).toBeGreaterThan(block.indexOf('[aria-pressed="true"]'));
    expect(block.indexOf(':focus-visible')).toBeGreaterThan(block.indexOf('[aria-current]'));
  });
  it('gives touch screens 44 px targets and 16 px inputs', () => {
    const block = css.slice(css.indexOf('@media (pointer: coarse) {'));
    expect(block).toMatch(/min-height: 2\.75rem/);
    expect(block).toMatch(/font-size: 1rem/);
    // the summary keeps display: list-item, or the disclosure marker disappears on touch screens
    expect(block).not.toMatch(/details > summary[^{]*\{[^}]*display:/);
    expect(block).toMatch(/details > summary \{[^}]*min-height: 2\.75rem/);
    expect(block).not.toMatch(/\.chip, details > summary/);
  });
  it('rings a focused preview frame, and marks busy htmx controls', () => {
    expect(rule('.preview:focus-visible')).toContain('outline: 2px solid var(--accent)');
    expect(css).toMatch(/\.htmx-request \.btn, \.btn\[disabled\] \{ opacity: 0\.6; cursor: progress; \}/);
  });
});
