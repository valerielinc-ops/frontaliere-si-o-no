/**
 * Offerwall FC snippet for STATIC article pages — regression + drift guard.
 *
 * The GAM Offerwall is scoped to the article sections, which are emitted as
 * static SSG HTML by build-plugins/staticPagesPlugin.ts. That HTML head does
 * NOT carry index.html's inline Offerwall block, so on those pages the only
 * Funding Choices loader that runs is the network-code one pulled in by
 * adsbygoogle.js AFTER hydration — it fetches the Offerwall message but never
 * renders the overlay. OFFERWALL_FC_SNIPPET injects the publisher-id
 * MESSAGING loader at PARSE TIME so article pages reach parity with
 * index.html's render path. The custom newsletter choice is intentionally not
 * emitted; Ad Manager owns the available choices.
 *
 * This test pins the snippet contract and asserts it cannot drift from the
 * index.html loader essentials (same pub-id loader URL, data-fc-loader marker,
 * no crossOrigin — see tests/index-html-fc-loader.test.ts — googlefcPresent
 * signal, deferred for LCP). index.html keeps its own inline copy because
 * tests/index-html-fc-loader.test.ts pins the SOURCE file; the two copies are
 * kept honest by cross-checking the loader URL here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OFFERWALL_FC_SNIPPET, FC_PUBLISHER_ID } from '../build-plugins/constants';
import { readBuildPluginSource } from './helpers/buildPluginSource';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

describe('OFFERWALL_FC_SNIPPET — custom choice', () => {
  it('does not emit the newsletter custom-choice registry', () => {
    expect(OFFERWALL_FC_SNIPPET).not.toContain('customchoice');
    expect(OFFERWALL_FC_SNIPPET).not.toContain('__ftOfferwallSubscribe');
    expect(OFFERWALL_FC_SNIPPET).not.toContain('cc.registry');
  });
});

describe('OFFERWALL_FC_SNIPPET — Funding Choices messaging loader', () => {
  it('does not filter the AdSense Offerwall on any page', () => {
    // The job-board Offerwall is the site's only rewarded demand (AdSense);
    // a controlledMessagingFunction here would switch it off.
    expect(OFFERWALL_FC_SNIPPET).not.toContain('controlledMessagingFunction');
    expect(OFFERWALL_FC_SNIPPET).not.toContain('OFFERWALL]');
    expect(OFFERWALL_FC_SNIPPET).not.toContain('proceed(false');
  });

  it('injects the publisher-id messaging loader (not the network-code one)', () => {
    expect(OFFERWALL_FC_SNIPPET).toContain(
      `fundingchoicesmessages.google.com/i/${FC_PUBLISHER_ID}?ers=1`,
    );
    // FC_PUBLISHER_ID is derived from the AdSense client id (no `ca-` prefix).
    expect(FC_PUBLISHER_ID).toBe('pub-8628054934855353');
  });

  it('does NOT set crossOrigin on the FC loader <script> (would trigger CORS rejection)', () => {
    expect(OFFERWALL_FC_SNIPPET).not.toMatch(/\.crossOrigin\s*=/);
    expect(OFFERWALL_FC_SNIPPET).not.toMatch(/setAttribute\(\s*['"]crossorigin['"]/i);
  });

  it('marks the injected loader with data-fc-loader so we never double-inject', () => {
    expect(OFFERWALL_FC_SNIPPET).toMatch(/data-fc-loader/);
  });

  it('signals the googlefcPresent iframe so FC knows the loader ran', () => {
    expect(OFFERWALL_FC_SNIPPET).toMatch(/googlefcPresent/);
  });

  it('keeps the loader deferred (requestIdleCallback or DOMContentLoaded) — LCP safeguard', () => {
    expect(OFFERWALL_FC_SNIPPET).toMatch(/requestIdleCallback|DOMContentLoaded/);
  });

  it('does NOT bundle the anti-adblock fallback IIFE (out of scope for the render fix)', () => {
    // The obfuscated anti-adblock recovery in index.html registers a uniquely
    // named global; it must not leak into this offerwall-only snippet.
    expect(OFFERWALL_FC_SNIPPET).not.toContain('__h82AlnkH6D91__');
  });
});

describe('OFFERWALL_FC_SNIPPET — parity with index.html (drift guard)', () => {
  it('uses the same publisher-id FC loader URL that index.html injects', () => {
    const loaderUrl = `fundingchoicesmessages.google.com/i/${FC_PUBLISHER_ID}`;
    expect(indexHtml, 'index.html must still inject the pub-id FC loader').toContain(loaderUrl);
    expect(OFFERWALL_FC_SNIPPET).toContain(loaderUrl);
  });
});

describe('OFFERWALL_FC_SNIPPET — wired into the article-page owners', () => {
  // The GAM Offerwall is scoped to the article sections. Those pages are emitted
  // by ogPagesPlugin (canonicalPrefix '/articoli-frontaliere/') — NOT staticPagesPlugin,
  // which skips them ("already exist"). The snippet MUST be injected by ogPagesPlugin
  // or the Offerwall never renders on article pages (the 2026-06-16 miss).
  const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

  it('ogPagesPlugin imports and injects OFFERWALL_FC_SNIPPET into the article <head>', () => {
    const src = readBuildPluginSource(resolve(__dirname, '..', 'build-plugins/ogPagesPlugin.ts'));
    expect(src, 'ogPagesPlugin must import the snippet').toMatch(
      /import\s*\{[^}]*OFFERWALL_FC_SNIPPET[^}]*\}\s*from\s*['"]\.\/constants['"]|offerwallFcSnippet:\s*OFFERWALL_FC_SNIPPET|\bOFFERWALL_FC_SNIPPET\b\s*[,}]/,
    );
    // Injected right before the article <body class="bg-surface-alt …"> template.
    expect(src).toMatch(/\$\{OFFERWALL_FC_SNIPPET\}\s*\n\s*<\/head>\s*\n\s*<body class="bg-surface-alt/);
  });

  it('ogPagesPlugin injects OFFERWALL_FC_SNIPPET in the bundle-less fallback <head> too (parity)', () => {
    // The `!hasSpaBundle` fallback template is unreachable today (the resolver
    // throws on a missing bundle), but it must still carry the snippet so the
    // structural gap can never become a revenue gap if that invariant changes —
    // matching staticPagesPlugin, whose own bundle-less fallback already does.
    const src = readBuildPluginSource(resolve(__dirname, '..', 'build-plugins/ogPagesPlugin.ts'));
    // The minimal fallback emits a plain `<body>` (no bg-surface-alt classes);
    // assert the snippet precedes that closing head/plain-body sequence.
    expect(src).toMatch(/\$\{OFFERWALL_FC_SNIPPET\}\s*\n\s*<\/head>\s*\n\s*<body>/);
  });

  it('staticPagesPlugin keeps the isBlogDetailPage-gated fallback injection', () => {
    const src = read('build-plugins/staticPagesPlugin.ts');
    expect(src).toMatch(/isBlogDetailPage\s*\?\s*`\\n\s*\$\{OFFERWALL_FC_SNIPPET\}`/);
  });
});
