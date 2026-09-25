import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  classifyTiSectorZeros,
  STRUCTURAL_TI_ZERO_EVIDENCE,
} from '../scripts/monitor-sector-coverage.mjs';
import {
  SECTOR_HUB_KEYS,
  loadSectorProseData,
} from '../build-plugins/jobSectorLanding';
import { buildSectorLandingHtml } from '../build-plugins/jobSectorPagesPlugin';

const ROOT_DIR = resolve(__dirname, '..');

describe('TI sector zero classification', () => {
  it('keeps the verified orologeria zero observable without routing it to crawler onboarding', () => {
    expect(classifyTiSectorZeros(['orologeria'])).toEqual({
      structuralZeroSectors: ['orologeria'],
      actionableZeroSectors: [],
    });
    expect(STRUCTURAL_TI_ZERO_EVIDENCE.orologeria.reason).toMatch(/nessuna vacancy TI genuina/i);
    expect(STRUCTURAL_TI_ZERO_EVIDENCE.orologeria.reclassifyWhen).toMatch(/vacancy TI verificata/i);
  });

  it('keeps an unclassified zero such as sicurezza actionable and separates mixed input', () => {
    expect(classifyTiSectorZeros(['orologeria', 'sicurezza'])).toEqual({
      structuralZeroSectors: ['orologeria'],
      actionableZeroSectors: ['sicurezza'],
    });
    expect(classifyTiSectorZeros(['sicurezza'])).toEqual({
      structuralZeroSectors: [],
      actionableZeroSectors: ['sicurezza'],
    });
  });

  it('does not remove or demote the orologeria TI landing when its count is zero', () => {
    expect(SECTOR_HUB_KEYS).toContain('orologeria');
    const html = buildSectorLandingHtml({
      sector: 'orologeria',
      locale: 'it',
      matchingJobs: [],
      count: 0,
      year: 2026,
      dateStamp: '2026-09-25',
      sectorProseData: loadSectorProseData(ROOT_DIR),
    });
    expect(html).toContain('/cerca-lavoro-ticino/orologeria/');
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+noindex/i);
  });
});
