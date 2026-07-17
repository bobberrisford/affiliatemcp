import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/brand-data/csv.js';

describe('toCsv', () => {
  it('returns an empty string for no rows', () => {
    expect(toCsv([])).toBe('');
  });

  it('renders a header from the first row and one line per row', () => {
    const csv = toCsv([
      { programId: 'p1', commission: 10, currency: 'GBP' },
      { programId: 'p2', commission: 5, currency: 'GBP' },
    ]);
    expect(csv).toBe('programId,commission,currency\np1,10,GBP\np2,5,GBP\n');
  });

  it('quotes fields containing commas, quotes, or newlines and doubles quotes', () => {
    const csv = toCsv([{ name: 'Acme, Inc', note: 'say "hi"', multi: 'a\nb' }]);
    expect(csv).toBe('name,note,multi\n"Acme, Inc","say ""hi""","a\nb"\n');
  });

  it('renders null/undefined as empty and objects as JSON', () => {
    const csv = toCsv([{ a: null, b: undefined, c: { x: 1 } }]);
    expect(csv).toBe('a,b,c\n,,"{""x"":1}"\n');
  });
});
