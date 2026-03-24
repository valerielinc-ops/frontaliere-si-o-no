/**
 * Baronie crawler parser tests
 *
 * Tests parseBaronieDetailHtml(), buildBaronieLocalizedContent(),
 * titleOverlap(), and isSwissJob() using real HTML fixtures from baronie.com.
 */
import { describe, it, expect } from 'vitest';

import { parseBaronieDetailHtml, buildBaronieLocalizedContent, titleOverlap, isSwissJob } from '@/scripts/lib/baronie-job-parser.mjs';

// ─── Fixture: International Sales Manager (Caslano, CH) ───
const SALES_MANAGER_HTML = `
<html lang="en">
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "International Sales Manager",
    "hiringOrganization": {
      "@type": "Organization",
      "name": "Chocolat Alprose SA / Baronie Switzerland SA"
    },
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Caslano-Lugano",
        "addressCountry": "CH"
      }
    }
  }
  </script>
</head>
<body>
<main>
  <article class="s-entry__content s-text-markup">
    <h1 class="s-text-medium-large">International Sales Manager</h1>
    <div class="s-spacer--5"></div>
    <p class="s-text-medium"><p>As international sales manager you are responsible for driving growth by developing and executing sales strategy, managing client relationships and expanding our company's presence in targeted markets.</p></p>
    <div class="s-spacer--5"></div>
    <div class="s-text-markup">
      <p>You are able to form strong relationships with both your customers as with a vast range of internal stakeholders. The role will be based within our office in Caslano, Switzerland.</p>
      <h3>Your key responsibilities:</h3>
      <ul>
        <li>Actively presenting our wide portfolio of products to our customers</li>
        <li>Developing and translating concepts into Private Label proposals</li>
        <li>Analyse the market trends and translate these into business opportunities</li>
        <li>Accurate customer demand forecasting and actively analysing deviations</li>
        <li>Taking a collaborative, connecting and active role within our organization</li>
        <li>Build and nurture long-term relationships with our customers</li>
        <li>Negotiate contracts, pricing agreements, and terms with our customers</li>
        <li>Represent the company at international trade shows</li>
        <li>Ensure compliance with international trade regulations</li>
        <li>Prepare and deliver regularly sales performance reports</li>
      </ul>
      <h3>Your skills &amp; expertise:</h3>
      <ul>
        <li>A completed Master's degree in a relevant discipline</li>
        <li>A driven, commercial, and enthusiastic approach with a hands-on mentality</li>
        <li>Strong communication skills who stands firm during price negotiations</li>
        <li>Minimum of 5 years of experience in commercial positions within FMCG</li>
        <li>You are fluent in English. Any other languages would be an advantage</li>
        <li>Proficient computer skills (Office package)</li>
      </ul>
      <h3>As international sales manager, we offer you:</h3>
      <ul>
        <li>A fully immersive role in our world of chocolate</li>
        <li>Full time opportunity in a growing international group</li>
        <li>International exposure to form and lead strategy</li>
        <li>A good remuneration package</li>
        <li>Training and career opportunities</li>
      </ul>
      <p>We are the global preferred partner for private label chocolate. Apply now!</p>
    </div>
  </article>
</main>
<section class="s-cta">
  <h2 class="s-text-medium-large">Interested?<em><br />Apply now.</em></h2>
  <p>Send us your CV and cover letter.</p>
</section>
<section class="s-image-text">
  <h2 class="s-text-medium-large">About Baronie</h2>
  <div class="s-text-markup"><p>Baronie is an European confectionery &amp; food company with locations in Belgium, Germany, UK, Switzerland and The Netherlands.</p></div>
</section>
</body></html>`;

