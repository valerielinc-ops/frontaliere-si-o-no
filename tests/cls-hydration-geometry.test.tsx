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
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';

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

  }

  it('the job gate fallback no longer stacks under the GIS container', () => {
    const src = read('components/community/JobBoard.tsx');
    const at = src.indexOf('{!inlineGoogleButtonReady && (');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 80)).toContain('<div className="absolute inset-0">');
  });
});

describe('LinkedIn button: one tri-state source, box held while Remote Config is pending', () => {
  /** Every component source under components/, recursively. */
  function componentSources(dir = resolve(root, 'components')): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...componentSources(full));
      else if (/\.tsx?$/u.test(entry.name)) out.push([full.slice(root.length + 1), readFileSync(full, 'utf8')]);
    }
    return out;
  }
  const sources = componentSources();
  const surfaces = sources.filter(([, src]) => /\blinkedInAvailable\b/u.test(src));

  it('finds every surface that offers the button (guards the scan itself)', () => {
    expect(surfaces.map(([f]) => f)).toEqual(expect.arrayContaining([
      'components/community/JobBoard.tsx',
      'components/community/NewsletterPopup.tsx',
      'components/shared/SocialSignInButtons.tsx',
    ]));
    expect(surfaces.length).toBeGreaterThanOrEqual(14);
  });

  it('no component reads availability directly or starts it at false', () => {
    const direct = sources.filter(([, src]) => /isLinkedInSignInAvailable\s*\(/u.test(src)).map(([f]) => f);
    expect(direct).toEqual([]);
    const legacy = surfaces.filter(([, src]) => /useState(?:<[^>]*>)?\((?:false|null)\)[^\n]*linkedIn|setLinkedInAvailable/u.test(src)).map(([f]) => f);
    expect(legacy).toEqual([]);
  });

  for (const [file, src] of surfaces) {
    it(`${file}: uses the hook and never mounts the button late`, () => {
      expect(src).toMatch(/const linkedInAvailable = useLinkedInSignInAvailable\(\);/u);
      expect(src).not.toMatch(/\{linkedInAvailable && \(/u);
      expect(src).not.toMatch(/linkedInAvailable \? \(/u);
      expect(src).not.toMatch(/\$\{linkedInAvailable \? 'sm:grid-cols-2'/u);
      expect(src).toMatch(/linkedInPendingClass\(linkedInAvailable\)/u);
    });
  }

  it('the hook is null while pending, then the answer; a failed lookup is false', async () => {
    const auth = await import('@/services/authService');
    // tests/setup-common.tsx mocks authService with vi.fn for every dom test.
    const spy = vi.mocked(auth.isLinkedInSignInAvailable);
    const { useLinkedInSignInAvailable, linkedInPendingClass } = await import('@/hooks/useLinkedInSignInAvailable');
    const seen: Array<boolean | null> = [];
    const Probe = () => { seen.push(useLinkedInSignInAvailable()); return null; };

    let release!: (v: boolean) => void;
    spy.mockImplementationOnce(() => new Promise<boolean>((r) => { release = r; }));
    render(<Probe />);
    expect(seen.at(-1)).toBeNull();
    await act(async () => { release(true); });
    expect(seen.at(-1)).toBe(true);
    cleanup(); seen.length = 0;

    spy.mockImplementationOnce(() => Promise.reject(new Error('rc down')));
    render(<Probe />);
    await act(async () => {});
    expect(seen.at(-1)).toBe(false);

    expect(linkedInPendingClass(null)).toBe(' invisible');
    expect(linkedInPendingClass(true)).toBe('');
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
