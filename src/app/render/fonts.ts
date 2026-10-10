import { readFileSync } from 'node:fs';

/**
 * The fonts embedded in rendered PDFs (Task 10 fix round 1): Noto Sans Regular and Bold (hinted TTF from
 * github.com/notofonts/notofonts.github.io, `fonts/NotoSans/hinted/ttf/`, Copyright 2022 The Noto Project Authors,
 * SIL Open Font License 1.1, vendored with `assets/fonts/OFL.txt`). Noto Sans was picked over Liberation Sans 2.1.5
 * because Liberation lacks U+20B9 (₹); both cover Latin Extended-A/B, Greek and Cyrillic.
 *
 * Trusted render library: it reads exactly these two vendored files, once, and nothing else (`scanRenderLib`).
 */
export const FONT_FILES = { regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' } as const;
const DIR = new URL('../../../assets/fonts/', import.meta.url);

let cache: { readonly regular: Uint8Array; readonly bold: Uint8Array } | undefined;

export function fontBytes(): { readonly regular: Uint8Array; readonly bold: Uint8Array } {
  cache ??= {
    regular: new Uint8Array(readFileSync(new URL(FONT_FILES.regular, DIR))),
    bold: new Uint8Array(readFileSync(new URL(FONT_FILES.bold, DIR))),
  };
  return cache;
}
