import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

describe('cost-of-living landing table accessibility', () => {
  it('names all three generated tables and marks every column header', () => {
    const source = fs.readFileSync(path.join(root, 'build-plugins/costOfLivingLandingsCopy.ts'), 'utf8');
    const tables = source.match(/<table class="seo-table s-JN75g4">[\s\S]*?<\/table>/g) ?? [];

    expect(tables).toHaveLength(3);
    expect(tables.every((table) => /<caption class="sr-only">/.test(table))).toBe(true);
    expect(tables.every((table) => !/<th\b(?![^>]*\bscope="col")/.test(table))).toBe(true);
  });
});
