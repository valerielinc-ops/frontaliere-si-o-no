import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

describe('hreflang round-trip non-TI canton (P3-B)', () => {
  it('a ZH job IT page declares EN/DE/FR alternates under matching canton sections', () => {
    if (!fs.existsSync(DIST)) return;
    // Find any ZH job HTML
    const zhDir = path.join(DIST, 'cerca-lavoro-zurigo');
    if (!fs.existsSync(zhDir)) return;
    const slugs = fs
      .readdirSync(zhDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const sample = slugs.find((s) => fs.existsSync(path.join(zhDir, s, 'index.html')));
    if (!sample) return;
    const html = fs.readFileSync(path.join(zhDir, sample, 'index.html'), 'utf8');
    // Quote-flexible: scripts/dist-shrink.mjs strips attribute quotes.
    // `hreflang="en" href="…"` is DOM-equivalent to `hreflang=en href=…`.
    expect(html, 'EN alt missing').toMatch(
      /hreflang=["']?en["']?[^>]*href=["']?[^"'\s>]*\/en\/find-jobs-zurich\//,
    );
    expect(html, 'DE alt missing').toMatch(
      /hreflang=["']?de["']?[^>]*href=["']?[^"'\s>]*\/de\/jobs-in-zurich\//,
    );
    expect(html, 'FR alt missing').toMatch(
      /hreflang=["']?fr["']?[^>]*href=["']?[^"'\s>]*\/fr\/trouver-emploi-zurich\//,
    );
  });
});
