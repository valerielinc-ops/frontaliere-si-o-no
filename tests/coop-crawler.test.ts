import { describe, it, expect } from 'vitest';
import {
  extractJsonLd,
  coopDescHtmlToMarkdown,
  validateCoopDescription,
  titleOverlap,
  applyCoopJsonLdToJob,
} from '../scripts/lib/coop-job-parser.mjs';

// ──────────────────────────────────────────────────────────────
// Real HTML fixtures from Coop detail pages
// ──────────────────────────────────────────────────────────────

const FIXTURE_DETAIL1_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Detailhandelsfachfrau:mann / -assistent:in",
  "datePosted": "2025-09-26",
  "employmentType": "FULL_TIME",
  "description": "<p><div>Deine Aufgaben</div><br><ul><li>Du erhältst an 2 Tagen einen abwechslungsreichen Einblick in den Beruf.</li><li>Du darfst aktiv mitarbeiten.</li><li>Du lernst das Unternehmen kennen.</li></ul></p><br><p><div>Das bringst du mit</div><br><ul><li>Du bist interessiert den Lehrberuf kennen zu lernen.</li><li>Du bist motiviert und hast Freude am Umgang mit Kund:innen.</li><li>Du befindest dich in der 7. oder 8. Schulstufe.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Spannende Einblicke in die Welt des Detailhandels.</li><li>Persönliche Betreuung während der Schnupperlehre.</li><li>Die Möglichkeit, erste Berufserfahrungen zu sammeln.</li></ul></p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Coop"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "Schweiz",
      "addressLocality": "Dietlikon",
      "addressRegion": "Dietlikon"
    }
  }
}
</script>`;

const FIXTURE_DETAIL2_JSONLD = `<script type="application/ld+json">
{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "Verkaufsberater:in Textil",
  "datePosted": "2026-03-05",
  "employmentType": "PART_TIME",
  "description": "<p><div>Aufgaben</div><br><ul><li>Mit deiner freundlichen und fachkompetenten Beratung begeisterst du unsere Kundschaft.</li><li>Du hältst dich an die internen Vorgaben und so stellst du sicher, dass die Waren attraktiv präsentiert sind.</li><li>Mit der Ware auf unserer Verkaufsfläche und im Lager gehst du sorgfältig um und du erledigst die anfallenden Unterhaltsarbeiten.</li></ul></p><br><p><div>Anforderungen</div><br><ul><li>Du besitzt eine abgeschlossene Grundbildung und hast Erfahrung im Detailhandel, vorzugsweise im Bekleidungsbereich.</li><li>Du bist eine kundenorientierte Persönlichkeit, die sich für Mode begeistert.</li><li>Du kommunizierst stilsicher in Deutsch und verfügst über weitere Sprachkenntnisse.</li><li>Du bist flexibel, motiviert und ein:e Teamplayer:in.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Abwechslungsreiche und verantwortungsvolle Tätigkeit.</li><li>Zeitgemässe Anstellungsbedingungen mit Personalrabatt und weiteren Benefits.</li><li>Gute Sozialleistungen und mindestens fünf Wochen Ferien.</li><li>Möglichkeiten sich persönlich und fachlich weiterzuentwickeln.</li></ul></p>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "Coop City"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressCountry": "Schweiz",
      "addressLocality": "Chur",
      "addressRegion": "Graubünden"
    }
  }
}
</script>`;

const FIXTURE_DESC_HTML_1 = `<p><div>Deine Aufgaben</div><br><ul><li>Du erhältst an 2 Tagen einen abwechslungsreichen Einblick in den Beruf.</li><li>Du darfst aktiv mitarbeiten.</li><li>Du lernst das Unternehmen kennen.</li></ul></p><br><p><div>Das bringst du mit</div><br><ul><li>Du bist interessiert den Lehrberuf kennen zu lernen.</li><li>Du bist motiviert und hast Freude am Umgang mit Kund:innen.</li><li>Du befindest dich in der 7. oder 8. Schulstufe.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Spannende Einblicke in die Welt des Detailhandels.</li><li>Persönliche Betreuung während der Schnupperlehre.</li><li>Die Möglichkeit, erste Berufserfahrungen zu sammeln.</li></ul></p>`;

const FIXTURE_DESC_HTML_2 = `<p><div>Aufgaben</div><br><ul><li>Mit deiner freundlichen und fachkompetenten Beratung begeisterst du unsere Kundschaft.</li><li>Du hältst dich an die internen Vorgaben und so stellst du sicher, dass die Waren attraktiv präsentiert sind.</li><li>Mit der Ware auf unserer Verkaufsfläche und im Lager gehst du sorgfältig um und du erledigst die anfallenden Unterhaltsarbeiten.</li></ul></p><br><p><div>Anforderungen</div><br><ul><li>Du besitzt eine abgeschlossene Grundbildung und hast Erfahrung im Detailhandel, vorzugsweise im Bekleidungsbereich.</li><li>Du bist eine kundenorientierte Persönlichkeit, die sich für Mode begeistert.</li><li>Du kommunizierst stilsicher in Deutsch und verfügst über weitere Sprachkenntnisse.</li><li>Du bist flexibel, motiviert und ein:e Teamplayer:in.</li></ul></p><br><p><div>Was wir bieten</div><br><ul><li>Abwechslungsreiche und verantwortungsvolle Tätigkeit.</li><li>Zeitgemässe Anstellungsbedingungen mit Personalrabatt und weiteren Benefits.</li><li>Gute Sozialleistungen und mindestens fünf Wochen Ferien.</li><li>Möglichkeiten sich persönlich und fachlich weiterzuentwickeln.</li></ul></p>`;

// ──────────────────────────────────────────────────────────────
// extractJsonLd tests
// ──────────────────────────────────────────────────────────────

describe('extractJsonLd — Coop pages', () => {
  it('extracts JobPosting from detail page 1', () => {
    const ld = extractJsonLd(FIXTURE_DETAIL1_JSONLD);
    expect(ld).not.toBeNull();
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.title).toBe('Detailhandelsfachfrau:mann / -assistent:in');
  });

  it('extracts JobPosting from detail page 2', () => {
    const ld = extractJsonLd(FIXTURE_DETAIL2_JSONLD);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Verkaufsberater:in Textil');
    expect(ld.hiringOrganization.name).toBe('Coop City');
  });

  it('returns null for pages without JSON-LD', () => {
    expect(extractJsonLd('<html><body>No JSON-LD here</body></html>')).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// coopDescHtmlToMarkdown tests
// ──────────────────────────────────────────────────────────────

describe('coopDescHtmlToMarkdown', () => {
  it('converts detail 1 description to markdown ≥ 350 chars', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md.length).toBeGreaterThanOrEqual(350);
  });

  it('preserves section headers from detail 1', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).toContain('## Deine Aufgaben');
    expect(md).toContain('## Das bringst du mit');
    expect(md).toContain('## Was wir bieten');
  });

  it('preserves list items from detail 1', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).toContain('- Du erhältst an 2 Tagen');
    expect(md).toContain('- Du darfst aktiv mitarbeiten');
    expect(md).toContain('- Spannende Einblicke');
  });

  it('converts detail 2 description to markdown ≥ 400 chars', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md.length).toBeGreaterThanOrEqual(400);
  });

  it('preserves detail 2 sections', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md).toContain('## Aufgaben');
    expect(md).toContain('## Anforderungen');
    expect(md).toContain('## Was wir bieten');
  });

  it('preserves detail 2 content', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    expect(md).toContain('Beratung begeisterst du unsere Kundschaft');
    expect(md).toContain('Bekleidungsbereich');
    expect(md).toContain('Personalrabatt');
  });

  it('does not contain raw HTML tags', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    expect(md).not.toMatch(/<(div|span|p|ul|li|br)\b/);
  });

  it('returns empty for empty input', () => {
    expect(coopDescHtmlToMarkdown('')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// validateCoopDescription tests
// ──────────────────────────────────────────────────────────────

describe('validateCoopDescription', () => {
  it('passes for detail 1 markdown', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_1);
    const result = validateCoopDescription(md, FIXTURE_DESC_HTML_1.length);
    expect(result.ok).toBe(true);
  });

  it('passes for detail 2 markdown', () => {
    const md = coopDescHtmlToMarkdown(FIXTURE_DESC_HTML_2);
    const result = validateCoopDescription(md, FIXTURE_DESC_HTML_2.length);
    expect(result.ok).toBe(true);
  });

  it('fails for very short description', () => {
    const result = validateCoopDescription('Short text', 1000);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('too short'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// titleOverlap tests
// ──────────────────────────────────────────────────────────────

describe('titleOverlap — Coop titles', () => {
  it('returns 1 for exact match', () => {
    expect(titleOverlap('Verkaufsberater:in Textil', 'Verkaufsberater:in Textil')).toBe(1);
  });

  it('handles colon-style Swiss German titles', () => {
    expect(
      titleOverlap('Detailhandelsfachfrau:mann / -assistent:in', 'Detailhandelsfachfrau:mann / -assistent:in')
    ).toBe(1);
  });

  it('returns high overlap when OG title adds company prefix', () => {
    // OG: "Coop City: Verkaufsberater:in Textil" vs stored: "Verkaufsberater:in Textil"
    expect(titleOverlap('Verkaufsberater:in Textil', 'Coop City: Verkaufsberater:in Textil')).toBeGreaterThanOrEqual(0.6);
  });

  it('returns low overlap for different roles', () => {
    expect(titleOverlap('Logistiker:in EBA', 'Verkaufsberater:in Textil')).toBeLessThan(0.5);
  });

  it('returns 1 for empty expected', () => {
    expect(titleOverlap('', 'anything')).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────
// applyCoopJsonLdToJob tests
// ──────────────────────────────────────────────────────────────

describe('applyCoopJsonLdToJob — location update from JSON-LD', () => {
  it('updates location and addressLocality when JSON-LD has different locality', () => {
    const job = {
      title: 'Verkaufsberater:in',
      location: 'Castione',
      addressLocality: 'Castione',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Canobbio',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.location).toBe('Canobbio');
    expect(updated.addressLocality).toBe('Canobbio');
    // Canton stays TI since "Ticino" normalizes to TI (same as before)
    expect(updated.canton).toBe('TI');
  });

  it('updates canton when JSON-LD addressRegion differs', () => {
    const job = {
      title: 'Logistiker:in',
      location: 'Ticino',
      addressLocality: 'Ticino',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Chur',
          addressRegion: 'Graubünden',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.location).toBe('Chur');
    expect(updated.addressLocality).toBe('Chur');
    expect(updated.canton).toBe('GR');
    expect(updated.addressRegion).toBe('GR');
  });

  it('updates company when JSON-LD has a more specific store name', () => {
    const job = {
      title: 'Verkaufsberater:in Textil',
      location: 'Chur',
      addressLocality: 'Chur',
      canton: 'GR',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Chur',
          addressRegion: 'Graubünden',
        },
      },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(true);
    expect(updated.company).toBe('Coop City');
  });

  it('does not update company when JSON-LD name is short (<=4 chars)', () => {
    const job = {
      title: 'Logistiker:in',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      company: 'Coop Ticino',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Lugano',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    // "Coop" is only 4 chars, should not replace "Coop Ticino"
    expect(updated.company).toBe('Coop Ticino');
  });

  it('returns changed=false when JSON-LD matches existing job data', () => {
    const job = {
      title: 'Test Job',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      addressRegion: 'TI',
      company: 'Coop City',
    };
    const jsonLd = {
      jobLocation: {
        address: {
          addressLocality: 'Lugano',
          addressRegion: 'Ticino',
        },
      },
      hiringOrganization: { name: 'Coop City' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Lugano');
    expect(updated.company).toBe('Coop City');
  });

  it('handles null/missing JSON-LD gracefully', () => {
    const job = {
      title: 'Test',
      location: 'Lugano',
      addressLocality: 'Lugano',
      canton: 'TI',
      company: 'Coop',
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, null);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Lugano');
  });

  it('handles JSON-LD with empty jobLocation', () => {
    const job = {
      title: 'Test',
      location: 'Bellinzona',
      addressLocality: 'Bellinzona',
      canton: 'TI',
      company: 'Coop',
    };
    const jsonLd = {
      jobLocation: {},
      hiringOrganization: { name: 'Coop' },
    };
    const { job: updated, changed } = applyCoopJsonLdToJob(job, jsonLd);
    expect(changed).toBe(false);
    expect(updated.location).toBe('Bellinzona');
  });
});
