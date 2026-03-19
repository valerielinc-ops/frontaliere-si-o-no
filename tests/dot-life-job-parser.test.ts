import { describe, expect, it } from 'vitest';
import {
  extractLinkedInJobId,
  linkedInJobUrl,
  parseDotLifeLinkedInCards,
  parseDotLifeLinkedInDetail,
  buildDotLifeLocalizedContent,
} from '../scripts/lib/dot-life-job-parser.mjs';

/* ── extractLinkedInJobId ─────────────────────────────────── */

describe('extractLinkedInJobId', () => {
  it('extracts ID from a full LinkedIn jobs/view URL', () => {
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/view/4366703746/')).toBe('4366703746');
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/view/4366703746?trk=foobar')).toBe('4366703746');
  });

  it('extracts ID from a data-entity-urn string', () => {
    expect(extractLinkedInJobId('urn:li:jobPosting:4366703746')).toBe('4366703746');
  });

  it('returns the value directly when passed a plain numeric ID', () => {
    expect(extractLinkedInJobId('4366703746')).toBe('4366703746');
  });

  it('returns null for irrelevant strings', () => {
    expect(extractLinkedInJobId('')).toBeNull();
    expect(extractLinkedInJobId('https://www.linkedin.com/company/dot-life/')).toBeNull();
    expect(extractLinkedInJobId('foobar')).toBeNull();
  });
});

describe('linkedInJobUrl', () => {
  it('builds canonical job URL from ID', () => {
    expect(linkedInJobUrl('4366703746')).toBe('https://www.linkedin.com/jobs/view/4366703746/');
  });
});

/* ── parseDotLifeLinkedInCards ────────────────────────────── */

// Representative HTML from /jobs-guest/jobs/api/seeMoreJobPostings/search
const LISTING_HTML = `
<ul>
  <li data-entity-urn="urn:li:jobPosting:4366703746">
    <div class="base-card base-search-card">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/4366703746/?trk=public_jobs_jserp-result_search-card">
        <span class="sr-only">Addetto alla selezione di personale acquisizione di talenti</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Addetto alla selezione di personale acquisizione di talenti</h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link" href="https://www.linkedin.com/company/dot-life/">DOT Life SA</a>
        </h4>
        <div class="job-search-card__location">Paradiso, Ticino, Switzerland</div>
        <time class="job-search-card__listdate" datetime="2026-03-13">Pubblicato 5 giorni fa</time>
      </div>
    </div>
  </li>
  <li data-entity-urn="urn:li:jobPosting:4366728002">
    <div class="base-card base-search-card">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/4366728002/?trk=public_jobs_jserp-result_search-card">
        <span class="sr-only">Front office Supervisor</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Front office Supervisor</h3>
        <h4 class="base-search-card__subtitle">
          <a class="hidden-nested-link" href="https://www.linkedin.com/company/dot-life/">DOT Life SA</a>
        </h4>
        <div class="job-search-card__location">Lugano, Ticino, Switzerland</div>
        <time class="job-search-card__listdate" datetime="2026-03-13">Pubblicato 5 giorni fa</time>
      </div>
    </div>
  </li>
  <li data-entity-urn="urn:li:jobPosting:4366728002">
    <!-- Duplicate of the previous card — should be deduplicated -->
    <div class="base-card base-search-card">
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Front office Supervisor</h3>
      </div>
    </div>
  </li>
</ul>
`;