// ─── Fixture: Administratieve Support (Belgium — should be filtered) ───
const BELGIUM_JOB_HTML = `
<html lang="en">
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    "title": "Administratieve Support - student of flexi (tijdelijk)",
    "hiringOrganization": {
      "@type": "Organization",
      "name": "Baronie Belgium NV"
    },
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Brugge",
        "addressCountry": "BE"
      }
    }
  }
  </script>
</head>
<body>
<main>
  <article class="s-entry__content s-text-markup">
    <h1 class="s-text-medium-large">Administratieve Support - student of flexi (tijdelijk)</h1>
    <div class="s-spacer--5"></div>
    <p class="s-text-medium"><p>Bij Baronie Brugge werken we dagelijks aan kwalitatieve chocoladeproducten. Om ons Product Management team extra te ondersteunen, zoeken we tijdelijke versterking.</p></p>
    <div class="s-spacer--5"></div>
    <div class="s-text-markup">
      <p>Je werkt vanuit onze site in Brugge of Veurne en ondersteunt de Product Managers.</p>
      <h3>Jouw rol</h3>
      <p>Als Administratieve Support bied je administratieve en operationele ondersteuning aan de Product Managers (NL &amp; BE).</p>
      <h3>Jouw taken</h3>
      <ul>
        <li>Administratieve ondersteuning</li>
        <li>Ondersteunen van de Product Managers in dagelijkse administratieve taken</li>
        <li>Opvolgen van dossiers en communicatie met interne en externe partners</li>
      </ul>
      <h3>Wie ben jij?</h3>
      <ul>
        <li>Bachelorprofiel (of gelijkwaardig door ervaring)</li>
        <li>Student of flexi</li>
        <li>Je werkt nauwkeurig en hebt oog voor detail</li>
      </ul>
      <h3>Praktisch</h3>
      <ul>
        <li>Locatie: Brugge of Veurne</li>
        <li>Periode: midden mei t.e.m. midden september 2026</li>
      </ul>
    </div>
  </article>
</main>
</body></html>`;

// ─── Fixture: Minimal page (no sections) ───
const MINIMAL_HTML = `
<html lang="en">
<body>
<main>
  <article class="s-entry__content s-text-markup">
    <h1 class="s-text-medium-large">Production Worker</h1>
    <div class="s-spacer--5"></div>
    <p class="s-text-medium"><p>We are looking for a production worker.</p></p>
  </article>
</main>
</body></html>`;

// ═══════════════════════════════════════════════════════════════
// parseBaronieDetailHtml
// ═══════════════════════════════════════════════════════════════

