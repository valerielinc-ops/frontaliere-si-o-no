import { describe, it, expect } from 'vitest';
import { formatSalary } from '../components/community/JobBoard';

describe('formatSalary — salarySource estimate suffix (#6403)', () => {
  const base = { salaryMin: 91000, salaryMax: 118000, currency: 'CHF' as const };

  it('appends the localized «(stima)» suffix when salarySource is "estimated"', () => {
    const result = formatSalary({ ...base, salarySource: 'estimated' }, 'it');
    expect(result).toBe('CHF 91k – 118k (stima)');
  });

  it('uses the locale-specific suffix for other locales', () => {
    expect(formatSalary({ ...base, salarySource: 'estimated' }, 'en')).toBe('CHF 91k – 118k (est.)');
    expect(formatSalary({ ...base, salarySource: 'estimated' }, 'de')).toBe('CHF 91k – 118k (Schätzung)');
    expect(formatSalary({ ...base, salarySource: 'estimated' }, 'fr')).toBe('CHF 91k – 118k (est.)');
  });

  it('renders no suffix when salarySource is "reported"', () => {
    expect(formatSalary({ ...base, salarySource: 'reported' }, 'it')).toBe('CHF 91k – 118k');
  });

  it('renders no suffix when salarySource is absent (legacy records)', () => {
    expect(formatSalary({ ...base }, 'it')).toBe('CHF 91k – 118k');
  });

  it('returns null when there is no usable salary data', () => {
    expect(formatSalary({ currency: 'CHF', salarySource: 'estimated' }, 'it')).toBeNull();
  });
});
