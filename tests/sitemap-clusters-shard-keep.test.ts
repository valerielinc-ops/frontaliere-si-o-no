/**
 * LOCALE-SHARD-BUILD-PLAN Fase 0 (follow-up #2477) — sitemap completeness on a
 * single-locale shard build.
 *
 * `relatedSearchClustersPlugin` builds `sitemap-search-clusters.xml` by passing
 * the full cross-locale loc set through `dropOverwrittenLocs`, which reads each
 * loc's HTML in dist/ to drop noindex / non-self-canonical / overwritten URLs.
 *
 * On a `BUILD_LOCALE=<locale>` shard the render-skip branch pushes a COMPLETE
 * cross-locale loc set (cheap, string-only) but the EN/DE/FR cluster HTML for
 * the non-owned locales is never written to dist (WriteCollector gates it). The
 * file-existence drop must therefore KEEP cross-shard locs unconditionally,
 * otherwise the it/main shard ships an IT-only sitemap.
 *
 * Env is read once at module load (localeEmitFilter parses BUILD_LOCALE), so
 * each scenario sets the var and re-imports via vi.resetModules().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function loadPlugin(buildLocale: string | undefined) {
  vi.resetModules();
  const prev = process.env.BUILD_LOCALE;
  if (buildLocale === undefined) delete process.env.BUILD_LOCALE;
  else process.env.BUILD_LOCALE = buildLocale;
  try {
    return await import('../build-plugins/relatedSearchClustersPlugin');
  } finally {
    if (prev === undefined) delete process.env.BUILD_LOCALE;
    else process.env.BUILD_LOCALE = prev;
  }
}

const BASE = 'https://frontaliereticino.ch';
const IT = `${BASE}/cerca-lavoro-ticino/ricerca-data-center-technician/`;
const EN = `${BASE}/en/find-jobs-ticino/search-data-center-technician/`;
const DE = `${BASE}/de/jobs-im-tessin/suche-data-center-technician/`;
const FR = `${BASE}/fr/trouver-emploi-tessin/recherche-data-center-technician/`;

// Self-canonical, indexable HTML — the KEEP case for a present file.
const okHtml = (loc: string) =>
  `<!doctype html><html><head><link rel="canonical" href="${loc}"></head><body></body></html>`;

let dist: string;

beforeEach(() => {
  // dist with ONLY the IT cluster page on disk (simulates an it-shard build,
  // where en/de/fr cluster HTML was gated out of the WriteCollector).
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-sitemap-shard-'));
  const itDir = path.join(dist, 'cerca-lavoro-ticino', 'ricerca-data-center-technician');
  fs.mkdirSync(itDir, { recursive: true });
  fs.writeFileSync(path.join(itDir, 'index.html'), okHtml(IT));
});

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
  vi.resetModules();
});

describe('dropOverwrittenLocs — default build (no BUILD_LOCALE) unchanged', () => {
  it('drops cross-locale locs whose HTML is absent on disk', async () => {
    const { dropOverwrittenLocs } = await loadPlugin(undefined);
    const kept = await dropOverwrittenLocs(dist, [IT, EN, DE, FR]);
    // Only IT exists on disk → en/de/fr dropped as DROP_MISSING (status quo).
    expect(kept).toEqual([IT]);
  });
});

describe('dropOverwrittenLocs — it shard keeps cross-shard cluster locs', () => {
  it('keeps en/de/fr (other shards own them) + the present it self-ref', async () => {
    const { dropOverwrittenLocs } = await loadPlugin('it');
    const kept = await dropOverwrittenLocs(dist, [IT, EN, DE, FR]);
    // it is real-checked (exists + self-canonical → kept); en/de/fr not emitted
    // by this shard → kept unconditionally so the sitemap stays complete.
    expect(kept).toEqual([IT, EN, DE, FR]);
  });

  it('preserves input order across the keep + check mix', async () => {
    const { dropOverwrittenLocs } = await loadPlugin('it');
    const kept = await dropOverwrittenLocs(dist, [EN, IT, FR, DE]);
    expect(kept).toEqual([EN, IT, FR, DE]);
  });
});

describe('dropOverwrittenLocs — en shard still real-checks its own locale', () => {
  it('drops a missing en page it owns, keeps cross-shard it/de/fr', async () => {
    // en-shard: en page is OWNED → subject to the file-existence check. Here the
    // en HTML is absent on disk → must be dropped (genuine broken/missing URL),
    // while it/de/fr (other shards) are kept unconditionally.
    const { dropOverwrittenLocs } = await loadPlugin('en');
    const kept = await dropOverwrittenLocs(dist, [IT, EN, DE, FR]);
    expect(kept).toEqual([IT, DE, FR]); // EN dropped (owned + missing)
    expect(kept).not.toContain(EN);
  });
});
