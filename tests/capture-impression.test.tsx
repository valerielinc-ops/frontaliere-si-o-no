/**
 * Contract for hooks/useCaptureImpression.ts — the visibility ("show") event of
 * the email-capture boxes, and the cta_id table that pairs each show with its
 * submit so GA4 can compute submits / views per box.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const botState = vi.hoisted(() => ({ bot: false }));
vi.mock('@/services/botPatterns', () => ({ isLikelyBot: () => botState.bot }));

import { Analytics } from '@/services/analytics';
import {
  useCaptureImpression,
  buildCaptureShowCtaId,
  CAPTURE_BOX_CTA_IDS,
  resetCaptureImpressionClaimsForTests,
  type UseCaptureImpressionOptions,
} from '../hooks/useCaptureImpression';
import LeadMagnetCTA from '@/components/shared/LeadMagnetCTA';
import LamalSsnBreakeven from '@/components/comparators/LamalSsnBreakeven';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Controllable IntersectionObserver stand-in that reports a visible ratio. */
class FakeIO {
  static instances: FakeIO[] = [];
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    FakeIO.instances.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve() { /* noop */ }
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
  report(ratio: number) {
    act(() => {
      this.callback(
        this.observed.map((target) => ({ isIntersecting: ratio > 0, intersectionRatio: ratio, target })) as unknown as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

function Probe(props: UseCaptureImpressionOptions) {
  const ref = useCaptureImpression(props);
  return <div ref={ref}>box</div>;
}

const BOX = { page: 'newsletter_box', section: 'compact', variant: 'newsletter_footer_compact' };

function setPath(p: string) {
  window.history.replaceState({}, '', p);
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

let trackSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeIO.instances = [];
  botState.bot = false;
  resetCaptureImpressionClaimsForTests();
  setPath('/');
  setVisibility('visible');
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);
  trackSpy = vi.spyOn(Analytics, 'trackUIInteraction').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setVisibility('visible');
});

function showCalls() {
  return trackSpy.mock.calls.filter((c) => c[2] === 'show');
}

describe('useCaptureImpression — emission contract', () => {
  it('does not emit on mount, only once the box is visible', () => {
    render(<Probe {...BOX} />);
    expect(showCalls()).toHaveLength(0);
    expect(FakeIO.instances).toHaveLength(1);
    expect(FakeIO.instances[0].options?.threshold).toBe(0.5);

    FakeIO.instances[0].report(0.6);
    expect(showCalls()).toHaveLength(1);
    expect(trackSpy).toHaveBeenCalledWith(
      'newsletter_box', 'compact', 'show', 'newsletter_footer_compact', 'newsletter_footer_compact',
      'newsletter_box.compact.show.newsletter_footer_compact',
    );
  });

  it('respects the 50% threshold: a box 10% on screen is not an impression', () => {
    render(<Probe {...BOX} />);
    const io = FakeIO.instances[0];
    io.report(0.1); // first IO callback: isIntersecting=true, ratio below threshold
    expect(showCalls()).toHaveLength(0);
    io.report(0.45);
    expect(showCalls()).toHaveLength(0);
    io.report(0.5);
    expect(showCalls()).toHaveLength(1);
  });

  it('emits once per mount even across repeated intersections', () => {
    render(<Probe {...BOX} />);
    const io = FakeIO.instances[0];
    io.report(0.8);
    io.report(0);
    io.report(1);
    expect(showCalls()).toHaveLength(1);
    expect(io.disconnected).toBe(true);
  });

  it('emits at most once per page path for the same box, across remounts', () => {
    const first = render(<Probe {...BOX} />);
    FakeIO.instances[0].report(1);
    first.unmount();

    render(<Probe {...BOX} />);
    FakeIO.instances[1].report(1);
    expect(showCalls()).toHaveLength(1);

    cleanup();
    setPath('/cerca-lavoro-ticino/');
    render(<Probe {...BOX} />);
    FakeIO.instances[2].report(1);
    expect(showCalls()).toHaveLength(2);
  });

  it('re-arms when the box identity (cta_id) changes while mounted', () => {
    const { rerender } = render(<Probe {...BOX} />);
    FakeIO.instances[0].report(1);
    rerender(<Probe {...BOX} variant="calc_result_contextual" />);
    FakeIO.instances[FakeIO.instances.length - 1].report(1);
    expect(showCalls().map((c) => c[5])).toEqual([
      'newsletter_box.compact.show.newsletter_footer_compact',
      'newsletter_box.compact.show.calc_result_contextual',
    ]);
  });

  it('does not observe while disabled, and arms when enabled flips true', () => {
    const { rerender } = render(<Probe {...BOX} enabled={false} />);
    expect(FakeIO.instances).toHaveLength(0);
    rerender(<Probe {...BOX} enabled />);
    expect(FakeIO.instances).toHaveLength(1);
    FakeIO.instances[0].report(1);
    expect(showCalls()).toHaveLength(1);
  });

  it('never emits for a likely bot', () => {
    botState.bot = true;
    render(<Probe {...BOX} />);
    FakeIO.instances[0].report(1);
    expect(showCalls()).toHaveLength(0);
  });

  it('waits while the document is hidden (background tab / prerender) and emits when shown', () => {
    setVisibility('hidden');
    render(<Probe {...BOX} />);
    FakeIO.instances[0].report(1);
    expect(showCalls()).toHaveLength(0);
    setVisibility('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(showCalls()).toHaveLength(1);
  });

  it('is SSR-safe: server render neither throws nor emits', () => {
    expect(() => renderToString(<Probe {...BOX} />)).not.toThrow();
    expect(showCalls()).toHaveLength(0);
    expect(FakeIO.instances).toHaveLength(0);
  });

  it('degrades to a mount impression without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Probe {...BOX} />);
    expect(showCalls()).toHaveLength(1);
  });

  it('uses the custom emitter and cta_id for surfaces with their own view contract', () => {
    const emit = vi.fn();
    render(<Probe page="job_auth_gate" section="expired" variant="view" ctaId="job_auth_gate.expired.unknown.view" emit={emit} />);
    FakeIO.instances[0].report(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(showCalls()).toHaveLength(0);
  });
});

describe('capture boxes — cta_id table (show ↔ submit)', () => {
  it('buildCaptureShowCtaId has the <page>.<section>.show.<variant> shape', () => {
    expect(buildCaptureShowCtaId({ page: 'lead_magnet', section: 'banner', variant: 'tax_checklist' }))
      .toBe('lead_magnet.banner.show.tax_checklist');
  });

  it('every non-job show id pairs with its submit on the variant token', () => {
    for (const row of CAPTURE_BOX_CTA_IDS) {
      if (row.show.startsWith('job_auth_gate.')) {
        const surface = row.show.split('.')[1];
        expect(row.submit, row.box).toBe(`job_auth_gate.${surface}.email.success`);
        continue;
      }
      const [page, section, component, variant] = row.show.split('.');
      expect(component, row.box).toBe('show');
      expect(buildCaptureShowCtaId({ page, section, variant }), row.box).toBe(row.show);
    }
  });

  // One row per instrumented file: the literal hook arguments the file must
  // pass, which is what produces the show cta_id in the table above.
  const SOURCE_TABLE: Array<{ file: string; needles: string[] }> = [
    { file: 'components/community/Newsletter.tsx', needles: ["page: 'newsletter_box'", "impressionPlacement || (compact ? 'compact' : 'page')", 'variant: analyticsSourceCta', 'ref={impressionRef}'] },
    { file: 'components/community/NewsletterMount.tsx', needles: ['impressionPlacement="island"'] },
    { file: 'components/shared/LeadMagnetCTA.tsx', needles: ["page: 'lead_magnet'", "section: 'banner'", 'ref={impressionRef}'] },
    { file: 'components/community/WeeklyDigest.tsx', needles: ["page: 'weekly_digest'", "section: 'form'", "variant: 'weekly_digest'", 'ref={impressionRef}'] },
    { file: 'components/pages/PublisherPublishPage.tsx', needles: ["page: 'publisher'", "section: 'gate'", "variant: 'email_login'", 'ref={gateImpressionRef}'] },
    { file: 'components/comparators/LamalSsnBreakeven.tsx', needles: ["page: 'lamal_ssn'", "section: 'email_pdf'", "variant: 'lamal_ssn_tool'", "trackUIInteraction('lamal_ssn', 'email_pdf', 'submit', 'lamal_ssn_tool')"] },
    { file: 'components/community/JobExpiredView.tsx', needles: ["ctaId: 'job_auth_gate.expired.unknown.view'", "trackJobAuthGate('success', {\n  surface: 'expired',\n  method: 'email'", 'ref={gateImpressionRef}'] },
    { file: 'components/community/JobOrphanView.tsx', needles: ["ctaId: 'job_auth_gate.orphan.unknown.view'", "trackJobAuthGate('success', {\n  surface: 'orphan',\n  method: 'email'", 'ref={gateImpressionRef}'] },
    { file: 'components/community/JobBridgeView.tsx', needles: ["ctaId: 'job_auth_gate.bridge.unknown.view'", "trackJobAuthGate('success', {\n  surface: 'bridge',\n  method: 'email'", "surface: 'bridge'", 'ref={gateImpressionRef}'] },
  ];

  for (const { file, needles } of SOURCE_TABLE) {
    it(`${file} wires the capture impression`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      if (!file.endsWith('NewsletterMount.tsx')) expect(src).toContain('useCaptureImpression(');
      for (const needle of needles) expect(src, needle).toContain(needle);
    });
  }
});

describe('capture boxes — rendered components emit the table ids', () => {
  it('LeadMagnetCTA emits lead_magnet.banner.show.<variant> when visible', () => {
    render(<LeadMagnetCTA variant="tax_checklist" />);
    expect(showCalls()).toHaveLength(0);
    FakeIO.instances.forEach((io) => io.report(1));
    expect(showCalls().map((c) => c[5])).toEqual(['lead_magnet.banner.show.tax_checklist']);
  });

  it('LamalSsnBreakeven emits lamal_ssn.email_pdf.show.lamal_ssn_tool when visible', () => {
    render(
      <LamalSsnBreakeven
        defaultAge={30}
        franchisesAdult={[300, 2500]}
        franchisesChild={[0]}
        computeCheapestPremium={() => null}
      />,
    );
    FakeIO.instances.forEach((io) => io.report(1));
    expect(showCalls().map((c) => c[5])).toEqual(['lamal_ssn.email_pdf.show.lamal_ssn_tool']);
  });
});
