import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adSlotHtml,
  infeedAdGridBlockHtml,
  infeedAdListItemHtml,
  pruneStaticInfeedAdsToContentRatio,
} from '../build-plugins/lib/adSlotHtml';
import { AD_SLOTS } from '../services/adsenseSlots';

const ROOT = resolve(__dirname, '..');

describe('static job-list AdSense ratio guard', () => {
  it('prunes trailing list/grid placements until the completed body supports them', () => {
    const body = [
      `<p>${'visible '.repeat(137)}</p>`,
      infeedAdListItemHtml(),
      infeedAdGridBlockHtml(),
      infeedAdListItemHtml(),
    ].join('');

    const output = pruneStaticInfeedAdsToContentRatio(body);
    const slot = AD_SLOTS.JOBLIST_INFEED_DESKTOP.slot;
    const slotCount = output.match(new RegExp(`data-ad-slot="${slot}"`, 'g'))?.length ?? 0;

    expect(slotCount).toBe(2);
    expect(output).toContain('visible');
    expect(output).not.toContain('data-ad-experiment');
  });

  it('removes the whole nested grid frame and preserves the neighboring content', () => {
    const neighbor = '<article><h2>Offerte disponibili</h2><div>Contenuto conservato</div></article>';
    const grid = infeedAdGridBlockHtml();
    expect(pruneStaticInfeedAdsToContentRatio(grid + neighbor)).toBe(neighbor);
  });

  it('still prunes legacy unwrapped slots without consuming a neighboring grid', () => {
    const slot = AD_SLOTS.JOBLIST_INFEED_DESKTOP.slot;
    const legacy = `<div class="ft-infeed-ad"><ins class="adsbygoogle" data-ad-slot="${slot}"></ins></div>`;
    const neighbor = '<div class="content"><div>Contenuto conservato</div></div>';
    expect(pruneStaticInfeedAdsToContentRatio(legacy + neighbor)).toBe(neighbor);
  });

  it('folds an existing disclosure into a single labeled owned frame', () => {
    const html = adSlotHtml('ARTICLE_END_MULTIPLEX', { frame: { tag: 'section', className: 's-sC82IX', label: 'Ad & service' } });
    expect(html).toMatch(/^<section data-house class="s-sC82IX" aria-label="Ad &amp; service"><ins /);
    expect(html).toMatch(/<\/ins><\/section>$/);
    expect(html.match(/data-house/g)).toHaveLength(1);
    expect(html).not.toContain('<div');
  });

  it('wires the guard at the shared completed-page shell boundary', () => {
    const source = readFileSync(resolve(ROOT, 'build-plugins/shared/seoPageShell.ts'), 'utf8');

    expect(source).toContain('const wrappedBody = pruneStaticInfeedAdsToContentRatio(bodyWithLocaleNav);');
    expect(source).toContain('innerHtml: bodyHtml');
  });
});
