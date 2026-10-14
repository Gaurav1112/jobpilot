import { describe, expect, it } from 'vitest';
import { childText, children, parseXml, XmlError } from '../../src/app/text/xml-lite.js';

describe('parseXml', () => {
  it('reads elements, text, CDATA, entities, comments, the prolog and self-closing tags', () => {
    const root = parseXml(`<?xml version="1.0"?>\n<!-- c --><a x="1 > 0"><b>R&amp;D &lt;x&gt; &#65;&#x42;</b><c><![CDATA[<p>hi</p>]]></c><d/><e></e><tt:f>1</tt:f></a>`);
    expect(root.name).toBe('a');
    expect(childText(root, 'b')).toBe('R&D <x> AB');
    expect(childText(root, 'c')).toBe('<p>hi</p>');
    expect(children(root, 'd')).toHaveLength(1);
    expect(childText(root, 'e')).toBe('');
    expect(childText(root, 'tt:f')).toBe('1');
    expect(childText(root, 'missing')).toBeNull();
  });
  it('decodes one level only: escaped HTML stays the HTML string', () => {
    expect(childText(parseXml('<a><d>&lt;p&gt;a &amp;amp; b&lt;/p&gt;</d></a>'), 'd')).toBe('<p>a &amp; b</p>');
  });
  it('rejects malformed documents by name', () => {
    for (const bad of ['', 'nothing', '<a><b></a>', '<a>', '<a></b>', '<a><b></b></a><c/>', '<a x="1></a>', '<!-- never closed', '<a><![CDATA[x</a>', '<![CDATA[x]]><a/>', '<a/><![CDATA[x]]>']) {
      expect(() => parseXml(bad), bad).toThrow(XmlError);
    }
  });
  it('refuses a document past its depth or node cap', () => {
    expect(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100))).toThrow(/deeper/);
    expect(() => parseXml(`<a>${'<b/>'.repeat(50)}</a>`, { maxNodes: 10 })).toThrow(/nodes/);
  });
  it('is linear on 1 MB adversarial input', () => {
    const cases = ['<a>' + '<'.repeat(1_000_000), '<a>' + '<![CDATA['.repeat(100_000), '<a ' + 'x="'.repeat(300_000), '<a>' + '&'.repeat(1_000_000) + '</a>', '<!--'.repeat(250_000), '<a>' + '<b>'.repeat(30) + '<c/>'.repeat(250_000), '<a>' + '&#'.repeat(500_000) + '</a>', '<a>' + '</'.repeat(500_000)];
    for (const c of cases) {
      const t = performance.now();
      try {
        parseXml(c);
      } catch {
        /* rejected is fine */
      }
      expect(performance.now() - t, c.slice(0, 12)).toBeLessThan(400);
    }
  });
});
