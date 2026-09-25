/**
 * Self-map coverage for the ITALIAN border-municipality family
 * (borderMunicipalityPagesPlugin.ts + borderMunicipalityData.ts).
 *
 * The four foreign families each self-map every emitted URL in
 * searchConsoleCompat.ts. The Italian family — the largest of the five — did
 * not, so its comuni matched the `^/vivere-in-ticino/` SECTION_FALLBACK (and
 * the /en/living-in-ticino/, /de/leben-im-tessin/, /fr/vivre-au-tessin/
 * twins) and resolved to the section HUB instead of to themselves.
 *
 * Two things are pinned here, because either alone would let the bug back:
 *   1. the compat resolver returns each emitted path unchanged (self-map),
 *      rather than folding it into the hub;
 *   2. the path set the resolver consults is the one the plugin actually
 *      emits — same base paths, same slug function. A self-map that agrees
 *      with itself but not with the emitter is worse than none.
 */
import { describe, it, expect } from 'vitest';

import {
  BORDER_MUNICIPALITY_BASE_PATH,
  BORDER_MUNICIPALITY_HUB_PATH,
  BORDER_MUNICIPALITY_LOCALES,
  borderMunicipalityPathFor,
  corridorMunicipalities,
  isBorderMunicipalityHubPath,
  isBorderMunicipalityPath,
  slugifyMunicipalityName,
} from '@/build-plugins/borderMunicipalityData';
import { resolveSearchConsoleCompatTarget } from '@/build-plugins/searchConsoleCompat';
import { TICINO_VITA_CORRIDOR_PROVINCES } from '@/build-plugins/shared/borderMunicipalityCorridors';

const MUNICIPALITIES = corridorMunicipalities();

describe('Italian border-municipality corridor set', () => {
  it('covers the Ticino corridor provinces and nothing else', () => {
    expect(MUNICIPALITIES.length).toBeGreaterThan(100);
    const provinces = new Set(MUNICIPALITIES.map((m) => m.province));
    for (const p of provinces) expect(TICINO_VITA_CORRIDOR_PROVINCES.has(p)).toBe(true);
  });

  it('emits all four site locales', () => {
    expect([...BORDER_MUNICIPALITY_LOCALES].sort()).toEqual(['de', 'en', 'fr', 'it']);
    expect(Object.keys(BORDER_MUNICIPALITY_BASE_PATH).sort()).toEqual(['de', 'en', 'fr', 'it']);
  });

  it('produces no slug collisions (a collision would drop a comune silently)', () => {
    const bySlug = new Map<string, string[]>();
    for (const m of MUNICIPALITIES) {
      const slug = slugifyMunicipalityName(m.name);
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), `${m.name} (${m.province})`]);
    }
    const collisions = [...bySlug.entries()].filter(([, names]) => names.length > 1);
    expect(collisions).toEqual([]);
  });
});

describe('searchConsoleCompat self-maps every emitted Italian border-municipality path', () => {
  it('returns each comune path unchanged instead of collapsing it to the hub', () => {
    const collapsed: string[] = [];
    for (const m of MUNICIPALITIES) {
      for (const locale of BORDER_MUNICIPALITY_LOCALES) {
        const path = borderMunicipalityPathFor(locale, m.name);
        const resolved = resolveSearchConsoleCompatTarget(path);
        if (resolved?.canonicalPath !== path) {
          collapsed.push(`${path} → ${resolved?.canonicalPath ?? 'null'}`);
        }
      }
    }
    expect(collapsed.slice(0, 5)).toEqual([]);
  });

  it('self-maps the hub in every locale too', () => {
    for (const locale of BORDER_MUNICIPALITY_LOCALES) {
      const hub = BORDER_MUNICIPALITY_HUB_PATH[locale];
      expect(isBorderMunicipalityHubPath(hub)).toBe(true);
      expect(resolveSearchConsoleCompatTarget(hub)?.canonicalPath).toBe(hub);
    }
  });

  it('still lets a genuinely unknown /vivere-in-ticino/ URL fall back to the hub', () => {
    // The fallback is correct for dead section URLs — the self-map must not
    // have swallowed it, or real 404s would stop being bridged.
    const dead = '/vivere-in-ticino/questa-pagina-non-esiste-davvero/';
    expect(isBorderMunicipalityPath(dead)).toBe(false);
    expect(resolveSearchConsoleCompatTarget(dead)?.canonicalPath).toBe('/vivere-in-ticino/');
  });

  it('recognises paths regardless of query string, hash or missing trailing slash', () => {
    const base = borderMunicipalityPathFor('it', MUNICIPALITIES[0].name);
    const noSlash = base.replace(/\/$/, '');
    expect(isBorderMunicipalityPath(noSlash)).toBe(true);
    expect(isBorderMunicipalityPath(`${base}?utm_source=x`)).toBe(true);
    expect(isBorderMunicipalityPath(`${base}#top`)).toBe(true);
  });

  it('is not shrunk by BORDER_MUNICIPALITY_PAGE_LIMIT', () => {
    // The limit truncates the plugin's emit list in dev/CI. If the compat set
    // were derived from it, the self-map would vanish for every truncated
    // comune exactly when a limited build runs.
    const previous = process.env.BORDER_MUNICIPALITY_PAGE_LIMIT;
    process.env.BORDER_MUNICIPALITY_PAGE_LIMIT = '3';
    try {
      expect(corridorMunicipalities().length).toBe(MUNICIPALITIES.length);
      const last = MUNICIPALITIES[MUNICIPALITIES.length - 1];
      expect(isBorderMunicipalityPath(borderMunicipalityPathFor('it', last.name))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BORDER_MUNICIPALITY_PAGE_LIMIT;
      else process.env.BORDER_MUNICIPALITY_PAGE_LIMIT = previous;
    }
  });
});
