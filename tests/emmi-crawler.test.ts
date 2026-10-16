import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  EMMI_KEY,
  EMMI_COMPANY_NAME,
  isEmmiJob,
  isTrustedDomain,
  extractEmmiVacancyHtml,
  assignEmmiJobIds,
  emmiStableRef,
} from '../scripts/lib/emmi-job-parser.mjs';
import { slugify, stripHtml } from '../scripts/lib/crawler-template.mjs';

describe('Emmi crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(EMMI_KEY).toBe('emmi');
    expect(EMMI_COMPANY_NAME).toBe('Emmi');
  });

  // ── isCompanyJob ──
  describe('isEmmiJob', () => {
    it('matches by companyKey', () => {
      expect(isEmmiJob({ companyKey: 'emmi' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isEmmiJob({ company: 'Emmi' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isEmmiJob({ url: 'https://emmi.com/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isEmmiJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isEmmiJob(null)).toBe(false);
      expect(isEmmiJob(undefined)).toBe(false);
      expect(isEmmiJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://emmi.com/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.emmi.com/job/456')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles invalid URLs', () => {
      expect(isTrustedDomain('')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  // ── slugify (imported from crawler-template) ──
  describe('slugify', () => {
    it('converts title to URL-safe slug', () => {
      const slug = slugify('Software Engineer (m/f/d)');
      expect(slug).toBe('software-engineer-m-f-d');
    });

    it('strips diacritics', () => {
      expect(slugify('Ingénieur qualité')).toBe('ingenieur-qualite');
    });

    it('builds slug with company suffix inline', () => {
      expect(slugify('Developer emmi ch')).toBe('developer-emmi-ch');
    });

    it('respects max length', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(90);
    });
  });

  // ── Job Shape Validation ──
  describe('job shape', () => {
    // A minimal valid job for reference
    const validJob = {
      id: 'emmi-abc123',
      slug: 'test-position-emmi-ch',
      slugByLocale: { de: 'test-position-emmi-ch' },
      company: 'Emmi',
      companyKey: 'emmi',
      title: 'Test Position',
      titleByLocale: { de: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { de: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://emmi.com/jobs/test',
      source: 'Emmi Dedicated Parser',
      sourceLang: 'de',
      crawledAt: new Date().toISOString(),
    };

    it('has all required fields', () => {
      const required = [
        'id', 'slug', 'slugByLocale', 'company', 'companyKey',
        'title', 'titleByLocale', 'description', 'descriptionByLocale',
        'location', 'canton', 'url', 'source', 'sourceLang', 'crawledAt',
      ];
      for (const field of required) {
        expect(validJob).toHaveProperty(field);
      }
    });

    it('slug only contains source locale', () => {
      const locales = Object.keys(validJob.slugByLocale);
      expect(locales).toHaveLength(1);
      expect(locales[0]).toBe(validJob.sourceLang);
    });

    it('id starts with company key', () => {
      expect(validJob.id).toMatch(/^emmi-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});

// ── #5253: the OHWS feed carries only the two bullet lists ────────────────
describe('extractEmmiVacancyHtml', () => {
  // Real jobs.emmi.com page, minimised (three benefit cards; contact anonymised).
  const LANGNAU = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'crawler-quality-f', 'emmi-vacancy-langnau.html'),
    'utf8',
  );
  const text = stripHtml(extractEmmiVacancyHtml(LANGNAU)).replace(/[ \t]+/g, ' ');

  it('starts with the role-specific introduction', () => {
    expect(text.trim().startsWith('Wir vereinen Schweizer Tradition mit innovativer Expertise')).toBe(true);
    expect(text).toContain('Werde Teil unseres Technik-Teams im Tagesbetrieb');
  });

  it('keeps both headed lists', () => {
    expect(text).toContain('Das kannst du bewirken');
    expect(text).toContain('• Du bist verantwortlich für die Instandhaltung und -setzung von technischen Anlagen.');
    expect(text).toContain('Das bringst du mit');
    expect(text).toContain('• Du sprichst fliessend Deutsch.');
  });

  it('turns every benefit card into one list item with its title and text', () => {
    expect(text).toContain('Das bieten wir dir');
    expect(text).toContain('• Attraktive Pensionskasse mit flexiblen Sparplänen: Unsere Emmi Vorsorgestiftung');
    expect(text).toContain('• Kostenlose Parkplätze & vergünstigte Verpflegung: Wir bieten unseren Mitarbeitenden');
  });

  it('leaves the workplace, contact and similar-jobs sections out', () => {
    expect(text).not.toContain('Dein Arbeitsort');
    expect(text).not.toContain('Hast du Fragen?');
    expect(text).not.toMatch(/\+41/);
  });

  it('reads a bare benefit card without throwing (normalizeSpace is the module-level helper)', () => {
    expect(extractEmmiVacancyHtml('<section id="benefits"><div class="benefitTitle">A</div><div class="benefitText">B</div></section>'))
      .toBe('<ul><li>A: B</li></ul>');
  });

  it('keeps an empty benefit grid when the source still publishes its heading and link', () => {
    const html = '<section id="benefits"><h2>Ce que nous offrons</h2>'
      + '<div id="benefitsHolder" class="benefits-grid"></div>'
      + '<a class="arrowIconLink" href="https://group.emmi.com/che/fr/travailler-chez-emmi/conditions-demploi-reglementations">'
      + '<span>En savoir plus sur les avantages</span></a></section>';
    const text = stripHtml(extractEmmiVacancyHtml(html));
    expect(text).toContain('Ce que nous offrons');
    expect(text).toContain('En savoir plus sur les avantages');
  });

  it('returns nothing for a page without the ad sections, so the OHWS blocks are used', () => {
    expect(extractEmmiVacancyHtml('<html><body><section id="contact">x</section></body></html>')).toBe('');
  });
});

// 2026-10-15: «Projektleiter/in Engineering» in Dagmersellen was published
// twice under one Emmi reference code, at two vacancy URLs. One id for both
// put a duplicate key in the slice and failed translate-pending's scatter
// parity (run 38854975768).
describe('assignEmmiJobIds', () => {
  const a = 'https://jobs.emmi.com/offene-stellen/projektleiter-in-engineering/4803d1e3-93c2-4108-b84f-ad85dd574200';
  const b = 'https://jobs.emmi.com/offene-stellen/projektleiter-in-engineering/32f9576c-c60f-4714-b63d-80d3f8bb3ce3';

  it('a reference code alone keeps the id it always had', () => {
    const [alone] = assignEmmiJobIds([{ stableRef: 'REF-1', publicUrl: a }]);
    const both = assignEmmiJobIds([{ stableRef: 'REF-1', publicUrl: b }, { stableRef: 'REF-1', publicUrl: a }]);
    expect(alone).toMatch(/^emmi-[0-9a-f]{12}$/);
    // Without history the last URL in sorted order (a, the 4803d1e3 posting
    // that existed first on 2026-10-15) keeps the code's id.
    expect(both[1]).toBe(alone);
  });

  it('distinct postings under one code get distinct ids, in any listing order', () => {
    const forward = assignEmmiJobIds([{ stableRef: 'REF-1', publicUrl: a }, { stableRef: 'REF-1', publicUrl: b }]);
    const backward = assignEmmiJobIds([{ stableRef: 'REF-1', publicUrl: b }, { stableRef: 'REF-1', publicUrl: a }]);
    expect(new Set(forward).size).toBe(2);
    expect(backward).toEqual([forward[1], forward[0]]);
  });

  it('the same URL listed twice is one posting with one id; no code falls back to the URL', () => {
    const ids = assignEmmiJobIds([{ stableRef: 'REF-1', publicUrl: a }, { stableRef: 'REF-1', publicUrl: a }]);
    expect(ids[0]).toBe(ids[1]);
    const [noCode] = assignEmmiJobIds([{ stableRef: '', publicUrl: b }]);
    expect(noCode).toMatch(/^emmi-[0-9a-f]{12}$/);
    expect(noCode).not.toBe(ids[0]);
  });

  it('reads the reference code first, then viewkey, then the listing id', () => {
    expect(emmiStableRef({ szas: { sza_reference_code: ' R ' }, viewkey: 'V', id: 1 })).toBe('R');
    expect(emmiStableRef({ viewkey: 'V', id: 1 })).toBe('V');
    expect(emmiStableRef({ id: 7 })).toBe('7');
    expect(emmiStableRef({})).toBe('');
  });
});

describe('assignReferenceJobIds is shared by the Prospective parsers', () => {
  it('keeps each crawler\'s namespace: the VZ ids are those it always had', async () => {
    const { assignReferenceJobIds } = await import('../scripts/lib/prospective-reference-ids.mjs');
    const { createHash } = await import('node:crypto');
    const legacy = `vz-vermoegenszentrum-${createHash('sha1').update('vz-vermoegenszentrum:REF-9').digest('hex').slice(0, 12)}`;
    expect(assignReferenceJobIds([{ stableRef: 'REF-9', publicUrl: 'https://x/1' }], 'vz-vermoegenszentrum')).toEqual([legacy]);
    const legacyEmmi = `emmi-${createHash('sha1').update('emmi:REF-9').digest('hex').slice(0, 12)}`;
    expect(assignEmmiJobIds([{ stableRef: 'REF-9', publicUrl: 'https://x/1' }])).toEqual([legacyEmmi]);
  });
});

describe('ids of postings the slice already knows', () => {
  const a = 'https://jobs.emmi.com/offene-stellen/x/32f9576c';
  const b = 'https://jobs.emmi.com/offene-stellen/x/4803d1e3';

  it('a known posting keeps its id when a new one appears under the same code (review of PR 13506)', async () => {
    const { assignReferenceJobIds } = await import('../scripts/lib/prospective-reference-ids.mjs');
    for (const key of ['emmi', 'vz-vermoegenszentrum']) {
      const [alone] = assignReferenceJobIds([{ stableRef: 'R', publicUrl: b }], key);
      const both = assignReferenceJobIds(
        [{ stableRef: 'R', publicUrl: a }, { stableRef: 'R', publicUrl: b }],
        key,
        { existingIdByUrl: new Map([[b, alone]]) },
      );
      expect(both[1]).toBe(alone);
      expect(both[0]).not.toBe(alone);
    }
  });

  it('the state of 2026-10-15 keeps both ids as they are on main', async () => {
    const { assignProspectiveListingIds } = await import('../scripts/lib/prospective-reference-ids.mjs');
    const listing = (url: string) => ({ szas: { sza_reference_code: 'R' }, links: { directlink: url } });
    const existingJobs = [
      { id: 'emmi-cfb6415b85ed', url: a },
      { id: 'emmi-cfb6415b85ed-r5fbd0b15', url: b },
    ];
    expect(assignProspectiveListingIds([listing(b), listing(a)], 'emmi', 'https://x', { existingJobs }))
      .toEqual(['emmi-cfb6415b85ed-r5fbd0b15', 'emmi-cfb6415b85ed']);
  });

  it('an id held by two URLs at once stays with one of them; the other gets its own', async () => {
    const { assignReferenceJobIds } = await import('../scripts/lib/prospective-reference-ids.mjs');
    const ids = assignReferenceJobIds(
      [{ stableRef: 'R', publicUrl: a }, { stableRef: 'R', publicUrl: b }],
      'emmi',
      { existingIdByUrl: new Map([[a, 'emmi-same'], [b, 'emmi-same']]) },
    );
    expect(ids[0]).toBe('emmi-same');
    expect(ids[1]).not.toBe('emmi-same');
  });

  it('refuses an empty crawler key', async () => {
    const { assignReferenceJobIds } = await import('../scripts/lib/prospective-reference-ids.mjs');
    expect(() => assignReferenceJobIds([{ stableRef: 'R', publicUrl: a }], '')).toThrow(TypeError);
  });
});
