import { describe, it, expect } from 'vitest';
import {
  createSmnClinicParser,
  normalizeClinicLabel,
  extractPostingDepartmentLabels,
} from '../scripts/lib/smn-clinic-job-parser.mjs';
import {
  matchesHopitalDeMoutierPosting,
} from '../scripts/lib/hopital-de-moutier-job-parser.mjs';
import {
  matchesKlinikSiloahPosting,
} from '../scripts/lib/klinik-siloah-job-parser.mjs';

/**
 * Since July 2026 the SMN clinic factory filters the SmartRecruiters
 * postings API (tenant SwissMedicalNetwork1) by ATS department label —
 * the legacy swissmedical.net `?clinic=XXX` HTML filter drifted to
 * Brands and silently returned zero tiles (issues #3857, #3859).
 */

function posting(overrides: Record<string, unknown> = {}) {
  return {
    id: '744000136408530',
    name: 'Chef de clinique en Pédopsychiatrie',
    releasedDate: '2026-07-08T08:31:20.127Z',
    location: { city: 'Moutier', region: 'JU', country: 'ch', postalCode: '2740' },
    department: { id: '5486128', label: 'Hôpital de Moutier' },
    customField: [
      { fieldLabel: 'Department', valueLabel: 'Hôpital de Moutier' },
      { fieldLabel: 'Brands', valueLabel: "Réseau de l'Arc" },
    ],
    ...overrides,
  };
}

describe('normalizeClinicLabel', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeClinicLabel('Hôpital de Moutier')).toBe('hopital de moutier');
    expect(normalizeClinicLabel('Clinique de Valère')).toBe('clinique de valere');
  });

  it('collapses punctuation and whitespace runs', () => {
    expect(normalizeClinicLabel('Clinique Générale-Beaulieu')).toBe('clinique generale beaulieu');
    expect(normalizeClinicLabel("  Réseau   de l'Arc ")).toBe('reseau de l arc');
  });

  it('handles empty/nullish input', () => {
    expect(normalizeClinicLabel('')).toBe('');
    expect(normalizeClinicLabel(undefined as unknown as string)).toBe('');
  });
});

describe('extractPostingDepartmentLabels', () => {
  it('collects structured department and Department custom field (deduped)', () => {
    expect(extractPostingDepartmentLabels(posting())).toEqual(['hopital de moutier']);
  });

  it('keeps distinct labels from both sources', () => {
    const labels = extractPostingDepartmentLabels(posting({
      department: { label: 'Privatklinik Siloah' },
      customField: [{ fieldLabel: 'Department', valueLabel: "Réseau de l'Arc" }],
    }));
    expect(labels).toContain('privatklinik siloah');
    expect(labels).toContain('reseau de l arc');
  });

  it('ignores other custom fields and missing data', () => {
    expect(extractPostingDepartmentLabels({ customField: [{ fieldLabel: 'Brands', valueLabel: 'X' }] })).toEqual([]);
    expect(extractPostingDepartmentLabels({})).toEqual([]);
    expect(extractPostingDepartmentLabels(undefined as unknown as object)).toEqual([]);
  });
});

describe('createSmnClinicParser — matchesClinicPosting', () => {
  const parser = createSmnClinicParser({
    companyKey: 'test-clinic',
    companyName: 'Clinique Générale-Beaulieu',
    clinicCode: 'CGB',
    defaultCanton: 'GE',
    defaultCity: 'Genève',
    defaultPostalCode: '1206',
  });

  it('matches by department label, diacritic/punctuation-insensitive', () => {
    expect(parser.matchesClinicPosting(posting({
      department: { label: 'Clinique Generale Beaulieu' },
      customField: [],
    }))).toBe(true);
  });

  it('matches via the Department custom field when structured department differs', () => {
    expect(parser.matchesClinicPosting(posting({
      department: { label: 'Something Else' },
      customField: [{ fieldLabel: 'Department', valueLabel: 'Clinique Générale-Beaulieu' }],
    }))).toBe(true);
  });

  it('rejects other clinics and empty postings', () => {
    expect(parser.matchesClinicPosting(posting())).toBe(false); // Hôpital de Moutier
    expect(parser.matchesClinicPosting({})).toBe(false);
  });

  it('does not match Brands custom field values', () => {
    expect(parser.matchesClinicPosting(posting({
      department: { label: 'Other' },
      customField: [{ fieldLabel: 'Brands', valueLabel: 'Clinique Générale-Beaulieu' }],
    }))).toBe(false);
  });
});

describe('Hôpital de Moutier clinic attribution (issue #3857)', () => {
  it('matches its own department', () => {
    expect(matchesHopitalDeMoutierPosting(posting())).toBe(true);
  });

  it("matches network department Réseau de l'Arc only in Moutier city", () => {
    const rdaMoutier = posting({
      department: { label: "Réseau de l'Arc" },
      customField: [{ fieldLabel: 'Department', valueLabel: "Réseau de l'Arc" }],
    });
    expect(matchesHopitalDeMoutierPosting(rdaMoutier)).toBe(true);
  });

  it("rejects Réseau de l'Arc postings in other cities (Saint-Imier, Biel, Bellelay)", () => {
    for (const city of ['Saint-Imier', 'Biel', 'Bellelay']) {
      const rdaElsewhere = posting({
        department: { label: "Réseau de l'Arc" },
        customField: [{ fieldLabel: 'Department', valueLabel: "Réseau de l'Arc" }],
        location: { city, country: 'ch' },
      });
      expect(matchesHopitalDeMoutierPosting(rdaElsewhere)).toBe(false);
    }
  });

  it('rejects sister-clinic departments even in Moutier context', () => {
    expect(matchesHopitalDeMoutierPosting(posting({
      department: { label: 'Medizinisches Zentrum Biel' },
      customField: [{ fieldLabel: 'Department', valueLabel: 'Medizinisches Zentrum Biel' }],
    }))).toBe(false);
  });
});

describe('Privatklinik Siloah clinic attribution (issue #3859)', () => {
  it('matches only its own department', () => {
    expect(matchesKlinikSiloahPosting(posting({
      department: { label: 'Privatklinik Siloah' },
      customField: [{ fieldLabel: 'Department', valueLabel: 'Privatklinik Siloah' }],
      location: { city: 'Gümligen', country: 'ch' },
    }))).toBe(true);
  });

  it('rejects the Siloah sister units (distinct departments)', () => {
    for (const label of ['Ärztezentrum Siloah Liebefeld', 'Ärztezentrum Siloah Murten']) {
      expect(matchesKlinikSiloahPosting(posting({
        department: { label },
        customField: [{ fieldLabel: 'Department', valueLabel: label }],
        location: { city: 'Liebefeld', country: 'ch' },
      }))).toBe(false);
    }
  });

  it('rejects unrelated clinics', () => {
    expect(matchesKlinikSiloahPosting(posting())).toBe(false);
  });
});
