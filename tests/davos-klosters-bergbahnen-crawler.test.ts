import { describe, it, expect } from 'vitest';
import {
  parseDavosKlostersBergbahnenListingHtml,
  parseDavosKlostersBergbahnenDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/davos-klosters-bergbahnen-job-parser.mjs';

// ── fixtures (matching real davosklostersmountains.ch HTML) ───────────

const SAMPLE_LISTING_HTML = `
<html><body>
<div class="job-item clickable js-go-to-link ">
  <h3 class="mb-1 text-primary job-item__title">Allrounder:in Restaurant Bolgen Plaza </h3>
  <div class="row row-gutter--2 vertical-gutter--3">
    <div class="col-md-10 vertical-gutter__item">
      <div class="row row-gutter--2 vertical-gutter--2">
        <div class="col-md vertical-gutter__item">Sommersaison 2026</div>
        <div class="col-md vertical-gutter__item">80%</div>
        <div class="col-md vertical-gutter__item">Gastro &amp; Bar</div>
      </div>
    </div>
    <div class="col-md-2 vertical-gutter__item">
      <a href="/de/mountains/stellenangebote/Allrounder-in-Restaurant-Bolgen-Plaza_j_3007454" class="text-primary">Details anzeigen</a>
    </div>
  </div>
</div>
<div class="job-item clickable js-go-to-link ">
  <h3 class="mb-1 text-primary job-item__title">Betriebselektriker:in</h3>
  <div class="row row-gutter--2 vertical-gutter--3">
    <div class="col-md-10 vertical-gutter__item">
      <div class="row row-gutter--2 vertical-gutter--2">
        <div class="col-md vertical-gutter__item">ab Sommersaison 2026</div>
        <div class="col-md vertical-gutter__item">100%</div>
        <div class="col-md vertical-gutter__item">Bergbahnen</div>
      </div>
    </div>
    <div class="col-md-2 vertical-gutter__item">
      <a href="/de/mountains/stellenangebote/Betriebselektriker-in_j_2730837" class="text-primary">Details anzeigen</a>
    </div>
  </div>
</div>
<div class="job-item clickable js-go-to-link ">
  <h3 class="mb-1 text-primary job-item__title">Mitarbeiter:in Gruppen &amp; Events</h3>
  <div class="row row-gutter--2 vertical-gutter--3">
    <div class="col-md-10 vertical-gutter__item">
      <div class="row row-gutter--2 vertical-gutter--2">
        <div class="col-md vertical-gutter__item">ab 01.06.2026</div>
        <div class="col-md vertical-gutter__item">Teilzeit 80% - 100%</div>
        <div class="col-md vertical-gutter__item">Resorts</div>
      </div>
    </div>
    <div class="col-md-2 vertical-gutter__item">
      <a href="/de/mountains/stellenangebote/Mitarbeiter-in-Gruppen-Events_j_3010123" class="text-primary">Details anzeigen</a>
    </div>
  </div>
</div>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html lang="de"><body>
<main id="main-content" role="main" class="content-block">
  <div class="title-block title-block--main title-block--main-small">
    <div class="media-text media-text--text-only text-center">
      <div class="container container--no-padding-xs">
        <div class="container-narrow">
          <div class="media-text__content">
            <div class="media-text__content__offset">
              <div class="h3 mb-0 text-white">Bergbahnen</div>
              <h1 class="mb-0 h2">
                <span class="d-block text-primary">Betriebselektriker:in</span>
              </h1>
              <div class="meta-list">
                <div class="meta-list__item">ab Sommersaison 2026</div>
                <div class="meta-list__item">100%</div>
                <div class="meta-list__item">
                  <a href='https://example.com/download' class='text-primary'><span class='icon icon-download'></span> Infos downloaden</a>
                </div>
              </div>
            </div>
            <div class="wysiwyg mt-2 pt-1 text-left">
              <p>Die Davos Klosters Mountains sind fünf Berg- und Skigebiete in den Bündner Alpen. Neben den
              Bergbahnen betreibt die Davos Klosters Bergbahnen AG unter der Marke Mountain Hotels und
              Resorts über 23 Unterkünfte vom einfachen Gruppenhaus bis zum gehobenen Vier-Sterne-
              Superior Hotel.</p>
              <p>Für die kommende <strong>Sommersaison 2026</strong> suchen wir eine Person als:</p>
              <p><strong>Betriebselektriker:in 100%</strong></p>
              <ul>
                <li>Unterhalt und Betrieb von Seilbahnen und Schneeanlagen</li>
                <li>Unterhalt und Betrieb unserer Gebäudeinfrastruktur inkl. Gastronomiebetriebe</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>
</body></html>
`;

// ── tests ─────────────────────────────────────────────────────────────

describe('Davos Klosters Bergbahnen job parser', () => {
  describe('parseDavosKlostersBergbahnenListingHtml', () => {
    it('extracts job cards from real HTML structure', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs).toHaveLength(3);
      expect(jobs[0].title).toBe('Allrounder:in Restaurant Bolgen Plaza');
      expect(jobs[0].url).toContain('Allrounder-in-Restaurant-Bolgen-Plaza_j_3007454');
      expect(jobs[0].jobId).toBe('3007454');
    });

    it('extracts metadata (period, percentage, department)', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs[0].period).toBe('Sommersaison 2026');
      expect(jobs[0].percentage).toBe('80%');
      expect(jobs[0].department).toBe('Gastro & Bar');
      expect(jobs[1].percentage).toBe('100%');
      expect(jobs[1].department).toBe('Bergbahnen');
    });

    it('sets all locations to Davos and canton to GR', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      for (const job of jobs) {
        expect(job.location).toBe('Davos');
        expect(job.canton).toBe('GR');
      }
    });

    it('deduplicates by URL', () => {
      const htmlWithDupe = SAMPLE_LISTING_HTML + `
<div class="job-item clickable js-go-to-link">
  <h3 class="mb-1 text-primary job-item__title">Allrounder:in Restaurant Bolgen Plaza </h3>
  <div class="row">
    <div class="col-md-10">
      <div class="row">
        <div class="col-md vertical-gutter__item">Sommersaison 2026</div>
        <div class="col-md vertical-gutter__item">80%</div>
        <div class="col-md vertical-gutter__item">Gastro &amp; Bar</div>
      </div>
    </div>
    <div class="col-md-2">
      <a href="/de/mountains/stellenangebote/Allrounder-in-Restaurant-Bolgen-Plaza_j_3007454">Details</a>
    </div>
  </div>
</div>`;
      const jobs = parseDavosKlostersBergbahnenListingHtml(htmlWithDupe);
      const urls = jobs.map((j) => j.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('generates slug-based IDs', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs[0].id).toBe(slugify('Allrounder:in Restaurant Bolgen Plaza'));
      expect(jobs[1].id).toBe(slugify('Betriebselektriker:in'));
    });

    it('returns empty for null/empty input', () => {
      expect(parseDavosKlostersBergbahnenListingHtml(null)).toEqual([]);
      expect(parseDavosKlostersBergbahnenListingHtml('')).toEqual([]);
      expect(parseDavosKlostersBergbahnenListingHtml(undefined)).toEqual([]);
    });
  });

  // Real-shaped detail page where a SITE-WIDE operational alert banner is
  // rendered inside its OWN `.wysiwyg` block ABOVE the job content — the exact
  // shape that made all 9 davos jobs share one 171-char notice (#3836).
  const SAMPLE_DETAIL_WITH_ALERT_BANNER_HTML = `
<html lang="de"><body>
<header class="site-header">
  <div class="site-alert notification">
    <div class="wysiwyg">
      <p>Aufgrund von tech. Arbeiten an der Pendelbahn (Jschalp-Jakobshorn), wird die 2. Sektion des Jakobshorns am 14.07.2026 ab 15:30 Uhr geschlossen. Danke für das Verständnis.</p>
    </div>
  </div>
</header>
<main id="main-content" role="main" class="content-block">
  <div class="title-block title-block--main title-block--main-small">
    <div class="media-text media-text--text-only text-center">
      <div class="container container--no-padding-xs">
        <div class="container-narrow">
          <div class="media-text__content">
            <div class="media-text__content__offset">
              <div class="h3 mb-0 text-white">Bergbahnen</div>
              <h1 class="mb-0 h2">
                <span class="d-block text-primary">Betriebselektriker:in</span>
              </h1>
              <div class="meta-list">
                <div class="meta-list__item">ab Sommersaison 2026</div>
                <div class="meta-list__item">100%</div>
                <div class="meta-list__item">
                  <a href='https://example.com/download' class='text-primary'><span class='icon icon-download'></span> Infos downloaden</a>
                </div>
              </div>
            </div>
            <div class="wysiwyg mt-2 pt-1 text-left">
              <p>Für die kommende <strong>Sommersaison 2026</strong> suchen wir eine engagierte Person als Betriebselektriker:in für unser Team in Davos.</p>
              <ul>
                <li>Unterhalt und Betrieb von Seilbahnen und Schneeanlagen</li>
                <li>Unterhalt und Betrieb unserer Gebäudeinfrastruktur inkl. Gastronomiebetriebe</li>
                <li>Störungsbehebung und Pikettdienst im Winterbetrieb</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>
<footer class="site-footer"><div class="wysiwyg"><p>Davos Klosters Bergbahnen AG — Kontakt und Impressum. Folgen Sie uns auf allen Kanälen.</p></div></footer>
</body></html>
`;

  // Faithful copy of the parser-quality audit's hasStructuredContent
  // (scripts/audit-parser-quality.mjs) — it is module-local there, so mirror it
  // to assert the extracted description would clear the no-structure signal.
  const auditStripHtml = (html: string) => (html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');
  const auditHasStructuredContent = (desc: string) => {
    const text = auditStripHtml(desc);
    if (/<li[\s>]/i.test(desc)) return true;
    if (/^\s*[-•*]\s/m.test(text)) return true;
    if (/^\s*\d+[.)]\s/m.test(text)) return true;
    return false;
  };

  describe('parseDavosKlostersBergbahnenDetailHtml — #3836 chrome-banner exclusion', () => {
    it('extracts the per-job body, NOT the site-wide alert banner', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_WITH_ALERT_BANNER_HTML);
      expect(result).not.toBeNull();
      // Banner text (the #3836 chrome blob) must be excluded.
      expect(result!.description).not.toContain('Jakobshorn');
      expect(result!.description).not.toContain('geschlossen');
      // Footer boilerplate must be excluded too.
      expect(result!.description).not.toContain('Impressum');
      // The actual job body must be present.
      expect(result!.description).toContain('Seilbahnen');
      expect(result!.description).toContain('Betriebselektriker');
    });

    it('produces a description that clears the audit hasStructuredContent signal', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_WITH_ALERT_BANNER_HTML);
      expect(auditHasStructuredContent(result!.description)).toBe(true);
    });

    it('still extracts the correct title and department past the banner', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_WITH_ALERT_BANNER_HTML);
      expect(result!.title).toBe('Betriebselektriker:in');
      expect(result!.department).toBe('Bergbahnen');
      expect(result!.period).toBe('ab Sommersaison 2026');
      expect(result!.percentage).toBe('100%');
    });
  });

  // #4205 follow-up: a decorative <h1> (e.g. a visually-hidden logo heading)
  // in the header, plus a stray class="h3" element inside the banner, must
  // NOT anchor bodyScope too early or leak into the department field.
  const SAMPLE_DETAIL_WITH_DECORATIVE_H1_AND_BANNER_H3_HTML = `
<html lang="de"><body>
<header class="site-header">
  <h1 class="sr-only">Davos Klosters Mountains</h1>
  <div class="site-alert notification">
    <div class="h3 mb-0">Betriebsmeldung</div>
    <div class="wysiwyg">
      <p>Aufgrund von tech. Arbeiten an der Pendelbahn (Jschalp-Jakobshorn), wird die 2. Sektion des Jakobshorns am 14.07.2026 ab 15:30 Uhr geschlossen. Danke für das Verständnis.</p>
    </div>
  </div>
</header>
<main id="main-content" role="main" class="content-block">
  <div class="title-block title-block--main title-block--main-small">
    <div class="media-text media-text--text-only text-center">
      <div class="container container--no-padding-xs">
        <div class="container-narrow">
          <div class="media-text__content">
            <div class="media-text__content__offset">
              <div class="h3 mb-0 text-white">Bergbahnen</div>
              <h1 class="mb-0 h2">
                <span class="d-block text-primary">Betriebselektriker:in</span>
              </h1>
              <div class="meta-list">
                <div class="meta-list__item">ab Sommersaison 2026</div>
                <div class="meta-list__item">100%</div>
              </div>
            </div>
            <div class="wysiwyg mt-2 pt-1 text-left">
              <p>Für die kommende <strong>Sommersaison 2026</strong> suchen wir eine engagierte Person als Betriebselektriker:in für unser Team in Davos.</p>
              <ul>
                <li>Unterhalt und Betrieb von Seilbahnen und Schneeanlagen</li>
                <li>Störungsbehebung und Pikettdienst im Winterbetrieb</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>
</body></html>
`;

  describe('parseDavosKlostersBergbahnenDetailHtml — #4205 decorative-h1/banner-h3 exclusion', () => {
    it('anchors on the title-owning <h1>, not a decorative <h1> in the header', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_WITH_DECORATIVE_H1_AND_BANNER_H3_HTML);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Betriebselektriker:in');
      expect(result!.description).not.toContain('Jakobshorn');
      expect(result!.description).not.toContain('geschlossen');
      expect(result!.description).toContain('Seilbahnen');
    });

    it('does not leak the banner class="h3" element into department', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_WITH_DECORATIVE_H1_AND_BANNER_H3_HTML);
      expect(result!.department).toBe('Bergbahnen');
      expect(result!.department).not.toBe('Betriebsmeldung');
    });
  });

  describe('parseDavosKlostersBergbahnenDetailHtml', () => {
    it('extracts title from <h1><span class="text-primary">', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.title).toBe('Betriebselektriker:in');
    });

    it('extracts department from <div class="h3">', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.department).toBe('Bergbahnen');
    });

    it('extracts metadata from meta-list (excluding download links)', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.period).toBe('ab Sommersaison 2026');
      expect(result.percentage).toBe('100%');
    });

    it('extracts description from wysiwyg div', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.description).toContain('Davos Klosters Mountains');
      expect(result.description).toContain('Seilbahnen');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('returns null for empty/short content', () => {
      expect(parseDavosKlostersBergbahnenDetailHtml(null)).toBeNull();
      expect(parseDavosKlostersBergbahnenDetailHtml('')).toBeNull();
      expect(parseDavosKlostersBergbahnenDetailHtml('<html><body><p>X</p></body></html>')).toBeNull();
    });
  });

  describe('slugify', () => {
    it('generates clean slugs', () => {
      expect(slugify('Bergbahnmechaniker (m/w/d)')).toBe('bergbahnmechaniker-m-w-d');
    });

    it('strips umlauts', () => {
      expect(slugify('Pistenfahrzeugführer')).toBe('pistenfahrzeugfuhrer');
    });

    it('truncates to 180 chars', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(180);
    });

    it('handles empty input', () => {
      expect(slugify('')).toBe('');
      expect(slugify(null)).toBe('');
      expect(slugify(undefined)).toBe('');
    });
  });

  describe('stripHtml', () => {
    it('removes tags', () => {
      expect(stripHtml('<p>Hallo <b>Davos</b></p>')).toBe('Hallo Davos');
    });

    it('decodes entities', () => {
      expect(stripHtml('&amp; &lt; &gt; &quot; &apos;')).toBe("& < > \" '");
    });

    it('handles empty input', () => {
      expect(stripHtml('')).toBe('');
      expect(stripHtml(null)).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('detects full-time by default', () => {
      expect(inferEmploymentType('Bergbahnmechaniker', 'Festanstellung')).toBe('FULL_TIME');
    });

    it('detects seasonal/temporary', () => {
      expect(inferEmploymentType('Chef de Partie (Saison)', '')).toBe('TEMPORARY');
    });

    it('detects part-time from percentage', () => {
      expect(inferEmploymentType('Mitarbeiter 50%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(inferEmploymentType('Teilzeit Kassierer', '')).toBe('PART_TIME');
    });

    it('detects full-time from 100%', () => {
      expect(inferEmploymentType('Pistenfahrzeugführer 100%', '')).toBe('FULL_TIME');
    });
  });
});
