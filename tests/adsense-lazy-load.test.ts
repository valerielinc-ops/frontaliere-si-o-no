/**
 * Lazy-load AdSense — regression tests for the Semrush "uncompressed JS"
 * fix (2026-04-23). Ensures adsbygoogle.js is NEVER eagerly loaded from
 * either index.html or the ADSENSE_SNIPPET used by static build plugins,
 * and that an IntersectionObserver-based loader is present instead.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADSENSE_CLIENT_ID,
  ADSENSE_LAZY_LOADER,
  ADSENSE_SCRIPT_SRC,
  ADSENSE_SNIPPET,
} from '@/build-plugins/constants';

const repoRoot = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
const adSenseBanner = readFileSync(
  resolve(repoRoot, 'components/shared/AdSenseBanner.tsx'),
  'utf8',
);

describe('AdSense lazy loading — index.html', () => {
  it('does NOT include an eager <script src=".../adsbygoogle.js"> tag in <head>', () => {
    // The whole point: Semrush crawlers must not encounter the script on every
    // static HTML fetch. A static <script src="...adsbygoogle.js"> is banned.
    expect(indexHtml).not.toMatch(
      /<script[^>]+src=["'][^"']*pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i,
    );
  });

  it('keeps the google-adsense-account verification meta tag', () => {
    expect(indexHtml).toMatch(
      /<meta\s+name=["']google-adsense-account["']\s+content=["']ca-pub-8628054934855353["']/,
    );
  });

  it('includes a preconnect hint to pagead2.googlesyndication.com', () => {
    expect(indexHtml).toMatch(
      /<link\s+rel=["']preconnect["']\s+href=["']https:\/\/pagead2\.googlesyndication\.com["']/,
    );
  });
});

describe('AdSense lazy loading — ADSENSE_SNIPPET (static pages)', () => {
  it('does NOT emit an eager <script src=".../adsbygoogle.js"> tag', () => {
    // Matches any <script ...src="...adsbygoogle.js..."></script> — but not
    // our inline loader which builds the src at runtime via string concat.
    expect(ADSENSE_SNIPPET).not.toMatch(
      /<script[^>]+src=["'][^"']*pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i,
    );
  });

  it('embeds the IntersectionObserver-based lazy loader', () => {
    expect(ADSENSE_SNIPPET).toContain(ADSENSE_LAZY_LOADER);
    expect(ADSENSE_LAZY_LOADER).toContain('IntersectionObserver');
    expect(ADSENSE_LAZY_LOADER).toContain('rootMargin');
  });

  it('exposes the correct client id + script URL', () => {
    expect(ADSENSE_CLIENT_ID).toBe('ca-pub-8628054934855353');
    expect(ADSENSE_SCRIPT_SRC).toBe(
      `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`,
    );
  });

  it('includes preconnect + dns-prefetch for pagead2', () => {
    expect(ADSENSE_SNIPPET).toMatch(
      /<link\s+rel=["']preconnect["']\s+href=["']https:\/\/pagead2\.googlesyndication\.com["']\s+crossorigin/,
    );
    expect(ADSENSE_SNIPPET).toMatch(
      /<link\s+rel=["']dns-prefetch["']\s+href=["']https:\/\/pagead2\.googlesyndication\.com["']/,
    );
  });

  it('pushes queued slots after script onload (not synchronously on DOMContentLoaded)', () => {
    // Regression: ensure we call push({}) only after the dynamically-injected
    // script fires its onload event, not before it exists.
    expect(ADSENSE_LAZY_LOADER).toContain('s.onload');
    expect(ADSENSE_LAZY_LOADER).toContain('adsbygoogle');
  });
});

describe('AdSense lazy loading — SPA AdSenseBanner component', () => {
  it('uses IntersectionObserver to defer script load', () => {
    expect(adSenseBanner).toContain('IntersectionObserver');
    expect(adSenseBanner).toMatch(/rootMargin:\s*['"]200px 0px['"]/);
  });

  it('still contains the singleton loadAdSenseScript helper', () => {
    expect(adSenseBanner).toContain('loadAdSenseScript');
  });
});
