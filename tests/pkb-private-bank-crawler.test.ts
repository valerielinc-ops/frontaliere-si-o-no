import { describe, it, expect } from 'vitest';
import {
  PKB_KEY,
  COMPANY_NAME,
  HQ,
  parsePkbListingPage,
  parsePkbDetailPage,
  buildPkbJob,
} from '../scripts/lib/pkb-private-bank-job-parser.mjs';

const LISTING_HTML = `
<html><body>
<div class="singleResult responsiveOnly" role="listitem">
  <a href="../job/view-job.php?id=123-senior-compliance-officer&language=it"><h3>Senior Compliance Officer</h3></a>
  <span class="citySpan">Lugano</span>
  <div class="descriptionContainer"><p>Ruolo di compliance in banca privata.</p></div>
  <span class="date">09/07/2026 - 09/09/2026</span>
</div>
<div class="singleResult responsiveOnly" role="listitem">
  <a href="../job/view-job.php?id=456-junior-assistant&language=it"><h3>Junior Private Banking Assistant</h3></a>
  <span class="citySpan">Lugano</span>
  <div class="descriptionContainer"><p>Supporto ai consulenti della clientela.</p></div>
  <span class="date">02/07/2026 - 02/09/2026</span>
</div>
<footer>trailing markup so the last block has no clean closing boundary</footer>
</body></html>`;

const DETAIL_HTML = `
<html><body>
<h1 itemprop="title">PKB Private Bank SA Senior Compliance Officer <a>Invia</a></h1>
<span itemprop="addressLocality">Lugano</span>
<span itemprop="addressRegion">Ticino</span>
<span itemprop="streetAddress">Via Serafino Balestra 1</span>
<span itemprop="industry">Banking</span>
<span itemprop="datePosted">09/07/2026</span>
<strong itemprop="validThrough">09/09/2026</strong>
<div itemprop="description"><p>Cerchiamo un Senior Compliance Officer con esperienza in ambito FATCA, QI e AEOI/CRS per la nostra sede di Lugano.</p></div>
</body></html>`;

// Reproduces the real `view-job.php` layout, where `itemprop="description"`
// appears THREE times: a void `<meta>` in the head, the real `<div>` container,
// and a `<p>` inside the login modal. `locateTagByAttribute` without
// `{ skipVoidTags: true }` stops on the `<meta>`, and since a void element has
// no `</meta>`, `extractBalancedTagBlock` scans forward to its cap and returns
// the surrounding head markup/scripts as the "description".
const DETAIL_HTML_VOID_META_COLLISION = `
<html><head>
<meta itemprop="description" content="PKB Private Bank SA - offerta di lavoro">
<script>var alertM = { wrongFileSize: "Il file che stai cercando di caricare e troppo grande.", zeroFileSize: "Il file e vuoto.", sicuroRifiutareInvito: "Sei sicuro di voler declinare l'invito?" };</script>
<style>.descriptionContainer { padding: 12px; margin: 0 auto; display: block; }</style>
</head><body>
<h1 itemprop="title">PKB Private Bank SA Senior Compliance Officer <a>Invia</a></h1>
<span itemprop="addressLocality">Lugano</span>
<span itemprop="datePosted">09/07/2026</span>
<div itemprop="description">
  <p>Descrizione del ruolo</p>
  <p>Per la nostra sede di Lugano ricerchiamo un Senior Compliance Officer con consolidata esperienza nell'ambito della Client Tax Compliance e del relativo reporting regolamentare FATCA, QI, AEOI/CRS, AML/CDB.</p>
</div>
<div class="loginModal">
  <p itemprop="description">Inserisci il tuo indirizzo mail per accedere al portale e candidarti alle nostre offerte di lavoro.</p>
</div>
</body></html>`;

