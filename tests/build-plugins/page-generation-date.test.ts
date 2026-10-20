import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { __renderOrphanLandingPage } from '../../build-plugins/orphanQueryLandingPlugin';

describe('generated page dates', () => {
  it.each([
    ['it', 'Pagina generata', 'Aggiornato'],
    ['en', 'Page generated', 'Updated'],
    ['de', 'Seite erstellt', 'Aktualisiert'],
    ['fr', 'Page générée', 'Mis à jour'],
  ] as const)('distinguishes generation from content freshness in %s', (locale, generated, updated) => {
    const dateStamp = new Date().toISOString().slice(0, 10);
    const page = __renderOrphanLandingPage({
      cluster: { clusterId: 'generation', locale, canonicalQuery: 'infermiere Lugano', canonicalSlug: 'generation', roleTokens: [], regionTokens: [], totalImpressions: 20, totalClicks: 0, queries: [] },
      matchingJobs: [], strings: { 'orphanLanding.updatedLabel': updated }, dateStamp, knownSlugsByLocale: new Map(),
    });
    const dom = new JSDOM(page.html);
    const header = dom.window.document.querySelector('main h1')?.closest('header')?.textContent || '';
    expect(header).toContain(generated);
    expect(header).not.toContain(updated);
    expect(header).toContain(dateStamp.slice(0, 4));
    dom.window.close();
  });
});
