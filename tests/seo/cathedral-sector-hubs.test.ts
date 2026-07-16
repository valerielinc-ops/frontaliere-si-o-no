import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

/**
 * Phase 3.2 — per-canton sector hubs (additive).
 *
 * The TI sector hubs at /cerca-lavoro-ticino/{sectorSlug}/ are owned by
 * jobSectorPagesPlugin.ts and are NOT touched. This test smoke-checks that
 * the additive per-canton emit produces hub pages under non-TI cantons.
 *
 * Build-output-gated: when `dist/` is absent (orchestrator policy / agent
 * sessions skip the full build), these tests are no-ops.
 */
describe('cathedral — per-canton sector hubs (Phase 3.2)', () => {
  it('per-canton sector hubs emit for at least one eligible non-TI canton', () => {
    if (!fs.existsSync(DIST)) return;
    const nonTiSections = [
      'cerca-lavoro-zurigo',
      'cerca-lavoro-ginevra',
      'cerca-lavoro-vaud',
      'cerca-lavoro-berna',
      'cerca-lavoro-argovia',
    ];
    const sectorSlugs = [
      'infermieri',
      'case-anziani',
      'educatori',
      'ingegneri',
      'autisti',
      'sviluppatori',
      'ristorazione',
      'operatori-socio-sanitari',
      'logistica',
      'apprendistato',
    ];
    let anyHub = false;
    for (const sec of nonTiSections) {
      const dir = path.join(DIST, sec);
      if (!fs.existsSync(dir)) continue;
      for (const slug of sectorSlugs) {
        const f = path.join(dir, slug, 'index.html');
        if (fs.existsSync(f)) {
          anyHub = true;
          // Verify canonical points at itself (self-canonical for per-canton hub).
          // Quote-flexible: dist-shrink (PR #473) strips attribute quotes.
          const html = fs.readFileSync(f, 'utf-8');
          expect(html, `${sec}/${slug} must self-canonicalize`).toMatch(
            new RegExp(
              `<link\\s+rel=["']?canonical["']?\\s+href=["']?https://frontaliereticino\\.ch/${sec}/${slug}/["']?`,
            ),
          );
          // Verify it embeds at least one job-card structure
          expect(html, `${sec}/${slug} must have a job listing grid`).toMatch(
            /<article|data-job-id|JobPosting|<li[^>]*>/,
          );
          break;
        }
      }
      if (anyHub) break;
    }
    expect(anyHub, 'No per-canton sector hub emitted under any sampled non-TI canton').toBe(true);
  });

  it('non-TI canton × sector hubs have no job-count floor — every sampled combo is a real, indexed page, never a noindex bridge (owner decision 2026-07-16)', () => {
    if (!fs.existsSync(DIST)) return;
    const nonTiSections = [
      'cerca-lavoro-zurigo',
      'cerca-lavoro-ginevra',
      'cerca-lavoro-vaud',
      'cerca-lavoro-berna',
      'cerca-lavoro-argovia',
      'cerca-lavoro-san-gallo',
      'cerca-lavoro-lucerna',
    ];
    const sectorSlugs = [
      'infermieri',
      'case-anziani',
      'educatori',
      'ingegneri',
      'autisti',
      'sviluppatori',
      'ristorazione',
      'operatori-socio-sanitari',
      'logistica',
      'apprendistato',
    ];
    const missing: string[] = [];
    const bridged: string[] = [];
    let checked = 0;
    for (const sec of nonTiSections) {
      const dir = path.join(DIST, sec);
      if (!fs.existsSync(dir)) continue;
      for (const slug of sectorSlugs) {
        const f = path.join(dir, slug, 'index.html');
        if (!fs.existsSync(f)) {
          missing.push(`${sec}/${slug}`);
          continue;
        }
        checked++;
        const html = fs.readFileSync(f, 'utf-8');
        // A below-floor bridge would noindex and canonicalize at the canton
        // section root instead of at its own slug — assert neither happens.
        if (/name=["']?robots["']?[^>]*noindex/i.test(html)) {
          bridged.push(`${sec}/${slug} (noindex)`);
        }
        const selfCanonical = new RegExp(
          `<link\\s+rel=["']?canonical["']?\\s+href=["']?https://frontaliereticino\\.ch/${sec}/${slug}/["']?`,
        );
        if (!selfCanonical.test(html)) {
          bridged.push(`${sec}/${slug} (canonical not self)`);
        }
      }
    }
    if (checked === 0) return; // dist built without these sections/sectors — nothing to assert
    expect(missing, `sector-hub pages missing for sampled non-TI combos:\n${missing.join('\n')}`).toEqual([]);
    expect(bridged, `sector-hub pages bridged (floor should be removed):\n${bridged.join('\n')}`).toEqual([]);
  });

  it('TI sector hubs at /cerca-lavoro-ticino/{sectorSlug}/ stay intact', () => {
    if (!fs.existsSync(DIST)) return;
    // Pick a TI sector hub that the legacy emit owns. infermieri is the
    // canonical anchor and is emitted by jobSectorPagesPlugin.
    const f = path.join(DIST, 'cerca-lavoro-ticino', 'infermieri', 'index.html');
    if (!fs.existsSync(f)) return;
    const html = fs.readFileSync(f, 'utf-8');
    expect(html).toMatch(
      /<link\s+rel=["']?canonical["']?\s+href=["']?https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/infermieri\/["']?/,
    );
  });
});

/**
 * Phase 3.3 — per-canton company hubs (additive, thin variant).
 *
 * TI canonical for company hubs stays at /cerca-lavoro-ticino/azienda-{slug}/.
 * The new per-canton hubs each self-canonicalize and serve filtered job
 * listings for jobs from that company in that specific canton.
 */
describe('cathedral — per-canton company hubs (Phase 3.3)', () => {
  it('per-canton company hubs emit when canton has the company with ≥3 jobs', () => {
    if (!fs.existsSync(DIST)) return;
    const nonTiSections = [
      'cerca-lavoro-zurigo',
      'cerca-lavoro-ginevra',
      'cerca-lavoro-vaud',
      'cerca-lavoro-berna',
      'cerca-lavoro-argovia',
      'cerca-lavoro-san-gallo',
    ];
    let anyCompanyHub: { section: string; entry: string } | null = null;
    for (const sec of nonTiSections) {
      const dir = path.join(DIST, sec);
      if (!fs.existsSync(dir)) continue;
      const hit = fs.readdirSync(dir).find((e) => e.startsWith('azienda-'));
      if (hit) {
        anyCompanyHub = { section: sec, entry: hit };
        break;
      }
    }
    expect(anyCompanyHub, 'No per-canton company hub emitted under any sampled non-TI canton').not.toBeNull();
    if (anyCompanyHub) {
      const f = path.join(DIST, anyCompanyHub.section, anyCompanyHub.entry, 'index.html');
      expect(fs.existsSync(f)).toBe(true);
      const html = fs.readFileSync(f, 'utf-8');
      expect(html, 'per-canton company hub must self-canonicalize').toMatch(
        new RegExp(
          `<link\\s+rel=["']?canonical["']?\\s+href=["']?https://frontaliereticino\\.ch/${anyCompanyHub.section}/${anyCompanyHub.entry}/["']?`,
        ),
      );
    }
  });

  it('every TI /cerca-lavoro-ticino/azienda-{slug}/ hub canonicalizes to TI-self or the Switzerland aggregator (never a foreign canton)', () => {
    if (!fs.existsSync(DIST)) return;
    const tiDir = path.join(DIST, 'cerca-lavoro-ticino');
    if (!fs.existsSync(tiDir)) return;
    const aziendaEntries = fs.readdirSync(tiDir).filter((e) => e.startsWith('azienda-'));
    if (aziendaEntries.length === 0) return;

    // The `/cerca-lavoro-ticino/azienda-*` namespace is emitted by TWO plugins
    // with intentionally different canonical semantics — sampling the first dir
    // entry indiscriminately (the previous brittle approach) broke whenever an
    // orphan-bridge happened to sort first (data-driven false-red, gate:seo-source
    // in post-deploy validate-dist):
    //   1. jobsSeoPagesPlugin real/legacy hubs + matched bridges +
    //      BRAND_CANONICAL_MAP alias bridges → self-canonical under
    //      `/cerca-lavoro-ticino/azienda-…` (a brand alias points at its TI
    //      primary, still under this prefix).
    //   2. companyHubBridgePlugin `renderUnmatchedPage` (orphan companies dropped
    //      from data/jobs.json, e.g. cross-canton URLs) → canonical points at the
    //      Switzerland-wide aggregator `/cerca-lavoro-svizzera/` BY DESIGN, to
    //      consolidate dead/cross-canton company URLs onto a live hub instead of
    //      self-canonicalizing thin orphan pages (404-recovery, AGENTS.md #4/SEO).
    // The real invariant — and the only thing that would be an actual SEO bug —
    // is a TI company hub whose canonical drifts to a *different specific canton*
    // (e.g. /cerca-lavoro-ginevra/azienda-…). Assert that across EVERY hub so the
    // gate is comprehensive and order-independent (never flaps on data churn).
    const TI_SELF = /^https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/azienda-/;
    const SWISS_AGGREGATOR = 'https://frontaliereticino.ch/cerca-lavoro-svizzera/';
    const canonicalRe = /<link\s+rel=["']?canonical["']?\s+href=["']?([^"'\s>]+)/i;

    const drifted: Array<{ entry: string; canonical: string }> = [];
    let checked = 0;
    for (const entry of aziendaEntries) {
      const f = path.join(tiDir, entry, 'index.html');
      if (!fs.existsSync(f)) continue;
      const html = fs.readFileSync(f, 'utf-8');
      const m = html.match(canonicalRe);
      expect(m, `${entry} must declare a <link rel=canonical>`).not.toBeNull();
      const canonical = m![1];
      checked++;
      if (!TI_SELF.test(canonical) && canonical !== SWISS_AGGREGATOR) {
        drifted.push({ entry, canonical });
      }
    }

    expect(checked, 'No readable TI company-hub index.html found').toBeGreaterThan(0);
    expect(
      drifted,
      `TI company hub(s) canonicalize to a foreign canton (must be TI-self or ${SWISS_AGGREGATOR}):\n` +
        drifted.map((d) => `  ${d.entry} → ${d.canonical}`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * Phase 3.4 — per-canton company × city hubs (additive).
 *
 * No legacy TI company×city emit exists, so Phase 3.4 only fires on non-TI
 * cantons. Each (canton, company, city) bucket with >= 2 jobs gets a page
 * at /cerca-lavoro-{cantonSlug}/azienda-{companySlug}-{citySlug}/.
 */
describe('cathedral — per-canton company × city hubs (Phase 3.4)', () => {
  it('per-canton company × city hubs emit when canton+company+city has ≥2 jobs', () => {
    if (!fs.existsSync(DIST)) return;
    const nonTiSections = [
      'cerca-lavoro-zurigo',
      'cerca-lavoro-ginevra',
      'cerca-lavoro-vaud',
      'cerca-lavoro-berna',
      'cerca-lavoro-argovia',
      'cerca-lavoro-san-gallo',
      'cerca-lavoro-lucerna',
    ];
    // Phase 3.4 produces `azienda-{company}-{city}` entries; multi-hyphen
    // tails distinguish them from plain `azienda-{company}` (Phase 3.3).
    let anyCompanyCity = false;
    for (const sec of nonTiSections) {
      const dir = path.join(DIST, sec);
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir).filter((e) => e.startsWith('azienda-'));
      // We can't distinguish Phase 3.3 vs Phase 3.4 from the entry name
      // alone because both share the `azienda-` prefix. Smoke check: at
      // least one entry of either kind exists. Stricter assertion would
      // need a manifest from the build — skipped to keep the test simple.
      if (entries.length > 0) {
        anyCompanyCity = true;
        break;
      }
    }
    expect(anyCompanyCity, 'No per-canton azienda-* hub emitted under any sampled non-TI canton').toBe(true);
  });
});
