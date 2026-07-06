/**
 * AdBlockGate — client-only AdBlock detection gate + 30/70 A/B test.
 * Part 1/2 of #2961, issue #3654.
 *
 * Scope:
 *  - Stable A/B bucket per visitor (services/adBlockAbTest.ts) — 30% "test",
 *    70% "control". Control always sees the site unchanged, even with an ad
 *    blocker active.
 *  - In the "test" bucket only: run the dual-signal ad-blocker probe
 *    (services/adBlockDetection.ts). If detected, show a full-screen gate
 *    offering exactly two ways forward — disable the blocker for this site,
 *    or go to the CHF 2.99/month no-ads subscription page. No dismiss/X button, no
 *    click-outside-to-close: this is the one deliberate exception to the
 *    site's "no invasive extra popups" convention, explicitly approved for
 *    this gate only (see AGENTS.md § Non-Negotiables) and does not
 *    generalize to any other popup on the site.
 *  - Never mounted for bots (isLikelyBot() gate, layered on top of the
 *    structural guarantee that this component only exists in the client
 *    React tree — it is lazy-loaded and never part of any server-rendered
 *    or static HTML; there is no ReactDOMServer usage anywhere in the
 *    build's SSG plugins).
 *  - Hard-excluded (owner refinement, #3655): a visitor already subscribed
 *    to the newsletter OR with an active job alert is treated exactly like
 *    the bot/control arm — no bucket resolution, no detection, no gate,
 *    ever. Checked via the raw localStorage flags
 *    (services/newsletterCtaState.ts, services/jobAlertCtaState.ts)
 *    immediately after the bot check, before any A/B assignment.
 *  - PostHog measurement: bucket-assignment event (fires for every non-bot
 *    visitor, both arms — needed to validate the split ratio) + gate-shown
 *    event + outcome event (disabled / subscribe CTA clicked / abandoned).
 *
 * The subscribe CTA navigates to the real Stripe checkout flow
 * (components/pages/SubscribePage, issue 2/2 of #2961 — #3655).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { registerSuperProperty } from '@/services/posthog';
import { isLikelyBot } from '@/services/botPatterns';
import { resolveAdBlockAbBucket } from '@/services/adBlockAbTest';
import { detectAdBlock } from '@/services/adBlockDetection';
import { useNavigationOptional } from '@/services/NavigationContext';
import { NEWSLETTER_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';

type GateLocale = 'it' | 'en' | 'de' | 'fr';
type GateOutcome = 'disabled' | 'subscribe_clicked' | 'abandoned';

// Self-contained 4-locale copy, matching the OfferwallNewsletterGate pattern —
// keeps this gate free of any dependency on on-demand locale chunk loading.
const COPY: Record<GateLocale, {
  title: string;
  body: string;
  instructionsToggle: string;
  instructionsBody: string;
  recheck: string;
  rechecking: string;
  subscribeCta: string;
}> = {
  it: {
    title: 'Abbiamo notato un AdBlock attivo',
    body: 'Il sito vive di pubblicità: senza, non possiamo restare gratuiti. Disattiva l’AdBlock per questo sito, oppure passa a un abbonamento senza pubblicità.',
    instructionsToggle: 'Come disattivare l’AdBlock',
    instructionsBody: 'Apri l’icona dell’estensione AdBlock/uBlock nella barra degli strumenti del browser e scegli "Disattiva su questo sito" o "Metti in pausa". Poi premi "Ricontrolla" qui sotto.',
    recheck: 'Ricontrolla',
    rechecking: 'Verifica in corso…',
    subscribeCta: 'Scopri l’abbonamento senza pubblicità',
  },
  en: {
    title: 'We noticed an active ad blocker',
    body: 'This site runs on advertising — without it, we can’t keep it free. Disable your ad blocker for this site, or switch to an ad-free subscription.',
    instructionsToggle: 'How to disable your ad blocker',
    instructionsBody: 'Open your AdBlock/uBlock extension icon in the browser toolbar and choose "Disable on this site" or "Pause". Then press "Recheck" below.',
    recheck: 'Recheck',
    rechecking: 'Checking…',
    subscribeCta: 'See the ad-free subscription',
  },
  de: {
    title: 'Wir haben einen aktiven Werbeblocker bemerkt',
    body: 'Diese Website finanziert sich über Werbung — ohne sie können wir sie nicht kostenlos anbieten. Deaktivieren Sie Ihren Werbeblocker für diese Website, oder wechseln Sie zu einem werbefreien Abonnement.',
    instructionsToggle: 'So deaktivieren Sie Ihren Werbeblocker',
    instructionsBody: 'Öffnen Sie das Symbol Ihrer AdBlock/uBlock-Erweiterung in der Symbolleiste des Browsers und wählen Sie „Auf dieser Website deaktivieren“ oder „Pausieren“. Klicken Sie danach unten auf „Erneut prüfen“.',
    recheck: 'Erneut prüfen',
    rechecking: 'Wird geprüft…',
    subscribeCta: 'Werbefreies Abonnement ansehen',
  },
  fr: {
    title: 'Nous avons détecté un bloqueur de publicités actif',
    body: 'Ce site vit de la publicité — sans elle, nous ne pouvons pas rester gratuits. Désactivez votre bloqueur de publicités pour ce site, ou passez à un abonnement sans publicité.',
    instructionsToggle: 'Comment désactiver votre bloqueur de publicités',
    instructionsBody: 'Ouvrez l’icône de votre extension AdBlock/uBlock dans la barre d’outils du navigateur et choisissez « Désactiver sur ce site » ou « Mettre en pause ». Puis cliquez sur « Revérifier » ci-dessous.',
    recheck: 'Revérifier',
    rechecking: 'Vérification…',
    subscribeCta: 'Découvrir l’abonnement sans publicité',
  },
};

function normalizeLocale(code?: string | null): GateLocale {
  const raw = String(code || 'it').toLowerCase().slice(0, 2);
  if (raw === 'en' || raw === 'de' || raw === 'fr') return raw;
  return 'it';
}

const AdBlockGate: React.FC = () => {
  const { locale } = useTranslation();
  const nav = useNavigationOptional();
  const [open, setOpen] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const outcomeLoggedRef = useRef(false);
  const activeTabRef = useRef(nav?.activeTab);
  activeTabRef.current = nav?.activeTab;

  const copy = COPY[normalizeLocale(locale)];

  const logOutcome = useCallback((outcome: GateOutcome) => {
    if (outcomeLoggedRef.current) return;
    outcomeLoggedRef.current = true;
    try { Analytics.trackUIInteraction('adblock_gate', 'modal', 'outcome', outcome); } catch { /* no-op */ }
  }, []);

  const closeGate = useCallback((outcome: 'disabled' | 'subscribe_clicked') => {
    logOutcome(outcome);
    setOpen(false);
  }, [logOutcome]);

  // Bucket assignment — resolved once per mount, reported for every non-bot
  // visitor (both arms) so the 30/70 split can be validated in PostHog.
  // Detection itself only runs for the "test" arm.
  useEffect(() => {
    if (isLikelyBot()) return;
    // Retained/engaged visitors (newsletter or job-alert subscribers) never
    // see this gate, regardless of bucket — same hard exclusion as bots,
    // checked BEFORE any bucket assignment (owner refinement, #3655).
    let alreadyEngaged = false;
    try {
      alreadyEngaged =
        localStorage.getItem(NEWSLETTER_SUBSCRIBED_KEY) === 'true' ||
        localStorage.getItem(JOB_ALERT_SUBSCRIBED_KEY) === 'true';
    } catch {
      alreadyEngaged = false; // fail-open: treat as not-subscribed on error.
    }
    if (alreadyEngaged) return;
    const bucket = resolveAdBlockAbBucket();
    registerSuperProperty('adblock_ab_bucket', bucket);
    try { Analytics.trackUIInteraction('adblock_gate', 'ab_test', 'bucket_assigned', bucket); } catch { /* no-op */ }
    if (bucket !== 'test') return; // control arm: no detection, no gate, ever.

    let cancelled = false;
    detectAdBlock().then((blocked) => {
      if (cancelled || !blocked) return;
      // Never trap the visitor on the escape-hatch page itself.
      if (activeTabRef.current === 'subscribe') return;
      outcomeLoggedRef.current = false;
      setOpen(true);
      try { Analytics.trackUIInteraction('adblock_gate', 'modal', 'show', 'detected'); } catch { /* no-op */ }
    });
    return () => { cancelled = true; };
  }, []);

  // Defensive auto-suppress if the visitor ends up on the subscribe
  // placeholder while the gate happens to still be open (the CTA click
  // already closes it — this covers back/forward navigation too).
  useEffect(() => {
    if (open && nav?.activeTab === 'subscribe') setOpen(false);
  }, [open, nav?.activeTab]);

  // Lock body scroll while the gate blocks the page, mirroring other
  // full-screen overlays on the site.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Log an "abandoned" outcome if the visitor leaves/hides the tab while the
  // gate is still open without picking either option.
  useEffect(() => {
    if (!open) return;
    const handleLeave = () => logOutcome('abandoned');
    const handleVisibility = () => { if (document.visibilityState === 'hidden') handleLeave(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handleLeave);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handleLeave);
    };
  }, [open, logOutcome]);

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      const stillBlocked = await detectAdBlock();
      if (!stillBlocked) closeGate('disabled');
    } finally {
      setRechecking(false);
    }
  };

  const handleSubscribeClick = () => {
    closeGate('subscribe_clicked');
    if (nav) nav.navigateTo('subscribe');
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="adblock-gate-title"
    >
      <div className="relative w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl border border-edge">
        <div className="mb-3 flex items-center gap-2 text-warning">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
          <h2 id="adblock-gate-title" className="text-lg font-semibold text-heading">
            {copy.title}
          </h2>
        </div>

        <p className="text-sm text-body mb-4">{copy.body}</p>

        <button
          type="button"
          onClick={() => setShowInstructions((v) => !v)}
          className="text-sm font-medium text-info hover:underline mb-2"
          aria-expanded={showInstructions}
        >
          {copy.instructionsToggle}
        </button>
        {showInstructions && (
          <p className="text-xs text-muted mb-4 rounded-lg bg-surface-alt p-3">{copy.instructionsBody}</p>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleRecheck}
            disabled={rechecking}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-info-strong px-4 py-2.5 font-semibold text-on-accent hover:bg-info-strong-hover disabled:opacity-60"
          >
            {rechecking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {rechecking ? copy.rechecking : copy.recheck}
          </button>
          <button
            type="button"
            onClick={handleSubscribeClick}
            className="w-full rounded-lg border border-edge px-4 py-2.5 text-sm font-semibold text-heading hover:bg-surface-alt"
          >
            {copy.subscribeCta}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AdBlockGate;
