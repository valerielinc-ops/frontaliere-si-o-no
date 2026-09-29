import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  parseOnlyfyListing,
  onlyfyFullAdUrl,
  extractOnlyfyJobAdText,
} from '../scripts/lib/onlyfy-listing-common.mjs';
import { fetchAllSpitexZuerichJobs, SPITEX_ZUERICH_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/spitex-zuerich-job-parser.mjs';

// Redesigned onlyfy.jobs card markup (2026). Both spitex-zuerich and
// vitrea-gesundheit sit on this portal; the old `<strong class="job-title">`
// selector silently returned 0 after this redesign.
const NEW_MARKUP = `
<div class="results">
  <a class="..." data-testid="job-card"
     aria-label="Dipl. Pflegefachfrau/-mann 60-100% (a)"
     href="/de/job/m6pttk2bqih13nqd4pbab9zfy4ntcpd">
    <div><h3 class="heading text-primary" data-testid="job-title">Dipl. Pflegefachfrau/-mann 60-100% (a)</h3></div>
    <div class="text-sm text-primary" data-testid="job-more-info">Zürich | Teilzeit / Vollzeit | 18.05.2026</div>
  </a>
  <a data-testid="job-card" aria-label="Fachfrau Gesundheit FaGe 40-90%"
     href="/de/job/acyvj8k21gua2zs1trmrl9ksk9ph92j">
    <div><h3 data-testid="job-title">Fachfrau Gesundheit FaGe 40-90%</h3></div>
    <div data-testid="job-more-info">Winterthur | Teilzeit | 12.05.2026</div>
  </a>
</div>`;

// The legacy markup the parser used to depend on — must yield nothing now, so a
// silent fallback to the old selector can never mask a future redesign.
const OLD_MARKUP = `
<strong class="job-title"><a href="/job/abc123def456">Pflegefachperson HF</a></strong>
<i class="icon-map-marker">Zürich</i><i class="icon-time">Teilzeit</i>`;

describe('parseOnlyfyListing', () => {
  it('extracts cards from the redesigned data-testid markup', () => {
    const rows = parseOnlyfyListing(NEW_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
      defaultLocation: 'Zürich',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: 'Dipl. Pflegefachfrau/-mann 60-100% (a)',
      location: 'Zürich',
      employmentTypeStr: 'Teilzeit / Vollzeit',
      url: 'https://spitex-zuerich.onlyfy.jobs/de/job/m6pttk2bqih13nqd4pbab9zfy4ntcpd',
    });
    expect(rows[1].location).toBe('Winterthur');
  });

  it('returns no rows for the deprecated legacy markup (no silent fallback)', () => {
    const rows = parseOnlyfyListing(OLD_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
    });
    expect(rows).toHaveLength(0);
  });

  it('dedupes repeated job-card hrefs', () => {
    const rows = parseOnlyfyListing(NEW_MARKUP + NEW_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
    });
    expect(rows).toHaveLength(2);
  });

  // onlyfy hashes are opaque; a `-` separator must NOT make the listing guard
  // reject the card (silent-zero) nor truncate the per-tenant matchKey to a
  // partial key (previousSlugs fragmentation, #829 class). Hash char-class is
  // `[a-z0-9-]` here AND in the update-* matchKey regex — keep them in lockstep.
  it('accepts job hashes that contain a hyphen separator', () => {
    const HYPHEN_MARKUP = `
      <a data-testid="job-card" aria-label="Pflegefachperson HF 80%"
         href="/de/job/abc123-def456-ghi789">
        <div><h3 data-testid="job-title">Pflegefachperson HF 80%</h3></div>
        <div data-testid="job-more-info">Zürich | Vollzeit | 01.06.2026</div>
      </a>`;
    const rows = parseOnlyfyListing(HYPHEN_MARKUP, {
      portalBase: 'https://spitex-zuerich.onlyfy.jobs',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('https://spitex-zuerich.onlyfy.jobs/de/job/abc123-def456-ghi789');

    // Mirror of the `matchKey` extraction in the update-* crawlers: the full
    // hyphenated hash must survive, not truncate at the first `-`.
    const matchKey = (j: { url: string }) =>
      j.url.match(/\/job\/([a-z0-9-]+)/i)?.[1] || j.url;
    expect(matchKey(rows[0])).toBe('abc123-def456-ghi789');
  });
});

// Job-ad documents fetched live on 2026-09-29 (`/job/show/{handle}/full`),
// minimized; contact persons replaced by placeholders. The public detail URL
// is a client-rendered shell whose server HTML has no role text.
const readFixture = (tenant: string) => fs.readFileSync(
  path.join(__dirname, 'fixtures', tenant, 'job-ad-full.html'),
  'utf8',
);

