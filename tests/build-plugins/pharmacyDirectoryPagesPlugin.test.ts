// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPharmacyDirectoryPage, pharmacyPageDescriptors } from '../../build-plugins/pharmacyDirectoryPagesPlugin';

const locales = ['it', 'en', 'de', 'fr'] as const;

describe('pharmacy directory page matrix', () => {
  it('emits hubs, areas, city pages and one detail descriptor per pharmacy', () => {
    const descriptors = pharmacyPageDescriptors();
    expect(descriptors.filter((descriptor) => descriptor.kind === 'pharmacy')).toHaveLength(749);
    expect(descriptors.some((descriptor) => descriptor.kind === 'country' && descriptor.country === 'IT')).toBe(true);
    expect(descriptors.filter((descriptor) => descriptor.kind === 'area')).toHaveLength(3);
    expect(descriptors.filter((descriptor) => descriptor.kind === 'city' && descriptor.country === 'IT').length).toBeGreaterThan(200);
  });

  it.each(locales)('renders an escaped, indexable detail page with schema and one static main (%s)', (locale) => {
    const descriptor = pharmacyPageDescriptors().find((candidate) => candidate.kind === 'pharmacy' && candidate.country === 'IT');
    expect(descriptor).toBeDefined();
    const page = buildPharmacyDirectoryPage(descriptor!, locale, '');
    expect(page.html).toMatch(/<main\b[^>]*class=(?:"|')?seo-static-content/);
    expect(page.html).not.toMatch(/<main\b[^>]*class=(?:"|')?seo-static-content[\s\S]*<main\b/);
    expect(page.html).toContain('"@type":"Pharmacy"');
    expect(page.html).toContain('"@type":"BreadcrumbList"');
    expect(page.html).toMatch(/<meta name=robots content="index, ?follow/);
    expect(page.path).toContain('/');
  });

  it('keeps same-name detail titles unique and duty-city aliases noindex without collection schema', () => {
    const details = pharmacyPageDescriptors().filter((descriptor) => descriptor.kind === 'pharmacy');
    const titles = details.map((descriptor) => buildPharmacyDirectoryPage(descriptor, 'it', '').html.match(/<title>([^<]*)<\/title>/)?.[1] || '');
    expect(new Set(titles).size).toBe(titles.length);

    const dutyCity = pharmacyPageDescriptors().find((descriptor) => descriptor.kind === 'duty-city');
    const page = buildPharmacyDirectoryPage(dutyCity!, 'it', '');
    expect(page.indexable).toBe(false);
    expect(page.html).toContain('noindex,follow');
    expect(page.html).not.toContain('CollectionPage');
  });
});
