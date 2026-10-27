import { describe, expect, it } from 'vitest';

import {
  hasInterpolatedStaticProperty,
  lastStaticPropertyValue,
  readStaticObjectProperty,
  readStructuredSeoObjectProperty,
  readStructuredSeoBlock,
  readStructuredSeoDescriptionState,
  readStructuredSeoObjectBlocks,
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

  it('reads fields from structuredData arrays without treating unrelated URL templates as dynamic', () => {
    const block = [
      '{',
      '  structuredData: [',
      '    {',
      '      headline: "News headline",',
      '      description: "News description",',
      '      image: { url: `${BASE_URL}/images/news.webp` },',
      '      mainEntityOfPage: `${BASE_URL}/articoli-frontaliere/news/`,',
      '    },',
      '    { "@type": "FAQPage", "mainEntity": [] },',
      '  ],',
      '}',
    ].join('\n');

    expect(hasInterpolatedStaticProperty(block, 'headline')).toBe(false);
    expect(readStructuredSeoDescriptionState(block)).toMatchObject({
      assigned: true,
      dynamic: false,
      value: 'News description',
    });
    expect(staticPropertyState(block, 'headline')).toMatchObject({
      assigned: true,
      dynamic: false,
      value: 'News headline',
    });

    const dynamicHeadline = block.replace('headline: "News headline"', 'headline: `${headline}`');
    expect(hasInterpolatedStaticProperty(dynamicHeadline, 'headline')).toBe(true);
  });

  it('selects the Event object from a JSON-LD array and balances braces in strings', () => {
    const block = String.raw`{
      structuredData: [
        { "@type": "BreadcrumbList", item: "home" },
        {
          "@type": "Event",
          "name": "Open {Data} Day",
          "location": { "@type": "Place", "name": "Hall {A}" },
        },
      ],
    }`;

    const objects = readStructuredSeoObjectBlocks(block);
    expect(objects).toHaveLength(2);
    expect(staticPropertyState(objects?.[1] ?? '', '@type')).toMatchObject({ value: 'Event' });
    expect(readStaticObjectProperty(objects?.[1] ?? '', 'location')).toContain('Hall {A}');
    expect(readStructuredSeoBlock(block)).toContain('Hall {A}');
  });

  it('clears a stale nested object when the final assignment is not an object', () => {
    const block = String.raw`{
      location: { "@type": "Place", name: "Old hall" },
      location: null,
    }`;

    expect(readStaticObjectProperty(block, 'location')).toBeUndefined();
  });

  it('reads a structured author with balanced braces and decoded fields', () => {
    const block = String.raw`{
      structuredData: {
        "@type": "NewsArticle",
        "author": {
          "@type": "Person",
          "@id": "https://frontaliereticino.ch/autori/example/#person",
          "name": "Author } Name",
        },
      },
    }`;

    const author = readStructuredSeoObjectProperty(block, 'author');
    expect(author).toContain('Author } Name');
    expect(lastStaticPropertyValue(author ?? '', 'name')).toBe('Author } Name');
  });

  it('keeps the final structuredData assignment last-write-wins', () => {
    const block = String.raw`{
      structuredData: { "@type": "Article", description: "old" },
      structuredData: [{ "@type": "Event", description: "new" }],
    }`;

    expect(readStructuredSeoBlock(block)).toContain('"@type": "Event"');
    expect(readStructuredSeoDescriptionState(block)).toMatchObject({
      assigned: true,
      dynamic: false,
      value: 'new',
    });
  });
});
