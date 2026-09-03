import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseCsbDetailPage,
  parseCsbSearchResults,
  parseSuccessFactorsMicrodataLocation,
} from '../scripts/lib/successfactors-shared-job-parser-common.mjs';
import { parseSearchPage as parseBentelerSearchPage } from '../scripts/lib/benteler-job-parser.mjs';
import { parseClariantListing } from '../scripts/lib/clariant-job-parser.mjs';
import { parseSearchPage as parseConstelliumSearchPage } from '../scripts/lib/constellium-job-parser.mjs';
import { parseDamianiSearchPage } from '../scripts/lib/damiani-job-parser.mjs';
import { parseListingPage as parsePatekListingPage } from '../scripts/lib/patek-philippe-job-parser.mjs';
import { parsePradaListingHtml } from '../scripts/lib/prada-job-parser.mjs';
import { parseSearchResults as parseSchindlerSearchResults } from '../scripts/lib/schindler-job-parser.mjs';
import { parseSkyguideListings } from '../scripts/lib/skyguide-job-parser.mjs';
import { parseZurichInsuranceListingPage } from '../scripts/lib/zurich-insurance-job-parser.mjs';
import { restoreExistingSlugIdentity } from '../scripts/lib/crawler-template.mjs';
import { parseDetailPage as parseHirslandenDetail } from '../scripts/lib/hirslanden-job-parser.mjs';
import { extractDetailFields } from '../scripts/lib/prospector/extract.mjs';
import {
  extractIbsaListingsFromTileHtml,
  normalizeIbsaRow,
} from '../scripts/update-ibsa-jobs.mjs';
import { __testables as sharedCrawlerTestables } from '../scripts/lib/shared-jobs-crawler.mjs';

const fixture = (name: string) => fs.readFileSync(
  path.resolve(process.cwd(), 'tests', 'fixtures', 'successfactors-parser-quality', `${name}.html`),
  'utf8',
);

