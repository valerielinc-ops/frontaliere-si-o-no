import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
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

  it('wires the guard at the shared completed-page shell boundary', () => {
    const source = readFileSync(resolve(ROOT, 'build-plugins/shared/seoPageShell.ts'), 'utf8');

    expect(source).toContain('const wrappedBody = pruneStaticInfeedAdsToContentRatio(bodyWithChrome);');
    expect(source).toContain('innerHtml: bodyHtml');
  });
});
