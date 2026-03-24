/**
 * LIS (Lugano Istituti Sociali) — Arca24 ATS parser tests
 *
 * Tests parseArca24ListingPage(), parseArca24DetailPage(), and buildLisJob()
 * using HTML fixtures matching the real Arca24 structure at lavoraconnoi.lugano-lis.ch.
 */
import { describe, it, expect } from 'vitest';

import {
  parseArca24ListingPage,
  parseArca24DetailPage,
  buildLisJob,
  normalizeSpace,
  stripHtml,
  slugify,
} from '@/scripts/lib/lis-lugano-istituti-sociali-job-parser.mjs';

// ── Fixture: Arca24 listing page with 2 job results ──

const LISTING_HTML = `
<html lang="it">
<head><title>Trova il tuo lavoro con LIS</title></head>
<body>
<div class="searchresults forCandidates" id="searchResults">
  <div class="searchResultsBody" role="list">
    <div class="singleResult responsiveOnly" role="listitem">
      <div class="operation"></div>
      <div class="details">
        <div class="dataContainer">
          <a href="../job/view-job.php?id=25-capireparto-pregassona&language=it" target="_parent">
            <h3>Capireparto</h3>
          </a>
          <div class="detailsHead">
            <table>
              <tr>
                <th><span class="glyphicon google-maps"></span><label>Luogo di lavoro:</label></th>
                <td>
                  <span>
                    <span>Svizzera</span>, <span>Ticino</span>, <span class="citySpan">Pregassona</span>
                  </span>
                </td>
              </tr>
            </table>
          </div>
          <div class="detailsData">
            <div class="descriptionContainer">
              <p>Il Consiglio di Amministrazione apre il concorso pubblico per capireparto alle condizioni del ROCIS.</p>
            </div>
            <span class="continue">...</span>
          </div>
        </div>
        <div class="date right">
          <span class="date">26/01/2026 - 13/12/2026</span>
        </div>
      </div>
    </div>
    <div class="smallspacer"></div>
    <div class="singleResult responsiveOnly" role="listitem">
      <div class="operation"></div>
      <div class="details">
        <div class="dataContainer">
          <a href="../job/view-job.php?id=29-infermieri-pregassona&language=it" target="_parent">
            <h3>Infermieri</h3>
          </a>
          <div class="detailsHead">
            <table>
              <tr>
                <th><span class="glyphicon google-maps"></span><label>Luogo di lavoro:</label></th>
                <td>
                  <span>
                    <span>Svizzera, Ticino</span>, <span class="citySpan">Pregassona</span>
                  </span>
                </td>
              </tr>
            </table>
          </div>
          <div class="detailsData">
            <div class="descriptionContainer">
              <p>Il Consiglio di Amministrazione apre il concorso pubblico per infermieri.</p>
            </div>
            <span class="continue">...</span>
          </div>
        </div>
        <div class="date right">
          <span class="date">26&sol;01&sol;2026 - 13&sol;12&sol;2026</span>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>
`;

// ── Fixture: Arca24 detail page ──

const DETAIL_HTML = `
<html lang="it">
<head>
  <title>Capireparto - LIS &ndash; Lugano Istituti Sociali</title>
  <meta property="og:title" content="Capireparto - Svizzera Ticino Pregassona - LIS &ndash; Lugano Istituti Sociali" />
  <script type="application/ld+json">
    {"@context": "http://schema.org", "@type": "TravelAction", "toLocation": {"@type": "City", "name": "Pregassona"}}
  </script>
</head>
<body>
<h1 itemprop="title" class="title">
  <span style="display:none">
    <span itemprop="hiringOrganization" itemscope itemtype="http://schema.org/Organization">
      <a itemprop="url" href="https://lavoraconnoi.lugano-lis.ch">
        <span itemprop="name">LIS &ndash; Lugano Istituti Sociali</span>
      </a>
    </span>
  </span>
  Capireparto
  <a href="whatsapp://send" class="wa_btn" style="display:none">Invia</a>
</h1>
<div class="detailsHead">
  <table>
    <tr itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
      <th>Luogo di lavoro:</th>
      <td>
        <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
          <span itemprop="addressCountry">Svizzera</span>,
          <span itemprop="addressRegion">Ticino</span>,
          <span itemprop="addressLocality">Pregassona</span>
          <span itemprop="streetAddress" class="hidden">Via alla Bozzoreda 15</span>
        </span>
      </td>
    </tr>
    <tr>
      <th>Settore:</th>
      <td><span itemprop="industry">Ospedaliero/Medicale/Sanitario/Educativo</span></td>
    </tr>
    <tr>
      <th>Ruolo:</th>
      <td><span itemprop="occupationalCategory">Medicina/Salute</span></td>
    </tr>
    <tr class="smaller">
      <th><span>Data ultimo aggiornamento:</span></th>
      <td>
        <strong itemprop="datePosted">26/01/2026</strong>
        <span>Data di scadenza:</span>
        <strong itemprop="validThrough">&nbsp;13/12/2026</strong>
      </td>
    </tr>
  </table>
</div>
<div class="descriptionContainer">
  <span>Short snippet only for listing</span>
</div>
<div class="descriptionContainer ">
  <span>Il Consiglio di Amministrazione dell'Ente Autonomo Lugano Istituti Sociali apre il concorso pubblico (valido per l'anno 2026) per l'assunzione di capireparto alle condizioni del Regolamento Organico dei Collaboratori (ROCIS) dell'Ente Autonomo Lugano Istituti Sociali (LIS) e del capitolato di concorso. Il Consiglio di Amministrazione puo prevedere delle classi stipendiali comprese tra la classe 7 min. CHF 64'017 / max. CHF 82'602 e la classe 9 min. CHF 72'636 / max. CHF 93'731 della tabella degli stipendi secondo ROCIS.</span>
</div>
</body>
</html>
`;

