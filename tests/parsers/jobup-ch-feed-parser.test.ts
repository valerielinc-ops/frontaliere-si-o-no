/**
 * Tests for the shared jobup.ch feed parser.
 *
 * Covers Romandie employers that publish jobs via the jobup.ch mask endpoint
 * (used by the Jalios JCMS PluginJobUp integration and others):
 *   - Pôle Santé Pays-d'Enhaut (key `hpe`) — VD Château-d'Oex
 *   - eHnv (key `ehnv`) — VD Yverdon-les-Bains
 *
 * Verifies:
 *   - Exported constants on each thin wrapper
 *   - isCompanyJob / isTrustedDomain matchers
 *   - parseJobupLieu (postal + city extraction from `lieu` field)
 *   - parseJobupDate (DD/MM/YYYY → YYYY-MM-DD)
 *   - detectEmploymentTypeFromOccupation (range → FULL_TIME/PART_TIME/OTHER)
 *   - Double-decoded HTML entities (jobup returns `&amp;nbsp;` → ` `)
 */
import { describe, it, expect } from 'vitest';
import {
  createJobupChFeedParser,
  parseJobupLieu,
  parseJobupDate,
  detectEmploymentTypeFromOccupation,
  decodeEntities,
} from '../../scripts/lib/jobup-ch-feed-common.mjs';
import {
  POLE_SANTE_PAYS_ENHAUT_KEY,
  POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME,
  isPoleSantePaysEnhautJob,
  isTrustedDomain as isPsTrusted,
} from '../../scripts/lib/pole-sante-pays-enhaut-job-parser.mjs';
import {
  EHNV_KEY,
  EHNV_COMPANY_NAME,
  isEhnvJob,
  isTrustedDomain as isEhnvTrusted,
} from '../../scripts/lib/ehnv-job-parser.mjs';

describe('jobup.ch employers — exported constants', () => {
  it('PSPE constants', () => {
    expect(POLE_SANTE_PAYS_ENHAUT_KEY).toBe('pole-sante-pays-enhaut');
    expect(POLE_SANTE_PAYS_ENHAUT_COMPANY_NAME).toMatch(/Pays-d'Enhaut/);
  });

  it('eHnv constants', () => {
    expect(EHNV_KEY).toBe('ehnv');
    expect(EHNV_COMPANY_NAME).toMatch(/Nord Vaudois/);
  });
});

describe('isCompanyJob — matchers', () => {
  it('PSPE matches by jobup mask URL', () => {
    expect(isPoleSantePaysEnhautJob({ url: 'https://www.jobup.ch/masks/hpe/anything' })).toBe(true);
    expect(isPoleSantePaysEnhautJob({ url: 'https://www.jobup.ch/masks/ehnv/anything' })).toBe(false);
  });

  it('PSPE matches by corporate domain', () => {
    expect(isPoleSantePaysEnhautJob({ url: 'https://www.pspe.ch/jcms/x' })).toBe(true);
  });

  it('eHnv matches by mask + corporate domain', () => {
    expect(isEhnvJob({ url: 'https://www.jobup.ch/masks/ehnv/anything' })).toBe(true);
    expect(isEhnvJob({ url: 'https://www.ehnv.ch/emplois' })).toBe(true);
  });
});

describe('isTrustedDomain — jobup.ch is always trusted', () => {
  it('PSPE trusts jobup.ch and pspe.ch', () => {
    expect(isPsTrusted('https://www.jobup.ch/fr/emplois/detail/xyz')).toBe(true);
    expect(isPsTrusted('https://jobup.ch/x')).toBe(true);
    expect(isPsTrusted('https://www.pspe.ch/x')).toBe(true);
    expect(isPsTrusted('https://malicious.example/x')).toBe(false);
  });

  it('eHnv trusts jobup.ch and ehnv.ch', () => {
    expect(isEhnvTrusted('https://www.jobup.ch/x')).toBe(true);
    expect(isEhnvTrusted('https://www.ehnv.ch/x')).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isPsTrusted('not-a-url')).toBe(false);
    expect(isPsTrusted('')).toBe(false);
  });
});

