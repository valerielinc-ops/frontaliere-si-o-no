import { describe, it, expect } from 'vitest';
import {
  DECATHLON_KEY,
  DECATHLON_COMPANY_NAME,
  extractDecathlonDetailDescription,
  isDecathlonJob,
  isTrustedDomain,
} from '../scripts/lib/decathlon-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

// joinus.decathlon.ch/fr_CH/annonce/4534967-velo-verkaufer-mwd-50-baar-6340-baar
// on 2026-09-29, minimized: the JSON-LD `description` is the «Mission» block
// only; «Profil» (profile, offer, application steps) is a second html_block.
const DETAIL_HTML = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'http://schema.org',
  '@type': 'JobPosting',
  title: 'Velo-Verkäufer (m/w/d) 50% - Baar',
  description: '<h3>Dein Spielfeld: Die Welt auf zwei Rädern</h3><p>Du liebst Fahrräder nicht nur, du verstehst sie auch?</p><h3>Deine Mission bei uns:</h3><ul><li><p><b>Beratung &amp; Verkauf:</b> Du bist der erste Ansprechpartner für Einsteiger und Profis.</p></li></ul>',
})}</script></head><body>
<section data-logic-value="catch_phrase" id="catch_phrase" class="catch-phrase-block blockList__block"><p>Rejoins-nous !</p></section>
<section data-logic-value="html_block" id="mission" class="html-block blockList__block"><h2 class="title html-block__title"> Mission </h2><div class="rich-text"><h3>Dein Spielfeld: Die Welt auf zwei Rädern</h3><p>Du liebst Fahrräder nicht nur, du verstehst sie auch?</p><h3>Deine Mission bei uns:</h3><ul><li><p><b>Beratung &amp; Verkauf:</b> Du bist der erste Ansprechpartner für Einsteiger und Profis.</p></li></ul></div></section>
<section data-logic-value="html_block" id="profile" class="html-block blockList__block"><h2 class="title html-block__title"> Profil </h2><div class="rich-text"><h3>Das bist du:</h3><ul><li><p><b>Velo-Fanatiker:</b> Du bist selbst aktiver Radfahrer (MTB, Rennrad oder City).</p></li></ul><h3>Was wir dir bieten:</h3><ul><li><p><b>Sport-Benefits:</b> 25% Rabatt auf Eigenmarken und 5 Wochen Ferien.</p></li></ul></div></section>
<section data-logic-value="job_ad_location" id="job_ad_location" class="job-ad-location-block blockList__block"><p>Langgasse 40, 6340 Baar, Switzerland</p></section>
<section data-logic-value="social_media_share" id="social_media_share" class="social-media-share-block blockList__block"><p>Partager cette annonce sur LinkedIn</p></section>
</body></html>`;

describe('Decathlon detail description', () => {
  it('reads every html_block of the ad, not only the JSON-LD mission', () => {
    const description = extractDecathlonDetailDescription(DETAIL_HTML);

    expect(description).toContain('Deine Mission bei uns:');
    expect(description).toContain('Velo-Fanatiker:');
    expect(description).toContain('Was wir dir bieten:');
    expect(description).toContain('Profil');
    expect(description).not.toContain('Langgasse 40');
    expect(description).not.toContain('Partager cette annonce');
    expect(description).not.toContain('Rejoins-nous');
  });

  it('returns text, not rich-text markup, with the section titles and list items kept', () => {
    const description = extractDecathlonDetailDescription(DETAIL_HTML);
    expect(description).not.toMatch(/<\/?(?:h[1-6]|p|section|ul|li|div|b)\b/i);
    expect(description).toMatch(/^Mission$/m);
    expect(description).toMatch(/^Profil$/m);
    expect(description).toMatch(/^• Velo-Fanatiker: Du bist selbst aktiver Radfahrer/m);
    expect(description).toContain('Beratung & Verkauf:');
    const minimal = extractDecathlonDetailDescription('<section data-logic-value="html_block"><h2>Mission</h2><p>Profil</p></section>');
    expect(minimal).toContain('Mission');
    expect(minimal).toContain('Profil');
    expect(minimal).not.toMatch(/<h2|<p|<section/);
  });

  it('keeps the JSON-LD body when the page has no html_block', () => {
    const jsonLdOnly = DETAIL_HTML.replace(/<section\b[\s\S]*<\/section>/, '');
    expect(extractDecathlonDetailDescription(jsonLdOnly)).toContain('Deine Mission bei uns:');
    expect(extractDecathlonDetailDescription(jsonLdOnly)).not.toContain('Velo-Fanatiker');
  });
});

describe('Decathlon crawler parser', () => {
  // ── Constants ──
  it('exports valid company key and name', () => {
    expect(DECATHLON_KEY).toBe('decathlon');
    expect(DECATHLON_COMPANY_NAME).toBe('Decathlon');
  });

  // ── isCompanyJob ──
  describe('isDecathlonJob', () => {
    it('matches by companyKey', () => {
      expect(isDecathlonJob({ companyKey: 'decathlon' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isDecathlonJob({ company: 'Decathlon' })).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isDecathlonJob({ url: 'https://decathlon.ch/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isDecathlonJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isDecathlonJob(null)).toBe(false);
      expect(isDecathlonJob(undefined)).toBe(false);
      expect(isDecathlonJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://decathlon.ch/careers/job-123')).toBe(true);
    });

    it('trusts subdomains', () => {
      expect(isTrustedDomain('https://careers.decathlon.ch/job/456')).toBe(true);
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
      expect(slugify('Developer decathlon ch')).toBe('developer-decathlon-ch');
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
      id: 'decathlon-abc123',
      slug: 'test-position-decathlon-ch',
      slugByLocale: { fr: 'test-position-decathlon-ch' },
      company: 'Decathlon',
      companyKey: 'decathlon',
      title: 'Test Position',
      titleByLocale: { fr: 'Test Position' },
      description: 'A test job description for validation.',
      descriptionByLocale: { fr: 'A test job description for validation.' },
      location: 'Lugano',
      canton: 'TI',
      url: 'https://decathlon.ch/jobs/test',
      source: 'Decathlon Dedicated Parser',
      sourceLang: 'fr',
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
      expect(validJob.id).toMatch(/^decathlon-/);
    });

    it('slug is URL-safe', () => {
      expect(validJob.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });
  });
});
