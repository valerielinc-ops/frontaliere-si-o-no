/**
 * Residuo di `audit:max-bfs-depth` su sitemap-jobs.xml (build f3659686):
 * `/{cantone}/aziende/` linkava `azienda-{employerKey}` dallo snapshot
 * settimanale: a Zurigo 28 link su 100 finivano su bridge noindex e 26 su
 * pagine inesistenti, con il prefisso italiano anche in en/de/fr. Ora linka gli
 * hub che jobsSeoPagesPlugin emette davvero
 * (build-plugins/shared/cantonCompanyHubRegistry.ts).
 *
 * L'archivio `tutti/page-N/` resta costruito dal solo snapshot storico, per
 * scelta della #10753 («The archive emitter consumes its historical snapshot,
 * independently of current listing counts», pinnato da
 * tests/build-plugins/job-board-hub-output.test.ts): le schede nuove non
 * ancora nello snapshot restano un residuo della issue non bloccante.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  _resetCantonCompanyHubRegistry,
  cantonCompanyHubs,
  markCantonCompanyHub,
} from '../build-plugins/shared/cantonCompanyHubRegistry';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

afterEach(() => {
  _resetCantonCompanyHubRegistry();
});

describe('registro degli hub azienda per cantone', () => {
  it('restituisce gli hub emessi, i più grandi per primi', () => {
    markCantonCompanyHub('ZH', { slug: 'stadler-rail', name: 'Stadler Rail', jobs: 12, logoKey: 'stadler' });
    markCantonCompanyHub('ZH', { slug: 'migros-hq-zurich', name: 'Migros HQ', jobs: 31, logoKey: 'migros' });
    markCantonCompanyHub('ZH', { slug: 'abb', name: 'ABB', jobs: 12, logoKey: 'abb' });
    markCantonCompanyHub('BE', { slug: 'post', name: 'Post', jobs: 40, logoKey: 'post' });
    expect(cantonCompanyHubs('ZH').map((h) => h.slug)).toEqual(['migros-hq-zurich', 'abb', 'stadler-rail']);
    expect(cantonCompanyHubs('TI')).toEqual([]);
  });

  it('jobsSeoPagesPlugin registra solo gli hub sopra soglia, prima del loop dei locale', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    const phase = src.slice(src.indexOf('/* ── Per-canton company hubs (Phase 3.3)'), src.indexOf('/* ── Per-canton company × city hubs (Phase 3.4)'));
    const bridge = phase.indexOf('emitCompanyCantonBelowFloorBridge(locale, canton');
    const mark = phase.indexOf('markCantonCompanyHub(canton, {');
    const loop = phase.indexOf('const cappedJobs = sortedJobs.slice(0, COMPANY_JOB_PAYLOAD_CAP);');
    expect(bridge).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(bridge);
    expect(mark).toBeLessThan(loop);
    expect(phase.slice(mark, loop)).toContain('slug: cSlug,');
  });

  it('la pagina aziende linka gli hub registrati con slug e prefisso del locale', () => {
    const src = read('build-plugins/seoHubsPlugin.ts');
    const block = src.slice(src.indexOf("// ── aziende (companies)"));
    expect(block).toContain('const emittedHubs = cantonCompanyHubs(canton).slice(0, 100);');
    expect(block).toContain('href: `${sectionRoot}/${COMPANY_ROUTE_PREFIX[locale]}-${hub.slug}/`,');
  });
});
