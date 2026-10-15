import { describe, expect, it } from 'vitest';
import { attrsOf, blockOf, decode, elementsWith, linksOf, rowOf, textOf } from './dom.js';

const PAGE = `<ol class="jobs"><li class="job" data-job="k1"><h2><a href="/jobs/k1">A &amp; B</a></h2><ul><li>x</li></ul></li>
<li class="job" data-job="k2"><a class="btn" href="/x" rel="noopener noreferrer" target="_blank">Open<span class="visually-hidden"> (new tab)</span></a><input type="hidden" name="_csrf" value="t"></li></ol>`;

describe('dom helpers', () => {
  it('decodes the five escapes and numeric references', () => {
    expect(decode('&lt;b&gt; &amp; &quot;q&quot; don&#39;t &#x2013; &#8212;')).toBe('<b> & "q" don\'t – —');
  });
  it('textOf drops tags, scripts and styles, and collapses whitespace', () => {
    expect(textOf('<style>p{}</style><p>Pay   <b>₹12 LPA</b></p>\n<script>x()</script>')).toBe('Pay ₹12 LPA');
  });
  it('blockOf returns an element with its nested same-name children', () => {
    const i = PAGE.indexOf('<li class="job" data-job="k1"');
    expect(blockOf(PAGE, i)).toBe('<li class="job" data-job="k1"><h2><a href="/jobs/k1">A &amp; B</a></h2><ul><li>x</li></ul></li>');
  });
  it('a void element is its own block', () => {
    expect(blockOf(PAGE, PAGE.indexOf('<input'))).toBe('<input type="hidden" name="_csrf" value="t">');
  });
  it('elementsWith and rowOf find elements by attribute', () => {
    expect(elementsWith(PAGE, 'data-job').map((e) => attrsOf(e)['data-job'])).toEqual(['k1', 'k2']);
    expect(textOf(rowOf(PAGE, 'data-job', 'k1'))).toBe('A & B x');
    expect(() => rowOf(PAGE, 'data-job', 'k9')).toThrow(/expected one element with data-job="k9", found 0/);
  });
  it('linksOf gives each link its href, visible text and attributes', () => {
    expect(linksOf(PAGE)).toEqual([
      { href: '/jobs/k1', text: 'A & B', attrs: { href: '/jobs/k1' } },
      { href: '/x', text: 'Open (new tab)', attrs: { class: 'btn', href: '/x', rel: 'noopener noreferrer', target: '_blank' } },
    ]);
  });
});
