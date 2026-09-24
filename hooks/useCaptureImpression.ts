/**
 * useCaptureImpression — visibility ("show") event for email-capture boxes.
 *
 * Why this exists: the footer newsletter, the NewsletterMount islands, every
 * LeadMagnetCTA variant, WeeklyDigest, the publisher email gate, the LAMal/SSN
 * PDF box and the expired/orphan/bridge job gates emitted submit events but no
 * view event, so GA4 could count "invii" but never "invii / visualizzazioni".
 *
 * Contract (pinned by tests/capture-impression.test.tsx):
 *   - emits AT MOST ONCE per mount (re-armed only if the box identity, i.e.
 *     its cta_id, changes while mounted), and at most once per page path per page
 *     lifetime for the same box (module-level claim keyed by cta_id + path), so
 *     a footer re-rendered by an SPA route change to the same path, or two
 *     copies of the same box on one page, still count as one impression;
 *   - counts only when at least `threshold` (default 0.5) of the box is inside
 *     the viewport — `isIntersecting` alone is NOT enough, because the first
 *     IntersectionObserver callback reports `isIntersecting: true` for a box
 *     that is 1% on screen;
 *   - never counts while the document is hidden or still a Speculation Rules
 *     prerender: it waits for `visibilitychange` / `prerenderingchange`;
 *   - never counts for `isLikelyBot()` sessions (same guard PostHog uses);
 *   - SSR-safe: nothing runs during render, only in effects;
 *   - without IntersectionObserver (very old browsers) it degrades to a
 *     mount-based impression, like hooks/useImpressionTracker.ts, rather than
 *     losing the denominator entirely.
 *
 * Event format: `ui_interaction` with page/section/component='show'/action=
 * variant, i.e. `cta_id = <page>.<section>.show.<variant>` — the same shape as
 * the existing `newsletter_popup.modal.show.smart_trigger` and
 * `lead_magnet.banner.dismiss.<variant>`. The variant is the same token the
 * box's submit event carries, so show and submit pair on it (see the table in
 * CAPTURE_BOX_CTA_IDS below).
 *
 * Surfaces whose view already has a dedicated contract (the job auth gates use
 * `job_auth_gate.<surface>.<method>.view`) pass `emit` + `ctaId` instead: the
 * visibility/dedupe logic stays here, the payload stays with its owner.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Analytics } from '@/services/analytics';
import { isLikelyBot } from '@/services/botPatterns';

export interface CaptureBoxKey {
  /** GA4 `page` param — the box family, e.g. `newsletter_box`, `lead_magnet`. */
  page: string;
  /** GA4 `section` param — the placement, e.g. `compact`, `island`, `banner`. */
  section: string;
  /** GA4 `action` param — the variant / source cta shared with the submit event. */
  variant: string;
}

/** `cta_id` of the show event for a capture box. */
export function buildCaptureShowCtaId({ page, section, variant }: CaptureBoxKey): string {
  return `${page}.${section}.show.${variant}`;
}

/**
 * Show/submit pairs for every capture box instrumented by this hook. Static
 * variants are literal; `{source}` / `{variant}` / `{domain}` mark the part
 * that comes from the box props (acquisition source, lead-magnet variant) or
 * from the existing submit event. Kept here so the PR table and the tests read
 * from one place.
 */
export const CAPTURE_BOX_CTA_IDS = [
  { box: 'Newsletter (footer / wizard, compact)', show: 'newsletter_box.compact.show.{source}', submit: 'newsletter.newsletter.{source}.subscribe' },
  { box: 'Newsletter (pagina /newsletter)', show: 'newsletter_box.page.show.{source}', submit: 'newsletter.newsletter.{source}.subscribe' },
  { box: 'NewsletterMount (isole meteo)', show: 'newsletter_box.island.show.{source}', submit: 'newsletter.newsletter.{source}.subscribe' },
  { box: 'LeadMagnetCTA', show: 'lead_magnet.banner.show.{variant}', submit: 'lead_magnet.form.subscribe.success_{variant}' },
  { box: 'WeeklyDigest', show: 'weekly_digest.form.show.weekly_digest', submit: 'weekly_digest.subscribe.success.{domain}' },
  { box: 'PublisherPublishPage gate email', show: 'publisher.gate.show.email_login', submit: 'publisher.gate.email_login.sent' },
  { box: 'LamalSsnBreakeven', show: 'lamal_ssn.email_pdf.show.lamal_ssn_tool', submit: 'lamal_ssn.email_pdf.submit.lamal_ssn_tool' },
  { box: 'JobExpiredView gate', show: 'job_auth_gate.expired.unknown.view', submit: 'job_auth_gate.expired.email.success' },
  { box: 'JobOrphanView gate', show: 'job_auth_gate.orphan.unknown.view', submit: 'job_auth_gate.orphan.email.success' },
  { box: 'JobBridgeView gate', show: 'job_auth_gate.bridge.unknown.view', submit: 'job_auth_gate.bridge.email.success' },
] as const;

