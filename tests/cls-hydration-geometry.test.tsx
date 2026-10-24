/**
 * cls-hydration-geometry — the box-geometry invariants behind the job-detail
 * CLS measured live on 2026-10-24 (Pixel 5, consent granted, Playwright with a
 * `layout-shift` PerformanceObserver on frontaliereticino.ch):
 *
 *  1. The Google sign-in control used to be TWO stacked boxes (GIS container +
 *     fallback button) and the fallback was removed on GIS readiness; GIS also
 *     re-rendered its iframe at ~80px before settling at 44px. Everything below
 *     the gate moved 36-52px, more than once per load.
 *  2. The LinkedIn button appeared ~2s after the gate, when Remote Config
 *     answered: +56px for the email form, the consent notice and the ad below.
 *  3. Fixed bottom prompts and the mobile nav followed the Auto Ads anchor by
 *     transitioning `bottom`; a fixed box whose `bottom` changes is scored as a
 *     layout shift every animation frame (the viewers toast: 507->442->425px).
 *  4. The Suspense fallback of a job-detail URL was the 10-card BOARD skeleton,
 *     so the static detail flipped to a list and back ~4s later.
 *
 * Each case pins the geometry, not the pixels: a regression puts the stacked
 * box, the late button, the `bottom` transition or the board skeleton back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import SkeletonFallback from '@/components/shared/Skeletons';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/** Body of the first top-level CSS rule whose selector is exactly `selector`. */
function cssRule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule present`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('Google / LinkedIn sign-in controls keep one box from first paint', () => {
  const surfaces: Array<[string, string[]]> = [
    ['components/community/JobBoard.tsx', ['modalGoogleButtonRef', 'inlineGoogleButtonRef']],
    ['components/community/NewsletterPopup.tsx', ['googleButtonRef']],
  ];

  for (const [file, refs] of surfaces) {
    const src = read(file);
    for (const ref of refs) {
      it(`${file}: ${ref} overlays its fallback inside one fixed 44px slot`, () => {
        const at = src.indexOf(`<div ref={${ref}}`);
        expect(at).toBeGreaterThan(-1);
        const slotOpen = src.lastIndexOf('<div className="relative h-[44px]" data-google-signin-slot>', at);
        expect(slotOpen, 'fixed-height slot wraps the GIS container').toBeGreaterThan(-1);
        // Nothing but the comment-free slot opener sits between wrapper and container.
        expect(src.slice(slotOpen, at)).not.toMatch(/<div(?! className="relative h-\[44px\]")/u);
        const containerTag = src.slice(at, src.indexOf('/>', at));
        expect(containerTag).toContain('absolute inset-0');
        expect(containerTag).not.toContain('min-h-[44px]');
      });
    }

    it(`${file}: LinkedIn availability starts unknown and holds the button box`, () => {
      expect(src).toMatch(/const \[linkedInAvailable, setLinkedInAvailable\] = useState<boolean \| null>\(null\);/u);
      expect(src).not.toMatch(/\{linkedInAvailable && \(/u);
      expect(src).toMatch(/\{linkedInAvailable !== false && \(/u);
      expect(src).toMatch(/linkedInAvailable \? ''\s*: ' invisible'|linkedInAvailable \? '' : ' invisible'|`\$\{gateSkin\.linkedInButton\} invisible`/u);
    });
  }

  it('the job gate fallback no longer stacks under the GIS container', () => {
    const src = read('components/community/JobBoard.tsx');
    const at = src.indexOf('{!inlineGoogleButtonReady && (');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 80)).toContain('<div className="absolute inset-0">');
  });
});

describe('fixed bottom chrome follows the anchor ad with translate, not bottom', () => {
  const css = read('index.css');

  it('.above-mobile-nav keeps a static bottom and lifts with translate', () => {
    const rule = cssRule(css, '.above-mobile-nav');
    expect(rule).toMatch(/bottom:\s*var\(--bottom-prompt-base\);/u);
    expect(rule).toMatch(/translate:\s*0 calc\(-1 \* var\(--bottom-prompt-lift\)\);/u);
    expect(rule).toMatch(/transition:\s*translate /u);
    expect(rule).not.toMatch(/transition:\s*bottom/u);
    // max-height of tall prompts still reads the full offset.
    expect(rule).toMatch(/--bottom-prompt-offset:\s*calc\(var\(--bottom-prompt-base\) \+ var\(--bottom-prompt-lift\)\);/u);
  });

  it('.mobile-bottom-nav does not animate bottom', () => {
    const rule = cssRule(css, '.mobile-bottom-nav');
    expect(rule).toMatch(/bottom:\s*0;/u);
    expect(rule).toMatch(/translate:\s*0 calc\(-1 \* var\(--mobile-nav-ad-clearance, 0px\)\);/u);
    expect(rule).not.toMatch(/transition:\s*bottom/u);
  });

  it('no box carrying ABOVE_MOBILE_NAV_BOTTOM uses a Tailwind translate utility or an inline bottom', () => {
    const shell = read('components/shared/BottomPromptShell.tsx');
    const align = shell.slice(shell.indexOf('const ALIGN_CLASS'), shell.indexOf('const WIDTH_CLASS'));
    const alignValues = [...align.matchAll(/^\s*\w+: '([^']*)',$/gmu)].map((m) => m[1]);
    expect(alignValues).toEqual(['right-4', 'inset-x-0 mx-auto']);
    expect(alignValues.join(' ')).not.toMatch(/translate-/u);

    const alertForm = read('components/community/JobAlertForm.tsx');
    const toastLine = alertForm.split('\n').find((l) => l.includes('${ABOVE_MOBILE_NAV_BOTTOM}')) ?? '';
    expect(toastLine).not.toBe('');
    expect(toastLine).not.toMatch(/translate-/u);

    const viewers = read('components/community/JobViewersActivityPrompt.tsx');
    expect(viewers).toMatch(/'--bottom-prompt-stack': `\$\{statusToastStackOffset\}px`/u);
    expect(viewers).not.toMatch(/^\s*bottom:/mu);
  });
});

describe('SkeletonFallback on a job-detail URL', () => {
  const w = window as unknown as { __JOB_SEED__?: unknown };

  afterEach(() => {
    cleanup();
    delete w.__JOB_SEED__;
    window.history.replaceState({}, '', '/');
  });

  it('renders the detail skeleton when the seed belongs to this URL', () => {
    w.__JOB_SEED__ = { id: 'acme-1', slug: 'infermiere-acme-lugano' };
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/infermiere-acme-lugano/');
    const { container } = render(<SkeletonFallback />);
    expect(container.textContent).not.toContain('Offerte di Lavoro Ticino');
  });

  it('keeps the board skeleton on a hub URL, even with a stale seed from another document', () => {
    w.__JOB_SEED__ = { id: 'acme-1', slug: 'infermiere-acme-lugano' };
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/infermieri/');
    const { container } = render(<SkeletonFallback />);
    expect(container.textContent).toContain('Offerte di Lavoro Ticino');
  });

  it('keeps the board skeleton on the board root without a seed', () => {
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/');
    const { container } = render(<SkeletonFallback />);
    expect(container.textContent).toContain('Offerte di Lavoro Ticino');
  });
});
