import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  fetchAllKitaSummervogelJobs,
  isKitaSummervogelJob,
  isTargetKitaSummervogelRole,
  isTrustedDomain,
  KITA_SUMMERVOGEL_JOBS_URL,
  KITA_SUMMERVOGEL_KEY,
  parseKitaSummervogelJobs,
} from '../scripts/lib/kita-summervogel-job-parser.mjs';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function germanDate(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`;
}

const SOURCE_BODY = [
  'Wir suchen eine engagierte Miterzieherin für unsere altersgemischte Kindergruppe.',
  'Sie begleiten die Kinder aufmerksam durch den Kita-Alltag, planen pädagogische Angebote',
  'und arbeiten partnerschaftlich mit Eltern und dem Team zusammen. Zu Ihren Aufgaben gehören',
  'die Beobachtung der kindlichen Entwicklung, die Gestaltung von Spiel- und Lernräumen,',
  'die Übernahme von Verantwortung in der Gruppe sowie die Mitarbeit an unseren Konzepten.',
  'Wir bieten ein wertschätzendes Arbeitsumfeld, regelmässige Fachbegleitung und Raum für',
  'eigene Ideen. Eine Ausbildung als Fachfrau Betreuung Kind oder eine gleichwertige',
  'pädagogische Qualifikation ist erwünscht. Wir freuen uns auf Ihre vollständige Bewerbung.',
].join(' ');

function officialPage(overrides: { title?: string; location?: string; date?: string; body?: string } = {}) {
  const title = overrides.title || 'Miterzieherin';
  const location = overrides.location || '9524 Zuzwil SG';
  const date = overrides.date || germanDate(daysAgo(10));
  const body = overrides.body || SOURCE_BODY;
  return `<!doctype html><html lang="de"><body>
    <main class="jobs-page">
      <section class="job-offer">
        <h2>${title}</h2>
        <p><strong>Arbeitsort:</strong><br>${location}</p>
        <p><strong>Publiziert:</strong> ${date}</p>
        <div class="job-description"><p>${body}</p></div>
        <a href="/jobs/miterzieherin/">Mehr erfahren</a>
      </section>
    </main>
    <footer><p>Kita Summervogel GmbH · Unterdorfstrasse 36c · 9524 Zuzwil SG</p></footer>
  </body></html>`;
}

function response(body: string, url = KITA_SUMMERVOGEL_JOBS_URL) {
  return {
    ok: true,
    status: 200,
    url,
    text: async () => body,
  } as Response;
}

describe('Kita Summervogel educator:SG crawler', () => {
  it('pins the source spec to the official jobs page and the observed educator role', () => {
    const spec = JSON.parse(readFileSync(new URL('../data/prospector/crawlers/kita-summervogel.json', import.meta.url), 'utf8'));
    expect(spec.companyKey).toBe(KITA_SUMMERVOGEL_KEY);
    expect(spec.seedUrls).toEqual([KITA_SUMMERVOGEL_JOBS_URL]);
    expect(spec.detailEnrichment).toBe(true);
    expect(spec.sampleVacancyCount).toBeGreaterThanOrEqual(1);
    expect(spec.sampleTitles).toContain('Miterzieherin');
    expect(JSON.stringify(spec)).not.toMatch(/jobsswitzerland|krippenstellen/);
  });

  it('extracts only a source-backed SG educator block with rich source text', () => {
    const jobs = parseKitaSummervogelJobs(officialPage());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Miterzieherin',
      addressLocality: 'Zuzwil',
      addressRegion: 'SG',
      postalCode: '9524',
      postingDateSource: 'reported',
    });
    expect(jobs[0].url).toBe('https://kitasummervogel.ch/jobs/miterzieherin/');
    expect(jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(jobs[0].datePosted).toBe(germanDate(daysAgo(10)).split('.').reverse().join('-'));
  });

  it('treats the official no-open-positions notice as an authoritative empty page', () => {
    const jobs = parseKitaSummervogelJobs('<main class="jobs-page"><h1>Jobs</h1><p>Zurzeit keine offenen Stellen. Wir freuen uns aber über Blindbewerbungen.</p></main>');
    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBe('authoritative-source-zero');
  });

  it('recognizes the official Elementor Jobangebote heading and loop-grid empty state', () => {
    const jobs = parseKitaSummervogelJobs(`
      <main class="elementor elementor-1029">
        <div class="elementor-element e-con e-child">
          <div class="elementor-element elementor-widget elementor-widget-heading">
            <div class="elementor-widget-container">
              <h2 class="elementor-heading-title">Jobangebote:</h2>
            </div>
          </div>
          <div class="elementor-element elementor-widget elementor-widget-loop-grid">
            <div class="elementor-widget-container">
              <div class="e-loop-nothing-found-message">
                <h5 class="e-loop-nothing-found-message__text">
                  Zurzeit keine offenen Stellen. Wir freuen uns aber über Blindbewerbungen.
                </h5>
              </div>
            </div>
          </div>
        </div>
      </main>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBe('authoritative-source-zero');
  });

  it('does not accept the same Elementor loop-grid empty message from a sidebar', () => {
    const jobs = parseKitaSummervogelJobs(`
      <div class="page-layout">
        <main>
          <div class="elementor-element e-con e-child">
            <div class="elementor-element elementor-widget elementor-widget-heading">
              <div class="elementor-widget-container">
                <h2 class="elementor-heading-title">Jobangebote:</h2>
              </div>
            </div>
            <div class="elementor-element elementor-widget elementor-widget-text-editor">
              <div class="elementor-widget-container">Aktuelle Angebote folgen.</div>
            </div>
          </div>
        </main>
        <aside class="sidebar">
          <div class="elementor-element e-con e-child">
            <div class="elementor-element elementor-widget elementor-widget-loop-grid">
              <div class="elementor-widget-container">
                <div class="e-loop-nothing-found-message">
                  <h5 class="e-loop-nothing-found-message__text">
                    Zurzeit keine offenen Stellen. Wir freuen uns aber über Blindbewerbungen.
                  </h5>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBeUndefined();
  });

  it('does not borrow an empty notice from a later page section', () => {
    const jobs = parseKitaSummervogelJobs(`
      <main>
        <h2>Jobangebote:</h2>
        <h2>Über uns</h2>
        <p>Zurzeit keine offenen Stellen — diese Nachricht betrifft eine spätere sezione.</p>
      </main>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBeUndefined();
  });

  it('checks the later heading boundary before reading its empty-state text', () => {
    const jobs = parseKitaSummervogelJobs(`
      <main>
        <h2>Jobangebote:</h2>
        <p>Aktuelle Angebote folgen.</p>
        <h2>Kontakt: keine offenen Stellen</h2>
      </main>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBeUndefined();
  });

  it('keeps same-title postings distinct when their official URLs differ', () => {
    const postings = [
      {
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Miterzieherin',
        description: SOURCE_BODY,
        url: 'https://kitasummervogel.ch/jobs/miterzieherin-wil-1/',
        datePosted: daysAgo(10).toISOString().slice(0, 10),
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Wil',
            addressRegion: 'SG',
            postalCode: '9500',
            addressCountry: 'CH',
          },
        },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Miterzieherin',
        description: SOURCE_BODY,
        url: 'https://kitasummervogel.ch/jobs/miterzieherin-wil-2/',
        datePosted: daysAgo(11).toISOString().slice(0, 10),
        jobLocation: {
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Wil',
            addressRegion: 'SG',
            postalCode: '9500',
            addressCountry: 'CH',
          },
        },
      },
    ];
    const html = `<script type="application/ld+json">${JSON.stringify(postings)}</script>`;

    const jobs = parseKitaSummervogelJobs(html);

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.url).sort()).toEqual([
      'https://kitasummervogel.ch/jobs/miterzieherin-wil-1/',
      'https://kitasummervogel.ch/jobs/miterzieherin-wil-2/',
    ]);
  });

  it('keeps query-identified postings distinct in both IDs and slugs', async () => {
    const postings = ['1', '2'].map((job) => ({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Miterzieherin',
      description: SOURCE_BODY,
      url: `${KITA_SUMMERVOGEL_JOBS_URL}?job=${job}`,
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Wil',
          addressRegion: 'SG',
          postalCode: '9500',
          addressCountry: 'CH',
        },
      },
    }));
    const html = `<script type="application/ld+json">${JSON.stringify(postings)}</script>`;

    const emitted = await fetchAllKitaSummervogelJobs({ fetchImpl: async () => response(html) });

    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map((job) => job.id)).size).toBe(2);
    expect(new Set(emitted.map((job) => job.slug)).size).toBe(2);
  });

  it('keeps source-identified summaries distinct when the board URL is shared', async () => {
    const postings = ['wil-1', 'wil-2'].map((identifier) => ({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      identifier,
      title: 'Miterzieherin',
      description: SOURCE_BODY,
      url: KITA_SUMMERVOGEL_JOBS_URL,
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'Wil',
          addressRegion: 'SG',
          postalCode: '9500',
          addressCountry: 'CH',
        },
      },
    }));
    const html = `<script type="application/ld+json">${JSON.stringify(postings)}</script>`;

    const jobs = parseKitaSummervogelJobs(html);

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.sourcePostingIdentity).sort()).toEqual(['wil-1', 'wil-2']);

    const emitted = await fetchAllKitaSummervogelJobs({ fetchImpl: async () => response(html) });
    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map((job) => job.id)).size).toBe(2);
  });

  it('does not treat an unrelated page node as the official empty state', () => {
    const jobs = parseKitaSummervogelJobs(`
      <main class="jobs-page">
        <h1>Jobs</h1>
        <section class="company-notice">
          <p>Zurzeit keine offenen Stellen — diese Nachricht betrifft die allgemeine Unternehmensseite.</p>
        </section>
      </main>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBeUndefined();
  });

  it('does not treat a nested empty-looking class as source empty evidence', () => {
    const jobs = parseKitaSummervogelJobs(`
      <main class="jobs-page">
        <div class="no-jobs">
          <p>Zurzeit keine offenen Stellen — diese Nachricht betrifft la pagina aziendale.</p>
        </div>
      </main>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBeUndefined();
  });

  it('accepts an explicit empty marker directly under the job list', () => {
    const jobs = parseKitaSummervogelJobs(`
      <main class="jobs-page">
        <div data-empty-state="true">
          <p>Zurzeit keine offenen Stellen.</p>
        </div>
      </main>
    `);

    expect(jobs).toEqual([]);
    expect((jobs as unknown as { authoritativeEmptyState?: string }).authoritativeEmptyState).toBe('authoritative-source-zero');
  });

  it('rejects non-educator roles and non-SG workplace evidence', () => {
    expect(isTargetKitaSummervogelRole('Köchin')).toBe(false);
    expect(parseKitaSummervogelJobs(officialPage({ location: '8000 Zürich ZH' }))).toEqual([]);
  });

  it('fetches only the official page and emits schema-ready source fields', async () => {
    const fetchImpl = vi.fn(async (url: string) => response(officialPage(), url));
    const jobs = await fetchAllKitaSummervogelJobs({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(KITA_SUMMERVOGEL_JOBS_URL, expect.objectContaining({ headers: expect.any(Object) }));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      companyKey: KITA_SUMMERVOGEL_KEY,
      canton: 'SG',
      addressLocality: 'Zuzwil',
      addressRegion: 'SG',
      addressCountry: 'CH',
      employmentType: 'OTHER',
      sourceLang: 'de',
    });
    expect(isKitaSummervogelJob(jobs[0])).toBe(true);
  });

  it('trusts only the employer origin', () => {
    expect(isTrustedDomain('https://kitasummervogel.ch/jobs/')).toBe(true);
    expect(isTrustedDomain('https://www.kitasummervogel.ch/jobs/miterzieherin/')).toBe(true);
    expect(isTrustedDomain('https://www.jobsswitzerland.ch/en/jobs/69418f21-4f49-4a0b-bb66-68621652fa93')).toBe(false);
    expect(isTrustedDomain('https://krippenstellen.ch/de/frontend/inserate/71152')).toBe(false);
  });
});
