import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  classifyTiLegacyZeroCause,
  classifyTiSectorZeros,
  renderTiLegacyZeroCauseLines,
  STRUCTURAL_TI_ZERO_EVIDENCE,
} from '../scripts/monitor-sector-coverage.mjs';
import {
  SECTOR_HUB_KEYS,
  loadSectorProseData,
} from '../build-plugins/jobSectorLanding';
import { buildSectorLandingHtml } from '../build-plugins/jobSectorPagesPlugin';

const ROOT_DIR = resolve(__dirname, '..');

describe('TI legacy zero-cause evidence', () => {
  it('classifies a zero as crawler-gap only when the same matcher has live matches outside TI', () => {
    expect(classifyTiLegacyZeroCause({
      tiLiveCount: 0,
      nonTiLiveCounts: [0, 2, 1],
    })).toBe('crawler-gap');
  });

  it('uses matcher-gap only with independently verified relevant TI titles', () => {
    expect(classifyTiLegacyZeroCause({
      tiLiveCount: 0,
      nonTiLiveCounts: [3],
      verifiedUnmatchedTiTitleCount: 1,
    })).toBe('matcher-gap');
  });

  it('keeps missing, ambiguous, or non-zero TI evidence unknown instead of inferring a cause', () => {
    expect(classifyTiLegacyZeroCause({ tiLiveCount: 0, nonTiLiveCounts: [] })).toBe('unknown');
    expect(classifyTiLegacyZeroCause({ tiLiveCount: 0, nonTiLiveCounts: null })).toBe('unknown');
    expect(classifyTiLegacyZeroCause({ tiLiveCount: undefined, nonTiLiveCounts: [2] })).toBe('unknown');
    expect(classifyTiLegacyZeroCause({ tiLiveCount: 1, nonTiLiveCounts: [2] })).toBe('unknown');
  });

  it('emits one evidence line for every zero, including unknown and verified matcher gaps', () => {
    const lines = renderTiLegacyZeroCauseLines(
      ['logopedista', 'architetto', 'assistente-dentale'],
      new Map([
        ['logopedista', { cause: 'crawler-gap', matchingCantons: [{ cantonKey: 'BE', liveCount: 2 }] }],
        ['assistente-dentale', { cause: 'matcher-gap', matchingCantons: [] }],
      ]),
    );
    expect(lines.match(/^- /gm)).toHaveLength(3);
    expect(lines).toContain('`logopedista`: `crawler-gap`');
    expect(lines).toContain('BE (2)');
    expect(lines).toContain('`architetto`: `unknown`');
    expect(lines).toContain('`assistente-dentale`: `matcher-gap`');
  });
});

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
