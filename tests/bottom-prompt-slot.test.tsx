/**
 * THE INVARIANT: two bottom-anchored prompts are never on screen at once, and
 * a new one cannot be added at those coordinates without joining the queue.
 *
 * WHAT WAS BROKEN, MEASURED FROM SOURCE
 * -------------------------------------
 * Four components carried this class list, byte-for-byte identical:
 *
 *   fixed above-mobile-nav right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-slide-up
 *
 * `JobDetailAlertPrompt`, `SavedJobsAlertNudge`, `ProfileEnrichmentPrompt`,
 * and — `left-1/2 -translate-x-1/2 max-w-md` instead of `right-4 max-w-sm`,
 * same offset, same z, and on a phone the same `calc(100% - 2rem)` box —
 * `JobAlertStickyBanner`. Identical coordinates are not a near-miss: any two
 * of them visible together are pixel-on-pixel, the lower one unreadable and
 * its buttons unclickable.
 *
 * `services/popupQueue.ts` has arbitrated exactly this problem since long
 * before these four existed, and eight other surfaces route through it. None
 * of these did. The only guard anywhere in the tree was a boolean in JobBoard,
 * `savedNudge && !jobDetailPromptVisible` — one hardcoded pair out of the ten
 * that four prompts produce, in a parent that happens to render two of them.
 * It could not see `ProfileEnrichmentPrompt` (rendered from `JobAlertForm`, a
 * different subtree), nor the sticky banner, nor the chatbot FAB sitting four
 * pixels away at `right-3 bottom-[4.5rem]` with ten more z-layers.
 *
 * WHY THE FIX IS A SHELL AND NOT FOUR BOOLEANS
 * --------------------------------------------
 * Because a fifth prompt would need a fifth boolean, and would not get one.
 * `components/shared/BottomPromptShell.tsx` owns the geometry AND the queue
 * claim, so reaching those coordinates and being arbitrated are the same act.
 * This file asserts both halves: the behaviour (below) and the fact that
 * nobody re-hardcodes the position to get around it (the source scan).
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { render, screen, act, cleanup } from '@testing-library/react';

import BottomPromptShell, { BOTTOM_PROMPT_BASE_CLASS } from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY, getActiveSlotId, releaseSlot } from '@/services/popupQueue';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

/**
 * The one surface allowed to sit at the shared bottom offset without a slot,
 * declared rather than filtered out.
 *
 * `JobAlertForm`'s toast is a 2-second confirmation of an action the visitor
 * just took, not an offer competing for their attention — and a confirmation
 * that waits in a queue is a confirmation that never arrives. It is centred at
 * `z-50`, above anything the shell renders, so it overlays rather than hides.
 * If a second exemption ever shows up here, the question to ask is whether it
 * is really a status message or just another ask that did not want to queue.
 */
const POSITION_EXEMPT: Record<string, string> = {
  'components/community/JobAlertForm.tsx':
    'transient success toast, z-50, must never be deferred behind an offer',
};

describe('bottom-anchored prompts share one slot, by construction', () => {
  it('no component outside the shell hardcodes the bottom-anchored position', () => {
    // `ABOVE_MOBILE_NAV_BOTTOM` is the marker: it exists only to place a
    // `fixed` element at the shared bottom offset, so importing it IS the act
    // of claiming those coordinates.
    const offenders = ['App.tsx', ...walk('components'), ...walk('hooks')]
      .filter((rel) => rel !== 'components/shared/BottomPromptShell.tsx')
      .filter((rel) => rel !== 'components/shared/mobileNavClearance.ts')
      .filter((rel) => !POSITION_EXEMPT[rel])
      .filter((rel) => read(rel).includes('ABOVE_MOBILE_NAV_BOTTOM'));

    expect(
      offenders,
      'place a bottom-anchored prompt with <BottomPromptShell>, or declare it in POSITION_EXEMPT with the reason',
    ).toEqual([]);
  });

  it('every exemption still exists, so the list cannot rot into a lie', () => {
    for (const rel of Object.keys(POSITION_EXEMPT)) {
      expect(read(rel), `${rel} no longer uses the shared offset — drop the exemption`)
        .toContain('ABOVE_MOBILE_NAV_BOTTOM');
    }
  });

  it('the four prompts route through the shell and claim distinct slots', () => {
    const prompts = [
      'components/community/JobDetailAlertPrompt.tsx',
      'components/community/SavedJobsAlertNudge.tsx',
      'components/community/ProfileEnrichmentPrompt.tsx',
      'components/community/JobAlertStickyBanner.tsx',
    ];
    const slots = new Set<string>();
    for (const rel of prompts) {
      const src = read(rel);
      expect(src, `${rel} must render <BottomPromptShell>`).toContain('<BottomPromptShell');
      expect(src, `${rel} must take its priority from POPUP_PRIORITY`).toMatch(
        /priority=\{POPUP_PRIORITY\.[A-Z_]+\}/,
      );
      const slot = src.match(/slotId="([^"]+)"/)?.[1];
      expect(slot, `${rel} must pass a literal slotId`).toBeTruthy();
      slots.add(slot as string);
    }
    expect(slots.size, 'two prompts sharing a slotId would evict each other').toBe(prompts.length);
  });

  it('the four priorities are distinct, so promotion order is deterministic', () => {
    const values = [
      POPUP_PRIORITY.JOB_DETAIL_PROMPT,
      POPUP_PRIORITY.SAVED_JOBS_NUDGE,
      POPUP_PRIORITY.PROFILE_ENRICHMENT,
      POPUP_PRIORITY.JOB_ALERT_STICKY,
    ];
    expect(new Set(values).size).toBe(values.length);
    // And all of them yield to consent and to a sign-in gate: neither is an
    // offer that can be postponed.
    expect(Math.max(...values)).toBeLessThan(POPUP_PRIORITY.COOKIE_CONSENT);
    expect(Math.max(...values)).toBeLessThan(POPUP_PRIORITY.AUTH_GATE);
  });

  it('the shared geometry lives in exactly one string', () => {
    expect(BOTTOM_PROMPT_BASE_CLASS).toContain('fixed');
    expect(BOTTOM_PROMPT_BASE_CLASS).toContain('above-mobile-nav');
    expect(BOTTOM_PROMPT_BASE_CLASS).toContain('z-40');
  });
});

