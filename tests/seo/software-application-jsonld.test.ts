import { describe, expect, it, vi } from 'vitest';

const { getAllSeoMetadata } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');
const SEO_METADATA = await getAllSeoMetadata();

function asArray<T>(value: T | T[] | undefined): T[] {
 if (value === undefined) return [];
 return Array.isArray(value) ? value : [value];
}

describe('WebApplication / SoftwareApplication structured data — policy enforcement', () => {
 const entries = Object.entries(SEO_METADATA)
  .flatMap(([key, meta]) =>
   asArray(meta.structuredData).flatMap((schema) => {
    const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
    return types.some((type) => type === 'WebApplication' || type === 'SoftwareApplication')
     ? [{ key, schema }]
     : [];
   }),
  );

 // Policy: pages that are NOT real interactive applications must not
 // declare WebApplication / SoftwareApplication. Schema.org's "Software App"
 // rich-result requires aggregateRating + review for eligibility, and
 // Google's structured-data guidelines forbid fabricated review data.
 // Without a real verifiable review feed we cannot satisfy that
 // requirement, so we must NOT claim WebApplication on any seo-pages /
 // seo-landing entry. Any new declaration here will surface as a
 // failure here AND at deploy time via the structured-data gate.
 it('SEO metadata declares ZERO WebApplication / SoftwareApplication entries', () => {
  const offenders = entries.map(({ key }) => key);
  expect(offenders).toEqual([]);
 });
});