describe('parseBaronieDetailHtml', () => {
  describe('International Sales Manager (Swiss job)', () => {
    const result = parseBaronieDetailHtml(SALES_MANAGER_HTML)!;

    it('extracts title from h1', () => {
      expect(result.detailTitle).toBe('International Sales Manager');
    });

    it('extracts intro text', () => {
      expect(result.introText).toContain('international sales manager');
      expect(result.introText).toContain('driving growth');
    });

    it('extracts preamble text from body', () => {
      expect(result.preambleText).toContain('Caslano, Switzerland');
    });

    it('extracts 3 content sections', () => {
      expect(result.sectionCount).toBe(3);
    });

    it('extracts responsibilities with 10 items', () => {
      const sec = result.sections.find((s: { heading: string }) =>
        /responsibilities/i.test(s.heading)
      );
      expect(sec).toBeDefined();
      expect(sec.items.length).toBe(10);
      expect(sec.items[0]).toContain('portfolio of products');
    });

    it('extracts skills section', () => {
      const sec = result.sections.find((s: { heading: string }) =>
        /skills/i.test(s.heading)
      );
      expect(sec).toBeDefined();
      expect(sec.items.length).toBe(6);
    });

    it('extracts we offer section', () => {
      const sec = result.sections.find((s: { heading: string }) =>
        /we offer/i.test(s.heading)
      );
      expect(sec).toBeDefined();
      expect(sec.items.length).toBe(5);
    });

    it('produces markdown >= 500 chars', () => {
      expect(result.markdown.length).toBeGreaterThanOrEqual(500);
    });

    it('markdown contains structured sections', () => {
      expect(result.markdown).toContain('## Your key responsibilities');
      expect(result.markdown).toContain('- Actively presenting');
    });

    it('does NOT include About Baronie or Interested content', () => {
      expect(result.markdown).not.toContain('About Baronie');
      expect(result.markdown).not.toContain('Interested?');
    });

    it('extracts location from JSON-LD', () => {
      expect(result.location).toBe('Caslano-Lugano');
      expect(result.addressCountry).toBe('CH');
    });

    it('extracts company from JSON-LD', () => {
      expect(result.company).toBe('Chocolat Alprose SA / Baronie Switzerland SA');
    });
  });

  describe('Belgium job (should be filtered)', () => {
    const result = parseBaronieDetailHtml(BELGIUM_JOB_HTML)!;

    it('extracts Dutch title', () => {
      expect(result.detailTitle).toBe('Administratieve Support - student of flexi (tijdelijk)');
    });

    it('extracts 4 sections (including Dutch headings)', () => {
      expect(result.sectionCount).toBe(4);
    });

    it('extracts location as Belgium', () => {
      expect(result.location).toBe('Brugge');
      expect(result.addressCountry).toBe('BE');
    });

    it('markdown >= 350 chars', () => {
      expect(result.markdown.length).toBeGreaterThanOrEqual(350);
    });
  });

  describe('minimal page', () => {
    const result = parseBaronieDetailHtml(MINIMAL_HTML)!;

    it('extracts title', () => {
      expect(result.detailTitle).toBe('Production Worker');
    });

    it('extracts intro', () => {
      expect(result.introText).toContain('production worker');
    });

    it('has 0 sections', () => {
      expect(result.sectionCount).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('returns null for empty input', () => {
      expect(parseBaronieDetailHtml('')).toBeNull();
      expect(parseBaronieDetailHtml(null as unknown as string)).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// isSwissJob
// ═══════════════════════════════════════════════════════════════

describe('isSwissJob', () => {
  it('returns true for CH addressCountry', () => {
    expect(isSwissJob({ addressCountry: 'CH', location: 'Caslano-Lugano' })).toBe(true);
  });

  it('returns false for BE addressCountry', () => {
    expect(isSwissJob({ addressCountry: 'BE', location: 'Brugge' })).toBe(false);
  });

  it('returns false for DE addressCountry', () => {
    expect(isSwissJob({ addressCountry: 'DE', location: 'Norderstedt' })).toBe(false);
  });

  it('returns true for Caslano location without addressCountry', () => {
    expect(isSwissJob({ addressCountry: '', location: 'Caslano' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isSwissJob(null)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildBaronieLocalizedContent
// ═══════════════════════════════════════════════════════════════

describe('buildBaronieLocalizedContent', () => {
  it('uses full markdown when available', () => {
    const longMarkdown = 'As sales manager you drive growth for Baronie.\n\n## Your key responsibilities\n- Presenting products to customers\n- Managing client relationships\n- Analysing market trends\n\n## Your skills\n- Master degree required\n- 5 years FMCG experience';
    const result = buildBaronieLocalizedContent({
      title: 'International Sales Manager',
      location: 'Caslano',
      company: 'Chocolat Alprose SA',
      detailMarkdown: longMarkdown,
    });
    expect(result.descriptionByLocale.it).toContain('## Your key responsibilities');
    expect(result.descriptionByLocale.it).toContain('- Presenting products');
  });

  it('falls back to boilerplate when markdown is short', () => {
    const result = buildBaronieLocalizedContent({
      title: 'Sales Manager',
      location: 'Caslano',
      company: 'Alprose',
      detailMarkdown: 'Too short',
    });
    expect(result.descriptionByLocale.it).toContain('cioccolato');
    expect(result.descriptionByLocale.it).toContain('Caslano');
  });

  it('generates correct slugs', () => {
    const result = buildBaronieLocalizedContent({
      title: 'International Sales Manager',
      location: 'Caslano',
      company: 'Baronie',
      detailMarkdown: '',
    });
    expect(result.slugByLocale.it).toBe('international-sales-manager-baronie-caslano');
  });
});

// ═══════════════════════════════════════════════════════════════
// titleOverlap
// ═══════════════════════════════════════════════════════════════

describe('titleOverlap', () => {
  it('returns 1.0 for identical titles', () => {
    expect(titleOverlap('Sales Manager', 'Sales Manager')).toBe(1);
  });

  it('returns high overlap for similar titles', () => {
    expect(titleOverlap('International Sales Manager', 'International Sales Manager')).toBe(1);
  });

  it('returns low overlap for different titles', () => {
    expect(titleOverlap('Sales Manager', 'Production Worker')).toBeLessThan(0.3);
  });

  it('returns 0 for empty strings', () => {
    expect(titleOverlap('', 'Test')).toBe(0);
  });
});