// ── Fixture: detail page with HTML entities (common in Arca24) ──

const DETAIL_HTML_ENTITIES = `
<html lang="it">
<head>
  <title>Infermieri - LIS &ndash; Lugano Istituti Sociali</title>
  <meta property="og:title" content="Infermieri - Svizzera Ticino Pregassona" />
</head>
<body>
<h1 itemprop="title" class="title">
  <span style="display:none">
    <span itemprop="hiringOrganization" itemscope itemtype="http://schema.org/Organization">
      <span itemprop="name">LIS &ndash; Lugano Istituti Sociali</span>
    </span>
  </span>
  Infermieri
  <a class="wa_btn" style="display:none">Invia</a>
</h1>
<div class="detailsHead">
  <table>
    <tr itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
      <th>Luogo di lavoro:</th>
      <td>
        <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
          <span itemprop="addressCountry">Svizzera</span>,
          <span itemprop="addressRegion">Ticino</span>,
          <span itemprop="addressLocality">Pregassona</span>
          <span itemprop="streetAddress" class="hidden">Via alla Bozzoreda 15</span>
        </span>
      </td>
    </tr>
    <tr class="smaller">
      <th><span>Data ultimo aggiornamento:</span></th>
      <td>
        <strong itemprop="datePosted">26/01/2026</strong>
        <span>Data di scadenza:</span>
        <strong itemprop="validThrough">&nbsp;13/12/2026</strong>
      </td>
    </tr>
  </table>
</div>
<div class="descriptionContainer ">
  <span>Il Consiglio di Amministrazione dell&apos;Ente Autonomo Lugano Istituti Sociali apre il concorso pubblico &lpar;valido per l&apos;anno 2026&rpar; per l&apos;assunzione di&NewLine;&NewLine;infermieri&NewLine;&NewLine;alle condizioni del Regolamento Organico dei Collaboratori &lpar;ROCIS&rpar;.</span>
</div>
</body>
</html>
`;

// ── Tests ────────────────────────────────────────────────────

