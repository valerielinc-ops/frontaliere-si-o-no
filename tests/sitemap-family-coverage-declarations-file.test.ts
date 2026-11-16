import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateSitemapFamilyCoverage } from '../scripts/lib/sitemap-family-coverage.mjs';

describe('sitemap family coverage declarations file', () => {
  it('uses the supported schema and contains only valid declarations', () => {
    const declarations = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '../data/sitemap-family-coverage-declarations.json'),
      'utf8',
    ));

    expect(declarations.version).toBe(1);
    expect(Array.isArray(declarations.decreases)).toBe(true);

    const unchangedSnapshot = { version: 3, perSitemap: {} };
    const result = evaluateSitemapFamilyCoverage(
      unchangedSnapshot,
      unchangedSnapshot,
      declarations,
    );

    expect(result.invalidDeclarations).toEqual([]);
  });
});