describe('parseDotLifeLinkedInCards', () => {
  it('extracts all unique job cards', () => {
    const cards = parseDotLifeLinkedInCards(LISTING_HTML);
    expect(cards).toHaveLength(2);
  });

  it('extracts correct fields from each card', () => {
    const cards = parseDotLifeLinkedInCards(LISTING_HTML);
    expect(cards[0].jobId).toBe('4366703746');
    expect(cards[0].title).toBe('Addetto alla selezione di personale acquisizione di talenti');
    expect(cards[0].company).toBe('DOT Life SA');
    expect(cards[0].location).toBe('Paradiso, Ticino, Switzerland');
    expect(cards[0].postedDate).toBe('2026-03-13');
    expect(cards[0].href).toBe('https://www.linkedin.com/jobs/view/4366703746/');
  });

  it('deduplicates cards by jobId', () => {
    const cards = parseDotLifeLinkedInCards(LISTING_HTML);
    const ids = cards.map((c) => c.jobId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns empty array when no cards present', () => {
    expect(parseDotLifeLinkedInCards('<html><body><p>No jobs.</p></body></html>')).toHaveLength(0);
  });
});

/* ── parseDotLifeLinkedInDetail — HTML fallback ───────────── */

const DETAIL_HTML_NO_JSONLD = `
<div class="top-card-layout">
  <h1 class="top-card-layout__title">Front office Supervisor</h1>
  <div class="top-card-layout__card">
    <div class="top-card-layout__second-subline">
      <a class="topcard__org-name-link">DOT Life SA</a>
    </div>
    <div class="top-card-layout__first-subline">
      <span class="top-card-layout__bullet topcard__flavor--bullet">Lugano, Ticino, Switzerland</span>
    </div>
  </div>
</div>
<section class="description">
  <div class="show-more-less-html__markup">
    <h3>Chi siamo</h3>
    <p>DOT Life SA gestisce strutture di lusso in Ticino.</p>
    <h3>Responsabilità</h3>
    <ul>
      <li>Gestione front office</li>
      <li>Accoglienza ospiti</li>
      <li>Coordinamento del team</li>
    </ul>
  </div>
</section>
<ul class="description__job-criteria-list">
  <li class="description__job-criteria-item">
    <h3>Employment type</h3>
    <span>Full-time</span>
  </li>
  <li class="description__job-criteria-item">
    <h3>Seniority level</h3>
    <span>Mid-Senior level</span>
  </li>
</ul>
<time datetime="2026-03-13">Pubblicato 5 giorni fa</time>
`;

describe('parseDotLifeLinkedInDetail (HTML fallback)', () => {
  it('extracts title, company, and location', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_NO_JSONLD, 'https://linkedin.com/jobs/view/4366728002/');
    expect(detail.title).toBe('Front office Supervisor');
    expect(detail.company).toContain('DOT Life SA');
    expect(detail.location).toContain('Lugano');
  });

  it('builds markdown description from show-more-less section', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_NO_JSONLD, 'https://example.com');
    expect(detail.description).toContain('Chi siamo');
    expect(detail.description).toContain('Gestione front office');
    expect(detail.description).toContain('Accoglienza ospiti');
  });

  it('extracts employment type and seniority from criteria', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_NO_JSONLD, 'https://example.com');
    expect(detail.employmentType).toBe('Full-time');
    expect(detail.seniority).toBe('Mid-Senior level');
  });

  it('extracts posted date', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_NO_JSONLD, 'https://example.com');
    expect(detail.postedDate).toBe('2026-03-13');
  });
});

/* ── parseDotLifeLinkedInDetail — JSON-LD preferred ────────── */

const DETAIL_HTML_WITH_JSONLD = `
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Front office Manager",
  "url": "https://www.linkedin.com/jobs/view/4366745329/",
  "datePosted": "2026-03-13",
  "employmentType": "FULL_TIME",
  "description": "<p>DOT Life SA gestisce Villa Principe Leopoldo a Lugano.</p><ul><li>Gestione del reparto front office</li><li>Supervisione del team</li></ul>",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "DOT Life SA"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Lugano",
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

describe('parseDotLifeLinkedInDetail (JSON-LD preferred)', () => {
  it('extracts title, company and location from JSON-LD', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_WITH_JSONLD, 'https://fallback.example.com');
    expect(detail.title).toBe('Front office Manager');
    expect(detail.company).toBe('DOT Life SA');
    expect(detail.location).toBe('Lugano');
  });

  it('strips HTML from JSON-LD description', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_WITH_JSONLD, 'https://example.com');
    expect(detail.description).not.toContain('<p>');
    expect(detail.description).toContain('Villa Principe Leopoldo');
    expect(detail.description).toContain('front office');
  });

  it('uses JSON-LD url as shareUrl', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_WITH_JSONLD, 'https://fallback.example.com');
    expect(detail.shareUrl).toBe('https://www.linkedin.com/jobs/view/4366745329/');
  });

  it('extracts employmentType and datePosted', () => {
    const detail = parseDotLifeLinkedInDetail(DETAIL_HTML_WITH_JSONLD, 'https://example.com');
    expect(detail.employmentType).toBe('FULL_TIME');
    expect(detail.postedDate).toBe('2026-03-13');
  });
});

/* ── buildDotLifeLocalizedContent ────────────────────────── */

describe('buildDotLifeLocalizedContent', () => {
  it('builds stub locale content with it and en slugs', () => {
    const localized = buildDotLifeLocalizedContent({
      title: 'Front office Supervisor',
      location: 'Lugano',
      description: 'Descrizione del ruolo.',
    });
    expect(localized.titleByLocale.it).toBe('Front office Supervisor');
    expect(localized.descriptionByLocale.it).toBe('Descrizione del ruolo.');
    expect(localized.slugByLocale.it).toContain('front-office-supervisor');
    expect(localized.slugByLocale.it).toContain('dot-life-sa');
    expect(localized.slugByLocale.en).toBe(localized.slugByLocale.it);
  });

  it('handles empty inputs without throwing', () => {
    const localized = buildDotLifeLocalizedContent({});
    expect(localized.titleByLocale.it).toBe('');
    expect(localized.slugByLocale.it).toBeTruthy();
  });
});
