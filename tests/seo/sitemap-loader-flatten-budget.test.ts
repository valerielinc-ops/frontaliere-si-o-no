/**
 * Issue #7488 item 2 — the wall-time side of the #7419 flatten.
 *
 * #7441 put `flatString` on the `<loc>` (and `<xhtml:link href>`) captures of
 * the four sitemap loaders inside `scripts/validate-sitemap-pages.mjs`, which
 * trades memory for CPU: the round-trip is now paid for EVERY `<loc>` of EVERY
 * shard, on the one consolidated gate that scans the full sitemap URL set. The
 * memory win was measured (tests/seo/bfs-audit-path-retention.test.ts); the CPU
 * cost was not, and the open question was whether the gate had just swapped an
 * OOM for a timeout.
 *
 * MEASURED HERE, and the margin is not thin. On a 45'000-`<loc>` × 5-alternate
 * synthetic shard (43.8 MB, the real production shape) on the CI-class runner:
 *
 *     loc loop        plain  34.3 ms   flat  50.3 ms   +16.0 ms   356 ns/call
 *     hreflang loop   plain 163.7 ms   flat 254.5 ms   +90.8 ms   403 ns/call
 *
 * `validate:sitemap-pages` flattens at most ~2M values per run (see
 * PRODUCTION_FLATTEN_CALLS below), i.e. ~0.8 s of added wall time against a
 * gate measured at 504-545 s on three consecutive production runs
 * (.github/workflows/post-deploy-validate-dist.yml, per-gate timings table) —
 * about 0.15 %, on a job that carries no `timeout-minutes` at all. So the
 * suggested fallback of "flatten only the values that really enter cross-shard
 * collections" is not needed: every current call site already does, and there
 * is nothing to claw back.
 *
 * WHAT THIS TEST GUARDS. Not the numbers above — those are the record. It
 * guards the thing that could still flip the gate to a timeout: someone
 * swapping the Buffer round-trip for a slower flattener. `flat-string.mjs`'s
 * own header lists `s.split('').join('')` as the other candidate that actually
 * flattens, and it was 3.4x slower on the original measurement. The primary
 * bound is RELATIVE (overhead vs the cost of the same parse loop without it),
 * so it means the same thing on a fast laptop and a noisy shared runner; the
 * absolute extrapolation is a second, looser net.
 */
import { describe, expect, it } from 'vitest';
import { flatString } from '../../scripts/lib/flat-string.mjs';

const HOST = 'https://frontaliereticino.ch';

