// The gate behind these helpers was verified once, by aiming it at a live
// defect: it named the six articles a browser was dropping. Then production
// healed and that check stopped being reproducible — a gate whose correctness
// cannot be re-established on demand decays into decoration. These pin the
// three decisions that actually decide its verdict.
import { describe, it, expect } from 'vitest';
import {
  renderedSlugs, idsInRegistryChunk, missingFromClient, divergentSurfaces,
} from '../scripts/lib/hydratedParity.mjs';

const card = (href: string) =>
  `<a href="${href}" aria-label="x" class="ssg-art-card"><h3>t</h3></a>`;

describe('renderedSlugs — only the grid, and only its cards', () => {
  const hub = '/articoli-frontaliere/';

  it('reads the cards the SSG wrote', () => {
    const html = `<div class="ssg-article-grid">${card('/articoli-frontaliere/uno-due-tre/')}${card('/articoli-frontaliere/quattro-cinque/')}</div>`;
    expect(renderedSlugs(html, hub).sort()).toEqual(['quattro-cinque', 'uno-due-tre']);
  });

  it('ignores article links outside a card — nav, footer, related rails', () => {
    const html = `<div class="ssg-article-grid">${card('/articoli-frontaliere/in-griglia/')}</div>`
      + '<a href="/articoli-frontaliere/nel-footer/">altro</a>';
    expect(renderedSlugs(html, hub)).toEqual(['in-griglia']);
  });

  it('does not care about attribute order', () => {
    const html = '<div class="ssg-article-grid"><a class="ssg-art-card" data-x="1" href="/articoli-frontaliere/ordine-diverso/">t</a></div>';
    expect(renderedSlugs(html, hub)).toEqual(['ordine-diverso']);
  });

  it('returns nothing when the grid is absent, so the caller can hard-fail', () => {
    // An empty set must never read as "nothing to compare, all good".
    expect(renderedSlugs('<html><body>no grid</body></html>', hub)).toEqual([]);
  });

  it('is locale-aware through the hub path', () => {
    const html = `<div class="ssg-article-grid">${card('/de/schweiz-artikel/ein-artikel-hier/')}</div>`;
    expect(renderedSlugs(html, '/de/schweiz-artikel/')).toEqual(['ein-artikel-hier']);
    expect(renderedSlugs(html, '/articoli-frontaliere/')).toEqual([]);
  });
});

describe('idsInRegistryChunk — ids out of minified JS', () => {
  it('reads every entry the bundler emitted', () => {
    const chunk = 'const u=[{id:"primo-articolo",category:"fiscale"},{id:"secondo",date:"2026"}];';
    expect([...idsInRegistryChunk(chunk)].sort()).toEqual(['primo-articolo', 'secondo']);
  });

  it('is total on junk', () => {
    expect(idsInRegistryChunk('').size).toBe(0);
    expect(idsInRegistryChunk(undefined as unknown as string).size).toBe(0);
  });
});

describe('missingFromClient — compares ids, never slugs', () => {
  // The trap this encodes: the URL slug and the registry id are different
  // strings on most evergreen articles and on every non-Italian URL. Comparing
  // them directly reports a healthy corpus as broken, which is exactly what
  // sent an earlier investigation after the wrong cause.
  const reverse = { 'stipendio-netto-frontaliere-2026': 'stipendio-netto-2026' };

  it('resolves the slug to its id before deciding', () => {
    const client = new Set(['stipendio-netto-2026']);
    expect(missingFromClient(['stipendio-netto-frontaliere-2026'], reverse, client)).toEqual([]);
  });

  it('reports the article when the client really lacks it, naming both', () => {
    const out = missingFromClient(['stipendio-netto-frontaliere-2026'], reverse, new Set());
    expect(out).toEqual(['stipendio-netto-frontaliere-2026 (id: stipendio-netto-2026)']);
  });

  it('treats an id-shaped URL as its own id', () => {
    expect(missingFromClient(['caso-delmastro-protesta-avs'], {}, new Set(['caso-delmastro-protesta-avs']))).toEqual([]);
    expect(missingFromClient(['caso-delmastro-protesta-avs'], {}, new Set())).toEqual(['caso-delmastro-protesta-avs']);
  });
});

describe('divergentSurfaces — the edge answering two ways', () => {
  it('flags a surface whose Origin copy is older than its bare copy', () => {
    const out = divergentSurfaces({
      'https://cdn/assets/App.js': {
        withOrigin: 'Wed, 05 Aug 2026 20:48:17 GMT',
        withoutOrigin: 'Thu, 06 Aug 2026 06:23:27 GMT',
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].url).toContain('App.js');
  });

  it('says nothing when the two agree', () => {
    expect(divergentSurfaces({ u: { withOrigin: 'X', withoutOrigin: 'X' } })).toEqual([]);
  });

  it('does not invent divergence from a missing reading', () => {
    // A surface with no Last-Modified must not read as a mismatch.
    expect(divergentSurfaces({ u: { withOrigin: null, withoutOrigin: 'X' } })).toEqual([]);
    expect(divergentSurfaces({})).toEqual([]);
  });
});
