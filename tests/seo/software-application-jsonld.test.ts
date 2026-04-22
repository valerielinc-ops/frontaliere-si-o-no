import { describe, expect, it, vi } from 'vitest';

const { getAllSeoMetadata } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');
const SEO_METADATA = await getAllSeoMetadata();

function asArray<T>(value: T | T[] | undefined): T[] {
 if (value === undefined) return [];
 return Array.isArray(value) ? value : [value];
}

describe('WebApplication / SoftwareApplication structured data', () => {
 const entries = Object.entries(SEO_METADATA)
  .flatMap(([key, meta]) =>
   asArray(meta.structuredData).flatMap((schema) => {
    const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
    return types.some((type) => type === 'WebApplication' || type === 'SoftwareApplication')
     ? [{ key, schema }]
     : [];
   }),
  );

 it('finds application schemas in SEO metadata', () => {
  expect(entries.length).toBeGreaterThan(20);
 });

 it('normalizes defaults required by Sprint 1 validators', () => {
  const failures: string[] = [];

  for (const { key, schema } of entries) {
   if (!schema.applicationCategory) {
    failures.push(`${key}: missing applicationCategory`);
   }
   if (schema.operatingSystem !== 'Web') {
    failures.push(`${key}: operatingSystem="${String(schema.operatingSystem)}"`);
   }
   if (!schema.offers || typeof schema.offers !== 'object') {
    failures.push(`${key}: missing offers`);
    continue;
   }
   if (schema.offers.price === undefined || schema.offers.price === null || schema.offers.price === '') {
    failures.push(`${key}: missing offers.price`);
   }
   if (!schema.offers.priceCurrency) {
    failures.push(`${key}: missing offers.priceCurrency`);
   }
  }

  expect(failures).toEqual([]);
 });

 it('keeps aggregateRating on the homepage app schema', () => {
  const homepage = entries.find(({ key }) => key === 'calculator');
  expect(homepage?.schema.aggregateRating).toBeTruthy();
  expect(homepage?.schema.aggregateRating?.ratingValue).toBeTruthy();
  expect(homepage?.schema.aggregateRating?.ratingCount).toBeTruthy();
 });
});
