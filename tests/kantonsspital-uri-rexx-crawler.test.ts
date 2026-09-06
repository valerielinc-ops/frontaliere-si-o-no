import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRexxSystemsParser,
  extractRexxDetail,
} from '../scripts/lib/rexx-systems-job-parser-common.mjs';
import {
  fetchAllKantonsspitalUriJobs,
  KANTONSSPITAL_URI_KEY,
} from '../scripts/lib/kantonsspital-uri-job-parser.mjs';
import { restoreExistingSlugIdentity, slugify } from '../scripts/lib/crawler-template.mjs';

const DETAIL_URL = 'https://stellen.ksuri.ch/Assistenzaerztin-Assistenzarzt-Gynaekologie-und-Geburtshil-de-j402.html';
const SECOND_DETAIL_URL = 'https://stellen.ksuri.ch/Pflegefachperson-de-j403.html';
const TITLE = 'Assistenzärztin / -Assistenzarzt Gynäkologie und Geburtshilfe (w/m/d) 100%';
const SOURCE_POSTED_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function listingEntry(url = DETAIL_URL, title = TITLE) {
  return `<article class="joboffer_container" onclick="window.location.href='${url}'">
    <div class="joboffer_title_text joboffer_box"><a href="${url}">${title}</a></div>
    <div class="joboffer_informations joboffer_box"><span class="job_standort">Kantonsspital Uri</span></div>
  </article>`;
}

function listingFixture(entries = [{ url: DETAIL_URL, title: TITLE }]) {
  return entries.map((entry) => listingEntry(entry.url, entry.title)).join('\n');
}

