import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskCommands, maskValues, numberForms } from '../../src/app/hosted/mask.js';
import { loadPack } from '../../src/app/pack/load.js';

const { pack } = loadPack(resolve(import.meta.dirname, '../fixtures/pack'));

describe('numberForms', () => {
  it('gives plain, en-IN, international and LPA forms in that order', () => {
    expect(numberForms(1_200_000)).toEqual(['1200000', '12,00,000', '1,200,000', '12 LPA']);
    expect(numberForms(1_250_000)).toContain('12.5 LPA');
    expect(numberForms(1_234_567)).toContain('12.35 LPA');
    expect(numberForms(40)).toEqual(['40']);
    expect(numberForms(99_999)).not.toContain('1 LPA');
  });
});

describe('maskValues', () => {
  const values = maskValues(pack);
  it('holds the contact, employers and forbidden terms of the fixture pack', () => {
    for (const v of ['Asha Rao', 'Asha', 'asha.rao@example.com', '+91 90000 00000', '919000000000', 'Pune', 'https://example.com/asha-rao', 'Northwind Labs', 'Contoso Retail', 'Fabrikam', 'Initech', 'Initech India (GCC for Northwind)']) {
      expect(values, v).toContain(v);
    }
  });
  it('holds the number forms of both floors and drops anything under 3 characters', () => {
    expect(values).toContain('12,00,000');
    expect(values).toContain('12 LPA');
    expect(values).not.toContain('40');
    expect(values.every((v) => v.length >= 3)).toBe(true);
    expect(values).toEqual([...new Set(values)].sort());
  });
});

describe('maskCommands', () => {
  it('escapes workflow-command characters and masks multi-line values line by line', () => {
    expect(maskCommands(['a%b', 'x\ny'])).toEqual(['::add-mask::a%25b', '::add-mask::x%0Ay', '::add-mask::x', '::add-mask::y']);
    expect(maskCommands(['a\r\nb'])).toEqual(['::add-mask::a%0D%0Ab', '::add-mask::a', '::add-mask::b']);
  });
});
