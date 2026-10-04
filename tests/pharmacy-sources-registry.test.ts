import { describe, expect, it } from 'vitest';

import registry from '../data/pharmacy-sources-registry.json';
import {
  validatePharmacySourcesRegistry,
  validatePharmacySourceEntry,
} from '../services/pharmacies/types';
import { SWISS_CANTONS } from '../services/pharmacies/swissCantons';

const ASSOCIATION_CANTON_KEYS = new Set([
  'aargau',
  'bern',
  'fribourg',
  'geneva',
  'graubunden',
  'lucerne',
  'neuchatel',
  'solothurn',
  'thurgau',
  'vaud',
  'valais',
  'zurich',
]);

/**
 * Schema guard for `data/pharmacy-sources-registry.json` (#6397, prereq for
 * the #6173 pharmacy/pharmacy-duty MVP). The registry maps the complete
 * `SWISS_CANTONS` geography to source configuration; every entry must carry
 * the full source-config shape so connectors share one contract. Ticino and
 * the verified Geneva/Jura/Basel-Stadt/Solothurn/Zürich adapters are active;
 * the remaining entries stay source-only until their release contract is complete.
 */
describe('pharmacy sources registry schema', () => {
  it('passes full-registry validation with zero errors', () => {
    const errors = validatePharmacySourcesRegistry(registry);
    expect(errors).toEqual([]);
  });

  it('covers exactly all 26 canton keys and codes from SWISS_CANTONS', () => {
    const registryKeys = Object.keys(registry.sources).sort();
    const cantonKeys = SWISS_CANTONS.map((canton) => canton.key).sort();

    expect(SWISS_CANTONS).toHaveLength(26);
    expect(new Set(SWISS_CANTONS.map((canton) => canton.code)).size).toBe(26);
    expect(registryKeys).toEqual(cantonKeys);

    for (const canton of SWISS_CANTONS) {
      const source = registry.sources[canton.key];
      expect(source.canton).toBe(canton.names.it);
      expect(source.officialSourceUrl).toMatch(/^https:\/\//);
      expect(source.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    }
  });

  it('ticino is "active" with html-scrape access, verified against ofct.ch (#6398)', () => {
    expect(registry.sources.ticino.status).toBe('active');
    expect(registry.sources.ticino.accessMethod).toBe('html-scrape');
  });

  it('Jura is active only after the official PDF adapter is registered', () => {
    expect(registry.sources.jura).toMatchObject({
      officialSourceUrl: 'https://www.jura.ch/fr/Autorites/Administration/CHA/SIC/Urgences/Numeros-d-urgence-Urgence.html',
      accessMethod: 'pdf',
      sourceType: 'official',
      fetchFrequency: 'P1D',
      status: 'active',
      dutiesPath: 'data/pharmacy-duties-swiss-cantons.json',
      dutiesKey: 'JU',
    });
    const sourceFetchedAt = registry.sources.jura.sourceFetchedAt;
    expect(typeof sourceFetchedAt).toBe('string');
    expect(Number.isFinite(Date.parse(sourceFetchedAt || ''))).toBe(true);
  });

  it('Basel-Stadt is active only after the official 24-hour pharmacy adapter is registered', () => {
    expect(registry.sources['basel-stadt']).toMatchObject({
      officialSourceUrl: 'https://www.bs.ch/gd/md/hoheitliche-funktionen/kantonsapothekerin/liste-der-apotheken-basel-stadt',
      accessMethod: 'html-scrape',
      sourceType: 'official',
      fetchFrequency: 'P1D',
      status: 'active',
      dutiesPath: 'data/pharmacy-duties-swiss-cantons.json',
      dutiesKey: 'BS',
    });
    const sourceFetchedAt = registry.sources['basel-stadt'].sourceFetchedAt;
    expect(typeof sourceFetchedAt).toBe('string');
    expect(Number.isFinite(Date.parse(sourceFetchedAt || ''))).toBe(true);
  });

  it('Zürich is active only after the official 24-hour pharmacy adapter is registered', () => {
    expect(registry.sources.zurich).toMatchObject({
      officialSourceUrl: 'https://www.avkz.ch/notfalldienst',
      accessMethod: 'html-scrape',
      sourceType: 'association',
      fetchFrequency: 'P1D',
      status: 'active',
      dutiesPath: 'data/pharmacy-duties-swiss-cantons.json',
      dutiesKey: 'ZH',
    });
    const sourceFetchedAt = registry.sources.zurich.sourceFetchedAt;
    expect(typeof sourceFetchedAt).toBe('string');
    expect(Number.isFinite(Date.parse(sourceFetchedAt || ''))).toBe(true);
  });

  it('Solothurn is active only after the AVSO three-region adapter is registered', () => {
    expect(registry.sources.solothurn).toMatchObject({
      officialSourceUrl: 'https://avso.ch/notfalldienst-apotheken/',
      accessMethod: 'html-scrape',
      sourceType: 'association',
      fetchFrequency: 'P1D',
      status: 'active',
      dutiesPath: 'data/pharmacy-duties-swiss-cantons.json',
      dutiesKey: 'SO',
    });
    const sourceFetchedAt = registry.sources.solothurn.sourceFetchedAt;
    expect(typeof sourceFetchedAt).toBe('string');
    expect(Number.isFinite(Date.parse(sourceFetchedAt || ''))).toBe(true);
  });

  it('registers Locarnese as an active regional duty source, not a 27th canton', () => {
    const source = registry.sources.ticino.regionalSources?.locarnese;

    // cron-count-ok: il registry copre esattamente la geografia SWISS_CANTONS.
    expect(Object.keys(registry.sources)).toHaveLength(26);
    expect(source).toMatchObject({
      officialSourceUrl: 'https://www.farmacielocarnese.ch/',
      accessMethod: 'html-scrape',
      fetchFrequency: 'P1D',
      timezone: 'Europe/Zurich',
      sourceType: 'association',
      status: 'active',
    });
    expect(source?.lastVerifiedAt).toBe('2026-09-15T00:00:00.000Z');
    expect(source?.sourceFetchedAt).toBe('2026-09-15T09:40:29.571Z');
    expect(source?.notes).toContain('unica identità');
    expect(source?.notes).toContain("non pubblica un'anagrafica completa");
  });

  it('keeps non-Ticino sources unverified until a connector or dataset exists', () => {
    for (const canton of SWISS_CANTONS.filter((candidate) => !['TI', 'GE', 'JU', 'BS', 'SO', 'ZH'].includes(candidate.code))) {
      const source = registry.sources[canton.key];
      expect(source.status).not.toBe('active');
      expect(source.sourceFetchedAt).toBeUndefined();
    }
  });

  it('marks associative and institutional discovery sources explicitly', () => {
    for (const canton of SWISS_CANTONS.filter((candidate) => !['TI', 'GE', 'JU', 'BS', 'SO', 'ZH'].includes(candidate.code))) {
      const source = registry.sources[canton.key];
      expect(source.status).toBe('unverified');
      expect(source.sourceType).toBe(ASSOCIATION_CANTON_KEYS.has(canton.key) ? 'association' : 'official');
    }
  });

  it('marks Geneva active while its dedicated connector publishes a complete release', () => {
    expect(registry.sources.geneva).toMatchObject({
      officialSourceUrl: 'https://pharmageneve.swiss/pharmacie-de-garde/',
      accessMethod: 'html-scrape',
      timezone: 'Europe/Zurich',
      sourceType: 'association',
      status: 'active',
    });
    expect(registry.sources.geneva.notes).toContain('365j/an');
  });

  it('rejects an entry missing a required field', () => {
    const incomplete = { ...registry.sources.ticino, owner: '' };
    const errors = validatePharmacySourceEntry('ticino', incomplete);
    expect(errors.some((e) => e.includes('owner'))).toBe(true);
  });

  it('rejects an entry with an invalid status', () => {
    const invalid = { ...registry.sources.ticino, status: 'bogus' };
    const errors = validatePharmacySourceEntry('ticino', invalid);
    expect(errors.some((e) => e.includes('status'))).toBe(true);
  });

  it('rejects an entry with an invalid sourceType', () => {
    const invalid = { ...registry.sources.ticino, sourceType: 'bogus' };
    const errors = validatePharmacySourceEntry('ticino', invalid);
    expect(errors.some((e) => e.includes('sourceType'))).toBe(true);
  });

  it('rejects invalid metadata for a regional source', () => {
    const locarnese = registry.sources.ticino.regionalSources!.locarnese;
    const invalid = {
      ...registry.sources.ticino,
      regionalSources: {
        locarnese: { ...locarnese, status: 'bogus' },
      },
    };
    const errors = validatePharmacySourceEntry('ticino', invalid);
    expect(errors).toContain('ticino.regionalSources.locarnese: invalid status "bogus"');
  });

  it('rejects a registry with no sources', () => {
    const errors = validatePharmacySourcesRegistry({ generatedAt: '2026-08-31T00:00:00.000Z', sources: {} });
    expect(errors.some((e) => e.includes('no entries'))).toBe(true);
  });
});

/**
 * `audit` records whether and how a canton source was examined (#8705), so
 * "never examined" and "examined, not publishable" stop looking the same.
 */
describe('audit verdict', () => {
  const validAudit = {
    verdict: 'partial-or-proximity',
    auditedAt: '2026-09-29T00:00:00.000Z',
    reason: 'Ricerca per posizione limitata a 50 risultati, nessun calendario cantonale.',
    evidenceUrl: 'https://garde.svph.ch/',
  };
  const withAudit = (audit: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    ...registry.sources.vaud,
    ...overrides,
    audit: { ...validAudit, ...audit },
  });

  it('accepts a well-formed audit on a non-active entry', () => {
    expect(validatePharmacySourceEntry('vaud', withAudit({}))).toEqual([]);
  });

  it('accepts complete-feed on an active entry', () => {
    expect(validatePharmacySourceEntry('vaud', withAudit({ verdict: 'complete-feed' }, { status: 'active' }))).toEqual([]);
  });

  it('rejects a verdict outside the three values', () => {
    expect(validatePharmacySourceEntry('vaud', withAudit({ verdict: 'looks-fine' }))).toEqual([
      'vaud: invalid audit.verdict "looks-fine"',
    ]);
  });

  it('rejects a malformed or impossible auditedAt', () => {
    for (const auditedAt of ['2026-09-29', '2026-09-29T10:00:00.000Z', '2026-02-30T00:00:00.000Z', 42]) {
      expect(validatePharmacySourceEntry('vaud', withAudit({ auditedAt }))).toEqual([
        'vaud: audit.auditedAt must be a valid day as YYYY-MM-DDT00:00:00.000Z',
      ]);
    }
  });

  it('rejects an empty or overlong reason', () => {
    expect(validatePharmacySourceEntry('vaud', withAudit({ reason: '  ' }))).toEqual(['vaud: audit.reason must not be empty']);
    expect(validatePharmacySourceEntry('vaud', withAudit({ reason: 'x'.repeat(401) }))).toEqual([
      'vaud: audit.reason exceeds 400 characters',
    ]);
  });

  it('rejects an evidenceUrl that is not https', () => {
    expect(validatePharmacySourceEntry('vaud', withAudit({ evidenceUrl: 'http://garde.svph.ch/' }))).toEqual([
      'vaud: audit.evidenceUrl must be an absolute https:// URL',
    ]);
  });

  it('rejects an active entry whose audit contradicts it', () => {
    expect(validatePharmacySourceEntry('vaud', withAudit({ verdict: 'no-machine-readable' }, { status: 'active' }))).toEqual([
      'vaud: an "active" source cannot carry audit.verdict "no-machine-readable" (only complete-feed)',
    ]);
  });

  it('rejects an audit that is not an object', () => {
    expect(validatePharmacySourceEntry('vaud', { ...registry.sources.vaud, audit: 'checked' })).toEqual([
      'vaud: "audit" must be an object',
    ]);
  });

  it('every audit carried by the real registry passes the validator', () => {
    const sources = registry.sources as Record<string, Record<string, unknown>>;
    for (const [key, entry] of Object.entries(sources).filter(([, entry]) => entry.audit !== undefined)) {
      expect(validatePharmacySourceEntry(key, entry)).toEqual([]);
    }
  });

  /**
   * Non-active cantons whose source could not be read on audit day. A network
   * error or a bot challenge is not a verdict, so they stay without `audit`
   * (#8705 keeps them open). The retry is tracked by item FU-2026-09-15-009 of
   * #8705 and by the PR body line `blocked: <canton> irraggiungibile`; the
   * data-health monitor keeps listing them under `unaudited` until then.
   * Remove a key in the same change that records its audit; no other
   * exclusion is allowed.
   */
  const UNREACHABLE_ON_AUDIT: Record<string, string> = {
    'basel-landschaft': 'baselland.ch answers HTTP 403 with a Cloudflare challenge (2026-10-04)',
    schaffhausen: 'sh.ch answers HTTP 503 on the whole domain, home page included (2026-10-04)',
  };

  it('every non-active canton carries a valid audit verdict that is not in the future', () => {
    const now = Date.now();
    const sources = registry.sources as Record<string, Record<string, unknown>>;
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(sources)) {
      if (entry.status === 'active') continue;
      if (key in UNREACHABLE_ON_AUDIT) continue;
      const audit = entry.audit as { auditedAt?: unknown } | undefined;
      if (audit === undefined) {
        problems.push(`${key}: non-active canton without an audit verdict in the registry`);
        continue;
      }
      problems.push(...validatePharmacySourceEntry(key, entry));
      if (typeof audit.auditedAt === 'string' && Date.parse(audit.auditedAt) > now) {
        problems.push(`${key}: audit.auditedAt ${audit.auditedAt} is in the future`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the unreachable-on-audit exclusions current', () => {
    const sources = registry.sources as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(UNREACHABLE_ON_AUDIT)) {
      const entry = sources[key];
      expect(entry, `${key}: excluded key is not in the registry`).toBeDefined();
      expect(entry.status, `${key}: an active canton needs no exclusion`).not.toBe('active');
      expect(entry.audit, `${key}: audited now, drop it from UNREACHABLE_ON_AUDIT`).toBeUndefined();
    }
  });
});
