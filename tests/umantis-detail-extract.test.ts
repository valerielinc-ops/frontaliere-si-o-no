import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractUmantisDetailContent } from '../scripts/lib/umantis-listing-common.mjs';

const fixture = fs.readFileSync(
  new URL('./fixtures/gzf-umantis-detail-structures.html', import.meta.url),
  'utf8',
);

describe('extractUmantisDetailContent — GZF customdatablock structure', () => {
  it('preserves p-based sections and every nested bullet', () => {
    const content = extractUmantisDetailContent(fixture);

    expect(content).toContain('Ihre Aufgaben');
    expect(content).toContain('Pflege und Betreuung');
    expect(content).toContain('abgeschlossene Ausbildung');
    expect(content.match(/•/g) || []).toHaveLength(6);
    expect(content.split(/\s+/).filter(Boolean).length).toBeGreaterThan(55);
  });
});