describe('LIS Arca24 parser — listing page', () => {
  it('extracts job URLs and titles from Arca24 listing HTML', () => {
    const jobs = parseArca24ListingPage(LISTING_HTML, 'https://lavoraconnoi.lugano-lis.ch/jobs.php');
    expect(jobs.length).toBe(2);

    expect(jobs[0].title).toBe('Capireparto');
    expect(jobs[0].url).toContain('view-job.php?id=25-capireparto-pregassona');
    expect(jobs[0].location).toBe('Pregassona');

    expect(jobs[1].title).toBe('Infermieri');
    expect(jobs[1].url).toContain('view-job.php?id=29-infermieri-pregassona');
    expect(jobs[1].location).toBe('Pregassona');
  });

  it('resolves relative URLs to absolute', () => {
    const jobs = parseArca24ListingPage(LISTING_HTML, 'https://lavoraconnoi.lugano-lis.ch/jobs.php');
    expect(jobs[0].url).toMatch(/^https:\/\/lavoraconnoi\.lugano-lis\.ch\//);
  });

  it('extracts description snippets', () => {
    const jobs = parseArca24ListingPage(LISTING_HTML, 'https://lavoraconnoi.lugano-lis.ch/jobs.php');
    expect(jobs[0].snippet).toContain('concorso pubblico');
    expect(jobs[0].snippet).toContain('capireparto');
  });

  it('returns empty array for non-listing HTML', () => {
    const jobs = parseArca24ListingPage('<html><body><p>No jobs</p></body></html>');
    expect(jobs).toEqual([]);
  });
});

describe('LIS Arca24 parser — detail page', () => {
  it('extracts title from H1 with itemprop', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML, 'https://lavoraconnoi.lugano-lis.ch/job/view-job.php?id=25');
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Capireparto');
  });

  it('strips company prefix and "Invia" suffix from title', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML);
    // The H1 has hidden spans with company name and "Invia" button
    // The parser should extract only "Capireparto"
    expect(parsed!.title).not.toContain('LIS');
    expect(parsed!.title).not.toContain('Invia');
  });

  it('extracts location from microdata', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML);
    expect(parsed!.location).toBe('Pregassona');
    expect(parsed!.region).toBe('Ticino');
    expect(parsed!.streetAddress).toBe('Via alla Bozzoreda 15');
  });

  it('extracts sector and role', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML);
    expect(parsed!.sector).toContain('Ospedaliero');
    expect(parsed!.role).toContain('Medicina');
  });

  it('extracts dates in ISO format', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML);
    expect(parsed!.datePosted).toBe('2026-01-26');
    expect(parsed!.validThrough).toBe('2026-12-13');
  });

  it('extracts the longest description container', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML);
    // The main description is the longer container
    expect(parsed!.description).toContain('Regolamento Organico dei Collaboratori');
    expect(parsed!.description.length).toBeGreaterThan(100);
  });

  it('handles HTML entities in description', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML_ENTITIES);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Infermieri');
    expect(parsed!.description).toContain('Ente Autonomo Lugano Istituti Sociali');
    // HTML entities should be decoded
    expect(parsed!.description).not.toContain('&apos;');
    expect(parsed!.description).not.toContain('&NewLine;');
  });

  it('returns null for empty or non-job HTML', () => {
    expect(parseArca24DetailPage('')).toBeNull();
    expect(parseArca24DetailPage('<html><body><h1>About Us</h1></body></html>')).toBeNull();
  });
});

describe('LIS Arca24 parser — buildLisJob', () => {
  it('builds a complete job object from parsed detail data', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML, 'https://lavoraconnoi.lugano-lis.ch/job/view-job.php?id=25');
    const job = buildLisJob('https://lavoraconnoi.lugano-lis.ch/job/view-job.php?id=25', parsed!);
    expect(job).not.toBeNull();
    expect(job!.title).toBe('Capireparto');
    expect(job!.company).toBe('LIS \u2013 Lugano Istituti Sociali');
    expect(job!.companyKey).toBe('lis-lugano-istituti-sociali');
    expect(job!.canton).toBe('TI');
    expect(job!.country).toBe('CH');
    expect(job!.location).toBe('Pregassona');
    expect(job!.streetAddress).toBe('Via alla Bozzoreda 15');
    expect(job!.slug).toBe('capireparto');
    expect(job!.source).toBe('arca24');
    expect(job!.datePosted).toBe('2026-01-26');
  });

  it('returns null when parsed data is null', () => {
    expect(buildLisJob('https://example.com', null as any)).toBeNull();
  });

  it('sets titleByLocale and slugByLocale for all 4 locales', () => {
    const parsed = parseArca24DetailPage(DETAIL_HTML);
    const job = buildLisJob('https://example.com', parsed!);
    expect(Object.keys(job!.titleByLocale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(Object.keys(job!.slugByLocale)).toEqual(['it', 'en', 'de', 'fr']);
  });
});

describe('LIS Arca24 parser — utility functions', () => {
  it('normalizeSpace collapses whitespace', () => {
    expect(normalizeSpace('  hello   world  ')).toBe('hello world');
    expect(normalizeSpace('\n\ttab\n')).toBe('tab');
  });

  it('stripHtml removes HTML tags and decodes entities', () => {
    expect(stripHtml('<p>Hello &amp; world</p>')).toContain('Hello & world');
    expect(stripHtml('<script>alert("x")</script>text')).toBe('text');
  });

  it('stripHtml decodes Arca24-specific entities', () => {
    const result = stripHtml('path&sol;to&comma;file&ndash;name');
    expect(result).toContain('/');
    expect(result).toContain(',');
  });

  it('slugify produces URL-safe slugs', () => {
    expect(slugify('Capireparto')).toBe('capireparto');
    expect(slugify('Operatori socioassistenziali')).toBe('operatori-socioassistenziali');
    expect(slugify('Fisioterapisti/Ergoterapisti')).toBe('fisioterapisti-ergoterapisti');
  });
});
