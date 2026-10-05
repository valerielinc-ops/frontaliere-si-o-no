/**
 * Offerwall FC snippet for STATIC pages — regression + drift guard.
 *
 * Static SEO heads do NOT carry index.html's inline Offerwall block. Article
 * pages keep the small inline carrier; job-board emitters reference the same
 * publisher-id MESSAGING loader through an ordered, deferred cacheable asset.
 * Relying on the network-code loader pulled in by adsbygoogle.js AFTER
 * hydration can fetch the Offerwall message without rendering its overlay.
 * The custom newsletter choice is intentionally not emitted; Ad Manager owns
 * the available choices.
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

import {
  OFFERWALL_FC_SNIPPET,
  OFFERWALL_FC_SCRIPT_CONTENT,
  FC_PUBLISHER_ID,
  FC_JOBBOARD_OFFERWALL_GATE_JS,
} from '../build-plugins/constants';
import { readBuildPluginSource } from './helpers/buildPluginSource';

const indexHtml = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');

describe('OFFERWALL_FC_SNIPPET — custom choice', () => {
  it('does not emit the newsletter custom-choice registry', () => {
    expect(OFFERWALL_FC_SNIPPET).not.toContain('customchoice');
    expect(OFFERWALL_FC_SNIPPET).not.toContain('__ftOfferwallSubscribe');
    expect(OFFERWALL_FC_SNIPPET).not.toContain('cc.registry');
  });
});

describe('OFFERWALL_FC_SCRIPT_CONTENT — shared static carrier', () => {
  it('keeps the inline article wrapper byte-identical to the external job-board body', () => {
    expect(OFFERWALL_FC_SNIPPET).toBe(`<script>${OFFERWALL_FC_SCRIPT_CONTENT}</script>`);
  });

  it('emits the job-board body once as a cacheable static asset', () => {
    const src = readFileSync(resolve(__dirname, '..', 'build-plugins/staticScriptsPlugin.ts'), 'utf8');
    expect(src).toContain('JOB_BOARD_FC_LOADER_FILENAME');
    expect(src).toContain('OFFERWALL_FC_SCRIPT_CONTENT');
  });
});

describe('OFFERWALL_FC_SNIPPET — Funding Choices messaging loader', () => {
  it('handles an online event without depending on the separate AdSense loader scope', () => {
    const listeners = new Map<string, Array<() => void>>();
    const fakeWindow = {
      history: {},
      requestIdleCallback: () => {},
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, [...(listeners.get(type) || []), listener]);
      },
    };
    const script = OFFERWALL_FC_SNIPPET.replace(/^<script>/, '').replace(/<\/script>$/, '');
    new Function('window', 'document', script)(fakeWindow, { readyState: 'complete' });
    expect(() => { for (const listener of listeners.get('online') || []) listener(); }).not.toThrow();
  });

  it('holds the native Offerwall on the job board until "Candidati" and suppresses it elsewhere', () => {
    // Behaviour is executed in tests/offerwall-click-gate-parity.test.ts.
    expect(OFFERWALL_FC_SNIPPET).toContain(FC_JOBBOARD_OFFERWALL_GATE_JS);
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

describe('OFFERWALL_FC_SNIPPET — wired into every static-page owner', () => {
  // The GAM Offerwall is scoped to the article sections and job-board pages.
  // Keep this list in sync with the source emitters: a GPT-only head passes
  // the ad-loading smoke test but fails the consent probe with fc_not_requested.
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

  it('staticPagesPlugin injects the shared carrier for job-board sections and the inline snippet for blog detail', () => {
    const src = read('build-plugins/staticPagesPlugin.ts');
    expect(src).toMatch(/jobBoardHeadTags\(fullUrl\)/);
    expect(src).toMatch(/isBlogDetailPage\s*\?\s*`\\n\s*\$\{OFFERWALL_FC_SNIPPET\}`/);
  });

  it('jobsSeoPagesPlugin applies the same CMP contract to every job-page template', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    expect(src).toMatch(/import \{ JOB_BOARD_HEAD_TAGS \} from ['"]\.\/jobBoardGpt['"]/);
    expect(src).toMatch(/staticAnalyticsHtml[^\n]*JOB_BOARD_HEAD_TAGS/);
    expect(src).not.toMatch(/jobBoardOfferwallTag/);
  });

  it('seoHubsPlugin applies the shared contract to paginated job hubs', () => {
    const src = read('build-plugins/seoHubsPlugin.ts');
    expect(src).toMatch(/import \{ jobBoardHeadTags \} from ['"]\.\/jobBoardGpt['"]/);
    expect(src).toMatch(/const jobBoardHeadTag = jobBoardHeadTags\(canonicalUrl\)/);
  });

  it('recency and sector job hubs use the same shared contract', () => {
    for (const plugin of ['jobRecencyPagesPlugin.ts', 'jobSectorPagesPlugin.ts']) {
      const src = read(`build-plugins/${plugin}`);
      expect(src, `${plugin} must use the shared job-board head contract`).toMatch(
        /jobBoardHeadTags\(canonicalUrl\)/,
      );
    }
  });

  it('the shared SEO shell carries the contract for every job-board consumer', () => {
    const src = read('build-plugins/shared/seoPageShell.ts');
    expect(src).toMatch(/extraHeadHtml:[^\n]*jobBoardHeadTags\(canonicalUrl\)/);
  });
});
