import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBridgePageHtml } from './_bridgeMarker';

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
    // Sample a REAL ZH job page, not a cf-hot-404 / canton-orphan bridge: those
    // legitimately live under this same dir, are noindex, and carry no hreflang
    // alternates — sampling one would fail the round-trip assertion below for a
    // page that is not supposed to have hreflang at all.
    let sample: string | undefined;
    let html = '';
    for (const s of slugs) {
      const f = path.join(zhDir, s, 'index.html');
      if (!fs.existsSync(f)) continue;
      const candidate = fs.readFileSync(f, 'utf8');
      if (isBridgePageHtml(candidate)) continue;
      sample = s;
      html = candidate;
      break;
    }
    if (!sample) return;
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
