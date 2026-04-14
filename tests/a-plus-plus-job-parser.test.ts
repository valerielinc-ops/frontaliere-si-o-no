import { describe, expect, it } from 'vitest';
import {
  parseAplusListings,
  parseAplusJobDetail,
  isAplusSwissLocation,
  inferAplusCanton,
  buildAplusLocalizedContent,
} from '../scripts/lib/a-plus-plus-job-parser.mjs';

/* ── Listing page HTML ─────────────────────────────────────── */

const LISTING_HTML = `
<div>
  <div class="vacancy__render">
    <div class="vacancy__title">
      <h3><a href="https://inrecruiting.intervieweb.it/a2plus/jobs/real-estate-project-manager-689356/en/">Real Estate Project Manager</a></h3>
    </div>
    <div class="subtitle__informations" title="Location">Massagno, Switzerland</div>
    <div class="vacancy__description">Manage real estate projects across the TI canton.</div>
  </div>
  <div class="vacancy__render">
    <div class="vacancy__title">
      <h3><a href="https://inrecruiting.intervieweb.it/a2plus/jobs/receptionist-100-692930/en/">Receptionist 100%</a></h3>
    </div>
    <div class="subtitle__informations" title="Location">Chiasso, Switzerland</div>
    <div class="vacancy__description">Front desk role at our Chiasso offices.</div>
  </div>
  <div class="vacancy__render">
    <div class="vacancy__title">
      <h3><a href="https://inrecruiting.intervieweb.it/a2plus/jobs/architect-milan-999/en/">Senior Architect</a></h3>
    </div>
    <div class="subtitle__informations" title="Location">Milan, Italy</div>
    <div class="vacancy__description">Architecture role in Milan.</div>
  </div>
</div>
`;

/* ── Detail page HTML (HTML structure fallback) ────────────── */

const DETAIL_HTML_NO_JSONLD = `
<div class="card-body" id="description__header">
  <h2 id="description__vacancy-title">Real Estate Project Manager</h2>
  <div id="description__subtitle">
    <span class="subtitle__informations">Massagno, Switzerland</span>
    <span class="subtitle__informations">Real Estate</span>
  </div>
  <textarea class="share__hidden">https://inrecruiting.intervieweb.it/a2plus/jobs/real-estate-project-manager-689356/en/</textarea>
</div>
<div class="card-body" id="description__info">
  <div id="description__body">
    <h3 class="body__headings">Chi siamo</h3>
    <div class="body__text"><p>A++ Group è una società di architettura basata a Massagno.</p></div>
    <h3 class="body__headings">Responsabilità</h3>
    <div class="body__text"><ul><li>Gestione cantieri</li><li>Coordinamento team</li></ul></div>
  </div>
</div>
`;

/* ── Detail page HTML with JSON-LD ────────────────────────── */

const DETAIL_HTML_WITH_JSONLD = `
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Tecnico di cantiere",
  "url": "https://inrecruiting.intervieweb.it/a2plus/jobs/tecnico-di-cantiere-692104/en/",
  "description": "<p>Cerchiamo un tecnico di cantiere con esperienza in Ticino.</p><ul><li>Geometra o ingegnere edile</li><li>Esperienza in cantiere</li></ul>",
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Massagno",
      "addressRegion": "Ticino",
      "addressCountry": "CH"
    }
  }
}
</script>
</head>
<body></body>
</html>
`;

/* ── parseAplusListings ────────────────────────────────────── */

describe('parseAplusListings', () => {
  it('extracts cards with title and href', () => {
    const rows = parseAplusListings(LISTING_HTML);
    expect(rows).toHaveLength(3);
    expect(rows[0].title).toBe('Real Estate Project Manager');
    expect(rows[0].href).toContain('/a2plus/jobs/real-estate-project-manager-689356/en/');
    expect(rows[1].title).toBe('Receptionist 100%');
    expect(rows[2].title).toBe('Senior Architect');
  });

  it('extracts location from subtitle spans', () => {
    const rows = parseAplusListings(LISTING_HTML);
    expect(rows[0].location).toBe('Massagno, Switzerland');
    expect(rows[1].location).toBe('Chiasso, Switzerland');
    expect(rows[2].location).toBe('Milan, Italy');
  });

  it('returns empty array when no vacancy cards present', () => {
    expect(parseAplusListings('<html><body><p>No jobs.</p></body></html>')).toHaveLength(0);
  });
});

/* ── parseAplusJobDetail — HTML fallback ──────────────────── */

