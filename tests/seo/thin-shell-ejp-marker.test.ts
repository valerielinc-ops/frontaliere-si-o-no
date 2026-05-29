/**
 * thin-shell-ejp-marker.test.ts
 *
 * The tiered-emission thin shells (PRs #723 previousSlug bridges, #740 GSC
 * keyword landings, #725 expired soft-landings, #742 related-search clusters)
 * are deliberately low-text-ratio crawler shells that SPA-hydrate to full
 * content. They are thinned only for zero-traffic, ≥15-day-old URLs with an
 * hourly self-heal promotion loop.
 *
 * They MUST carry the `<!--EJP_STRIPPED-->` marker so audit-text-html-ratio
 * skips them, exactly like the legacy STRIP_* paths. When the four thin-shell
 * builders forgot the marker, 65039 job-board + 10851 spa-locale + 8581
 * spa-other offenders regressed past the ratchet baseline and blocked every
 * deploy. This guards each builder against losing the marker again.
 */

import { describe, expect, it } from 'vitest';
// @ts-ignore: .mjs script with no .d.ts (resolved at runtime via vitest)
import { createAuditor } from '../../scripts/audit-text-html-ratio.mjs';
import { minifyHtml } from '../../build-plugins/shared/htmlMinify';
import { buildGscKeywordThinBody } from '../../build-plugins/shared/gscKeywordThinShell';
import { buildSoftLandingThinHtml } from '../../build-plugins/shared/softLandingThinShell';
import { buildBridgeThinHtml } from '../../build-plugins/shared/bridgeThinShell';
import { buildClusterThinHtml } from '../../build-plugins/shared/clusterThinShell';

const MARKER = '<!--EJP_STRIPPED-->';

// Wrap a body fragment in a minimal document so the auditor can scan it.
const wrap = (body: string) =>
  `<!doctype html><html><head><title>x</title>` +
  `<link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/foo/"></head>` +
  `<body>${body}</body></html>`;

// Full docs shaped so each builder's block-replace regex matches.
const SOFT_LANDING_FULL = wrap(
  `<h1>Foo Engineer — Acme</h1>` +
    `<article class="ft-static-article"><h2>Heavy</h2>${'<p>lorem ipsum dolor sit amet</p>'.repeat(40)}</article>`,
);
const BRIDGE_FULL = wrap(
  `<h1>Bar Specialist — Beta</h1>` +
    `<main class="seo-static-content static-job-page"><h2>Heavy</h2>${'<p>lorem ipsum dolor sit amet</p>'.repeat(40)}</main>`,
);
const CLUSTER_FULL = wrap(
  `<h1>Lavoro Lugano</h1>` +
    `<main class="cluster-seo-prose"><h2>Heavy</h2>${'<p>lorem ipsum dolor sit amet</p>'.repeat(40)}</main>`,
);

// Each entry: a thin HTML string that the auditor must SKIP via the marker.
const cases: Array<{ name: string; html: string }> = [
  {
    name: 'gsc-keyword landing',
    html: wrap(
      buildGscKeywordThinBody({
        h1Title: 'Lavoro infermiere Ticino',
        query: 'infermiere',
        listingUrl: '/cerca-lavoro-ticino/',
        locale: 'it',
      }),
    ),
  },
  { name: 'soft-landing (expired)', html: buildSoftLandingThinHtml(SOFT_LANDING_FULL, 'it') },
  { name: 'bridge (previousSlug)', html: buildBridgeThinHtml(BRIDGE_FULL, 'bar-specialist-beta', 'it') },
  { name: 'cluster (related-search)', html: buildClusterThinHtml(CLUSTER_FULL, 'it') },
];

describe('thin-shell builders emit the EJP_STRIPPED audit-skip marker', () => {
  for (const { name, html } of cases) {
    it(`${name}: output carries <!--EJP_STRIPPED-->`, () => {
      expect(html).toContain(MARKER);
    });

    it(`${name}: marker survives htmlMinify`, () => {
      expect(minifyHtml(html)).toContain(MARKER);
    });

    it(`${name}: audit-text-html-ratio skips it (minified, end-to-end)`, async () => {
      const a = createAuditor({ threshold: 10, failOnOffenders: true });
      a.collect('dist/cerca-lavoro-ticino/foo/index.html', minifyHtml(html));
      const r = await a.report();
      expect(r.extra.skippedEjpStripped).toBe(1);
      expect(r.offendersTotal).toBe(0);
      expect(r.extra.scanned).toBe(0);
    });
  }
});

// The `career-landings` regression (10 > cap 0) is NOT the company-hub path:
// the audit's classifyFeature maps any `/cerca-lavoro-ticino/azienda-*/` URL
// to `career-landings`, which also catches expired-job soft-landings whose
// slug starts with the word "azienda" (e.g. the AMB "Azienda Multiservizi
// Bellinzona" job, or "azienda di formazione …spital-emmental-burgdorf").
// Those are soft-landing THIN shells (text ~700 B / html ~7-15 KB per the
// failing run's text-html-ratio.json), so the softLandingThinShell marker fix
// above skips them — the marker check runs before feature classification, so a
// skipped page never reaches the career-landings bucket. (Real company hubs
// like `entreprise-zurzach-care` sit at 31-67% ratio and were never offenders.)
describe('career-landings regression is soft-landing thin pages, covered by the marker', () => {
  const azPath =
    'dist/cerca-lavoro-ticino/azienda-multiservizi-bellinzona-amb-un-una-assistente-clienti/index.html';

  it('a thin soft-landing under an azienda-* path is skipped, not bucketed as career-landings', async () => {
    const thin = buildSoftLandingThinHtml(SOFT_LANDING_FULL, 'it');
    const a = createAuditor({ threshold: 10, failOnOffenders: true });
    a.collect(azPath, minifyHtml(thin));
    const r = await a.report();
    expect(r.extra.skippedEjpStripped).toBe(1);
    expect(r.byFeature?.['career-landings'] ?? 0).toBe(0);
    expect(r.offendersTotal).toBe(0);
  });

  it('control: the same azienda-* path WITHOUT the marker IS bucketed as a career-landings offender', async () => {
    const lowRatioNoMarker =
      `<!doctype html><html><head><title>x</title></head><body><h1>Y</h1>${'<div></div>'.repeat(2000)}</body></html>`;
    const a = createAuditor({ threshold: 10, failOnOffenders: true });
    a.collect(azPath, lowRatioNoMarker);
    const r = await a.report();
    expect(r.byFeature?.['career-landings']).toBe(1);
  });
});
