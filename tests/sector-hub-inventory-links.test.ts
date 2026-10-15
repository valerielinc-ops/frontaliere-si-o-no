import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  buildSectorLandingHtml,
  filterSectorHubSiblings,
} from '../build-plugins/jobSectorPagesPlugin';
import {
  renderSectorHubLinksBlock,
  type InjectionTarget,
} from '../build-plugins/sectorHubLinksPlugin';
import { loadSectorProseData } from '../build-plugins/jobSectorLanding';

const ROOT = resolve(__dirname, '..');

describe('sector hub links follow emitted inventory', () => {
  it('keeps only positive-inventory sibling sectors in curated order', () => {
    const counts = {
      'case-anziani': 0,
      oss: 4,
      medici: 2,
      fisioterapisti: 0,
    } as Record<string, number>;
    expect(filterSectorHubSiblings('infermieri', counts)).toEqual(['oss', 'medici']);

    const html = buildSectorLandingHtml({
      sector: 'infermieri',
      locale: 'it',
      matchingJobs: [],
      count: 1,
      year: 2026,
      dateStamp: '2026-09-18',
      sectorProseData: loadSectorProseData(ROOT),
      siblingCounts: counts,
    });
    expect(html).toContain('data-sector-inventory-count="1"');
    expect(html).toContain('/cerca-lavoro-ticino/operatori-socio-sanitari/');
    expect(html).toContain('/cerca-lavoro-ticino/medici/');
    expect(html).not.toContain('/cerca-lavoro-ticino/case-anziani/');
    expect(html).not.toContain('/cerca-lavoro-ticino/fisioterapisti/');
  });

  it('filters root-hub links without changing their deterministic order', () => {
    const target: InjectionTarget = {
      indexPath: '/tmp/index.html',
      locale: 'fr',
      title: 'Emplois par secteur',
      intro: 'Choisissez un secteur.',
      availableSectors: new Set(['infermieri', 'autisti']),
    };
    const html = renderSectorHubLinksBlock(target);
    expect(html).toContain('/fr/trouver-emploi-tessin/infirmiers/');
    expect(html).toContain('/fr/trouver-emploi-tessin/chauffeurs/');
    expect(html).not.toContain('/fr/trouver-emploi-tessin/educateurs/');
    expect(html).not.toContain('href="/fr/trouver-emploi-tessin/infirmiers"');
  });
});
