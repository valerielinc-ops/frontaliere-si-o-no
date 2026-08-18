/**
 * AdBlockGate — client-only AdBlock detection gate + 30/70 A/B test.
 * Part 1/2 of #2961, issue #3654.
 *
 * Scope:
 * - Stable A/B bucket per visitor (services/adBlockAbTest.ts) — 30% "test",
 *   70% "control". Control always sees the site unchanged, even with an ad
 *   blocker active.
 * - In the "test" bucket only: run the dual-signal ad-blocker probe
 *   (services/adBlockDetection.ts). If detected, show a full-screen gate
 *   offering exactly two ways forward — disable the blocker for the site,
 *   or go to the CHF 2.99/month no-ads subscription page. No dismiss/X
 *   button, no click-outside-to-close: one deliberate exception to the
 *   site's "no invasive extra popups" convention, explicitly approved for
 *   this gate only (see AGENTS.md § Non-Negotiables), not to be
 *   generalized to any other popup on the site.
 * - Never mounted for bots (isLikelyBot() gate, layered on top of the
 *   structural guarantee that this component only exists in the client
 *   React tree — lazy-loaded, never part of any server-rendered
 *   static HTML; no ReactDOMServer usage anywhere in the build's SSG plugins).
 * - Hard-excluded (owner refinement, #3655): a visitor already subscribed to
 *   the newsletter OR with an active job alert is treated exactly like the
 *   bot/control arm — no bucket resolution, no detection, no gate, ever.
 *   Checked via raw localStorage flags (services/newsletterCtaState.ts,
 *   services/jobAlertCtaState.ts) immediately before any bot check, before
 *   any A/B assignment.
 * - PostHog measurement: bucket-assignment event (fires for every non-bot
 *   visitor, both arms — needed to validate the split ratio) + gate-shown
 *   event + outcome event (disabled / subscribe CTA clicked / abandoned /
 *   reload_still_blocked). 'disabled' is reported from two places: the
 *   in-place recheck, and — via a sessionStorage marker that survives the
 *   reload — the document that comes back after the gate's own reload button,
 *   which is the only path on which a paused blocker actually stops reporting
 *   itself. Hiding the tab is recorded as `tab_hidden`, never as an outcome:
 *   it is how the visitor reaches the extension menu.
 * - GA4 measurement (#3654 UX pass): distinct named events for every
 *   interactive element in the gate — popup_cta_subscribe, popup_cta_adblock,
 *   popup_adblock_disable, popup_instructions_toggle — each carrying
 *   event_category: 'popup', event_label: <element>, page_location. The
 *   page_view for /abbonamento/ itself is already covered by the app-wide
 *   SPA route-change tracker (App.tsx), not duplicated here.
 * - Re-arm on navigation away from the subscribe escape-hatch page: the gate
 *   suppresses itself while the visitor is on the 'subscribe' tab (so it
 *   never traps them on their own way out), but re-runs detection the
 *   moment they leave that tab for anywhere else, reopening if the blocker
 *   is still active. Edge-triggered on the subscribe→elsewhere transition
 *   only, so it fires once per visit to the page, not on every navigation.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, Loader2, Sparkles, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { registerSuperProperty } from '@/services/posthog';
import { isLikelyBot } from '@/services/botPatterns';
import { resolveAdBlockAbBucket, type AdBlockAbBucket } from '@/services/adBlockAbTest';
import { detectAdBlockDetailed } from '@/services/adBlockDetection';
import { useNavigationOptional } from '@/services/NavigationContext';
import { NEWSLETTER_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';
import { JOB_ALERT_SUBSCRIBED_KEY } from '@/services/jobAlertCtaState';

type GateLocale = 'it' | 'en' | 'de' | 'fr';
type GateOutcome = 'disabled' | 'subscribe_clicked' | 'abandoned' | 'reload_still_blocked';

// Self-contained 4-locale copy, matching the OfferwallNewsletterGate pattern —
// keeps this gate free of any dependency on the on-demand locale chunk loader.
const COPY: Record<GateLocale, {
  title: string;
  body: string;
  headline: string;
  urgency: string;
  benefits: string[];
  socialProof: string;
  instructionsToggle: string;
  instructionsBody: string;
  recheck: string;
  rechecking: string;
  reloadHint: string;
  reloadCta: string;
  subscribeCta: string;
}> = {
  it: {
    title: 'Abbiamo notato un AdBlock attivo',
    body: 'Il sito vive di pubblicità: senza, non possiamo restare gratuiti.',
    headline: 'Naviga senza pubblicità, per sempre.',
    urgency: 'Bastano 30 secondi per liberarti dalla pubblicità su tutto il sito.',
    benefits: [
      'Zero banner, video e interstitial pubblicitari su tutto il sito',
      'Attivo subito dopo il pagamento, nessun vincolo',
      'Disdici quando vuoi in un clic dal portale Stripe',
    ],
    socialProof: 'Fai parte di una community di oltre 2.500 frontalieri',
    instructionsToggle: 'Come disattivare l’AdBlock',
    instructionsBody: 'Apri l’icona dell’estensione AdBlock/uBlock nella barra degli strumenti del browser e scegli "Disattiva su questo sito" o "Metti in pausa". Poi premi "Ricontrolla" qui sotto.',
    recheck: 'Ricontrolla AdBlock',
    rechecking: 'Verifica in corso…',
    reloadHint: 'Ancora rilevato. Se hai già disattivato l’estensione, il browser deve ricaricare la pagina per applicare la modifica.',
    reloadCta: 'Ricarica pagina',
    subscribeCta: 'Attiva l’abbonamento — CHF 2.99/mese',
  },
  en: {
    title: 'We noticed an active ad blocker',
    body: 'This site runs on advertising — without it, we can’t keep it free.',
    headline: 'Browse ad-free. For good.',
    urgency: 'Takes 30 seconds to go ad-free across the whole site.',
    benefits: [
      'Zero banners, video or interstitial ads sitewide',
      'Active immediately after payment, no lock-in',
      'Cancel anytime in one click from Stripe’s portal',
    ],
    socialProof: 'Join a community of 2,500+ cross-border workers',
    instructionsToggle: 'How to disable your ad blocker',
    instructionsBody: 'Open your AdBlock/uBlock extension icon in the browser toolbar and choose "Disable on this site" or "Pause". Then press "Recheck" below.',
    recheck: 'Recheck ad blocker',
    rechecking: 'Checking…',
    reloadHint: 'Still detected. If you’ve already disabled the extension, the browser needs to reload the page for the change to take effect.',
    reloadCta: 'Reload page',
    subscribeCta: 'Subscribe — CHF 2.99/mo',
  },
  de: {
    title: 'Wir haben einen aktiven Werbeblocker bemerkt',
    body: 'Diese Website finanziert sich über Werbung — ohne sie können wir sie nicht kostenlos anbieten.',
    headline: 'Werbefrei surfen. Für immer.',
    urgency: 'In 30 Sekunden werbefrei auf der ganzen Website.',
    benefits: [
      'Keine Banner, Video- oder Interstitial-Werbung auf der ganzen Seite',
      'Sofort aktiv nach der Zahlung, keine Mindestlaufzeit',
      'Jederzeit mit einem Klick über das Stripe-Portal kündbar',
    ],
    socialProof: 'Werden Sie Teil einer Community von über 2.500 Grenzgängern',
    instructionsToggle: 'So deaktivieren Sie Ihren Werbeblocker',
    instructionsBody: 'Öffnen Sie das Symbol Ihrer AdBlock/uBlock-Erweiterung in der Symbolleiste des Browsers und wählen Sie „Auf dieser Website deaktivieren“ oder „Pausieren“. Klicken Sie danach unten auf „Erneut prüfen“.',
    recheck: 'Werbeblocker erneut prüfen',
    rechecking: 'Wird geprüft…',
    reloadHint: 'Weiterhin erkannt. Wenn Sie die Erweiterung bereits deaktiviert haben, muss die Seite neu geladen werden, damit die Änderung wirksam wird.',
    reloadCta: 'Seite neu laden',
    subscribeCta: 'Abonnieren — CHF 2.99/Monat',
  },
  fr: {
    title: 'Nous avons détecté un bloqueur de publicités actif',
    body: 'Ce site vit de la publicité — sans elle, nous ne pouvons pas rester gratuits.',
    headline: 'Naviguez sans publicité. Pour de bon.',
    urgency: '30 secondes suffisent pour dire adieu à la pub sur tout le site.',
    benefits: [
      'Aucune bannière, vidéo ou publicité interstitielle sur tout le site',
      'Actif immédiatement après paiement, sans engagement',
      'Résiliable à tout moment en un clic depuis le portail Stripe',
    ],
    socialProof: 'Rejoignez une communauté de plus de 2 500 frontaliers',
    instructionsToggle: 'Comment désactiver votre bloqueur de publicités',
    instructionsBody: 'Ouvrez l’icône de votre extension AdBlock/uBlock dans la barre d’outils du navigateur et choisissez « Désactiver sur ce site » ou « Mettre en pause ». Puis cliquez sur « Revérifier » ci-dessous.',
    recheck: 'Revérifier le bloqueur',
    rechecking: 'Vérification…',
    reloadHint: 'Toujours détecté. Si vous avez déjà désactivé l’extension, le navigateur doit recharger la page pour appliquer le changement.',
    reloadCta: 'Recharger la page',
    subscribeCta: 'S’abonner — CHF 2.99/mois',
  },
};

function normalizeLocale(code?: string | null): GateLocale {
  const raw = String(code || 'it').toLowerCase().slice(0, 2);
  if (raw === 'en' || raw === 'de' || raw === 'fr') return raw;
  return 'it';
}

/**
 * The gate's reload button unloads the page on purpose, so whatever happens
 * next — blocker gone or still there — happens in a different document than
 * the one that asked. Without a marker that survives the reload, the only
 * path on which a visitor CAN successfully disable a blocker is also the one
 * path whose outcome we never see. sessionStorage, not localStorage: the
 * question is scoped to this visit.
 */
