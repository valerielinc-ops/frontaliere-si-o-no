import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseJobalinoListingHtml } from '../scripts/lib/jobalino-common.mjs';
import { fetchAllTeoJakobAgJobs } from '../scripts/lib/teo-jakob-ag-job-parser.mjs';

const TITLE = 'Projektleiter Interior Design';
const DESCRIPTION = 'Sie planen anspruchsvolle Innenausbauprojekte und begleiten unsere Kundschaft von der Beratung bis zur erfolgreichen Umsetzung. '
  .repeat(8);
const SWISS_ADDRESS = {
  '@type': 'PostalAddress',
  addressLocality: 'Bern',
  postalCode: '3000',
  streetAddress: 'Gerechtigkeitsgasse 1',
  addressCountry: 'CH',
};
const FOREIGN_ADDRESS = {
  '@type': 'PostalAddress',
  addressLocality: 'Berlin',
  postalCode: '10115',
  streetAddress: 'Friedrichstrasse 1',
  addressCountry: 'DE',
};

function listingHtml(attributes = 'class="reflink" href="https://my.jobalino.ch/public/job/de/abc123/projektleiter"') {
  return `<a ${attributes}>`
    + `<span class="title">${TITLE}</span>`
    + '<span class="company">Teo Jakob AG</span>'
    + '<span class="address">Gerechtigkeitsgasse 1</span>'
    + '<span class="zip">3000</span><span class="city">Bern</span>'
    + '<span class="country">Schweiz</span><span class="workload">80% - 100%</span>'
    + '</a>';
}

function detailHtml(overrides: Record<string, unknown> = {}) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: TITLE,
    description: DESCRIPTION,
    hiringOrganization: { '@type': 'Organization', name: 'Teo Jakob AG' },
    jobLocation: { '@type': 'Place', address: SWISS_ADDRESS },
    ...overrides,
  })}</script>`;
}

function stubJobalino(detail: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
    url.includes('/public/component/jobsfactory') ? listingHtml() : detail,
    { status: 200 },
  )));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Jobalino exact href attributes', () => {
  it('does not treat data-href or aria-href as the vacancy href', () => {
    const html = listingHtml(
      'data-href="https://my.jobalino.ch/public/job/de/abc123/wrong" '
      + 'aria-href="https://my.jobalino.ch/public/job/de/abc123/also-wrong" '
      + 'href="/other" class="reflink"',
    );
    expect(parseJobalinoListingHtml(html)).toEqual([]);
  });

  it.each([
    'href="https://my.jobalino.ch/public/job/de/abc123/projektleiter?origin=joblist" class="card reflink"',
    'class="reflink card" href="https://my.jobalino.ch/public/job/de/abc123/projektleiter?origin=joblist"',
  ])('keeps the real href independent of attribute order: %s', (attributes) => {
    expect(parseJobalinoListingHtml(listingHtml(attributes))).toMatchObject([{
      id: 'abc123',
      url: 'https://my.jobalino.ch/job/abc123/projektleiter',
    }]);
  });

  it('keeps a valid tile when a quoted attribute contains >', () => {
    const html = listingHtml(
      'data-label="x > y" class="reflink" href="https://my.jobalino.ch/public/job/de/abc123/projektleiter"',
    );
    expect(parseJobalinoListingHtml(html)).toMatchObject([{ id: 'abc123' }]);
  });
});

describe('Teo Jakob JSON-LD arrays', () => {
  it('uses listing evidence only when employer and location fields are absent', async () => {
    stubJobalino(detailHtml({
      hiringOrganization: undefined,
      jobLocation: undefined,
    }));

    const jobs = await fetchAllTeoJakobAgJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      company: 'Teo Jakob AG',
      location: 'Bern',
      postalCode: '3000',
      streetAddress: 'Gerechtigkeitsgasse 1',
    });
  });

  it.each([
    { label: 'empty employer array', overrides: { hiringOrganization: [] }, expected: /hiringOrganization is unusable/i },
    { label: 'non-object employer', overrides: { hiringOrganization: 'Teo Jakob AG' }, expected: /hiringOrganization is unusable/i },
    { label: 'empty location array', overrides: { jobLocation: [] }, expected: /jobLocation is unusable/i },
    { label: 'non-object location', overrides: { jobLocation: 'Bern' }, expected: /jobLocation is unusable/i },
    { label: 'location without address', overrides: { jobLocation: { '@type': 'Place' } }, expected: /jobLocation address is unusable/i },
    { label: 'empty address array', overrides: { jobLocation: { '@type': 'Place', address: [] } }, expected: /jobLocation address is unusable/i },
    { label: 'empty address object', overrides: { jobLocation: { '@type': 'Place', address: {} } }, expected: /jobLocation address is unusable/i },
    {
      label: 'blank address fields',
      overrides: {
        jobLocation: {
          '@type': 'Place',
          address: {
            addressLocality: ' ',
            addressRegion: '\n',
            addressCountry: '\t',
            postalCode: '',
            streetAddress: '  ',
          },
        },
      },
      expected: /jobLocation address is unusable/i,
    },
    { label: 'non-object address', overrides: { jobLocation: { '@type': 'Place', address: 'Bern' } }, expected: /jobLocation address is unusable/i },
  ])('fails closed for a present but unusable $label', async ({ overrides, expected }) => {
    stubJobalino(detailHtml(overrides));

    await expect(fetchAllTeoJakobAgJobs()).rejects.toThrow(expected);
  });

  it('fails closed for a multi-member hiringOrganization array', async () => {
    stubJobalino(detailHtml({
      hiringOrganization: [
        { '@type': 'Organization', name: 'Other Employer AG' },
        { '@type': 'Organization', name: 'Teo Jakob AG' },
      ],
    }));

    await expect(fetchAllTeoJakobAgJobs()).rejects.toThrow(/hiringOrganization is ambiguous/i);
  });

  it('fails closed for a multi-member jobLocation array', async () => {
    stubJobalino(detailHtml({
      jobLocation: [
        { '@type': 'Place', address: FOREIGN_ADDRESS },
        { '@type': 'Place', address: SWISS_ADDRESS },
      ],
    }));

    await expect(fetchAllTeoJakobAgJobs()).rejects.toThrow(/jobLocation is ambiguous/i);
  });

  it('fails closed when multiple organization objects claim the tenant', async () => {
    stubJobalino(detailHtml({
      hiringOrganization: [
        { '@type': 'Organization', name: 'Teo Jakob AG' },
        { '@type': 'Organization', name: 'Teo Jakob AG' },
      ],
    }));

    await expect(fetchAllTeoJakobAgJobs()).rejects.toThrow(/hiringOrganization is ambiguous/i);
  });

  it('fails closed when multiple Swiss addresses match the listing evidence', async () => {
    stubJobalino(detailHtml({
      jobLocation: [
        { '@type': 'Place', address: SWISS_ADDRESS },
        { '@type': 'Place', address: { ...SWISS_ADDRESS, streetAddress: 'Kramgasse 2' } },
      ],
    }));

    await expect(fetchAllTeoJakobAgJobs()).rejects.toThrow(/jobLocation is ambiguous/i);
  });

  it('fails closed when a nested address array has multiple listing matches', async () => {
    stubJobalino(detailHtml({
      jobLocation: {
        '@type': 'Place',
        address: [
          SWISS_ADDRESS,
          { ...SWISS_ADDRESS, streetAddress: 'Kramgasse 2' },
        ],
      },
    }));

    await expect(fetchAllTeoJakobAgJobs()).rejects.toThrow(/jobLocation is ambiguous/i);
  });
});