describe('parseAplusJobDetail (HTML fallback)', () => {
  it('extracts title, location and share URL', () => {
    const detail = parseAplusJobDetail(DETAIL_HTML_NO_JSONLD, 'https://example.com');
    expect(detail.title).toBe('Real Estate Project Manager');
    expect(detail.location).toBe('Massagno, Switzerland');
    expect(detail.shareUrl).toContain('/a2plus/jobs/real-estate-project-manager-689356/en/');
  });

  it('builds markdown description from body sections', () => {
    const detail = parseAplusJobDetail(DETAIL_HTML_NO_JSONLD, 'https://example.com');
    expect(detail.description).toContain('## Chi siamo');
    expect(detail.description).toContain('## Responsabilità');
    expect(detail.description).toContain('- Gestione cantieri');
  });
});

/* ── parseAplusJobDetail — JSON-LD preferred ─────────────── */

describe('parseAplusJobDetail (JSON-LD preferred)', () => {
  it('extracts title and location from JobPosting JSON-LD', () => {
    const detail = parseAplusJobDetail(DETAIL_HTML_WITH_JSONLD, 'https://fallback.example.com');
    expect(detail.title).toBe('Tecnico di cantiere');
    expect(detail.location).toBe('Massagno');
    expect(detail.shareUrl).toContain('/a2plus/jobs/tecnico-di-cantiere-692104/en/');
  });

  it('strips HTML tags from JSON-LD description', () => {
    const detail = parseAplusJobDetail(DETAIL_HTML_WITH_JSONLD, 'https://fallback.example.com');
    expect(detail.description).not.toContain('<p>');
    expect(detail.description).toContain('Cerchiamo un tecnico');
  });
});

/* ── isAplusSwissLocation ─────────────────────────────────── */

describe('isAplusSwissLocation', () => {
  it('returns true for Swiss locations', () => {
    expect(isAplusSwissLocation('Massagno, Switzerland')).toBe(true);
    expect(isAplusSwissLocation('Lugano, Ticino')).toBe(true);
    expect(isAplusSwissLocation('Chiasso')).toBe(true);
    expect(isAplusSwissLocation('Chur, Graubünden')).toBe(true);
    expect(isAplusSwissLocation('Schweiz')).toBe(true);
    expect(isAplusSwissLocation('Suisse')).toBe(true);
  });

  it('returns false for non-Swiss locations', () => {
    expect(isAplusSwissLocation('Milan, Italy')).toBe(false);
    expect(isAplusSwissLocation('Rome')).toBe(false);
    expect(isAplusSwissLocation('')).toBe(false);
  });
});

/* ── inferAplusCanton ────────────────────────────────────── */

describe('inferAplusCanton', () => {
  it('returns TI for Ticino cities', () => {
    expect(inferAplusCanton('Massagno, Switzerland')).toBe('TI');
    expect(inferAplusCanton('Lugano')).toBe('TI');
    expect(inferAplusCanton('Chiasso (Ticino)')).toBe('TI');
    expect(inferAplusCanton('Bellinzona')).toBe('TI');
  });

  it('returns GR for Grigioni', () => {
    expect(inferAplusCanton('Chur, Graubünden')).toBe('GR');
    expect(inferAplusCanton('Davos, Grigioni')).toBe('GR');
  });

  it('returns empty string for generic/unknown locations (no confident canton)', () => {
    expect(inferAplusCanton('Switzerland')).toBe('');
    expect(inferAplusCanton('Svizzera')).toBe('');
    expect(inferAplusCanton('')).toBe('');
  });
});

/* ── buildAplusLocalizedContent ──────────────────────────── */

describe('buildAplusLocalizedContent', () => {
  it('builds stub locale content with it and en slugs', () => {
    const localized = buildAplusLocalizedContent({
      title: 'Real Estate Project Manager',
      location: 'Massagno',
      description: 'Descrizione del ruolo.',
    });
    expect(localized.titleByLocale.it).toBe('Real Estate Project Manager');
    expect(localized.descriptionByLocale.it).toBe('Descrizione del ruolo.');
    expect(localized.slugByLocale.it).toContain('real-estate-project-manager');
    expect(localized.slugByLocale.it).toContain('a-plus-plus-group');
    expect(localized.slugByLocale.en).toBe(localized.slugByLocale.it);
  });

  it('handles empty inputs without throwing', () => {
    const localized = buildAplusLocalizedContent({});
    expect(localized.titleByLocale.it).toBe('');
    expect(localized.slugByLocale.it).toBeTruthy();
  });
});