const RELOAD_MARKER_KEY = 'ft_adblock_reload_pending';
const RELOAD_MARKER_TTL_MS = 5 * 60 * 1000;

function markReloadFromGate(): void {
  try { sessionStorage.setItem(RELOAD_MARKER_KEY, String(Date.now())); } catch { /* storage disabled — outcome simply stays unknown */ }
}

/** Reads and clears the marker. Stale markers (restored tab, much later) do not count. */
function consumeReloadMarker(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_MARKER_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(RELOAD_MARKER_KEY);
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < RELOAD_MARKER_TTL_MS;
  } catch { return false; }
}

function trackPopupEvent(eventName: string, buttonName: string): void {
  try {
    Analytics.trackEvent(eventName, {
      event_category: 'popup',
      event_label: buttonName,
      page_location: window.location.href,
    });
  } catch { /* no-op */ }
}

function isEngagedVisitor(): boolean {
  try {
    return (
      localStorage.getItem(NEWSLETTER_SUBSCRIBED_KEY) === 'true' ||
      localStorage.getItem(JOB_ALERT_SUBSCRIBED_KEY) === 'true'
    );
  } catch {
    return false; // fail-open: treat as not-subscribed on error.
  }
}

const AdBlockGate: React.FC = () => {
  const { locale } = useTranslation();
  const nav = useNavigationOptional();
  const [open, setOpen] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckFailed, setRecheckFailed] = useState(false);
  const outcomeLoggedRef = useRef(false);
  // The gate asks the visitor to leave the page; that is not abandonment.
  // These two keep the intended flow from being logged as one.
  const tabHiddenLoggedRef = useRef(false);
  const reloadInitiatedRef = useRef(false);
  const activeTabRef = useRef(nav?.activeTab);
  activeTabRef.current = nav?.activeTab;
  const bucketRef = useRef<AdBlockAbBucket | null>(null);
  const wasOnSubscribeTabRef = useRef(false);

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
    if (isEngagedVisitor()) return;
    const bucket = resolveAdBlockAbBucket();
    bucketRef.current = bucket;
    registerSuperProperty('adblock_ab_bucket', bucket);
    try { Analytics.trackUIInteraction('adblock_gate', 'ab_test', 'bucket_assigned', bucket); } catch { /* no-op */ }
    if (bucket !== 'test') return; // control arm: no detection, no gate, ever.

    let cancelled = false;
    // Read before the probe: this document exists because the previous one
    // reloaded itself from the gate, and this is where that path's outcome
    // becomes observable at all.
    const cameBackFromGateReload = consumeReloadMarker();
    detectAdBlockDetailed().then(({ blocked, adsAllowed }) => {
      if (cancelled) return;
      // Funding Choices says this visitor already allowlisted the site. They
      // did exactly what the gate asks for, possibly through Google's own
      // recovery message rather than ours — gating them again would punish
      // the one action we wanted. Their ads may still be blocked elsewhere on
      // the page, so `blocked` alone is not enough to tell the two apart.
      if (adsAllowed) {
        if (cameBackFromGateReload) {
          try { Analytics.trackUIInteraction('adblock_gate', 'modal', 'outcome', 'disabled', 'allowlisted'); } catch { /* no-op */ }
        }
        return;
      }
      if (cameBackFromGateReload) {
        // A reload is the only way a paused blocker stops reporting itself:
        // cosmetic filter rules already injected into the previous document
        // survive the pause, which is why the in-place recheck so rarely
        // succeeds (see the comment on handleRecheck).
        try {
          Analytics.trackUIInteraction(
            'adblock_gate',
            'modal',
            'outcome',
            blocked ? 'reload_still_blocked' : 'disabled',
            'after_reload',
          );
        } catch { /* no-op */ }
      }
      if (!blocked) return;
      // Never trap the visitor on the escape-hatch page itself.
      if (activeTabRef.current === 'subscribe') return;
      outcomeLoggedRef.current = false;
      tabHiddenLoggedRef.current = false;
      setRecheckFailed(false);
      setOpen(true);
      try { Analytics.trackUIInteraction('adblock_gate', 'modal', 'show', 'detected'); } catch { /* no-op */ }
    });
    return () => { cancelled = true; };
  }, []);

  // Re-arm on navigation away from the subscribe page (#3654 UX fix): the
  // gate is suppressed while the visitor is on 'subscribe' (effect below),
  // but nothing previously re-ran detection once they left it — a full page
  // refresh was required to see the gate again even if the blocker was
  // still active. Edge-triggered on the subscribe→elsewhere transition only
  // (tracked via wasOnSubscribeTabRef), so this fires once per visit to the
  // page rather than on every tab change, avoiding any re-check loop.
  useEffect(() => {
    const currentTab = nav?.activeTab;
    const leftSubscribeTab = wasOnSubscribeTabRef.current && currentTab !== 'subscribe';
    wasOnSubscribeTabRef.current = currentTab === 'subscribe';
    if (!leftSubscribeTab || open) return;
    if (bucketRef.current !== 'test') return;
    if (isLikelyBot() || isEngagedVisitor()) return;

    let cancelled = false;
    detectAdBlockDetailed().then(({ blocked, adsAllowed }) => {
      if (cancelled || !blocked || adsAllowed) return;
      outcomeLoggedRef.current = false;
      tabHiddenLoggedRef.current = false;
      setRecheckFailed(false);
      setOpen(true);
      try { Analytics.trackUIInteraction('adblock_gate', 'modal', 'show', 'detected_revisit'); } catch { /* no-op */ }
    });
    return () => { cancelled = true; };
  }, [nav?.activeTab, open]);

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

  // "Abandoned" now means the visitor really walked away. Two things used to
  // be counted as abandonment and are not:
  //
  //  - visibilitychange → hidden fires when the visitor switches to the
  //    browser's extension menu to turn the blocker off — the single action
  //    this gate exists to ask for. Because logOutcome is one-shot, that
  //    reading also SEALED the outcome, so the 'disabled' that followed was
  //    dropped. Measured over 2026-07-27..08-18: outcome=disabled 0 while the
  //    in-page popup_adblock_disable counter recorded 4, and
  //    'subscribe_clicked' — the one outcome reachable without leaving the
  //    page — matched its counter exactly (3 = 3).
  //  - the gate's own reload button, which unloads the page deliberately; the
  //    outcome of that path is decided after the reload, in the mount effect.
  //
  // Tab-hiding is still worth counting, just not as an outcome.
  useEffect(() => {
    if (!open) return;
    const handleHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      if (tabHiddenLoggedRef.current) return;
      tabHiddenLoggedRef.current = true;
      try { Analytics.trackUIInteraction('adblock_gate', 'modal', 'tab_hidden', 'while_open'); } catch { /* no-op */ }
    };
    const handleUnload = () => {
      if (reloadInitiatedRef.current) return; // our own reload, not a departure
      logOutcome('abandoned');
    };
    document.addEventListener('visibilitychange', handleHidden);
    window.addEventListener('pagehide', handleUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleHidden);
      window.removeEventListener('pagehide', handleUnload);
    };
  }, [open, logOutcome]);

  // Most ad blockers apply cosmetic CSS hiding rules via a content script
  // that only runs on page load — pausing/disabling the extension mid-session
  // does not retroactively strip the already-injected rules, so the bait
  // element in the heuristic fallback keeps reporting "blocked" until the page
  // is reloaded (the network-level signal alone updates live, but the probe ORs
  // it with the stale cosmetic one). Funding Choices' getAllowAdsStatus() is
  // exempt from this — it reports the allowlisting itself, not a side effect of
  // it, which is why the recheck consults it first. A second failed check offers an
  // explicit reload instead of leaving the visitor re-clicking a button that
  // can never succeed without one.
  const handleRecheck = async () => {
    trackPopupEvent('popup_cta_adblock', 'recheck_cta');
    setRechecking(true);
    try {
      // `live`: the Funding Choices snapshot was taken at page load, when the
      // blocker was still on. Trusting its verdict here would answer the
      // question the visitor just changed the answer to.
      const { blocked: stillBlocked, adsAllowed } = await detectAdBlockDetailed({ live: true });
      if (adsAllowed) {
        trackPopupEvent('popup_adblock_disable', 'adblock_allowlisted_confirmed');
        closeGate('disabled');
        return;
      }
      if (!stillBlocked) {
        trackPopupEvent('popup_adblock_disable', 'adblock_disabled_confirmed');
        closeGate('disabled');
        return;
      }
      setRecheckFailed(true);
    } finally {
      setRechecking(false);
    }
  };

  const handleReload = () => {
    trackPopupEvent('popup_cta_adblock', 'reload_cta');
    // Set BOTH before reloading: the ref stops this unload being read as a
    // departure, the marker lets the next document report what happened.
    reloadInitiatedRef.current = true;
    markReloadFromGate();
    window.location.reload();
  };

  const handleSubscribeClick = () => {
    trackPopupEvent('popup_cta_subscribe', 'subscribe_cta');
    closeGate('subscribe_clicked');
    if (nav) nav.navigateTo('subscribe');
  };

  const handleToggleInstructions = () => {
    trackPopupEvent('popup_instructions_toggle', showInstructions ? 'hide' : 'show');
    setShowInstructions((v) => !v);
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="adblock-gate-title"
    >
      <div className="animate-gate-in relative w-full max-w-md overflow-hidden rounded-2xl border border-edge bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 p-6 shadow-2xl sm:p-7">
        <div className="pointer-events-none absolute -top-24 -right-24 h-56 w-56 rounded-full bg-accent/20 blur-3xl" aria-hidden="true" />

        {/* Secondary: adblock-detected notice strip (was the whole gate's framing; demoted to context) */}
        <div className="relative mb-4 flex items-start gap-2 rounded-lg bg-white/5 px-3 py-2">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <p className="text-xs leading-snug text-on-accent/80">{copy.title} — {copy.body}</p>
        </div>

        {/* Primary: headline + benefits + social proof + subscribe CTA */}
        <h2 id="adblock-gate-title" className="relative mb-2 text-2xl font-extrabold leading-tight text-on-accent sm:text-[1.75rem]">
          {copy.headline}
        </h2>
        <p className="relative mb-4 text-sm text-on-accent/85">{copy.urgency}</p>

        <ul className="relative mb-5 flex flex-col gap-2">
          {copy.benefits.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2 text-sm text-on-accent/90">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-accent-hover" aria-hidden="true" />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={handleSubscribeClick}
          className="cta-sheen animate-cta-pulse relative flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-hover px-5 py-3.5 text-base font-bold text-on-accent shadow-lg transition hover:brightness-110"
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          {copy.subscribeCta}
        </button>

        <p className="relative mt-3 text-center text-xs text-on-accent/75">{copy.socialProof}</p>

        <div className="relative mt-5 border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={handleToggleInstructions}
            className="text-xs font-medium text-on-accent/70 hover:text-on-accent hover:underline"
            aria-expanded={showInstructions}
          >
            {copy.instructionsToggle}
          </button>
          {showInstructions && (
            <p className="mt-2 rounded-lg bg-white/5 p-3 text-xs text-on-accent/75">{copy.instructionsBody}</p>
          )}

          <button
            type="button"
            onClick={handleRecheck}
            disabled={rechecking}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-xs font-medium text-on-accent/70 transition hover:bg-white/5 hover:text-on-accent disabled:opacity-60"
          >
            {rechecking && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {rechecking ? copy.rechecking : copy.recheck}
          </button>

          {recheckFailed && (
            <div className="mt-3">
              <p className="mb-2 text-xs text-on-accent/75">{copy.reloadHint}</p>
              <button
                type="button"
                onClick={handleReload}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-on-accent transition hover:bg-white/15"
              >
                {copy.reloadCta}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default AdBlockGate;
