import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ADSENSE_LOADER_CONTENT } from '@/build-plugins/constants';
import { adSlotHtml } from '@/build-plugins/lib/adSlotHtml';
import { STATIC_AD_COLLAPSE_CSS } from '@/build-plugins/shared/criticalCss';
import { AD_FILL_TIMEOUT_MS } from '@/services/adsenseSlots';

const ROOT = resolve(__dirname, '..');

describe('static AdSense layout recovery', () => {
  it('marks the drive-by slot for the static loader', () => {
    const html = adSlotHtml('FT_DRIVEBY_ATF_DISPLAY', { collapseWhenUnfilled: true });

    expect(html).toContain('data-ft-static-ad="true"');
    expect(html).toContain('min-height:1100px');
  });

  it('collapses a static slot only after no-fill or the shared fill budget', () => {
    expect(ADSENSE_LOADER_CONTENT).toContain('data-ft-static-ad');
    expect(ADSENSE_LOADER_CONTENT).toContain('data-ft-static-ad-collapsed');
    expect(ADSENSE_LOADER_CONTENT).toContain("getAttribute('data-ad-status')==='unfilled'");
    expect(ADSENSE_LOADER_CONTENT).toContain(String(AD_FILL_TIMEOUT_MS));
    expect(ADSENSE_LOADER_CONTENT).toContain('staticAdCollapseWhenSafe(el,true)');
    expect(ADSENSE_LOADER_CONTENT).toContain("existing.addEventListener('load',armSlots");
  });

  it('arms static collapse before consent and no-ads gates can return', () => {
    const armIndex = ADSENSE_LOADER_CONTENT.indexOf('staticAdArm();');
    const noAdsIndex = ADSENSE_LOADER_CONTENT.indexOf(
      "if((function(){try{return window.localStorage.getItem('reader_noads_active')==='true';",
    );
    const consentIndex = ADSENSE_LOADER_CONTENT.indexOf('if(hasConsent()){');

    expect(armIndex).toBeGreaterThan(-1);
    expect(noAdsIndex).toBeGreaterThan(armIndex);
    expect(consentIndex).toBeGreaterThan(armIndex);
  });

  it('zeroes both the inline reserve and its wrapper margin', () => {
    const css = readFileSync(resolve(ROOT, 'index.css'), 'utf8');

    expect(css).toContain('ins.adsbygoogle[data-ft-static-ad-collapsed]');
    expect(css).toContain('height: 0 !important');
    expect(css).toContain(':where(div, li, section):has(> ins.adsbygoogle[data-ft-static-ad-collapsed])');
    expect(STATIC_AD_COLLAPSE_CSS).toContain('data-ft-static-ad-collapsed');
  });
});

describe('static reading-page rail breakpoints', () => {
  it('reserves 160px rails from 1200px and keeps the 300px xlw tier', () => {
    const css = readFileSync(resolve(ROOT, 'index.css'), 'utf8');
    const criticalCss = readFileSync(resolve(ROOT, 'build-plugins/shared/criticalCss.ts'), 'utf8');
    const stack = readFileSync(resolve(ROOT, 'components/shared/ArticleRailAdStack.tsx'), 'utf8');
    const panel = readFileSync(resolve(ROOT, 'components/shared/ArticleRailAd.tsx'), 'utf8');

    expect(css).toContain('@media (min-width: 1200px) and (max-width: 1399.98px)');
    expect(css).toContain('grid-template-columns: 160px minmax(0, 1fr) 160px');
    expect(criticalCss).toContain('grid-template-columns:160px minmax(0,1fr) 160px');
    expect(criticalCss).toContain("'@media(min-width:1400px){'");
    expect(stack).toContain('desktopRail?: boolean');
    expect(stack).toContain('ft-static-rail-stack');
    expect(panel).toContain('RAIL_SIZES_NARROW');
    expect(panel).toContain('ft-static-rail-panel');
  });
});
