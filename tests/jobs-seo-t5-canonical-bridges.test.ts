import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  renderAvailableJobCategoryLinks,
  renderJobsSeoEditorialBelowFloorBridge,
} from '../build-plugins/jobsSeoPagesPlugin';
import { REDIRECT_STUB_MARKER } from '../build-plugins/shared/redirectStubMarker.mjs';
import {
  classifyDocument,
  FRONTIER_SCOPE,
  SITEMAP_SCOPE,
} from '../scripts/seo/bing-site-explorer-crawl.mjs';

// This renderer imports a data snapshot omitted by sparse worktrees; the
// commuter-context block is unrelated to these canonical contracts.
vi.mock('../build-plugins/shared/companyHubFrontalierContext', () => ({
  renderCompanyHubFrontalierContext: () => '',
}));

const BASE = 'https://frontaliereticino.ch';
const SOURCE = `${BASE}/cerca-lavoro-appenzello/case-anziani-appenzello/`;
const CANTON_HUB = `${BASE}/cerca-lavoro-appenzello/`;
const DESCRIPTION = 'Pagina aggiornata con informazioni verificate sulle opportunità di lavoro e sui servizi per i lavoratori frontalieri in Svizzera.';

function codes(url: string, html: string, scope = FRONTIER_SCOPE) {
  return classifyDocument({
    url,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    html,
    scope,
  }).findings.map(({ code }) => code);
}

function noindexHtml(canonicalUrl: string, marker = '') {
  return `<!doctype html><html><head>${marker}<title>Pagina aggiornata</title><meta name="description" content="${DESCRIPTION}"><meta name="robots" content="noindex,follow"><link rel="canonical" href="${canonicalUrl}"></head><body><h1>Pagina aggiornata</h1></body></html>`;
}

describe('T5 job-board canonical bridges', () => {
  it('renders a below-floor editorial bridge with a self-canonical and a live hub CTA', () => {
    const html = renderJobsSeoEditorialBelowFloorBridge({
      canonicalUrl: SOURCE,
      pathLabel: CANTON_HUB,
      lang: 'it',
      noindex: true,
      title: 'Case anziani Appenzello',
      description: DESCRIPTION,
    });

    expect(html).toContain(REDIRECT_STUB_MARKER);
    expect(html).toContain(`<link rel="canonical" href="${SOURCE}">`);
    expect(html).toContain('<meta name="robots" content="noindex,follow">');
    expect(html).toContain(`href="${CANTON_HUB}"`);
    expect(codes(SOURCE, html)).not.toContain('frontier-canonical-drift');
  });

  it('does not treat REDIRECT_STUB alone as a canonical exemption', () => {
    const html = noindexHtml(CANTON_HUB, REDIRECT_STUB_MARKER);
    const findings = codes(SOURCE, html);

    expect(findings).toContain('frontier-noindex');
    expect(findings).toContain('frontier-canonical-drift');
    expect(findings).not.toContain('frontier-canonical-expected');
  });

  it('keeps an undeclared cross-canton category canonical actionable in both scopes', () => {
    const url = `${BASE}/cerca-lavoro-appenzello/categoria-informatica/`;
    const canonical = `${BASE}/cerca-lavoro-ticino/categoria-informatica/`;
    const html = noindexHtml(canonical, REDIRECT_STUB_MARKER);

    expect(codes(url, html)).toContain('frontier-canonical-drift');
    expect(codes(url, html, SITEMAP_SCOPE)).toContain('canonical-drift');
  });

  it('links category neighbors only when their source count meets the renderer floor', () => {
    const links = renderAvailableJobCategoryLinks({
      categoryKeys: ['health', 'tech', 'other'],
      currentCategoryKey: 'other',
      minimumJobCount: 3,
      countFor: (key) => ({ health: 3, tech: 2, other: 8 } as Record<string, number>)[key] ?? 0,
      hrefFor: (key) => `/cerca-lavoro-appenzello/categoria-${key}/`,
      labelFor: (key) => key,
    });

    expect(links).toEqual(['<a class="s-gcEaMI" href="/cerca-lavoro-appenzello/categoria-health/">health</a>']);
  });

  it('wires source-counted category navs and preserves canonical, hreflang, and sitemap output', () => {
    const source = readFileSync(new URL('../build-plugins/jobsSeoPagesPlugin.ts', import.meta.url), 'utf8');
    const navOffsets = [...source.matchAll(/const catOtherLinks = renderAvailableJobCategoryLinks\(\{/g)].map((match) => match.index ?? -1);
    const editorialStart = source.indexOf('const emitEditorialBelowFloorBridge = ');
    const editorialEmitter = source.slice(editorialStart, editorialStart + 900);

    expect(navOffsets).toHaveLength(2);
    expect(source).toContain('const MIN_JOBS_PER_CATEGORY = 3;');
    expect(source).toContain('if (catJobs.length < MIN_JOBS_PER_CATEGORY) continue;');
    expect(source).toContain('countFor: (key) => globalCategoryJobCounts.get(key) ?? 0');
    expect(source).toContain('countFor: (key) => byCat.get(key)?.length ?? 0');
    expect(editorialEmitter).toContain('canonicalUrl: `${BASE_URL}${canonicalPath}`');
    expect(editorialEmitter).toContain('pathLabel: targetPath');
    expect(source).toContain('canonicalUrl: catCanonicalUrl');
    expect(source).toContain('hreflangHtml: catAlternates');
    expect(source).toContain('categorySitemapEntries.push(');
  });
});
