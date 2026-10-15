/**
 * Unit tests for services/logoService.ts.
 *
 * Verifies the post-cleanup fallback chain:
 *   Clearbit → local SVG placeholder (NO Google favicons step).
 *
 * Background: the previous chain inserted `google.com/s2/favicons` between
 * Clearbit and the local placeholder. Google's favicons API returns a generic
 * gray-globe icon for unknown/disallowed domains, which the user reported as
 * a broken-looking logo (Intesa Sanpaolo case). The Google step was removed.
 */
import { describe, it, expect } from 'vitest';
import type { SyntheticEvent } from 'react';
import { handleCompanyLogoError, COMPANY_LOGO_PLACEHOLDER } from '@/services/logoService';

interface FakeImg {
  src: string;
  dataset: { logoFallback?: string };
  style: { visibility: string };
}

function makeEvent(initialSrc: string): { event: SyntheticEvent<HTMLImageElement>; el: FakeImg } {
  const el: FakeImg = {
    src: initialSrc,
    dataset: {},
    style: { visibility: '' },
  };
  // Cast through `unknown` — we intentionally feed a stripped-down DOM-shaped
  // object into the handler. The handler only touches `currentTarget.{src, dataset, style}`.
  const event = { currentTarget: el } as unknown as SyntheticEvent<HTMLImageElement>;
  return { event, el };
}

describe('handleCompanyLogoError', () => {
  it('falls back from Clearbit straight to the local SVG placeholder (no Google favicons hop)', () => {
    const { event, el } = makeEvent('https://logo.clearbit.com/intesasanpaolo.com');

    handleCompanyLogoError(event);

    expect(el.src).toBe(COMPANY_LOGO_PLACEHOLDER);
    expect(el.dataset.logoFallback).toBe('placeholder');
    expect(el.style.visibility).toBe('visible');
  });

  it('falls back from any non-Clearbit src directly to the placeholder', () => {
    const { event, el } = makeEvent('/images/providers/some-broken-local.png');

    handleCompanyLogoError(event);

    expect(el.src).toBe(COMPANY_LOGO_PLACEHOLDER);
    expect(el.dataset.logoFallback).toBe('placeholder');
  });

  it('NEVER assigns a google.com/s2/favicons URL (regression guard for gray-globe bug)', () => {
    // Run the handler against several plausible inputs and assert the final
    // src is NEVER the Google favicons URL. The old chain set this URL after
    // a Clearbit failure; the new chain must not.
    const inputs = [
      'https://logo.clearbit.com/intesasanpaolo.com',
      'https://logo.clearbit.com/n26.com',
      'https://logo.clearbit.com/hype.it',
      '/images/providers/postfinance.png',
      '/images/insurers/css.svg',
    ];

    for (const initialSrc of inputs) {
      const { event, el } = makeEvent(initialSrc);
      handleCompanyLogoError(event);
      expect(el.src).not.toContain('google.com/s2/favicons');
      expect(el.src).not.toContain('google.com');
    }
  });

  it('is idempotent: a second error after placeholder assignment does not re-mutate src', () => {
    // Loop guard: once dataset.logoFallback === 'placeholder', the handler
    // must early-return so we don't enter an infinite onError loop in case
    // the placeholder itself fails to load.
    const { event, el } = makeEvent('https://logo.clearbit.com/example.com');

    handleCompanyLogoError(event);
    expect(el.src).toBe(COMPANY_LOGO_PLACEHOLDER);

    // Simulate the placeholder itself "failing" — the handler must do nothing.
    el.src = 'mutated-by-test';
    handleCompanyLogoError(event);
    expect(el.src).toBe('mutated-by-test');
  });

  it('makes the image visible after fallback (some hosts hide the <img> on error)', () => {
    const { event, el } = makeEvent('https://logo.clearbit.com/anything.com');
    el.style.visibility = 'hidden';

    handleCompanyLogoError(event);

    expect(el.style.visibility).toBe('visible');
  });
});
