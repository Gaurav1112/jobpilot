import { escapeHtml } from '../render/html.js';

/**
 * The dashboard's only way to build HTML (Task 13). `html` is a tagged template: every interpolated value is
 * HTML-escaped (the five characters `& < > " '`), so a value is safe in element text and in a double- or
 * single-quoted attribute. The only values passed through unescaped are `Html` fragments, and the only way to make
 * one is another `html` template: there is no raw-string escape hatch. Views never build markup any other way
 * (a test scans `views/` for template interpolation outside `html`).
 *
 * Accepted values: strings, finite numbers, booleans (`false` renders nothing, `true` renders "true"), null and
 * undefined (nothing), `Html`, and arrays of those (concatenated). Anything else throws, so an object can never
 * render as "[object Object]".
 */
/** The only key that can make an `Html`; never exported, so no other module can wrap a raw string. */
const MINT = Symbol('Html.mint');

export class Html {
  readonly value: string;
  constructor(key: typeof MINT, value: string) {
    if (key !== MINT) throw new TypeError('Html values come only from the html template');
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export type HtmlValue = Html | string | number | boolean | null | undefined | readonly HtmlValue[];

function render(v: HtmlValue): string {
  if (v instanceof Html) return v.value;
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`html: refusing to render the number ${String(v)}`);
    return String(v);
  }
  if (v === true) return 'true';
  if (Array.isArray(v)) return v.map(render).join('');
  throw new TypeError(`html: refusing to render a ${typeof v}`);
}

export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i] as HtmlValue) + (strings[i + 1] ?? '');
  return new Html(MINT, out);
}

/** A URL safe for an `href` that leaves the dashboard: http(s) only, else undefined (the link is not rendered). */
export function externalUrl(u: string): string | undefined {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
