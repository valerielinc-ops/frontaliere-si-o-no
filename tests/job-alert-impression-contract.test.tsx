/**
 * Regression pin for issue #5039 — `alert_funnel_conversion`
 * (`job_alert_created / job_alert_cta_shown`, 14d, target ≥ 5%).
 *
 * `Analytics.trackJobAlertCtaShown` documents itself as
 *   "Impression event: the surface became VISIBLE to the user without any
 *    explicit action."
 * but `JobAlertEndCard` fired it from a bare mount effect, and the job-match /
 * board-filter CTAs fired it from an effect keyed on "is rendered". All three
 * render inside a job list most visitors never scroll to, so the goal's
 * denominator counted renders instead of impressions.
 *
 * PostHog, 14d window before the fix (surfaces keyed on `cta_surface`):
 *   end_card         440 shown →   0 clicks → 0 created
 *   job_match_pill   300 shown →   0 clicks → 0 created
 *   job_board_filters 35 shown →   1
 *   job_detail_prompt 410 shown → 106 clicks → 5 created
 *   sticky_banner     85 shown →   4 clicks
 * The two mount-based surfaces contributed 740 of 1321 impressions (56%) and
 * not one single interaction — the signature of a CTA nobody saw, not of a CTA
 * nobody liked. `sticky_banner` was already gated on real scroll visibility and
 * `job_detail_prompt` is a fixed toast, which is exactly why those two are the
 * only surfaces with a non-zero click rate.
 *
 * This is an instrumentation-correctness fix, NOT a threshold relaxation: the
 * target stays 5%, the event just has to mean what its own docblock says.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useImpressionTracker } from '../hooks/useImpressionTracker';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Controllable IntersectionObserver stand-in. */
