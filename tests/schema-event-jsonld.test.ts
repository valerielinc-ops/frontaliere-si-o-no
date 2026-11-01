import { describe, expect, it } from 'vitest';
import {
  eventJsonLdCandidates,
  extractJsonLdScriptContents,
  isSchemaEventJsonLdType,
} from '../scripts/lib/schema-event-jsonld.mjs';

describe('schema Event JSON-LD boundary', () => {
  it('finds a JSON-LD script when an opening attribute contains >', () => {
    const html = '<script data-note=">" type="application/ld+json">{"@type":"Event","startDate":"2026-11-01"}</script>';

    expect(extractJsonLdScriptContents(html)).toEqual([
      '{"@type":"Event","startDate":"2026-11-01"}',
    ]);
  });

  it('rejects a lowercase bare event type as a schema.org Event', () => {
    const node = { '@context': 'https://schema.org', '@type': 'event', startDate: '2026-11-01' };

    expect(isSchemaEventJsonLdType(node['@type'])).toBe(false);
    expect(eventJsonLdCandidates(node).filter((candidate) => isSchemaEventJsonLdType(candidate['@type']))).toEqual([]);
  });
});