describe('the shell renders one prompt at a time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    // The queue is a module singleton — a slot left claimed by one test is a
    // prompt that never renders in the next one.
    ['a', 'b'].forEach(releaseSlot);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const Pair: React.FC<{ withA?: boolean }> = ({ withA = true }) => (
    <>
      {withA && (
        <BottomPromptShell slotId="a" priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT}>
          <span>prompt A</span>
        </BottomPromptShell>
      )}
      <BottomPromptShell slotId="b" priority={POPUP_PRIORITY.JOB_ALERT_STICKY}>
        <span>prompt B</span>
      </BottomPromptShell>
    </>
  );

  it('shows the higher-priority prompt and hides the other entirely', () => {
    render(<Pair />);
    expect(screen.getByText('prompt A')).toBeTruthy();
    // Not merely covered: not in the DOM, so it cannot be read by a screen
    // reader or tabbed into either.
    expect(screen.queryByText('prompt B')).toBeNull();
    expect(getActiveSlotId()).toBe('a');
  });

  it('promotes the waiting prompt once the winner goes away', () => {
    const { rerender } = render(<Pair />);
    expect(screen.getByText('prompt A')).toBeTruthy();

    rerender(<Pair withA={false} />);
    // `promoteNext` waits 500ms so the two animations do not collide.
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText('prompt B')).toBeTruthy();
    expect(getActiveSlotId()).toBe('b');
  });

  it('fires onShown when the prompt appears, not when it is mounted', () => {
    const onShownA = vi.fn();
    const onShownB = vi.fn();
    const Both: React.FC<{ withA?: boolean }> = ({ withA = true }) => (
      <>
        {withA && (
          <BottomPromptShell
            key="a"
            slotId="a"
            priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT}
            onShown={onShownA}
          >
            <span>prompt A</span>
          </BottomPromptShell>
        )}
        <BottomPromptShell
          key="b"
          slotId="b"
          priority={POPUP_PRIORITY.JOB_ALERT_STICKY}
          onShown={onShownB}
        >
          <span>prompt B</span>
        </BottomPromptShell>
      </>
    );

    const { rerender } = render(<Both />);

    expect(onShownA).toHaveBeenCalledTimes(1);
    // B is mounted and waiting its turn. Counting an impression for it here is
    // exactly the inflated denominator this callback exists to prevent.
    expect(onShownB).not.toHaveBeenCalled();

    rerender(<Both withA={false} />);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(onShownB).toHaveBeenCalledTimes(1);
    expect(onShownA).toHaveBeenCalledTimes(1);
  });

  it('Escape reaches only the visible prompt, never the one waiting', () => {
    // The mirror image of the impression bug. Two prompts bound `keydown` on
    // `window` from their own effects, which was harmless while a prompt was
    // either mounted-and-visible or not mounted at all. Now that a prompt can
    // be mounted and WAITING, that listener would run its dismiss path — and
    // record the dismissal, burning the gating cooldown — for a toast nobody
    // ever saw.
    const escA = vi.fn();
    const escB = vi.fn();
    render(
      <>
        <BottomPromptShell slotId="a" priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT} onEscape={escA}>
          <span>prompt A</span>
        </BottomPromptShell>
        <BottomPromptShell slotId="b" priority={POPUP_PRIORITY.JOB_ALERT_STICKY} onEscape={escB}>
          <span>prompt B</span>
        </BottomPromptShell>
      </>,
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(escA).toHaveBeenCalledTimes(1);
    expect(escB, 'the queued prompt must not see the key').not.toHaveBeenCalled();
  });

  it('an undefined onEscape unbinds the listener (submit in flight)', () => {
    const esc = vi.fn();
    const { rerender } = render(
      <BottomPromptShell slotId="a" priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT} onEscape={esc}>
        <span>prompt</span>
      </BottomPromptShell>,
    );
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(esc).toHaveBeenCalledTimes(1);

    rerender(
      <BottomPromptShell slotId="a" priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT} onEscape={undefined}>
        <span>prompt</span>
      </BottomPromptShell>,
    );
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(esc, 'a submit in flight must not be cancellable by Escape').toHaveBeenCalledTimes(1);
  });

  it('a reused instance handed a different slot still counts its impression', () => {
    // React keeps one component instance when the same element type reappears
    // in the same position. A "have we fired once" boolean would ride along and
    // swallow the second prompt's impression — the ref is keyed on the slot.
    const onShown = vi.fn();
    const { rerender } = render(
      <BottomPromptShell slotId="a" priority={POPUP_PRIORITY.JOB_DETAIL_PROMPT} onShown={onShown}>
        <span>prompt</span>
      </BottomPromptShell>,
    );
    expect(onShown).toHaveBeenCalledTimes(1);

    rerender(
      <BottomPromptShell slotId="b" priority={POPUP_PRIORITY.JOB_ALERT_STICKY} onShown={onShown}>
        <span>prompt</span>
      </BottomPromptShell>,
    );
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(onShown).toHaveBeenCalledTimes(2);
  });
});
