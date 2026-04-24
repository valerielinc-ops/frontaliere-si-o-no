/**
 * Duplicate-body content tests.
 *
 * Exercises the per-entity distinguishing content injected into two high-page-
 * count build plugins — `orphanQueryLandingPlugin` and `fuelDailyPagesPlugin`'s
 * per-station renderer — so that near-duplicate source data never collapses
 * into identical body HTML.
 *
 * We call the pure functions directly (no `dist/` build). Tests also cover
 * the audit script's body-extraction helper.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildClusterSignalsParagraph,
} from '../../build-plugins/orphanQueryLandingPlugin';
import type {
  OrphanQueryCluster,
  OrphanLandingLocale,
} from '../../build-plugins/orphanQueryData';
import {
  buildStationSignaturePargaraph,
  type StationSignatureInput,
} from '../../build-plugins/fuelDailyPagesPlugin';
// The audit script is authored as a .mjs module with JSDoc types — importing
// the named exports works through Vite/vitest's bundler resolution but is
// untyped at TS level, so we cast via `unknown` to keep strict mode happy.
import * as auditModule from '../../scripts/audit-content-duplicates.mjs';

const { extractBodyText, inferLocale } = auditModule as unknown as {
  extractBodyText: (html: string) => string;
  inferLocale: (relPath: string) => 'it' | 'en' | 'de' | 'fr';
};

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hashOf(text: string): string {
  return createHash('sha256').update(normalize(text), 'utf-8').digest('hex');
}

describe('Orphan-query cluster signals paragraph', () => {
  const baseCluster = (overrides: Partial<OrphanQueryCluster>): OrphanQueryCluster => ({
    clusterId: 'c',
    locale: 'it',
    canonicalQuery: 'lavoro generico ticino',
    canonicalSlug: 'lavoro-generico-ticino',
    roleTokens: [],
    regionTokens: [],
    totalImpressions: 0,
    totalClicks: 0,
    queries: [{ query: 'lavoro generico ticino', clicks: 0, impressions: 0 }],
    ...overrides,
  });

  it('produces 10 distinct paragraphs for 10 different clusters in the same locale', () => {
    const clusters: OrphanQueryCluster[] = [
      baseCluster({ canonicalQuery: 'infermiere mendrisio', canonicalSlug: 'infermiere-mendrisio', roleTokens: ['infermiere', 'nurse'], regionTokens: ['mendrisio'] }),
      baseCluster({ canonicalQuery: 'cameriere lugano', canonicalSlug: 'cameriere-lugano', roleTokens: ['cameriere'], regionTokens: ['lugano'] }),
      baseCluster({ canonicalQuery: 'autista chiasso', canonicalSlug: 'autista-chiasso', roleTokens: ['autista'], regionTokens: ['chiasso'] }),
      baseCluster({ canonicalQuery: 'operaio bellinzona', canonicalSlug: 'operaio-bellinzona', roleTokens: ['operaio', 'magazziniere'], regionTokens: ['bellinzona'] }),
      baseCluster({ canonicalQuery: 'commessa locarno', canonicalSlug: 'commessa-locarno', roleTokens: ['commessa'], regionTokens: ['locarno'] }),
      baseCluster({ canonicalQuery: 'receptionist hotel ticino', canonicalSlug: 'receptionist-hotel-ticino', roleTokens: ['receptionist'], regionTokens: [] }),
      baseCluster({ canonicalQuery: 'segretaria medica', canonicalSlug: 'segretaria-medica', roleTokens: ['segretaria'], regionTokens: [] }),
      baseCluster({ canonicalQuery: 'addetto pulizie', canonicalSlug: 'addetto-pulizie', roleTokens: ['addetto', 'pulizie'], regionTokens: [] }),
      baseCluster({ canonicalQuery: 'muratore chiasso', canonicalSlug: 'muratore-chiasso', roleTokens: ['muratore'], regionTokens: ['chiasso'] }),
      baseCluster({ canonicalQuery: 'panettiere mendrisio', canonicalSlug: 'panettiere-mendrisio', roleTokens: ['panettiere'], regionTokens: ['mendrisio'] }),
    ];

    const paragraphs = clusters.map((c) => buildClusterSignalsParagraph(c, 'it'));
    const hashes = new Set(paragraphs.map(hashOf));
    expect(hashes.size).toBe(10);
  });

  it('produces distinct paragraphs even when roleTokens+regionTokens collapse to empty', () => {
    const clusters = [
      baseCluster({ canonicalQuery: 'query alpha ticino', canonicalSlug: 'query-alpha', queries: [{ query: 'query alpha ticino', clicks: 1, impressions: 100 }, { query: 'alpha job', clicks: 0, impressions: 20 }] }),
      baseCluster({ canonicalQuery: 'query beta ticino', canonicalSlug: 'query-beta', queries: [{ query: 'query beta ticino', clicks: 0, impressions: 80 }, { query: 'beta position', clicks: 0, impressions: 10 }] }),
      baseCluster({ canonicalQuery: 'query gamma ticino', canonicalSlug: 'query-gamma', queries: [{ query: 'query gamma ticino', clicks: 0, impressions: 60 }] }),
      baseCluster({ canonicalQuery: 'query delta ticino', canonicalSlug: 'query-delta', queries: [{ query: 'query delta ticino', clicks: 0, impressions: 40 }] }),
      baseCluster({ canonicalQuery: 'query epsilon ticino', canonicalSlug: 'query-epsilon', queries: [{ query: 'query epsilon ticino', clicks: 0, impressions: 20 }] }),
    ];
    const paragraphs = clusters.map((c) => buildClusterSignalsParagraph(c, 'it'));
    const hashes = new Set(paragraphs.map(hashOf));
    expect(hashes.size).toBe(clusters.length);
  });

  it('emits a distinct paragraph in every locale for the same cluster', () => {
    const cluster = baseCluster({
      canonicalQuery: 'infermiere mendrisio',
      canonicalSlug: 'infermiere-mendrisio',
      roleTokens: ['infermiere', 'nurse'],
      regionTokens: ['mendrisio'],
    });
    const locales: OrphanLandingLocale[] = ['it', 'en', 'de', 'fr'];
    const paragraphs = locales.map((l) => buildClusterSignalsParagraph(cluster, l));
    const hashes = new Set(paragraphs.map(hashOf));
    // Different locale = different natural-language text.
    expect(hashes.size).toBe(4);
  });

  it('every paragraph contains the canonical query (capitalised)', () => {
    const cluster = baseCluster({ canonicalQuery: 'operatore socio sanitario', canonicalSlug: 'oss' });
    for (const loc of ['it', 'en', 'de', 'fr'] as OrphanLandingLocale[]) {
      const p = buildClusterSignalsParagraph(cluster, loc);
      expect(p).toContain('Operatore socio sanitario');
      expect(p.length).toBeGreaterThan(40);
    }
  });
});

describe('Fuel per-station signature paragraph', () => {
  const baseInput = (overrides: Partial<StationSignatureInput>): StationSignatureInput => ({
    locale: 'it',
    brand: 'Agip',
    street: 'Via Generica 1',
    city: 'Chiasso',
    zone: 'Mendrisiotto',
    fuelLabel: 'Diesel',
    priceFmt: '1,789',
    zoneAvgFmt: '1,810',
    rankIndex: 3,
    total: 20,
    station: { id: 'agip-gen-1', address: 'Via Generica 1, 6830 Chiasso', updatedAt: '2026-04-24T06:00:00Z', lat: 45.8350, lng: 9.0300 },
    slug: 'agip-via-generica-1-chiasso',
    ...overrides,
  });

  it('produces 10 distinct paragraphs for 10 stations sharing (brand, city, zone, fuel)', () => {
    const stations: StationSignatureInput[] = Array.from({ length: 10 }, (_, i) => baseInput({
      street: `Via Esempio ${i + 1}`,
      priceFmt: `1,${700 + i * 3}`,
      rankIndex: i,
      station: {
        id: `agip-esempio-${i + 1}`,
        address: `Via Esempio ${i + 1}, 6830 Chiasso`,
        updatedAt: `2026-04-2${(i % 9) + 1}T06:00:00Z`,
        lat: 45.8350 + i * 0.001,
        lng: 9.0300 + i * 0.001,
      },
      slug: `agip-via-esempio-${i + 1}-chiasso`,
    }));
    const paragraphs = stations.map(buildStationSignaturePargaraph);
    const hashes = new Set(paragraphs.map(hashOf));
    expect(hashes.size).toBe(10);
  });

  it('produces distinct paragraphs even when coordinates + updatedAt are missing', () => {
    const stations: StationSignatureInput[] = Array.from({ length: 6 }, (_, i) => baseInput({
      street: `Via Vuota ${i + 1}`,
      rankIndex: i,
      station: { id: `empty-${i}`, address: `Via Vuota ${i + 1}, 6830 Chiasso` },
      slug: `empty-via-vuota-${i + 1}-chiasso`,
    }));
    const paragraphs = stations.map(buildStationSignaturePargaraph);
    const hashes = new Set(paragraphs.map(hashOf));
    expect(hashes.size).toBe(6);
  });

  it('emits a distinct paragraph for every locale with the same station', () => {
    const station = baseInput({});
    const locales = ['it', 'en', 'de', 'fr'] as const;
    const paragraphs = locales.map((loc) => buildStationSignaturePargaraph({ ...station, locale: loc }));
    const hashes = new Set(paragraphs.map(hashOf));
    expect(hashes.size).toBe(4);
  });
});

describe('audit-content-duplicates body extractor', () => {
  it('strips <script>, <style> and <head>, keeps visible body text', () => {
    const html = `<!doctype html><html><head><title>x</title><meta name="robots" content="index"></head><body>
      <script>var x=1</script>
      <style>.a{color:red}</style>
      <main><h1>Unique body text XYZ</h1><p>Secondary sentence here.</p></main>
    </body></html>`;
    const body = extractBodyText(html);
    expect(body).toContain('Unique body text XYZ');
    expect(body).toContain('Secondary sentence here');
    expect(body).not.toContain('var x=1');
    expect(body).not.toContain('color:red');
    expect(body).not.toContain('<title>');
  });

  it('infers locale from dist-relative path prefix', () => {
    expect(inferLocale('en/foo/index.html')).toBe('en');
    expect(inferLocale('de/jobs/index.html')).toBe('de');
    expect(inferLocale('fr/emploi.html')).toBe('fr');
    expect(inferLocale('cerca-lavoro-ticino/index.html')).toBe('it');
    expect(inferLocale('index.html')).toBe('it');
  });

  it('extractBodyText yields different hashes for pages whose main content differs', () => {
    const mk = (body: string) => `<!doctype html><html><head><title>t</title></head><body><main>${body}</main></body></html>`;
    const a = extractBodyText(mk('<h1>Station Agip Chiasso</h1><p>Price 1.789</p>'));
    const b = extractBodyText(mk('<h1>Station Shell Mendrisio</h1><p>Price 1.810</p>'));
    expect(hashOf(a)).not.toBe(hashOf(b));
  });

  it('extractBodyText yields identical hash for the same visible body even if scripts differ', () => {
    const mk = (script: string) =>
      `<!doctype html><html><head></head><body><script>${script}</script><main><h1>Same body</h1><p>Identical paragraph.</p></main></body></html>`;
    const a = extractBodyText(mk('var a=1'));
    const b = extractBodyText(mk('var b=2;console.log("x")'));
    expect(hashOf(a)).toBe(hashOf(b));
  });
});
