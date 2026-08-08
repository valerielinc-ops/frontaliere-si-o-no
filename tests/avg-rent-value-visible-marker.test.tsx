/**
 * `AvgRentValue` renders its estimate marker as VISIBLE TEXT, in every locale
 * (issue #4545 residual 4, follow-up to the disclosure that first landed for
 * it).
 *
 * What was wrong. The component carried the whole disclosure in `title` and
 * `aria-label`. A `title` tooltip requires a pointer to hover — there is none
 * on a touch screen, so on phones the figure rendered completely unqualified
 * and the reader saw a bare `€550/mese` with nothing marking it an estimate.
 * That is the exact defect the component exists to remove, still present on
 * the majority of this site's traffic.
 *
 * It also put the SPA at odds with the SSG side, which had it right all along:
 * `borderMunicipalityPagesPlugin` prints `rentCaptionSuffix` as visible caption
 * text under the metric tile. Two surfaces telling the reader different things
 * about the same number is the drift `services/avgRentEstimate.ts` was created
 * to prevent.
 *
 * Why a dedicated file rather than another case in avg-rent-estimate.test.ts:
 * that file is node-environment and guards the WIRING (which surfaces import
 * the shared module) by reading source text. A source-level grep cannot tell a
 * marker rendered as JSX children from one passed to `title=` — which is the
 * whole distinction under test here. This one mounts the component and asserts
 * on the rendered DOM.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { rentEstimateLabel, rentEstimateNote } from '@/services/avgRentEstimate';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

// Mutable so each case can mount the component under a different locale.
// `t` echoes keys: the disclosure does not come from i18n (it lives in
// services/avgRentEstimate.ts so the SSG side can share it), so a
// key-echoing `t` cannot accidentally satisfy any assertion below.
let currentLocale: string = 'it';
vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: currentLocale }),
  getCantonI18nParams: () => ({}) as Record<string, string>,
}));

import AvgRentValue from '@/components/shared/AvgRentValue';

/** 550 is the band this issue was filed about: 118 comuni carry it. */
const MUNI = { avgRentMonthly: 550 } as const;

afterEach(() => {
  cleanup();
  currentLocale = 'it';
});

describe('the estimate marker is readable without a pointer', () => {
  it.each(LOCALES)('%s renders the marker as visible text, not only in title', (locale) => {
    currentLocale = locale;
    const { container } = render(<AvgRentValue municipality={MUNI} />);

    const label = rentEstimateLabel(locale);
    // The assertion that matters: the marker is in the rendered text content,
    // which is what a touch user actually sees.
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain('550');

    // ...and it is NOT merely sitting in an attribute. Strip every attribute
    // value, then re-check: if the marker only lived in `title`/`aria-label`
    // this fails, which is precisely the regression being fenced.
    const visibleOnly = (container.textContent ?? '').trim();
    expect(visibleOnly.length).toBeGreaterThan(String(MUNI.avgRentMonthly).length);
  });

  it('renders a different marker per locale (no untranslated fallback leaking through)', () => {
    const rendered = new Set(
      LOCALES.map((locale) => {
        currentLocale = locale;
        const { container } = render(<AvgRentValue municipality={MUNI} />);
        const text = container.textContent ?? '';
        cleanup();
        return text;
      }),
    );
    expect(rendered.size).toBe(LOCALES.length);
  });
});

describe('the long-form note is still available to pointer and assistive tech', () => {
  it('keeps the full note in title and aria-label', () => {
    render(<AvgRentValue municipality={MUNI} />);
    const note = rentEstimateNote(MUNI, 'it');
    const abbr = screen.getByTitle(note);
    expect(abbr).toBeTruthy();
    expect(abbr.getAttribute('aria-label')).toBe(note);
    // The note names the cohort — 118 comuni share 550 — so the disclosure
    // stays checkable rather than a vague "approx".
    expect(note).toContain('118');
  });

  it('does not announce the marker twice to a screen reader', () => {
    // The abbr's aria-label already carries the full note; the visible marker
    // is decorative repetition for sighted users and must be aria-hidden.
    const { container } = render(<AvgRentValue municipality={MUNI} />);
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker, 'the visible marker must be aria-hidden').toBeTruthy();
    expect(marker?.textContent).toContain(rentEstimateLabel('it'));
  });
});

describe('prefix and suffix still surround the figure', () => {
  it('keeps caller-supplied affixes next to the number, with the marker after them', () => {
    render(<AvgRentValue municipality={MUNI} prefix="€ " suffix="/mese" />);
    const text = screen.getByTitle(rentEstimateNote(MUNI, 'it')).textContent ?? '';
    expect(text).toContain('€ 550/mese');
    // Marker comes after the unit, so the figure reads as one uninterrupted
    // quantity — "€ 550/mese (stima)", not "€ 550 (stima)/mese".
    expect(text.indexOf(rentEstimateLabel('it'))).toBeGreaterThan(text.indexOf('/mese'));
  });
});
