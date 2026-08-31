import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseCsbDetailPage,
  parseSuccessFactorsMicrodataLocation,
} from '../scripts/lib/successfactors-shared-job-parser-common.mjs';
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
