import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * #5130 follow-up — the `it` build was OOM-killed inside `events-seo-pages`.
 *
 * Run 31062047677, `build-locale (it)`, `[profile-mem]`:
 *
 *   austrian-border-municipality-pages  rss_mb=10145  heapUsed_mb=4907
 *   events-seo-pages                    rss_mb=12281  heapUsed_mb=4917   → Killed
 *
 * +2,136 MB of RSS with heapUsed +10 MB and arrayBuffers flat: ~1.97 GB that no
 * V8 counter accounts for, which is why no `--max-old-space-size` ever helped.
 * The same spike is in the run that SURVIVED (31036546298: 9,891 → 11,839, then
 * back down to 11,496 at the next plugin), so it is transient allocation, not a
 * leak — and the build died only because the floor beneath it had risen ~254 MB.
 *
 * Three quarters of that allocation was rendered-then-discarded HTML: the plugin
 * rendered all four locales and `WriteCollector.add()` dropped the non-owned
 * ones as its FIRST action. This test pins the gate that stops producing them.
 *
 * The invariance argument is unusually strong here and the tests below encode
 * it: the chokepoint that decides what ships already rejected these writes, so
 * not rendering them cannot change a byte of output.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN = fs.readFileSync(
  path.join(REPO_ROOT, 'build-plugins/eventsSeoPagesPlugin.ts'),
  'utf8',
);
/** Source minus `//` comment lines, so prose is never a match. */
const CODE = PLUGIN.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

afterEach(() => {
  vi.resetModules();
});

describe('#5130 — events-seo-pages does not render locales this shard discards', () => {
  it('gates every render loop, not just the biggest one', () => {
    // Three loops feed `emit()`: per-canton hub/comune/detail, past-event
    // detail, and the national index. Gating only the first would leave two
    // thirds of the discarded renders in place.
    const emitLoops = CODE.split(/for \(const locale of LOCALES\) \{/).length - 1;
    const gates = CODE.split('if (!shouldEmitLocale(locale))').length - 1;
    expect(emitLoops).toBeGreaterThanOrEqual(3);
    // Every locale loop that renders is gated; the inbound-link patch loop is
    // deliberately NOT (it only touches hub files that already exist on disk).
    expect(gates).toBe(3);
  });

  it('imports the shared filter rather than re-deriving locale ownership', () => {
    expect(CODE).toMatch(/import \{[^}]*shouldEmitLocale[^}]*\} from '\.\/shared\/localeEmitFilter'/);
  });

  it('leaves the sitemap and cross-locale slug assignment OUTSIDE the gate', () => {
    // These must stay complete for all four locales or the shard publishes
    // truncated hreflang alternates — the exact failure localeEmitFilter's
    // docblock warns about. They are built from perCantonSitemap/detailSlugs,
    // never inside a gated loop.
    const sitemapAt = CODE.indexOf('const sitemapXml = buildSitemap(');
    const gateAt = CODE.indexOf('if (!shouldEmitLocale(locale))');
    expect(sitemapAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    // buildSitemap is called after the loops, at top level of the handler —
    // assert it is not inside a `shouldEmitLocale` guard by checking no gate
    // appears between the last emit loop and it on the same nesting path.
    expect(CODE.slice(sitemapAt, sitemapAt + 200)).not.toContain('shouldEmitLocale');
  });

  it('still patches inbound hub links for every locale', () => {
    // patchInboundLink is idempotent and skips a hub that isn't on disk, so it
    // stays ungated — the `it` shard already reports only `it` reached.
    const patchLoop = CODE.indexOf('INBOUND_HUBS[locale]');
    expect(patchLoop).toBeGreaterThan(-1);
    const enclosing = CODE.slice(Math.max(0, patchLoop - 300), patchLoop);
    expect(enclosing).not.toContain('shouldEmitLocale');
  });

  it('reports what it skipped, so the next deploy can be compared', () => {
    expect(CODE).toContain('skippedLocaleRenders');
    expect(CODE).toContain('non-owned-locale renders skipped');
  });
});

describe('#5130 — the gate is a no-op on the default all-locale build', () => {
  async function loadFilter(buildLocale: string | undefined) {
    vi.resetModules();
    const prev = process.env.BUILD_LOCALE;
    if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = buildLocale;
    try {
      return await import('../build-plugins/shared/localeEmitFilter');
    } finally {
      if (prev === undefined) delete process.env.BUILD_LOCALE;
      else process.env.BUILD_LOCALE = prev;
    }
  }

  it('renders all four locales when BUILD_LOCALE is unset', async () => {
    const f = await loadFilter(undefined);
    expect(f.EMIT_ALL_LOCALES).toBe(true);
    for (const l of ['it', 'en', 'de', 'fr']) expect(f.shouldEmitLocale(l)).toBe(true);
  });

  it.each(['it', 'en', 'de', 'fr'])('on the %s shard renders exactly one locale', async (loc) => {
    const f = await loadFilter(loc);
    const rendered = ['it', 'en', 'de', 'fr'].filter((l) => f.shouldEmitLocale(l));
    expect(rendered).toEqual([loc]);
  });

  it('the collector this gate mirrors really does discard the other three', async () => {
    // The load-bearing claim: WriteCollector.add() drops a non-owned-locale
    // write before doing anything else, so the render was pure waste. Asserted
    // against the source so a future change to that order is caught here.
    const batch = fs.readFileSync(path.join(REPO_ROOT, 'build-plugins/batchWrite.ts'), 'utf8');
    const addAt = batch.indexOf('add(filePath: string, content: string) {');
    expect(addAt).toBeGreaterThan(-1);
    const body = batch.slice(addAt, addAt + 2000);
    const dropAt = body.indexOf('!shouldEmitPath(filePath, this._distDir)');
    const claimAt = body.indexOf('= claim(filePath');
    const existsAt = body.indexOf('fs.existsSync(filePath)');
    expect(dropAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(existsAt).toBeGreaterThan(-1);
    // The locale drop happens BEFORE the collision claim and before any disk
    // work — i.e. the content is discarded outright, never used for anything.
    expect(dropAt).toBeLessThan(claimAt);
    expect(dropAt).toBeLessThan(existsAt);
  });
});
