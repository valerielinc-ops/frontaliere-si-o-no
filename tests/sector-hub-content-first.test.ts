import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTOR_HUB_EMOJI, sectorHubEmojiFor } from '../build-plugins/shared/sectorHubEmoji';
import { SECTOR_HUB_KEYS } from '../build-plugins/jobSectorLanding';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('shared sector-hub emoji map', () => {
  it('covers every sector-hub key (no missing decorative emoji)', () => {
    for (const key of SECTOR_HUB_KEYS) {
      expect(SECTOR_HUB_EMOJI[key], `missing emoji for sector "${key}"`).toBeTruthy();
    }
  });

  it('falls back to a neutral compass for unknown keys', () => {
    expect(sectorHubEmojiFor('not-a-real-sector')).toBe('🧭');
  });
});

describe('per-canton non-TI sector hub is content-first (propagated from PR #1118)', () => {
  const source = readFileSync(
    resolve(__dirname, '../build-plugins/jobsSeoPagesPlugin.ts'),
    'utf8',
  );

  // Narrow to the per-canton sector hub emit block so the assertions can't be
  // satisfied by an unrelated section of this very large file.
  const block = (() => {
    const start = source.indexOf('Per-canton sector hubs (Phase 3.2)');
    const end = source.indexOf('Per-canton company hubs (Phase 3.3)');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  })();

  it('renders the lively colored stat grid', () => {
    expect(block).toContain('renderStatGrid(statTiles)');
    expect(block).toContain("pickStatTileTone('openings'");
    expect(block).toContain("pickStatTileTone('fresh'");
  });

  it('renders the decorative emoji eyebrow (aria-hidden, not in the H1)', () => {
    expect(block).toContain('SECTOR_HUB_EMOJI[sector]');
    expect(block).toContain('aria-hidden="true"');
    // emoji must live in the eyebrow paragraph, never inside the <h1>
    expect(block).not.toMatch(/<h1>\$\{[^}]*SECTOR_HUB_EMOJI/);
  });

  it('promotes the "view all" link to a primary CTA button above the listings', () => {
    expect(block).toContain('${CTA_PRIMARY_CLASS}');
    // CTA + stat grid must precede the listing <ul> in the composed bodyHtml
    const bodyIdx = block.indexOf('const bodyHtml =');
    const composed = block.slice(bodyIdx, block.indexOf('buildSeoPageHtml({', bodyIdx));
    const ctaPos = composed.indexOf('${ctaHtml}');
    const statPos = composed.indexOf('${statGridHtml}');
    const listPos = composed.indexOf('<ul class="s-0WjlyL">');
    expect(statPos).toBeGreaterThan(-1);
    expect(ctaPos).toBeGreaterThan(-1);
    expect(listPos).toBeGreaterThan(ctaPos);
    expect(listPos).toBeGreaterThan(statPos);
  });

  it('computes honest counts over the full (uncapped) match set', () => {
    expect(block).toContain('sJobs.map((j: any) => String(j.company');
    expect(block).toContain('sJobs.map((j: any) => String(j.location');
  });
});
