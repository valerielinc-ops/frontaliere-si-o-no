/**
 * Regression test for the shared bridge-page SEO prose helper.
 *
 * Why this exists
 * ---------------
 * The redirect/alias bridge pages emitted by `legacyAliasPlugin` and
 * `jobOrphanBridgePlugin` are intentionally short (2-line "page moved"
 * placeholder + link to the live target). Without prose injection they
 * sat at ~5 % text/HTML and drove the residual `audit:text-html-ratio`
 * offenders across three buckets (blog +15, fuel-daily +7, job-board
 * +61 over baseline as of 2026-05-12).
 *
 * `build-plugins/shared/bridgePageProse.ts` appends ~1.6-2.0 KB of
 * visible text below the existing CTA on every bridge page:
 *   - 1-paragraph opener keyed to bridgeKind (article / job-matched /
 *     job-expired / fuel-station / generic)
 *   - 1-paragraph G-permit + 2024 New Bilateral Agreement summary
 *   - 3 FAQ entries in collapsed `<details>` accordions
 *   - 1-paragraph related-tools cross-link block
 *
 * Mobile-first per CLAUDE.md non-negotiables #15-17: hosts MUST place
 * the helper output AFTER their CTA link so the CTA stays first-paint.
 *
 * This test asserts:
 *   1. Each (locale × bridgeKind) call produces ≥ 1200 bytes of visible
 *      text (enough to lift a 6.5 KB host page above the 10 % threshold).
 *   2. The opener differs across bridgeKinds (no cross-page duplicate
 *      content within the same locale).
 *   3. The output never includes a `noindex` meta (per CLAUDE.md
 *      non-negotiable #5 + the never_noindex_without_approval memory).
 *   4. All links target canonical site paths (no broken hrefs).
 *
 * A regression in any of these dimensions reopens the text-to-html-ratio
 * gate on the bridge pages.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderBridgePageProse,
  __resetBridgeProseCache,
  type BridgePageKind,
  type BridgePageLocale,
} from '../../build-plugins/shared/bridgePageProse';

const LOCALES: BridgePageLocale[] = ['it', 'en', 'de', 'fr'];
const KINDS: BridgePageKind[] = [
  'article',
  'job-matched',
  'job-expired',
  'fuel-station',
  'generic',
];

function extractVisibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('bridgePageProse helper', () => {
  beforeEach(() => {
    __resetBridgeProseCache();
  });

  it('emits ≥ 1200 bytes of visible text for every (locale × kind)', () => {
    for (const locale of LOCALES) {
      for (const kind of KINDS) {
        const html = renderBridgePageProse({ locale, bridgeKind: kind });
        const text = extractVisibleText(html);
        expect(
          text.length,
          `locale=${locale} kind=${kind} produced only ${text.length} chars`,
        ).toBeGreaterThanOrEqual(1200);
      }
    }
  });

  it('opener differs across bridge kinds within the same locale', () => {
    // Each kind has its own page-relevant opening paragraph so two
    // bridges of different kinds never share the same intro string
    // (cross-page duplicate-content penalty).
    for (const locale of LOCALES) {
      const openers = KINDS.map((kind) => {
        const html = renderBridgePageProse({ locale, bridgeKind: kind });
        // First paragraph after the H2 (the opener).
        const match = html.match(/<p style="margin:0 0 14px">([^<]+(?:<[^>]+>[^<]*<\/[^>]+>[^<]*)*)<\/p>/);
        return match ? match[1].slice(0, 80) : '';
      });
      const unique = new Set(openers);
      expect(
        unique.size,
        `locale=${locale}: ${KINDS.length} kinds produced only ${unique.size} unique openers`,
      ).toBe(KINDS.length);
    }
  });

  it('output never includes a noindex meta', () => {
    // CLAUDE.md non-negotiable #5 + the never_noindex_without_approval
    // memory: every bridge page MUST stay indexable.
    for (const locale of LOCALES) {
      for (const kind of KINDS) {
        const html = renderBridgePageProse({ locale, bridgeKind: kind });
        expect(html).not.toMatch(/noindex/i);
      }
    }
  });

  it('all links target canonical site paths (no broken or external hrefs)', () => {
    // The cross-link block must point at site-relative paths (calculator,
    // FX, health, fuel, jobs). Detect any href that escapes the site or
    // points at an undefined route.
    const ALLOWED_PATH_PATTERNS = [
      /^\/(?:[a-z]{2}\/)?calcola-stipendio\/$/,
      /^\/(?:[a-z]{2}\/)?calculate-salary\/$/,
      /^\/(?:[a-z]{2}\/)?gehalt-berechnen\/$/,
      /^\/(?:[a-z]{2}\/)?calculer-salaire\/$/,
      /^\/comparatori\/cambio-valuta\/$/,
      /^\/en\/comparators\/currency-exchange\/$/,
      /^\/de\/vergleiche\/wechselkurs\/$/,
      /^\/fr\/comparateurs\/change-devises\/$/,
      /^\/comparatori\/casse-malati\/$/,
      /^\/en\/comparators\/health-insurance\/$/,
      /^\/de\/vergleiche\/krankenkassen\/$/,
      /^\/fr\/comparateurs\/caisses-maladie\/$/,
      /^\/prezzi-benzina-svizzera\/$/,
      /^\/en\/gasoline-price-switzerland\/$/,
      /^\/de\/benzinpreis-schweiz\/$/,
      /^\/fr\/prix-essence-suisse\/$/,
      /^\/cerca-lavoro-ticino\/$/,
      /^\/en\/find-jobs-ticino\/$/,
      /^\/de\/jobs-im-tessin\/$/,
      /^\/fr\/trouver-emploi-tessin\/$/,
    ];
    for (const locale of LOCALES) {
      for (const kind of KINDS) {
        const html = renderBridgePageProse({ locale, bridgeKind: kind });
        const hrefs = Array.from(html.matchAll(/href="([^"]+)"/g)).map(
          (m) => m[1],
        );
        for (const href of hrefs) {
          const ok = ALLOWED_PATH_PATTERNS.some((re) => re.test(href));
          expect(
            ok,
            `locale=${locale} kind=${kind}: unexpected href "${href}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('two calls with same input return byte-identical HTML (memoization)', () => {
    // The helper is called ~hundreds of times per build across the
    // bridge plugins. The memo cache must guarantee identical output
    // so the audit-text-html-ratio numbers stay deterministic.
    for (const locale of LOCALES) {
      for (const kind of KINDS) {
        const a = renderBridgePageProse({ locale, bridgeKind: kind });
        const b = renderBridgePageProse({ locale, bridgeKind: kind });
        expect(a).toBe(b);
      }
    }
  });
});
