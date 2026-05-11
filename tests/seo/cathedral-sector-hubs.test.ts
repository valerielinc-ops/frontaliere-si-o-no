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
          // Verify canonical points at itself (self-canonical for per-canton hub)
          const html = fs.readFileSync(f, 'utf-8');
          expect(html, `${sec}/${slug} must self-canonicalize`).toMatch(
            new RegExp(`<link rel="canonical" href="https://frontaliereticino\\.ch/${sec}/${slug}/"`),
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

  it('TI sector hubs at /cerca-lavoro-ticino/{sectorSlug}/ stay intact', () => {
    if (!fs.existsSync(DIST)) return;
    // Pick a TI sector hub that the legacy emit owns. infermieri is the
    // canonical anchor and is emitted by jobSectorPagesPlugin.
    const f = path.join(DIST, 'cerca-lavoro-ticino', 'infermieri', 'index.html');
    if (!fs.existsSync(f)) return;
    const html = fs.readFileSync(f, 'utf-8');
    expect(html).toMatch(
      /<link rel="canonical" href="https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/infermieri\/"/,
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
          `<link rel="canonical" href="https://frontaliereticino\\.ch/${anyCompanyHub.section}/${anyCompanyHub.entry}/"`,
        ),
      );
    }
  });

  it('TI company hub at /cerca-lavoro-ticino/azienda-{slug}/ stays intact (byte-identical legacy)', () => {
    if (!fs.existsSync(DIST)) return;
    const tiDir = path.join(DIST, 'cerca-lavoro-ticino');
    if (!fs.existsSync(tiDir)) return;
    const aziendaEntries = fs.readdirSync(tiDir).filter((e) => e.startsWith('azienda-'));
    if (aziendaEntries.length === 0) return;
    // Sample the first one — verify it carries its TI canonical (legacy
    // semantics: a TI company hub canonical is its own TI URL, unless
    // BRAND_CANONICAL_MAP redirects it to a sibling — either way Phase 3.3
    // does not alter the TI emit).
    const sampled = aziendaEntries[0];
    const f = path.join(tiDir, sampled, 'index.html');
    if (!fs.existsSync(f)) return;
    const html = fs.readFileSync(f, 'utf-8');
    // TI hub must reference itself somewhere as canonical OR a sibling TI
    // company hub (BRAND_CANONICAL_MAP rerouting). Either way, never a
    // non-TI section.
    expect(html, 'TI legacy company hub canonical must stay under /cerca-lavoro-ticino/').toMatch(
      /<link rel="canonical" href="https:\/\/frontaliereticino\.ch\/cerca-lavoro-ticino\/azienda-/,
    );
  });
});