const claimed = new Set<string>();

function currentPath(): string {
  try {
    return typeof window === 'undefined' ? '' : window.location.pathname;
  } catch {
    return '';
  }
}

/**
 * Claim the (cta_id, page path) slot. Returns false when the same box already
 * emitted on this path during this page lifetime.
 */
export function claimCaptureImpression(ctaId: string, path: string = currentPath()): boolean {
  const key = `${ctaId}|${path}`;
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

/** Test-only: forget every claim. */
export function resetCaptureImpressionClaimsForTests(): void {
  claimed.clear();
}

function pageNotShown(): boolean {
  if (typeof document === 'undefined') return true;
  const doc = document as Document & { prerendering?: boolean };
  if (doc.prerendering === true) return true;
  return doc.visibilityState === 'hidden';
}

export interface UseCaptureImpressionOptions extends CaptureBoxKey {
  /** When false the box is not observed (e.g. already subscribed, logged in). */
  enabled?: boolean;
  /** Fraction of the box that must be on screen. Default 0.5. */
  threshold?: number;
  /** Free-form details param; defaults to the variant. */
  details?: string;
  /** Override the dedupe/cta id — required together with `emit`. */
  ctaId?: string;
  /** Custom emitter for surfaces with their own view contract. */
  emit?: () => void;
}

/** Tolerance for browsers that report 0.4999… on an exactly-half-visible box. */
const RATIO_EPSILON = 0.01;

/**
 * Returns a ref callback to attach to the box whose visibility counts.
 */
export function useCaptureImpression(options: UseCaptureImpressionOptions): (node: Element | null) => void {
  const { enabled = true, threshold = 0.5 } = options;
  const ctaId = options.ctaId ?? buildCaptureShowCtaId(options);
  const [node, setNode] = useState<Element | null>(null);
  const firedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const emit = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (isLikelyBot()) return;
    if (!claimCaptureImpression(ctaId)) return;
    const opts = optionsRef.current;
    try {
      if (opts.emit) {
        opts.emit();
      } else {
        Analytics.trackUIInteraction(opts.page, opts.section, 'show', opts.variant, opts.details ?? opts.variant, ctaId);
      }
    } catch {
      /* analytics must never break the box */
    }
  }, [ctaId]);

  // A box whose identity changes while mounted (the footer picks up a new
  // contextual acquisition source on an SPA route change) is a different box:
  // re-arm so its show pairs with the submit that will carry the new source.
  // Declared before the observer effect so it runs first on the same commit.
  const armedForRef = useRef(ctaId);
  useEffect(() => {
    if (armedForRef.current !== ctaId) {
      armedForRef.current = ctaId;
      firedRef.current = false;
    }
  }, [ctaId]);

  useEffect(() => {
    if (!node || !enabled || firedRef.current) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      // Degrade to mount-based rather than dropping the denominator.
      if (!pageNotShown()) emit();
      return undefined;
    }

    let inView = false;
    const tryFire = () => {
      if (!inView || firedRef.current || pageNotShown()) return;
      emit();
      cleanup();
    };
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting && e.intersectionRatio >= threshold - RATIO_EPSILON);
        tryFire();
      },
      { threshold },
    );
    const onPageShown = () => tryFire();
    function cleanup() {
      io.disconnect();
      document.removeEventListener('visibilitychange', onPageShown);
      document.removeEventListener('prerenderingchange', onPageShown);
    }
    io.observe(node);
    document.addEventListener('visibilitychange', onPageShown);
    document.addEventListener('prerenderingchange', onPageShown);
    return cleanup;
  }, [node, enabled, threshold, emit]);

  return setNode;
}

export default useCaptureImpression;