describe('parseJobupLieu — postal code + city extraction', () => {
  it('splits "1660 Château-d\'Oex"', () => {
    expect(parseJobupLieu('1660 Château-d\'Oex')).toEqual({ postal: '1660', city: 'Château-d\'Oex' });
  });

  it('decodes entity-encoded city names', () => {
    expect(parseJobupLieu('1400 Yverdon-les-Bains')).toEqual({ postal: '1400', city: 'Yverdon-les-Bains' });
  });

  it('handles missing postal code', () => {
    expect(parseJobupLieu('Lausanne')).toEqual({ postal: '', city: 'Lausanne' });
  });

  it('handles entity-encoded city', () => {
    expect(parseJobupLieu('1660 Ch&#226;teau d\'Oex')).toEqual({ postal: '1660', city: 'Château d\'Oex' });
  });

  it('returns empty for empty input', () => {
    expect(parseJobupLieu('')).toEqual({ postal: '', city: '' });
  });
});

describe('parseJobupDate — DD/MM/YYYY → ISO', () => {
  it('parses two-digit day and month', () => {
    expect(parseJobupDate('11/05/2026')).toBe('2026-05-11');
  });

  it('parses single-digit day and month', () => {
    expect(parseJobupDate('3/5/2024')).toBe('2024-05-03');
  });

  it('returns empty for invalid input', () => {
    expect(parseJobupDate('not-a-date')).toBe('');
    expect(parseJobupDate('2024-05-03')).toBe('');
    expect(parseJobupDate('')).toBe('');
  });
});

describe('detectEmploymentTypeFromOccupation', () => {
  it('detects FULL_TIME at >=90%', () => {
    expect(detectEmploymentTypeFromOccupation('100', '100%')).toBe('FULL_TIME');
    expect(detectEmploymentTypeFromOccupation('80', '100%')).toBe('FULL_TIME');
    expect(detectEmploymentTypeFromOccupation('90', '90')).toBe('FULL_TIME');
  });

  it('detects PART_TIME at <90%', () => {
    expect(detectEmploymentTypeFromOccupation('50', '70%')).toBe('PART_TIME');
    expect(detectEmploymentTypeFromOccupation('20', '40%')).toBe('PART_TIME');
  });

  it('returns OTHER for missing data', () => {
    expect(detectEmploymentTypeFromOccupation('', '')).toBe('OTHER');
    expect(detectEmploymentTypeFromOccupation('', '0%')).toBe('OTHER');
  });
});

describe('decodeEntities — handles double-encoded entities', () => {
  it('decodes single-encoded named entities', () => {
    expect(decodeEntities('Foo&nbsp;Bar')).toBe('Foo Bar');
    expect(decodeEntities('Ch&acirc;teau')).toBe('Château');
  });

  it('decodes double-encoded entities (jobup quirk)', () => {
    // jobup returns "Bâtiment&amp;nbsp;/&amp;nbsp;Construction"
    // where `&amp;nbsp;` should become ` ` (space)
    expect(decodeEntities('B&#226;timent&amp;nbsp;/&amp;nbsp;Construction')).toBe('Bâtiment / Construction'.replace(/ /g, ' '));
  });

  it('decodes numeric entities', () => {
    expect(decodeEntities('&#8217;')).toBe('’');
    expect(decodeEntities('&#x2014;')).toBe('—');
  });

  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&unknownEntity;')).toBe('&unknownEntity;');
  });
});

describe('createJobupChFeedParser — config validation', () => {
  it('throws on missing required config', () => {
    expect(() => createJobupChFeedParser({} as any)).toThrow();
    expect(() => createJobupChFeedParser({
      companyKey: 'x',
      companyName: 'X',
      // missing jobupKey, defaultCanton
    } as any)).toThrow();
  });

  it('returns the three required functions', () => {
    const p = createJobupChFeedParser({
      companyKey: 'test',
      companyName: 'Test',
      companyDomain: 'test.ch',
      jobupKey: 'test',
      defaultCanton: 'VD',
      defaultCity: 'Lausanne',
      defaultPostalCode: '1000',
    });
    expect(typeof p.fetchAllJobs).toBe('function');
    expect(typeof p.isCompanyJob).toBe('function');
    expect(typeof p.isTrustedDomain).toBe('function');
  });
});