describe('SuccessFactors parser-quality boundary', () => {
  it('keeps the balanced Groupe E body, list structure and microdata location', () => {
    const detail = parseCsbDetailPage(fixture('groupe-e'));

    expect(detail?.descriptionText).toContain('Diriger les travaux moyenne tension');
    expect(detail?.descriptionText).toMatch(/^[•-] Diriger les travaux/m);
    expect(detail?.descriptionText).not.toContain('Cookie-Einwilligungen');
    expect(detail?.descriptionText.split(/\s+/).length).toBeGreaterThan(50);
    expect(detail?.city).toBe('Matran');
    expect(detail?.region).toBe('FR');
    expect(detail?.postalCode).toBe('1753');
  });

  it('uses Hirslanden PostalAddress locality and keeps its nested source body comparable', () => {
    const html = fixture('hirslanden');
    const location = parseSuccessFactorsMicrodataLocation(html);
    const detail = parseHirslandenDetail(html);
    const auditDetail = extractDetailFields(html, 'https://careers.mediclinic.com/Hirslanden/job/test/1389326233/');

    expect(location).toMatchObject({ city: 'Hirslanden Salem-Spital', region: 'Bern', postalCode: '3013' });
    expect(detail).toMatchObject({
      location: 'Hirslanden Salem-Spital',
      locationEvidence: 'microdata',
      region: 'Bern',
      postalCode: '3013',
    });
    expect(detail?.description).toMatch(/^- Du unterstützt/m);
    expect(auditDetail.description).toContain('schrittweise Verantwortung');
    expect(auditDetail.description.length).toBeGreaterThan(400);
  });

  it('keeps Hirslanden published slugs stable while correcting its facility location', () => {
    const existing = {
      id: 'hirslanden-stable-id',
      slug: 'pflegefachperson-hirslanden-bern',
      slugByLocale: {
        de: 'pflegefachperson-hirslanden-bern',
        it: 'infermiere-hirslanden-bern',
      },
      previousSlugs: ['older-hirslanden-slug'],
      previousSlugsByLocale: { de: ['older-hirslanden-slug'] },
      location: 'Bern',
      description: 'old body',
    };
    const corrected = {
      ...existing,
      slug: 'pflegefachperson-hirslanden-salem-spital',
      slugByLocale: {
        de: 'pflegefachperson-hirslanden-salem-spital',
        it: 'infermiere-hirslanden-salem-spital',
        fr: 'infirmier-hirslanden-salem-spital',
      },
      previousSlugs: [...existing.previousSlugs, existing.slug],
      previousSlugsByLocale: { de: [...existing.previousSlugsByLocale.de, existing.slug] },
      location: 'Hirslanden Salem-Spital',
      description: 'new authoritative body',
    };

    const once = restoreExistingSlugIdentity([existing], [corrected]).jobs[0];
    const twice = restoreExistingSlugIdentity([existing], [once]).jobs[0];

    expect(once).toMatchObject({
      slug: existing.slug,
      slugByLocale: {
        de: existing.slugByLocale.de,
        it: existing.slugByLocale.it,
        fr: corrected.slugByLocale.fr,
      },
      previousSlugs: existing.previousSlugs,
      previousSlugsByLocale: existing.previousSlugsByLocale,
      location: corrected.location,
      description: corrected.description,
    });
    expect(twice).toEqual(once);
  });

  it('carries IBSA tile locality through post-processing without changing identity', () => {
    const listings = extractIbsaListingsFromTileHtml(fixture('ibsa'));
    expect(listings).toEqual([{
      url: "https://career.ibsagroup.com/job/Collina-d'Oro-Industrial-Controlling-Manager-TI-6926/1348512955/",
      location: "Collina d'Oro",
      canton: 'TI',
      country: 'CH',
      postalCode: '6926',
    }]);

    const original = {
      id: 'ibsa-institut-biochimique-stable-id',
      slug: 'industrial-controlling-manager-ibsa-6926-working-area',
      slugByLocale: { it: 'industrial-controlling-manager-ibsa-6926-working-area' },
      title: 'Industrial Controlling Manager',
      description: 'Descrizione sorgente sufficientemente ricca.',
      location: '6926 Working Area',
      addressLocality: '6926 Working Area',
      canton: 'TI',
      url: listings[0].url,
    };
    const normalized = normalizeIbsaRow(original, {
      [listings[0].url]: listings[0],
    });

    expect(normalized.location).toBe("Collina d'Oro");
    expect(normalized.addressLocality).toBe("Collina d'Oro");
    expect(normalized.postalCode).toBe('6926');
    expect(normalized.id).toBe(original.id);
    expect(normalized.slug).toBe(original.slug);
    expect(normalized.slugByLocale.it).toBe(original.slugByLocale.it);
    expect(normalizeIbsaRow(normalized, { [listings[0].url]: listings[0] })).toEqual(normalized);
  });

  it('does not promote the city to canton when an IBSA tile omits the canton segment', () => {
    const html = fixture('ibsa').replace("Collina d'Oro, TI, CH, 6926", "Collina d'Oro, CH, 6926");

    expect(extractIbsaListingsFromTileHtml(html)).toEqual([{
      url: "https://career.ibsagroup.com/job/Collina-d'Oro-Industrial-Controlling-Manager-TI-6926/1348512955/",
      location: "Collina d'Oro",
      canton: '',
      country: 'CH',
      postalCode: '6926',
    }]);
  });

  it('does not treat IT in a Swiss job title as geographic Italy', () => {
    const parsed = sharedCrawlerTestables.toJobFromHtmlFallback(
      fixture('ibsa-grancia'),
      'https://career.ibsagroup.com/job/Grancia-IT-Category-Manager-TI-6916/1365742755/',
      'IBSA Institut Biochimique',
      'Ticino',
      {
        isSeedDetail: true,
        seedMeta: { location: 'Grancia', canton: 'TI', country: 'CH' },
      },
    );

    expect(parsed.reason).toBeNull();
    expect(parsed.job).toMatchObject({
      title: 'IT Category Manager',
      location: 'Grancia, TI',
      canton: 'TI',
    });
  });

  it('still rejects a real Italian address even when the adapter seed is Swiss', () => {
    const parsed = sharedCrawlerTestables.toJobFromHtmlFallback(
      fixture('italia-real'),
      'https://career.example.com/job/it-category-manager/12345/',
      'Example Company',
      'Ticino',
      {
        isSeedDetail: true,
        seedMeta: { location: 'Grancia', canton: 'TI', country: 'CH' },
      },
    );

    expect(parsed).toEqual({ job: null, reason: 'html_location_explicitly_foreign' });
  });
});

/* ── j2w multi-office family gate ─────────────────────────────
 *
 * A posting open in several offices renders the extras as a nested
 * `<small class="nobr">+N more&hellip;</small>` INSIDE the location cell.
 * Every j2w listing parser that reads that cell whole used to emit
 * "Lugano, CH +1 more…" as `location`, which no Swiss-city resolver
 * accepts — on Zurich Insurance it failed the whole run closed.
 *
 * This block is the family observer for that class: one fixture row, every
 * listing parser in the family. The table IS the membership list, and
 * `discoverJ2wListingModules()` below fails when a module joins the family
 * without joining the table — so the omission shows up in review as a red
 * test, not as the next tenant shipping the same defect.
 */

const J2W_FIXTURE = fixture('j2w-multi-location');
const J2W_FIXTURE_HREF = '/job/Lugano-Ingegnere-di-produzione-TI/1387654321/';
const MORE_LOCATIONS_MARKER = /\+\s*\d+\s*(?:more|weitere|mehr|autres?|altr)/i;