describe('PKB Private Bank crawler parser', () => {
  it('exports valid company key and name', () => {
    expect(PKB_KEY).toBe('pkb-private-bank');
    expect(COMPANY_NAME).toBe('PKB Private Bank SA');
  });

  describe('parsePkbListingPage', () => {
    it('extracts every job block including the last one', () => {
      const jobs = parsePkbListingPage(LISTING_HTML, 'https://careers.pkb.ch');
      expect(jobs).toHaveLength(2);
      expect(jobs[0].title).toBe('Senior Compliance Officer');
      expect(jobs[1].title).toBe('Junior Private Banking Assistant');
      expect(jobs[0].location).toBe('Lugano');
      expect(jobs[0].url).toContain('view-job.php?id=123-senior-compliance-officer');
    });

    it('returns empty array for empty/invalid HTML', () => {
      expect(parsePkbListingPage('')).toEqual([]);
      expect(parsePkbListingPage('<html><body>bounce snippet</body></html>')).toEqual([]);
    });
  });

  describe('parsePkbDetailPage', () => {
    it('extracts structured fields from Arca24 microdata', () => {
      const parsed = parsePkbDetailPage(DETAIL_HTML, 'https://careers.pkb.ch/job/view-job.php?id=123');
      expect(parsed).not.toBeNull();
      expect(parsed!.title).toBe('Senior Compliance Officer');
      expect(parsed!.location).toBe('Lugano');
      expect(parsed!.datePosted).toBe('2026-07-09');
      expect(parsed!.validThrough).toBe('2026-09-09');
      expect(parsed!.description).toContain('FATCA');
    });

    it('reads the description from the real <div>, skipping the void <meta> and the login modal', () => {
      const parsed = parsePkbDetailPage(
        DETAIL_HTML_VOID_META_COLLISION,
        'https://careers.pkb.ch/job/view-job.php?id=27-senior-compliance-officer-lugano',
      );
      expect(parsed).not.toBeNull();
      // The real role text wins...
      expect(parsed!.description).toContain('Descrizione del ruolo');
      expect(parsed!.description).toContain('Client Tax Compliance');
      // ...and the block STOPS at that <div>'s close tag. Without
      // `skipVoidTags` the scan starts at the void <meta> and runs past every
      // later element, so these three markers — head markup before the <div>
      // and the login modal after it — are what the overscan drags in.
      expect(parsed!.description).not.toContain('alertM');
      expect(parsed!.description).not.toContain('descriptionContainer');
      expect(parsed!.description).not.toContain('Inserisci il tuo indirizzo mail');
      // Exact boundary: nothing but the <div>'s own two paragraphs.
      expect(parsed!.description.replace(/\s+/g, ' ').trim()).toBe(
        "Descrizione del ruolo Per la nostra sede di Lugano ricerchiamo un Senior Compliance Officer "
        + "con consolidata esperienza nell'ambito della Client Tax Compliance e del relativo reporting "
        + 'regolamentare FATCA, QI, AEOI/CRS, AML/CDB.',
      );
    });

    it('returns null when no usable title is present', () => {
      expect(parsePkbDetailPage('<html><body></body></html>')).toBeNull();
    });
  });

  describe('buildPkbJob', () => {
    const url = 'https://careers.pkb.ch/job/view-job.php?id=123';
    const parsed = parsePkbDetailPage(DETAIL_HTML, url)!;

    it('emits the canonical postedDate field (never datePosted)', () => {
      const job = buildPkbJob(url, parsed)!;
      // #3843 item 5: the pipeline/consumers (JobBoard, sitemap, newsletter,
      // assemble-jobs-dataset churn guard) read `postedDate`; the Arca24
      // microdata name `datePosted` must not leak into the built job object.
      expect(job.postedDate).toBe('2026-07-09');
      expect(job).not.toHaveProperty('datePosted');
    });

    it('falls back to today for postedDate when the source has no date', () => {
      const job = buildPkbJob(url, { ...parsed, datePosted: '' })!;
      expect(job.postedDate).toBe(new Date().toISOString().split('T')[0]);
    });

    it('fills HQ defaults and company identity', () => {
      const job = buildPkbJob(url, parsed)!;
      expect(job.companyKey).toBe(PKB_KEY);
      expect(job.canton).toBe(HQ.canton);
      expect(job.location).toBe('Lugano');
      expect(job.slug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('returns null for empty parse results', () => {
      expect(buildPkbJob(url, null)).toBeNull();
    });
  });
});
