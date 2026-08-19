/**
 * Auto Ad containers that never answer — `services/autoAdCollapse.ts`.
 *
 * The failure this pins (measured live on frontaliereticino.ch, 2026-08-19):
 * Google injects `.google-auto-placed` with an `<ins>` carrying an inline
 * ~280px height, `adsbygoogle.js` marks it done, and then no answer ever
 * arrives — no `data-ad-status`, no creative iframe. The two collapse rules in
 * `index.css` key on `:empty` and `ins[data-ad-status="unfilled"]`, and this
 * container is neither, so the reserve is held forever: 4 stuck containers on
 * `/`, 3 on `/cerca-lavoro-ticino/`, 3 on `/statistiche/` — 840-1120px of
 * blank per page, still unresolved after 16s in the viewport.
 *
 * The invariant on the other side matters just as much (AGENTS.md §7): the
 * space is given back only AFTER the same fill budget our own slots get, and
 * is handed straight back the moment a creative shows up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AUTO_AD_COLLAPSED_ATTR,
  AUTO_AD_CONTAINER_SELECTOR,
  autoAdHasCreative,
  installAutoAdCollapse,
} from '../services/autoAdCollapse';
import { AD_FILL_TIMEOUT_MS } from '../services/adsenseSlots';

const ROOT = resolve(__dirname, '..');

/** `.google-auto-placed` wrapping whatever markup the ad layer produced. */
function placeContainer(inner: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'google-auto-placed';
  el.innerHTML = inner;
  document.body.appendChild(el);
  return el;
}

const BARE_INS = '<ins class="adsbygoogle" data-adsbygoogle-status="done"></ins>';

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('autoAdHasCreative — only a real creative earns the space', () => {
  it('a rendered iframe counts as filled', () => {
    expect(autoAdHasCreative(placeContainer('<ins><iframe></iframe></ins>'))).toBe(true);
  });

  it('data-ad-status="filled" counts as filled', () => {
    expect(autoAdHasCreative(placeContainer('<ins data-ad-status="filled"></ins>'))).toBe(true);
  });

  it('the silent no-answer case does NOT count — this is the whole bug', () => {
    // Not empty, not flagged unfilled: invisible to both CSS collapse rules.
    expect(autoAdHasCreative(placeContainer(BARE_INS))).toBe(false);
  });

  it('an explicitly unfilled ad does not count', () => {
    expect(autoAdHasCreative(placeContainer('<ins data-ad-status="unfilled"></ins>'))).toBe(false);
  });

  it('an empty container does not count', () => {
    expect(autoAdHasCreative(placeContainer(''))).toBe(false);
  });
});

describe('installAutoAdCollapse — gives the space back, but only after the budget', () => {
  it('collapses a container still unanswered after the fill budget', () => {
    vi.useFakeTimers();
    const el = placeContainer(BARE_INS);
    teardown = installAutoAdCollapse();

    vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS - 1);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(true);
  });

  it('never touches a container that filled (AGENTS.md §7)', () => {
    vi.useFakeTimers();
    const el = placeContainer('<ins data-ad-status="filled"><iframe></iframe></ins>');
    teardown = installAutoAdCollapse();

    vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS * 3);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(false);
  });

  it('hands the space back when a creative arrives after the collapse', async () => {
    vi.useFakeTimers();
    const el = placeContainer(BARE_INS);
    teardown = installAutoAdCollapse();

    vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(true);

    // A late fill — the module must not have turned a slow ad into no ad.
    el.querySelector('ins')!.appendChild(document.createElement('iframe'));
    await vi.advanceTimersByTimeAsync(0);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(false);
  });

  it('picks up containers Google injects after install', async () => {
    vi.useFakeTimers();
    teardown = installAutoAdCollapse();

    const el = placeContainer(BARE_INS);
    await vi.advanceTimersByTimeAsync(0); // let the MutationObserver see it
    vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(true);
  });

  it('teardown stops the budget — no collapse after unmount', () => {
    vi.useFakeTimers();
    const el = placeContainer(BARE_INS);
    installAutoAdCollapse()();

    vi.advanceTimersByTime(AD_FILL_TIMEOUT_MS * 2);
    expect(el.hasAttribute(AUTO_AD_COLLAPSED_ATTR)).toBe(false);
  });
});

describe('the CSS half and the JS half cannot drift', () => {
  it('index.css collapses exactly the attribute the module sets', () => {
    const css = readFileSync(resolve(ROOT, 'index.css'), 'utf8');
    expect(css).toMatch(
      new RegExp(`\\${AUTO_AD_CONTAINER_SELECTOR}\\[${AUTO_AD_COLLAPSED_ATTR}\\]`),
    );
    // Google writes the height inline on the <ins>, so clipping is what makes
    // the collapse visible — a rule without it would set 0 and still paint.
    const rule = css.slice(css.indexOf(`[${AUTO_AD_COLLAPSED_ATTR}]`));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/overflow:\s*hidden\s*!important/);
  });

  it('both consumers spend the SAME fill budget', () => {
    const banner = readFileSync(resolve(ROOT, 'components', 'shared', 'AdSenseBanner.tsx'), 'utf8');
    expect(banner).toMatch(/AD_FILL_TIMEOUT_MS/);
    // A re-hardcoded literal would let the two halves of one page collapse at
    // two different moments.
    expect(banner).not.toMatch(/\b12_000\b|\b12000\b/);
  });
});
