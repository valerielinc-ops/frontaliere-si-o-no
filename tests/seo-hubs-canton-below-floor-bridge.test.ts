/**
 * Regression guard for the GSC Coverage Drilldown 404 sweep sibling bug class
 * in build-plugins/seoHubsPlugin.ts (same class already covered by
 * tests/jobs-seo-editorial-below-floor-bridge.test.ts and
 * tests/ch-canton-below-floor-bridge.test.ts): `emitThinCantonHubs` used to
 * silently `continue` past a non-TI canton once it fell under
 * MIN_JOBS_FOR_CANTON_PAGE (or once its slug-bearing job count / dedup count
 * disagreed with the count, or once the canton's parent landing went
 * noindex), dropping the `/tutti/`, `/settori/`, `/aziende/` URLs -- which may
 * already be indexed via a prior build's sitemap -- straight to a GH Pages
 * hard 404 with no bridge.
 *
 * seoHubsPlugin.ts is a single closeBundle()-hook Vite plugin that only runs
 * inside a full SSG build, not invocable in a lightweight unit test. This
 * test follows the established source-assertion convention: it asserts the
 * below-floor bridge helper exists and is wired up at every known
 * below-floor/noindex site, and that the old bare-`continue` bug pattern has
 * not been reintroduced.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, '../build-plugins/seoHubsPlugin.ts'), 'utf8');
const staticPagesSource = readFileSync(resolve(__dirname, '../build-plugins/staticPagesPlugin.ts'), 'utf8');

describe('seoHubsPlugin thin canton-hub below-floor bridges', () => {
  it('defines the shared below-floor/noindex canton-hub bridge helper', () => {
    expect(source).toContain('const emitCantonHubBelowFloorBridge = (canton: string): void => {');
  });

  it('wires the bridge helper into every below-floor / noindex floor-check site', () => {
    const callSites = source.split('emitCantonHubBelowFloorBridge(canton);').length - 1;
    // total<MIN, jobs.length<MIN, isCantonNoindex, dedupKeys.size<MIN
    expect(callSites).toBe(4);
  });

  it('does not contain the bare-continue 404 bug pattern for any of the four thin canton-hub floor checks', () => {
    expect(source).not.toContain('if (total < MIN_JOBS_FOR_CANTON_PAGE) continue;');
    expect(source).not.toContain('if (jobs.length < MIN_JOBS_FOR_CANTON_PAGE) continue;');
    expect(source).not.toContain('if (isCantonNoindex(canton)) continue;');
    expect(source).not.toContain('if (dedupKeys.size < MIN_JOBS_FOR_CANTON_PAGE) continue;');
  });

  it('the bridge helper emits noindex canonical-bridge pages at the exact tutti/settori/aziende hub paths, pointing at the always-live canton section root', () => {
    const startIdx = source.indexOf('const emitCantonHubBelowFloorBridge = (canton: string): void => {');
    expect(startIdx).toBeGreaterThan(-1);
    const body = source.slice(startIdx, startIdx + 900);
    expect(body).toContain("['tutti', 'settori', 'aziende']");
    expect(body).toContain('hubSlugFor(canton, locale, hub)');
    expect(body).toContain('resolveCantonSection(locale, canton)');
    expect(body).toContain('noindex: true');
  });

  it('never adds below-floor bridge pages to the sitemap', () => {
    const startIdx = source.indexOf('const emitCantonHubBelowFloorBridge = (canton: string): void => {');
    const endIdx = source.indexOf('\n  };\n', startIdx);
    const body = source.slice(startIdx, endIdx);
    expect(body).not.toContain('sitemapEntries.push');
  });

  // #3608 item 3 (adversarial follow-up on #3594): emitCantonHubBelowFloorBridge
  // has no explicit `shouldEmitLocale` gate of its own (it loops HUB_LOCALES
  // internally) — the real BUILD_LOCALE shard-locale gate for its writes is
  // path-based: it writes via the injected `qw` param, which the caller
  // (staticPagesPlugin.ts) binds to its own `_qw`, which funnels every write
  // through the shared WriteCollector's collector.add() → shouldEmitPath on
  // the actual computed dist path (see build-plugins/shared/localeEmitFilter.ts
  // and tests/below-floor-bridge-locale-shard.test.ts for an end-to-end proof
  // of that chokepoint against the three below-floor emitters that ARE
  // invocable outside a full build). These two tests lock in that this
  // helper still writes only via the injected `qw` — never a raw fs write —
  // and that the caller still wires `qw` to a WriteCollector-backed `_qw`,
  // so a future refactor can't silently bypass the shard-locale gate for
  // this family of below-floor bridges.
  it('the bridge helper writes only via the injected qw param, never a raw fs write', () => {
    const startIdx = source.indexOf('const emitCantonHubBelowFloorBridge = (canton: string): void => {');
    const endIdx = source.indexOf('\n  };\n', startIdx);
    const body = source.slice(startIdx, endIdx);
    expect(body).toContain('qw(np.join(distDir, canonicalPath.slice(1), \'index.html\'), html);');
    expect(body).not.toContain('fs.writeFileSync(');
  });

  it('the caller (staticPagesPlugin.ts) wires qw to its own WriteCollector-backed _qw, the real shard-locale chokepoint', () => {
    const callIdx = staticPagesSource.indexOf('const hubs = emitSeoHubs({');
    expect(callIdx).toBeGreaterThan(-1);
    const callBody = staticPagesSource.slice(callIdx, callIdx + 200);
    expect(callBody).toContain('qw: _qw,');

    const qwDefIdx = staticPagesSource.indexOf('function _qw(');
    expect(qwDefIdx).toBeGreaterThan(-1);
    const qwBody = staticPagesSource.slice(qwDefIdx, qwDefIdx + 300);
    expect(qwBody).toContain('collector.add(');
  });
});
