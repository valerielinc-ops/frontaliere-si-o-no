/**
 * Regression test for the weekly-employers orphan-pages fix.
 *
 * Background: Semrush 2026-04-28 audit flagged sitemap-weekly-employers.xml
 * as having 174/188 (~93%) orphan rate. Root causes were:
 *
 *   1. There was no top hub at `/aziende-che-assumono/` — only the 28 city
 *      hubs and their per-employer × city leaves were emitted, leaving
 *      cross-locale variants unreachable from each other.
 *   2. City hubs did not link to every per-employer leaf in their city, so
 *      the leaves had no inbound static `<a>` from any reachable page.
 *   3. There were no `<a>` cross-links between locale variants — only
 *      `<link rel="alternate" hreflang>` (which BFS deliberately ignores).
 *
 * The fix adds: a top hub per locale, a "city hubs" list block on every
 * city hub + top hub, a "leaves for this city" block on every city hub,
 * and a locale-switcher block (with `<a hreflang>` anchors, not `<link>`)
 * on every top hub and city hub.
 *
 * This test guards the invariant end-to-end: a synthetic mini dist tree is
 * built (top hubs + 2 city hubs + 4 leaves across 2 locales), BFS runs from
 * `/`, and every URL must be reachable in ≤3 hops.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import np from 'node:path';
import os from 'node:os';

import {
  renderTopHubPage,
  renderWeeklyEmployersPage,
} from '../../build-plugins/weeklyEmployersPlugin';
import {
  buildCompanyCityCurrentPath,
  buildCurrentWeekPath,
} from '../../build-plugins/weeklyEmployersData';

let TMPDIR: string;
let DIST: string;

beforeAll(() => {
  TMPDIR = fs.mkdtempSync(np.join(os.tmpdir(), 'we-orphan-bfs-'));
  DIST = np.join(TMPDIR, 'dist');
  fs.mkdirSync(DIST, { recursive: true });
});

afterAll(() => {
  if (TMPDIR && fs.existsSync(TMPDIR)) {
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  }
});

/** Write `<html>` to `dist/<path>/index.html`, creating the dir tree as needed. */
function writeHtmlAt(distRoot: string, path: string, html: string): void {
  const rel = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const dir = rel.length === 0 ? distRoot : np.join(distRoot, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(np.join(dir, 'index.html'), html, 'utf-8');
}

describe('weekly-employers BFS reachability — top hub + city + leaves + cross-locale', () => {
  it('reaches every URL from / in <=3 hops with the new linking', async () => {
    const today = new Date('2026-04-28T08:00:00Z');

    // ─── Synthesize a mini dist tree ──────────────────────────────
    //
    //   /  → /aziende-che-assumono/lugano/settimana-corrente/   (depth 1)
    //   /aziende-che-assumono/lugano/...      → /aziende-che-assumono/   (depth 2)
    //   /aziende-che-assumono/                → /en/companies-hiring/    (depth 3)
    //   /aziende-che-assumono/{city}/...      → leaf URLs                (depth 3)
    //
    // We keep two locales (it, en) and two cities per locale + two leaves
    // per (city, locale) — the structural minimum that exercises:
    //   - top hub → all city hubs
    //   - city hub → all per-employer leaves
    //   - top hub → top hub (other locale, BFS-traversable cross-locale link)

    // (a) Homepage with one anchor into the IT weekly-employers graph.
    //     This mirrors `SeoDailyBanner` linking to the regional ticino hub
    //     in production. The exact target doesn't matter — any hub will do.
    writeHtmlAt(
      DIST,
      '/',
      `<!doctype html><html><head><title>Home</title></head>
       <body><main><a href="${buildCurrentWeekPath('it', 'lugano')}">
         Aziende che assumono — Lugano</a></main></body></html>`,
    );

    // (b) IT and EN top hubs (real production renderer — exercises
    //     renderCityHubsListBlock + renderLocaleSwitcherBlock).
    for (const locale of ['it', 'en'] as const) {
      const html = renderTopHubPage({
        locale,
        today,
        jobsCount: 100,
        companiesCount: 25,
        // distDir omitted so seoPageShell skips entry-asset injection
      });
      writeHtmlAt(
        DIST,
        locale === 'it' ? '/aziende-che-assumono/' : '/en/companies-hiring/',
        html,
      );
    }

    // (c) Two city hubs per locale (ticino + lugano), with `cityLeaves`
    //     populated for `lugano` so the per-employer-leaves block renders.
    //     The renderer pulls a non-trivial body from real COPY/JSON-LD —
    //     we just need its outgoing <a> graph for BFS.
    const luganoLeaves = [
      { companySlug: 'employer-a', employer: 'Employer A SA' },
      { companySlug: 'employer-b', employer: 'Employer B GmbH' },
    ];
    const minimalStats = {
      city: 'lugano' as const,
      activeJobsCount: 10,
      topCompanies: [],
      newcomers: [],
      topRoles: [],
    };
    for (const locale of ['it', 'en'] as const) {
      for (const city of ['ticino', 'lugano'] as const) {
        const canonicalPath = buildCurrentWeekPath(locale, city);
        const html = renderWeeklyEmployersPage({
          locale,
          city,
          variant: 'current',
          weekNum: 18,
          year: 2026,
          stats: { ...minimalStats, city },
          hasHistoricalDelta: false,
          canonicalPath,
          today,
          indexable: true,
          cityLeaves: city === 'lugano' ? luganoLeaves : [],
        });
        writeHtmlAt(DIST, canonicalPath, html);
      }
    }

    // (d) Stub HTML for the 4 leaves (it×2 + en×2) so BFS doesn't mark them
    //     dangling. The leaf body content doesn't matter for this test.
    for (const locale of ['it', 'en'] as const) {
      for (const leaf of luganoLeaves) {
        const path = buildCompanyCityCurrentPath(locale, 'lugano', leaf.companySlug);
        writeHtmlAt(
          DIST,
          path,
          `<!doctype html><html><body><main>${leaf.employer}</main></body></html>`,
        );
      }
    }

    // ─── Run the production BFS over this synthetic dist ──────────
    const { __test } = await import('../../scripts/audit-orphan-pages-in-sitemaps.mjs');
    const { linked } = await __test.bfsReachableFromHome(DIST);

    // BFS normalises trailing slashes to "no trailing slash" except `/`.
    const norm = (p: string) => (p === '/' ? '/' : p.replace(/\/+$/, ''));

    // ─── Assert: top hubs reachable ───────────────────────────────
    expect(linked.has(norm('/aziende-che-assumono/'))).toBe(true);
    expect(linked.has(norm('/en/companies-hiring/'))).toBe(true);

    // ─── Assert: every city hub (4 = 2 cities × 2 locales) ────────
    for (const locale of ['it', 'en'] as const) {
      for (const city of ['ticino', 'lugano'] as const) {
        const p = norm(buildCurrentWeekPath(locale, city));
        expect(linked.has(p), `BFS missed city hub ${p}`).toBe(true);
      }
    }

    // ─── Assert: every per-employer leaf (4 = 2 leaves × 2 locales) ─
    for (const locale of ['it', 'en'] as const) {
      for (const leaf of luganoLeaves) {
        const p = norm(buildCompanyCityCurrentPath(locale, 'lugano', leaf.companySlug));
        expect(linked.has(p), `BFS missed leaf ${p}`).toBe(true);
      }
    }
  });
});
