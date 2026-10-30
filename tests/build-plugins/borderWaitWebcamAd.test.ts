import { describe, expect, it } from 'vitest';
import { COPY, renderWebcamSection } from '@/build-plugins/borderWaitPagesPlugin';
import { STATIC_AD_COLLAPSE_CSS } from '@/build-plugins/shared/criticalCss';
import { AD_SLOTS } from '@/services/adsenseSlots';
import type { WebcamRef } from '@/data/borderCrossings';

const cam = (id: string, extra: Partial<WebcamRef> = {}): WebcamRef => ({
  label: `Cam ${id}`,
  imageUrl: `https://example.test/${id}.gif`,
  sourceName: 'Fonte',
  sourceUrl: 'https://example.test/',
  ...extra,
} as WebcamRef);

const render = (webcams: WebcamRef[], locale: keyof typeof COPY = 'it') =>
  renderWebcamSection('Chiasso Brogeda', webcams, COPY[locale]);

const slotCount = (html: string) =>
  html.split(`data-ad-slot="${AD_SLOTS.ARTICLE_INLINE_MOBILE.slot}"`).length - 1;

describe('annuncio tra le webcam del valico', () => {
  it('sta tra la prima e la seconda webcam, una sola volta', () => {
    const html = render([cam('a'), cam('b'), cam('c')]);
    expect(slotCount(html)).toBe(1);
    const ad = html.indexOf('ft-webcam-ad');
    expect(html.indexOf('a.gif')).toBeLessThan(ad);
    expect(ad).toBeLessThan(html.indexOf('b.gif'));
  });

  it('non compare senza una coppia di webcam incorporate', () => {
    expect(slotCount(render([]))).toBe(0);
    expect(slotCount(render([cam('a')]))).toBe(0);
    expect(slotCount(render([cam('a'), cam('b', { embedAllowed: false })]))).toBe(0);
  });

  it('dichiara l\'annuncio nella lingua della pagina', () => {
    expect(render([cam('a'), cam('b')], 'it')).toContain('aria-label="Pubblicità"');
    expect(render([cam('a'), cam('b')], 'en')).toContain('aria-label="Advertisement"');
    expect(render([cam('a'), cam('b')], 'de')).toContain('aria-label="Werbung"');
    expect(render([cam('a'), cam('b')], 'fr')).toContain('aria-label="Publicité"');
  });

  it('riserva lo spazio e resta collassabile quando non viene servito', () => {
    const html = render([cam('a'), cam('b')]);
    const wrapper = html.match(/<section class="ft-webcam-ad"[^>]*>(.*?)<\/section>/s);
    expect(wrapper?.[1]).toMatch(/^<ins [^>]*><\/ins>$/);
    expect(wrapper?.[1]).toContain('data-ft-static-ad="true"');
    expect(wrapper?.[1]).toContain(`min-height:${AD_SLOTS.ARTICLE_INLINE_MOBILE.placeholderMinHeight}px`);
    expect(STATIC_AD_COLLAPSE_CSS).toContain(':only-child');
  });
});
