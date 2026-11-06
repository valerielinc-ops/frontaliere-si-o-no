import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const xml = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'sitemap-glossario.xml'), 'utf-8');

describe('public/sitemap-glossario.xml', () => {
  it('carries no tag Google ignores', () => {
    expect(xml).not.toContain('<changefreq>');
    expect(xml).not.toContain('<priority>');
  });

  it('keeps every entry dated', () => {
    expect(xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)?.length).toBe(xml.match(/<url>/g)?.length);
  });
});
