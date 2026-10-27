import { describe, expect, it } from 'vitest';

import {
  hasInterpolatedStaticProperty,
  readStructuredSeoBlock,
  readStructuredSeoDescriptionState,
  staticPropertyState,
} from '../packages/articles/engine/shared/seo-entry.mjs';

describe('articles engine SEO-entry compatibility contract', () => {
  it('exports the dynamic/static readers consumed by the corpus generator', () => {
    const block = [
      '{',
      '  canonicalPath: `${BASE_URL}/events/`,',
      '  structuredData: {',
      "    headline: 'Event headline',",
      '    description: `${description}`,',
      '  },',
      '}',
    ].join('\n');

    expect(hasInterpolatedStaticProperty(block, 'canonicalPath')).toBe(true);
    expect(hasInterpolatedStaticProperty(block, 'canonicalPath', { allowBaseUrlTemplates: true })).toBe(false);
    expect(readStructuredSeoBlock(block)).toContain("headline: 'Event headline'");
    expect(readStructuredSeoDescriptionState(block)).toMatchObject({ assigned: true, dynamic: true });
    expect(staticPropertyState(block, 'headline')).toMatchObject({ assigned: true, value: 'Event headline' });
  });

  it('uses the last top-level assignment while remaining fail-closed for JSON-LD templates', () => {
    const block = [
      '{',
      '  headline: `${title}`,',
      '  headline: "Static headline",',
      '}',
    ].join('\n');

    expect(hasInterpolatedStaticProperty(block, 'headline')).toBe(false);
    expect(staticPropertyState(block, 'headline')).toMatchObject({
      assigned: true,
      dynamic: false,
      value: 'Static headline',
    });
  });

  it('keeps a static structuredData description readable', () => {
    const block = String.raw`{
      structuredData: { description: 'A static description.' },
    }`;

    expect(readStructuredSeoDescriptionState(block)).toMatchObject({
      assigned: true,
      dynamic: false,
      value: 'A static description.',
    });
  });
});