/**
 * The same fixture for every tenant, with only the detail href swapped:
 * the URL-trust checks differ per tenant (Schindler's paths carry a leading
 * `/{Tenant}` segment), the listing markup does not.
 */
const j2wListing = (href: string = J2W_FIXTURE_HREF) => J2W_FIXTURE.replaceAll(J2W_FIXTURE_HREF, href);

/** Modules that read a location out of a j2w listing row, discovered from source. */
const discoverJ2wListingModules = () => {
  const dir = path.resolve(process.cwd(), 'scripts', 'lib');
  const discovered = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.mjs'))
    .filter((file) => {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      return /colLocation|jobLocation/.test(source) && /jobTitle-link|data-row/.test(source);
    });
  // The shared CSB parser reads `td.colLocation` for every tenant that delegates
  // its listing to it, but names neither `data-row` nor `jobTitle-link`.
  return [...new Set([...discovered, 'successfactors-shared-job-parser-common.mjs'])].sort();
};

/**
 * Family members with no listing location to protect. Keeping them here — and
 * not silently outside the scan — is what makes a new omission reviewable.
 */
const J2W_LISTING_MODULES_WITHOUT_LOCATION: Record<string, string> = {
  // Tile listing (`li.job-tile`), and `parseListingTiles()` emits no location
  // field at all: the marker has nowhere to leak into.
  'stadt-zuerich-job-parser.mjs': 'listing tiles carry no location field',
};

type J2wListingCase = {
  module: string;
  locationsOf: (html: string) => string[];
  href?: string;
};

const J2W_LISTING_PARSERS: J2wListingCase[] = [
  {
    module: 'zurich-insurance-job-parser.mjs',
    locationsOf: (html) => parseZurichInsuranceListingPage(html).rows.map((row) => row.location),
  },
  {
    module: 'clariant-job-parser.mjs',
    locationsOf: (html) => parseClariantListing(html).map((row) => row.location),
  },
  {
    module: 'patek-philippe-job-parser.mjs',
    locationsOf: (html) => parsePatekListingPage(html, 'https://career.patek.com/search/').map((row) => row.location),
  },
  {
    module: 'prada-job-parser.mjs',
    locationsOf: (html) => parsePradaListingHtml(html).map((row) => row.location),
  },
  {
    module: 'damiani-job-parser.mjs',
    locationsOf: (html) => parseDamianiSearchPage(html).rows.map((row) => row.location),
  },
  {
    module: 'benteler-job-parser.mjs',
    locationsOf: (html) => parseBentelerSearchPage(html).rows.map((row) => row.locationText),
  },
  {
    module: 'constellium-job-parser.mjs',
    locationsOf: (html) => parseConstelliumSearchPage(html).rows.map((row) => row.locationText),
  },
  {
    module: 'skyguide-job-parser.mjs',
    locationsOf: (html) => parseSkyguideListings(html).rows.map((row) => row.location),
  },
  {
    module: 'schindler-job-parser.mjs',
    // This tenant's detail paths are `/{Tenant}/job/{slug}/{id}/`.
    href: '/Schindler/job/Lugano-Ingegnere-di-produzione-TI/1387654321/',
    locationsOf: (html) => parseSchindlerSearchResults(html).map((row) => row.location),
  },
  {
    module: 'successfactors-shared-job-parser-common.mjs',
    locationsOf: (html) => parseCsbSearchResults(html).map((row) => row.location),
  },
];

describe('SuccessFactors j2w multi-office listing row', () => {
  it('exposes the "+N more…" marker inside the location cell of the shared fixture', () => {
    const locationCell = J2W_FIXTURE.match(/<span class="jobLocation">([\s\S]*?)<\/span>/)?.[1];

    expect(locationCell).toContain('<small class="nobr">+1 more&hellip;</small>');
    expect(J2W_FIXTURE).toContain(J2W_FIXTURE_HREF);
  });

  it.each(J2W_LISTING_PARSERS)('keeps the visible office intact in $module', ({ locationsOf, href }) => {
    const locations = locationsOf(j2wListing(href));

    expect(locations).toEqual(['Lugano, CH']);
    expect(locations[0]).not.toMatch(MORE_LOCATIONS_MARKER);
    expect(locations[0]).not.toContain('…');
  });

  it('still flags the row as multi-office where the crawler needs to know', () => {
    // Benteler keeps multi-office rows and resolves them from the detail
    // microdata: stripping the marker must not cost it the flag.
    expect(parseBentelerSearchPage(j2wListing()).rows[0].hasMoreLocations).toBe(true);
  });

  it('covers every j2w listing parser in the family', () => {
    const covered = new Set([
      ...J2W_LISTING_PARSERS.map((entry) => entry.module),
      ...Object.keys(J2W_LISTING_MODULES_WITHOUT_LOCATION),
    ]);

    expect(discoverJ2wListingModules().filter((module) => !covered.has(module))).toEqual([]);
  });
});