function realRexxDetailFixture({
  title = TITLE,
  locality = 'Kantonsspital Uri',
  region = 'Uri',
  postalCode = '6460',
  streetAddress = 'Spitalstrasse 1',
  structuredTitle = title,
  structuredUrl = '',
  addressCountry = 'CH',
  extraStructuredHtml = '',
  includeJobLocation = true,
  description = `<h2></h2><p>Das Kantonsspital Uri stellt mit seinem erweiterten Leistungsangebot die medizinische Grundversorgung für die Region sicher.</p>
    <h2>WIR SUCHEN</h2><p>Wir suchen eine motivierte Persönlichkeit für die Gynäkologie und Geburtshilfe.</p>
    <ul><li>Interdisziplinäre Betreuung der Patientinnen</li><li>Mitarbeit im Ambulatorium und im Operationsbetrieb</li></ul>
    <h2>WAS DICH ERWARTET</h2><p>Ein modernes und vielseitiges Arbeitsumfeld in einem dynamischen Team. Gemeinsam betreuen wir unsere Patientinnen ganzheitlich und mit hohem Engagement. Das breite Spektrum umfasst ambulante Konsultationen, operative Eingriffe und die enge Zusammenarbeit mit spezialisierten Partnerkliniken.</p>
    <h2>UNSER ANGEBOT</h2><p>Eine strukturierte Weiterbildung, direkte fachärztliche Begleitung und langfristige Entwicklungsmöglichkeiten. Gute Deutschkenntnisse und Freude an der interdisziplinären Zusammenarbeit ergänzen dein Profil.</p>`,
  structuredDescription = description,
  renderedDescription = description,
} = {}) {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: structuredTitle,
    ...(structuredUrl ? { url: structuredUrl } : {}),
    description: structuredDescription,
    datePosted: SOURCE_POSTED_DATE,
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: 'Kantonsspital Uri' },
    ...(includeJobLocation ? { jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress,
        addressLocality: locality,
        addressRegion: region,
        postalCode,
        addressCountry,
      },
    } } : {}),
  })}</script>${extraStructuredHtml}</head><body>
    <main id="pageframework_content"><div id="jobTplContainer" class="ck_content">
      <h1>${title}</h1>${renderedDescription}
    </div></main>
  </body></html>`;
}

function stubKantonsspitalSource(detailHtml: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/stellenangebote.html')) return new Response(listingFixture(), { status: 200 });
    if (url === DETAIL_URL) return new Response(detailHtml, { status: 200 });
    return new Response('', { status: 404 });
  }));
}

beforeEach(() => {
  process.env.JOBS_CRAWLER_RETRIES = '0';
  process.env.JOBS_CRAWLER_RETRY_BASE_MS = '0';
  process.env.JOBS_CRAWLER_TIMEOUT_MS = '10';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.JOBS_CRAWLER_RETRIES;
  delete process.env.JOBS_CRAWLER_RETRY_BASE_MS;
  delete process.env.JOBS_CRAWLER_TIMEOUT_MS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Kantonsspital Uri shared rexx parser', () => {
  it('extracts the complete source-backed JobPosting body and structured fields', () => {
    const detail = extractRexxDetail(realRexxDetailFixture(), DETAIL_URL);

    expect(detail.title).toBe(TITLE);
    expect(detail.description.length).toBeGreaterThan(700);
    expect(detail.description).toContain('Interdisziplinäre Betreuung der Patientinnen');
    expect(detail.description).toContain('\n• Mitarbeit im Ambulatorium');
    expect(detail.postedDate).toBe(SOURCE_POSTED_DATE);
    expect(detail.employmentType).toBe('FULL_TIME');
    expect(detail.sourceAddresses[0]).toMatchObject({
      addressLocality: 'Kantonsspital Uri',
      addressRegion: 'Uri',
      postalCode: '6460',
      streetAddress: 'Spitalstrasse 1',
    });
  });

  it('publishes rich KSURI detail while preserving the established ID, URL and Altdorf route slug', async () => {
    stubKantonsspitalSource(realRexxDetailFixture());

    const jobs = await fetchAllKantonsspitalUriJobs();

    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    const expectedHash = createHash('sha1').update(DETAIL_URL).digest('hex').slice(0, 12);
    expect(job.id).toBe(`${KANTONSSPITAL_URI_KEY}-${expectedHash}`);
    expect(job.url).toBe(DETAIL_URL);
    expect(job.applyUrl).toBe(DETAIL_URL);
    expect(job.slug).toBe(slugify(`${TITLE} ${KANTONSSPITAL_URI_KEY} Altdorf`));
    expect(job.previousSlugs).toBeUndefined();
    expect(job.description.length).toBeGreaterThan(700);
    expect(job.description).not.toBe(`${TITLE} — Kantonsspital Uri`);
    expect(job).toMatchObject({
      location: 'Altdorf',
      canton: 'UR',
      addressLocality: 'Altdorf',
      addressRegion: 'UR',
      postalCode: '6460',
      streetAddress: 'Spitalstrasse 1',
      postedDate: SOURCE_POSTED_DATE,
      employmentType: 'FULL_TIME',
    });
  });

  it('uses a distinct source workplace without changing the identity route', async () => {
    const parser = createRexxSystemsParser({
      companyKey: KANTONSSPITAL_URI_KEY,
      companyName: 'Kantonsspital Uri',
      companyDomain: 'ksuri.ch',
      atsHost: 'stellen.ksuri.ch',
      defaultCanton: 'UR',
      defaultCity: 'Altdorf',
      defaultPostalCode: '6460',
      defaultSourceLang: 'de',
    });
    stubKantonsspitalSource(realRexxDetailFixture({
      locality: 'Schwyz',
      region: 'Schwyz',
      postalCode: '6430',
      streetAddress: 'Bahnhofstrasse 10',
    }));

    const [job] = await parser.fetchAllJobs();

    expect(job).toMatchObject({
      location: 'Schwyz',
      canton: 'SZ',
      postalCode: '6430',
      streetAddress: 'Bahnhofstrasse 10',
    });
    expect(job.slug).toBe(slugify(`${TITLE} ${KANTONSSPITAL_URI_KEY} Altdorf`));
  });

  it('rejects an explicitly foreign source workplace instead of relabelling it as Swiss', async () => {
    stubKantonsspitalSource(realRexxDetailFixture({
      locality: 'Hamburg',
      region: 'Hamburg',
      postalCode: '20095',
      addressCountry: 'DE',
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('rejects rich detail with no source workplace instead of publishing the configured headquarters', async () => {
    stubKantonsspitalSource(realRexxDetailFixture({ includeJobLocation: false }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('expands an employer label only when source postal or region evidence corroborates it', async () => {
    stubKantonsspitalSource(realRexxDetailFixture({
      locality: 'Kantonsspital Uri',
      region: '',
      postalCode: '',
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it.each([
    'http://127.0.0.1:9/Private-de-j901.html',
    'https://malicious.example/Off-origin-de-j902.html',
  ])('rejects an off-origin detail before fetch: %s', async (untrustedUrl) => {
    let untrustedFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) {
        return new Response(listingFixture([{ url: untrustedUrl, title: TITLE }]), { status: 200 });
      }
      untrustedFetches++;
      return new Response(realRexxDetailFixture(), { status: 200 });
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
    expect(untrustedFetches).toBe(0);
  });

  it('rejects a cross-origin detail redirect without following the target', async () => {
    let crossOriginFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.redirect).toBe('manual');
      if (url.endsWith('/stellenangebote.html')) return new Response(listingFixture(), { status: 200 });
      if (url === DETAIL_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://malicious.example/redirected-de-j402.html' },
        });
      }
      crossOriginFetches++;
      return new Response(realRexxDetailFixture(), { status: 200 });
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
    expect(crossOriginFetches).toBe(0);
  });

  it('rejects conflicting current-job location evidence across structured formats', async () => {
    const foreignMicrodata = `<article itemscope itemtype="https://schema.org/JobPosting">
      <meta itemprop="title" content="${TITLE}">
      <div itemprop="jobLocation">
        <meta itemprop="addressLocality" content="Geneva">
        <meta itemprop="addressRegion" content="NY">
        <meta itemprop="addressCountry" content="US">
      </div>
    </article>`;
    stubKantonsspitalSource(realRexxDetailFixture({ extraStructuredHtml: foreignMicrodata }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('does not consume a rich JobPosting that belongs to a different vacancy', async () => {
    stubKantonsspitalSource(realRexxDetailFixture({
      structuredTitle: 'Related vacancy from a recommendation widget',
      renderedDescription: '<p>Temporarily unavailable.</p>',
    }));

    const detail = extractRexxDetail(realRexxDetailFixture({
      structuredTitle: 'Related vacancy from a recommendation widget',
      renderedDescription: '<p>Temporarily unavailable.</p>',
    }), DETAIL_URL);
    expect(detail.description).not.toContain('Interdisziplinäre Betreuung der Patientinnen');
    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('still matches its own JobPosting when the structured title doubles an internal space', async () => {
    // Live shape of #7461: `spital-schwyz` j549 published `Köchin  / Koch` with
    // a double space in both the `<h1>` and the JSON-LD title. The rendered side
    // is whitespace-collapsed before the identity comparison, the structured
    // side is not, so the posting failed to match itself: no structured record,
    // no address evidence, and the unresolved-location gate discarded all 18
    // vacancies of the batch.
    const SPACED_TITLE = 'Köchin  / Koch EFZ mit Berufsbildungsfunktion 80 - 100 %';
    stubKantonsspitalSource(realRexxDetailFixture({ title: SPACED_TITLE }));

    const detail = extractRexxDetail(realRexxDetailFixture({ title: SPACED_TITLE }), DETAIL_URL);
    expect(detail.sourceAddresses).not.toHaveLength(0);

    const jobs = await fetchAllKantonsspitalUriJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Altdorf', canton: 'UR', postalCode: '6460' });
  });

  it('still matches its own JobPosting when the structured title is HTML-escaped', async () => {
    // The content of `<script type="application/ld+json">` is raw text, so the
    // HTML parser never resolves its entities: a tenant whose JSON-LD title
    // writes `K&ouml;chin&nbsp; / Koch &amp; ...` reaches the identity
    // comparison escaped, while the `<h1>` side arrives decoded. Without
    // decoding both sides the posting misses itself and the whole batch fails
    // the same way as #7461.
    const RENDERED_TITLE = 'Köchin  / Koch EFZ & Berufsbildungsfunktion 80 - 100 %';
    const ESCAPED_TITLE = 'K&ouml;chin&nbsp; / Koch EFZ &amp; Berufsbildungsfunktion 80 - 100 %';
    const html = realRexxDetailFixture({ title: RENDERED_TITLE, structuredTitle: ESCAPED_TITLE });
    stubKantonsspitalSource(html);

    const detail = extractRexxDetail(html, DETAIL_URL);
    expect(detail.sourceAddresses).not.toHaveLength(0);

    const jobs = await fetchAllKantonsspitalUriJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ location: 'Altdorf', canton: 'UR', postalCode: '6460' });
  });

  it('lets an explicit different JobPosting URL override a coincidentally equal title', async () => {
    stubKantonsspitalSource(realRexxDetailFixture({
      structuredUrl: SECOND_DETAIL_URL,
      renderedDescription: '<p>Temporarily unavailable.</p>',
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('fails closed instead of publishing the synthetic title/company fallback for malformed detail', async () => {
    stubKantonsspitalSource('<html><body><h1>Maintenance</h1></body></html>');

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('fails closed when the detail endpoint returns a non-success response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) return new Response(listingFixture(), { status: 200 });
      return new Response('Service unavailable', { status: 503 });
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('preserves the previous slice atomically when one detail in a mixed batch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) {
        return new Response(listingFixture([
          { url: DETAIL_URL, title: TITLE },
          { url: SECOND_DETAIL_URL, title: 'Pflegefachperson HF 80–100%' },
        ]), { status: 200 });
      }
      if (url === DETAIL_URL) return new Response(realRexxDetailFixture(), { status: 200 });
      if (url === SECOND_DETAIL_URL) return new Response('<h1>Maintenance</h1>', { status: 200 });
      return new Response('', { status: 404 });
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  /**
   * #7459: the location gate was batch-wide. `kantonsspital-uri` published 26
   * listings, ONE of them (j210) sat at an address the source contradicts, and
   * the parser returned `[]` — 25 live vacancies discarded, three consecutive
   * empty runs, `crawler unhealthy`. A record the source proves is elsewhere is
   * an exclusion of that record only.
   */
  it('quarantines only the record whose source workplace is contradicted and publishes its siblings', async () => {
    const FOREIGN_URL = 'https://stellen.ksuri.ch/Pflegefachperson-de-j210.html';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) {
        return new Response(listingFixture([
          { url: DETAIL_URL, title: TITLE },
          { url: SECOND_DETAIL_URL, title: 'Pflegefachperson HF 80–100%' },
          { url: FOREIGN_URL, title: 'Pflegefachperson Hamburg 100%' },
        ]), { status: 200 });
      }
      if (url === FOREIGN_URL) {
        return new Response(realRexxDetailFixture({
          title: 'Pflegefachperson Hamburg 100%',
          locality: 'Hamburg',
          region: 'Hamburg',
          postalCode: '20095',
          addressCountry: 'DE',
        }), { status: 200 });
      }
      if (url === SECOND_DETAIL_URL) {
        return new Response(realRexxDetailFixture({ title: 'Pflegefachperson HF 80–100%' }), { status: 200 });
      }
      if (url === DETAIL_URL) return new Response(realRexxDetailFixture(), { status: 200 });
      return new Response('', { status: 404 });
    }));

    const jobs = await fetchAllKantonsspitalUriJobs();

    expect(jobs.map((job: { url: string }) => job.url)).toEqual([DETAIL_URL, SECOND_DETAIL_URL]);
  });

  it('still fails closed when the contradicted records are systemic rather than outliers', async () => {
    const foreignUrls = ['j210', 'j211'].map((id) => `https://stellen.ksuri.ch/Pflegefachperson-de-${id}.html`);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) {
        return new Response(listingFixture([
          { url: DETAIL_URL, title: TITLE },
          { url: SECOND_DETAIL_URL, title: 'Pflegefachperson HF 80–100%' },
          ...foreignUrls.map((foreign, i) => ({ url: foreign, title: `Pflegefachperson Hamburg ${i} 100%` })),
        ]), { status: 200 });
      }
      if (foreignUrls.includes(url)) {
        return new Response(realRexxDetailFixture({
          title: `Pflegefachperson Hamburg ${foreignUrls.indexOf(url)} 100%`,
          locality: 'Hamburg',
          region: 'Hamburg',
          postalCode: '20095',
          addressCountry: 'DE',
        }), { status: 200 });
      }
      if (url === SECOND_DETAIL_URL) {
        return new Response(realRexxDetailFixture({ title: 'Pflegefachperson HF 80–100%' }), { status: 200 });
      }
      if (url === DETAIL_URL) return new Response(realRexxDetailFixture(), { status: 200 });
      return new Response('', { status: 404 });
    }));

    // 2 of 4 rejected: at the systemic threshold the configured headquarters or
    // the parser has drifted, so the previously published slice stays intact.
    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  /**
   * The other half of the #7459 split, and the one that is easy to get wrong:
   * `resolveRexxWorkplace` returns nothing both when the source PROVES the
   * vacancy is elsewhere and when nobody could place it (no address block, a
   * multi-canton homonym like Buchs or Wald, an uncorroborated employer label).
   * Only the first is a statement about that record. Quarantining the second
   * would silently drop a live Swiss vacancy whose address the run simply
   * failed to read — the same de-indexing loss #7459 is about, mirrored.
   */
  it('fails the whole batch closed when a record location is unresolved rather than contradicted', async () => {
    const UNPLACED_URL = 'https://stellen.ksuri.ch/Pflegefachperson-de-j212.html';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) {
        return new Response(listingFixture([
          { url: DETAIL_URL, title: TITLE },
          { url: SECOND_DETAIL_URL, title: 'Pflegefachperson HF 80–100%' },
          { url: UNPLACED_URL, title: 'Pflegefachperson Buchs 100%' },
        ]), { status: 200 });
      }
      if (url === UNPLACED_URL) {
        // Swiss country, but 'Buchs' alone is a multi-canton homonym and no
        // canton or postal code corroborates it: an absence of evidence, not
        // a foreign address the source asserted.
        return new Response(realRexxDetailFixture({
          title: 'Pflegefachperson Buchs 100%',
          locality: 'Buchs',
          region: '',
          postalCode: '',
          addressCountry: 'CH',
        }), { status: 200 });
      }
      if (url === SECOND_DETAIL_URL) {
        return new Response(realRexxDetailFixture({ title: 'Pflegefachperson HF 80–100%' }), { status: 200 });
      }
      if (url === DETAIL_URL) return new Response(realRexxDetailFixture(), { status: 200 });
      return new Response('', { status: 404 });
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('fails closed when a detail request times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/stellenangebote.html')) return new Response(listingFixture(), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      });
    }));

    await expect(fetchAllKantonsspitalUriJobs()).resolves.toEqual([]);
  });

  it('is idempotent across two equivalent source runs', async () => {
    stubKantonsspitalSource(realRexxDetailFixture());

    const first = await fetchAllKantonsspitalUriJobs();
    const second = await fetchAllKantonsspitalUriJobs();

    expect(second.map(({ crawledAt: _crawledAt, ...job }) => job))
      .toEqual(first.map(({ crawledAt: _crawledAt, ...job }) => job));
  });

  it('pins the published slug and history at the updater boundary', () => {
    const updater = fs.readFileSync('scripts/update-kantonsspital-uri-jobs.mjs', 'utf8');
    expect(updater).toContain('preserveExistingSlugs: true');

    const existing = [{
      id: 'kantonsspital-uri-stable',
      url: DETAIL_URL,
      slug: 'published-route',
      slugByLocale: { de: 'veroeffentlichte-route' },
      previousSlugs: ['historic-route'],
      previousSlugsByLocale: { de: ['historische-route'] },
    }];
    const current = [{
      ...existing[0],
      slug: 'parser-title-route',
      slugByLocale: { de: 'parser-titel-route' },
      previousSlugs: ['historic-route', 'published-route'],
      previousSlugsByLocale: { de: ['historische-route', 'veroeffentlichte-route'] },
    }];

    const restored = restoreExistingSlugIdentity(existing, current);
    expect(restored.jobs[0]).toMatchObject({
      slug: 'published-route',
      slugByLocale: { de: 'veroeffentlichte-route' },
      previousSlugs: ['historic-route'],
      previousSlugsByLocale: { de: ['historische-route'] },
    });
  });
});
