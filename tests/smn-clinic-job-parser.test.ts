import { describe, it, expect } from 'vitest';
import {
  createSmnClinicParser,
  normalizeClinicLabel,
  extractPostingDepartmentLabels,
  classifyZeroMatchRun,
  fetchOutcomeForZeroMatch,
  suggestDirectoryLabels,
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

/**
 * Issue #7320: a clinic with no current openings and a renamed ATS department
 * look identical in the postings payload — the configured label is absent in
 * both cases. Only the tenant department directory tells them apart.
 */
describe('classifyZeroMatchRun (drift vs empty board, issue #7320)', () => {
  const targets = ['clinique de montchoisi'];

  it('reports "matched" when a configured label is in the payload, directory irrelevant', () => {
    expect(classifyZeroMatchRun({
      targets,
      seenLabels: new Set(['clinique de montchoisi', 'motionlab']),
      directoryLabels: null,
    })).toBe('matched');
  });

  it('reports "empty-board" when the department is still live in the directory', () => {
    expect(classifyZeroMatchRun({
      targets,
      seenLabels: new Set(['motionlab', 'swiss visio']),
      directoryLabels: new Set(['clinique de montchoisi', 'centre medical montchoisi']),
    })).toBe('empty-board');
  });

  it('reports "label-drift" only when the department is gone from the directory too', () => {
    expect(classifyZeroMatchRun({
      targets,
      seenLabels: new Set(['motionlab']),
      directoryLabels: new Set(['centre medical montchoisi', 'clinique de genolier']),
    })).toBe('label-drift');
  });

  it('reports "unverified" instead of guessing when the directory is unreachable', () => {
    expect(classifyZeroMatchRun({
      targets,
      seenLabels: new Set(['motionlab']),
      directoryLabels: null,
    })).toBe('unverified');
  });

  it('accepts a city-scoped label as payload evidence ("matched")', () => {
    expect(classifyZeroMatchRun({
      targets: ['hopital de moutier', 'reseau de l arc'],
      directoryTargets: ['hopital de moutier'],
      seenLabels: new Set(['reseau de l arc']),
      directoryLabels: new Set(['reseau de l arc']),
    })).toBe('matched');
  });

  it('ignores a city-scoped network brand in the DIRECTORY check (drift stays detectable)', () => {
    // "Réseau de l'Arc" is listed in the tenant directory whatever happens to
    // Moutier: counting it as evidence would permanently mute drift detection.
    expect(classifyZeroMatchRun({
      targets: ['hopital de moutier', 'reseau de l arc'],
      directoryTargets: ['hopital de moutier'],
      seenLabels: new Set(['clinique de genolier']),
      directoryLabels: new Set(['reseau de l arc']),
    })).toBe('label-drift');
  });

  it('still reports "empty-board" when the clinic\'s OWN label is in the directory', () => {
    expect(classifyZeroMatchRun({
      targets: ['hopital de moutier', 'reseau de l arc'],
      directoryTargets: ['hopital de moutier'],
      seenLabels: new Set(['clinique de genolier']),
      directoryLabels: new Set(['reseau de l arc', 'hopital de moutier']),
    })).toBe('empty-board');
  });

  it('falls back to targets when directoryTargets is omitted', () => {
    expect(classifyZeroMatchRun({
      targets,
      seenLabels: new Set(['motionlab']),
      directoryLabels: new Set(['clinique de montchoisi']),
    })).toBe('empty-board');
  });

  it('treats an EMPTY directory as a non-observation, not as drift', () => {
    // assertJsonListShape warns and returns [] on an unexpected envelope, so an
    // empty directory cannot be told apart from a degraded fetch.
    expect(classifyZeroMatchRun({
      targets,
      directoryTargets: targets,
      seenLabels: new Set(['motionlab']),
      directoryLabels: new Set(),
    })).toBe('unverified');
  });

  it('reports "unverified" when the clinic has no own label to check', () => {
    expect(classifyZeroMatchRun({
      targets: ['reseau de l arc'],
      directoryTargets: [],
      seenLabels: new Set(['clinique de genolier']),
      directoryLabels: new Set(['reseau de l arc']),
    })).toBe('unverified');
  });

  it('defaults to "unverified" on empty input rather than throwing', () => {
    expect(classifyZeroMatchRun()).toBe('unverified');
  });
});

describe('suggestDirectoryLabels', () => {
  const directory = [
    { label: 'Centre Médical Montchoisi' },
    { label: 'Clinique de Genolier' },
    { label: 'MotionLab' },
  ];

  it('surfaces rename candidates sharing a significant word', () => {
    expect(suggestDirectoryLabels(['clinique de montchoisi'], directory))
      .toEqual(['Centre Médical Montchoisi', 'Clinique de Genolier']);
  });

  it('ignores short filler words', () => {
    expect(suggestDirectoryLabels(['de la'], directory)).toEqual([]);
  });

  it('returns an empty list on empty input', () => {
    expect(suggestDirectoryLabels([], directory)).toEqual([]);
    expect(suggestDirectoryLabels(['motionlab'])).toEqual([]);
  });
});

describe('fetchOutcomeForZeroMatch (slice lastFetchOutcome, issue #7897)', () => {
  it('reports a label drift as selector_miss', () => {
    // The verdict the crawler-health monitor could never reach on its own: a
    // drifted run and an idle board both publish `total: 0`, so the streak gate
    // waited three days and then still only said "returned 0 jobs".
    expect(fetchOutcomeForZeroMatch('label-drift')).toBe('selector_miss');
  });

  it('reports a genuinely empty board as ok', () => {
    // Fetch and parse both worked — the clinic simply has no openings. `ok`
    // says nothing about the count, so the existing gates keep owning the run.
    expect(fetchOutcomeForZeroMatch('empty-board')).toBe('ok');
    expect(fetchOutcomeForZeroMatch('matched')).toBe('ok');
  });

  it('omits the field when the directory could not be read', () => {
    // `unverified` means the run separated nothing. Emitting `ok` here would
    // assert a healthy parser on no evidence — the #7320 guess-from-absence,
    // pointing the other way. Absent is a different claim, and the monitor
    // reads it as "no verdict" and falls back to the pre-#7897 behaviour.
    expect(fetchOutcomeForZeroMatch('unverified')).toBeNull();
  });

  it('omits the field for an unknown verdict rather than inventing one', () => {
    expect(fetchOutcomeForZeroMatch(undefined as unknown as 'matched')).toBeNull();
  });
});