/** One shard, same shape as public/sitemap-blog.xml: `<loc>` + 5 alternates. */
function buildShard(locs: number): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
      'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n',
  ];
  for (let i = 0; i < locs; i++) {
    const slug = `/articoli-frontaliere/stipendio-netto-frontaliere-guida-completa-${i}`;
    parts.push(`  <url>\n    <loc>${HOST}${slug}/</loc>\n`);
    for (const lang of ['it', 'en', 'de', 'fr', 'x-default']) {
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="${lang}" href="${HOST}/${lang}${slug}/" />\n`,
      );
    }
    parts.push('    <lastmod>2026-09-01</lastmod>\n  </url>\n');
  }
  parts.push('</urlset>\n');
  return parts.join('');
}

/** `loadValidateCanonicalUrls`' loop, verbatim in shape. */
function locLoop(xml: string, flatten: boolean): number {
  const re = /<loc>([^<]+)<\/loc>/g;
  const urls = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = flatten ? flatString(m[1].trim()) : m[1].trim();
    if (url.startsWith(HOST)) urls.add(url);
  }
  return urls.size;
}

/** `loadSoft404Urls`' hreflang loop, verbatim in shape. */
function hreflangLoop(xml: string, flatten: boolean): number {
  const re = /<xhtml:link[^>]*href="(https?:\/\/[^"]+)"[^>]*\/?\s*>/gi;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.add(flatten ? flatString(m[1].trim()) : m[1].trim());
  }
  return out.size;
}

/** Best-of-N: a shared runner's noise only ever adds time, never removes it. */
function fastestMs(fn: () => unknown, reps: number): number {
  let best = Infinity;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

// Kept small enough to stay a unit test; the per-call cost is what scales, and
// it is flat in the shard count.
const LOCS = 8_000;
const REPS = 5;

/**
 * Upper bound on the `flatString` calls one `validate:sitemap-pages` run makes,
 * deliberately generous. Three of the four loaders scan `dist/sitemap*.xml`
 * (~400k `<loc>` at production scale) and `loadContentQualityUrls` flattens
 * TWICE per entry (`url` and `path`), so 4 x 400k; the fourth reads `public/`,
 * whose checked-in shards hold 7'118 `<loc>` + 34'410 `<xhtml:link>`. Round up.
 */
const PRODUCTION_FLATTEN_CALLS = 2_000_000;

/**
 * CALIBRATED, not guessed. Sixteen repeated best-of-5 measurements of each loop
 * at LOCS = 8'000 and 20'000 put the Buffer round-trip's overhead ratio between
 * 0.43 and 0.71 — while `s.split('').join('')`, the only other candidate in
 * `flat-string.mjs`'s header that actually flattens, sits at 2.88 on the same
 * harness. 1.5 is ~2x above the noisiest honest reading and ~2x below the
 * cheapest wrong flattener, which is the whole separation this bound needs. A
 * looser 4x — the first value tried here — let `split('').join('')` through.
 */
const MAX_OVERHEAD_RATIO = 1.5;

/**
 * `validate:sitemap-pages` was measured at 504.30 / 522.53 / 545.46 s on runs
 * 31287634802 / 31296098323 / 31283409340. 30 s is ~6 % of the fastest of the
 * three — far above the ~0.8 s actually observed, and still small enough that
 * blowing it means the flattener changed kind, not that the runner was busy.
 */
const EXTRAPOLATED_BUDGET_MS = 30_000;

describe('validate-sitemap-pages sitemap loaders: flatten wall-time budget', () => {
  it('costs a fraction of the parse loop it rides on, at both call sites', () => {
    const xml = buildShard(LOCS);

    // Warm both shapes so JIT tiering is not attributed to the flattener.
    locLoop(xml, false);
    locLoop(xml, true);
    hreflangLoop(xml, false);
    hreflangLoop(xml, true);

    const locPlain = fastestMs(() => locLoop(xml, false), REPS);
    const locFlat = fastestMs(() => locLoop(xml, true), REPS);
    const hrePlain = fastestMs(() => hreflangLoop(xml, false), REPS);
    const hreFlat = fastestMs(() => hreflangLoop(xml, true), REPS);

    const locRatio = (locFlat - locPlain) / locPlain;
    const hreRatio = (hreFlat - hrePlain) / hrePlain;

    expect(
      locRatio,
      `loc loop: ${locPlain.toFixed(1)} → ${locFlat.toFixed(1)} ms`,
    ).toBeLessThan(MAX_OVERHEAD_RATIO);
    expect(
      hreRatio,
      `hreflang loop: ${hrePlain.toFixed(1)} → ${hreFlat.toFixed(1)} ms`,
    ).toBeLessThan(MAX_OVERHEAD_RATIO);
  });

  it('extrapolates to well under the gate wall at production sitemap volume', () => {
    const xml = buildShard(LOCS);
    locLoop(xml, false);
    locLoop(xml, true);

    const plain = fastestMs(() => locLoop(xml, false), REPS);
    const flat = fastestMs(() => locLoop(xml, true), REPS);
    const perCallNs = ((flat - plain) * 1e6) / LOCS;
    const extrapolatedMs = (perCallNs * PRODUCTION_FLATTEN_CALLS) / 1e6;

    expect(
      extrapolatedMs,
      `${perCallNs.toFixed(0)} ns/call x ${PRODUCTION_FLATTEN_CALLS} = ` +
        `${(extrapolatedMs / 1000).toFixed(2)} s of added gate wall`,
    ).toBeLessThan(EXTRAPOLATED_BUDGET_MS);
  });

  it('still returns the exact URL, so the budget is not bought with content', () => {
    // A "cheaper flattener" that truncates or mangles would sail through the
    // two timing bounds above; the loaders use these strings as lookup keys.
    const url = `${HOST}/articoli-frontaliere/stipendio-netto-frontaliere-2026/`;
    expect(flatString(url)).toBe(url);
    expect(flatString(`${HOST}/città-di-lugano/perché-è-così/`)).toBe(
      `${HOST}/città-di-lugano/perché-è-così/`,
    );
  });
});