describe('onlyfyFullAdUrl', () => {
  it('maps a public detail URL to its ad document', () => {
    expect(onlyfyFullAdUrl('https://spitex-zuerich.onlyfy.jobs/de/job/ypv2le9p78ygmhn2pogybj1gphgx2ls'))
      .toBe('https://spitex-zuerich.onlyfy.jobs/job/show/ypv2le9p78ygmhn2pogybj1gphgx2ls/full?lang=de&mode=candidate');
    expect(onlyfyFullAdUrl('https://vamed-ag-ch.onlyfy.jobs/job/abc123-def456'))
      .toBe('https://vamed-ag-ch.onlyfy.jobs/job/show/abc123-def456/full?lang=de&mode=candidate');
  });

  it('returns an empty string for anything that is not a job URL', () => {
    expect(onlyfyFullAdUrl('https://spitex-zuerich.onlyfy.jobs/')).toBe('');
    expect(onlyfyFullAdUrl('not a url')).toBe('');
  });
});

describe('extractOnlyfyJobAdText', () => {
  it('reads the prescreen template ad (spitex-zuerich) without buttons or contact card', () => {
    const text = extractOnlyfyJobAdText(readFixture('spitex-zuerich'));
    expect(text.startsWith('Es freut uns, dass du dich für einen Praktikumsplatz')).toBe(true);
    expect(text).toContain('WARUM ES SICH LOHNT, BEI UNS DEIN PRAKTIKUM ZU ABSOLVIEREN\n• Auf deinen aktuellen Bildungsstand');
    expect(text).toContain('DAS ERWARTET DICH BEI UNS\n• Ressourcen- und zielorientierte');
    expect(text).toContain('DU BRINGST MIT\n• Abschluss des Studiums Bachelor of Science in Pflege FH');
    expect(text).not.toMatch(/Bändliweg|bewegte-jobs|\+41 00 000/);
    expect(text).not.toMatch(/^•\s*$/m);
  });

  it('reads the component template ad (vitrea-gesundheit) up to the apply button, never the hidden StepStone copy', () => {
    const text = extractOnlyfyJobAdText(readFixture('vitrea-gesundheit'));
    expect(text).toContain('Darauf darfst du dich freuen:\n• Pflegeteam aktiv und vorbildlich');
    expect(text).toContain('Darüber freuen wir uns:\n• Abgeschlossene Ausbildung als Pflegefachperson auf Tertiärstufe');
    expect(text).toContain('Darum Rehaklinik Zihlschlacht:');
    expect(text).not.toMatch(/Jetzt bewerben|Fragen zum Bewerbungsprozess|Vorname Nachname|Einleitung/);
    // One copy of the ad, not the visible one plus the StepStone export.
    expect(text.match(/Darauf darfst du dich freuen/g)).toHaveLength(1);
  });

  it('returns an empty string for a page without an ad template', () => {
    expect(extractOnlyfyJobAdText('<html><body><main>Alle Jobs</main></body></html>')).toBe('');
  });
});

describe('fetchAllSpitexZuerichJobs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes the ad from the job-ad document, not the synthesised stub', async () => {
    const listing = NEW_MARKUP;
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(String(url));
      const body = String(url).includes('/job/show/') ? readFixture('spitex-zuerich') : listing;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }));
    const jobs = await fetchAllSpitexZuerichJobs();
    expect(jobs).toHaveLength(2);
    expect(requested).toContain('https://spitex-zuerich.onlyfy.jobs/job/show/m6pttk2bqih13nqd4pbab9zfy4ntcpd/full?lang=de&mode=candidate');
    expect(jobs[0].description.startsWith('Es freut uns, dass du dich')).toBe(true);
    expect(jobs[0].description).toContain('• Arbeitszeit: Teilzeit / Vollzeit');
    expect(jobs[0].description).not.toMatch(/Bewerbung über das softgarden|gemeinnützige Non-Profit-Organisation/);
  }, 20000);

  it('writes no stub of its own when the ad document has no text (thin-source path)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = String(url).includes('/job/show/') ? '<html><body><main>Alle Jobs</main></body></html>' : NEW_MARKUP;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
    }));
    const jobs = await fetchAllSpitexZuerichJobs();
    // Both vacancies are kept, with no description: the former stub
    // ("<Titel> bei Spitex Zürich, … Schweiz." with Standort/Bereich/Bewerbung
    // bullets) is gone and the pipeline quarantines the empty description.
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.description).toBe('');
      expect(job.description).not.toMatch(SPITEX_ZUERICH_FABRICATED_DESCRIPTION_RE);
    }
  }, 20000);
});