class FakeIO {
  static instances: FakeIO[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    FakeIO.instances.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve() { /* noop */ }
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
  enter() {
    act(() => {
      this.callback(
        this.observed.map((target) => ({ isIntersecting: true, target })) as unknown as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

function Probe({ onImpression }: { onImpression: () => void }) {
  const ref = useImpressionTracker(onImpression);
  return <div ref={ref}>surface</div>;
}

describe('useImpressionTracker', () => {
  beforeEach(() => {
    FakeIO.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does NOT fire on mount — the whole point of the fix', () => {
    const spy = vi.fn();
    render(<Probe onImpression={spy} />);
    expect(spy).not.toHaveBeenCalled();
    expect(FakeIO.instances).toHaveLength(1);
  });

  it('fires once when the element becomes visible', () => {
    const spy = vi.fn();
    render(<Probe onImpression={spy} />);
    FakeIO.instances[0].enter();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never double-counts on repeated intersections', () => {
    const spy = vi.fn();
    render(<Probe onImpression={spy} />);
    const io = FakeIO.instances[0];
    io.enter();
    io.enter();
    io.enter();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('disconnects the observer after firing', () => {
    render(<Probe onImpression={() => {}} />);
    const io = FakeIO.instances[0];
    io.enter();
    expect(io.disconnected).toBe(true);
  });

  it('degrades to mount-based when IntersectionObserver is unavailable', () => {
    // Losing the event entirely would be worse than over-counting: the goal
    // would then read as a conversion-rate improvement that never happened.
    vi.unstubAllGlobals();
    vi.stubGlobal('IntersectionObserver', undefined);
    const spy = vi.fn();
    render(<Probe onImpression={spy} />);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('#5039 — no alert-CTA impression is emitted from a bare mount', () => {
  it('JobAlertEndCard tracks on visibility, not on mount', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/community/JobAlertEndCard.tsx'), 'utf-8');
    expect(src).toContain('useImpressionTracker');
    expect(src).toMatch(/ref=\{impressionRef\}/);
    // The pre-fix shape: a mount effect that fired the impression directly.
    expect(src).not.toMatch(/useEffect\([^)]*\)\s*=>\s*\{[^}]*trackJobAlertCtaShown/s);
  });

  it('the job-match and board-filter CTAs own their own impression', () => {
    for (const rel of [
      'components/community/JobMatchAlertCta.tsx',
      'components/community/JobBoardFilterAlertCta.tsx',
    ]) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      expect(src, `${rel} must use the shared impression hook`).toContain('useImpressionTracker');
      expect(src).toMatch(/ref=\{impressionRef\}/);
      expect(src).toContain('onImpression');
    }
  });

  it('JobBoard no longer fires those impressions from a "is rendered" effect', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf-8');
    // The dedupe helper must survive — impressions stay once-per-surface-per-session.
    expect(src).toContain('function trackJobAlertCtaShownOnce');
    // …but it must only be reachable through the components' onImpression prop.
    expect(src).toMatch(/onImpression=\{\(\) => trackJobAlertCtaShownOnce\('job_match_pill'/);
    expect(src).toMatch(/onImpression=\{\(\) => trackJobAlertCtaShownOnce\('job_board_filters'/);
    expect(src).not.toMatch(/if \(!jobMatchAlertVisible\) return;\s*\n[^\n]*\n[^\n]*\n\s*trackJobAlertCtaShownOnce/);
    expect(src).not.toMatch(/if \(!boardFilterAlertVisible\) return;\s*\n[^\n]*\n[^\n]*\n\s*trackJobAlertCtaShownOnce/);
  });
});

describe('#7311 — the created event carries the funnel surface dimension', () => {
  it('job_alert_created reports cta_surface, the dimension the other funnel events use', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/analytics.ts'), 'utf-8');
    const payload = src.slice(src.indexOf("log('job_alert_created'"));
    expect(payload).toContain('cta_surface: surface');
    // Kept alongside, not replaced: the PostHog queries read `alert_surface`.
    expect(payload).toContain('alert_surface: surface');
  });
});

describe('#5040 — the apply hand-off leaves a visible trace on the page', () => {
  const src = () => fs.readFileSync(path.join(ROOT, 'components/community/JobBoard.tsx'), 'utf-8');

  it('handleApply records the applied job alongside the new-tab open', () => {
    // PostHog calls a click dead when nothing mutates within 2.5s. A bare
    // window.open mutates nothing, so every apply — our highest-intent action —
    // was logged as a $dead_click AND left the returning user with no feedback.
    expect(src()).toMatch(/window\.open\(buildReferralUrl\(job\.url, job\), '_blank', 'noopener,noreferrer'\);[\s\S]{0,400}setAppliedJobId\(job\.id\);/);
  });

  it('the receipt is rendered on both the mobile and the desktop apply blocks', () => {
    expect(src().match(/\{appliedNoticeJsx\}/g) ?? []).toHaveLength(2);
  });

  it('the receipt is dropped when the user moves to another job', () => {
    expect(src()).toMatch(/selectedJob\?\.id !== appliedJobId[\s\S]{0,120}setAppliedJobId\(null\)/);
  });

  it('its alert CTA does NOT require an authenticated session', () => {
    // The only converting surface today is gated on userId+email and logs a
    // `no_auth` skip for everyone else (34 such skips in 14d). Peak intent is
    // the wrong moment to demand a login: hand off to JobAlertForm, which owns
    // auth + email capture, exactly as SavedJobsAlertNudge already does.
    const full = src();
    const start = full.indexOf('const appliedNoticeJsx');
    expect(start).toBeGreaterThan(-1);
    const block = full.slice(start, full.indexOf(') : null;', start));
    expect(block).toContain('requestJobAlertOpen');
    expect(block).toContain('backToList()');
    expect(block).not.toMatch(/\buserId\b/);
    expect(block).not.toMatch(/\buserEmail\b/);
  });
});

describe('applied-state copy exists in all four locales', () => {
  it('the release entry is registered in WhatsNewModal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/community/WhatsNewModal.tsx'), 'utf-8');
    expect(src).toContain("whatsNew.v3910.applyReceipt.title");
  });

  it.each(['it', 'en', 'de', 'fr'])('%s', (locale) => {
    const src = fs.readFileSync(path.join(ROOT, 'services/locales', `${locale}-core.ts`), 'utf-8');
    for (const key of [
      'jobBoard.applied.title',
      'jobBoard.applied.body',
      'jobBoard.applied.alertCta',
      'jobBoard.applied.reopen',
      // User-facing feature ⇒ WhatsNewModal entry (AGENTS.md, Accessibility And UX).
      'whatsNew.v3910.title',
      'whatsNew.v3910.applyReceipt.title',
      'whatsNew.v3910.applyReceipt.desc',
    ]) {
      expect(src, `${locale} is missing ${key}`).toContain(`'${key}'`);
    }
  });
});
