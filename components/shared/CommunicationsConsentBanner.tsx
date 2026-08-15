/**
 * CommunicationsConsentBanner — the consent-banner slot's second panel
 * (#5842, owner direction of 2026-08-15): collect OUR communications consent
 * from a visitor the SPA can already name, once per device, with the refusal
 * falling back to the activation/subscription acts that already record proof
 * (#5902).
 *
 * WHY SEQUENCED AFTER THE ADS DECISION, NOT MERGED WITH IT
 * --------------------------------------------------------
 * The ads decision now belongs to the Google Funding Choices popup (the CMP —
 * the custom AdsConsentBanner that used to own this slot's first turn was
 * removed in the CMP-single-surface rework), so a combined dialog is not even
 * possible: that surface is Google-rendered. And identity is NEVER known on
 * the first paint anyway — `useAuth` starts at idle (for LCP) and the
 * `ac → custom token` exchange of an email arrival is async. Strictly
 * sequential in the same slot instead: this panel does not render while the
 * ads decision is pending, so within ADS_DECISION_GRACE_MS the CMP question
 * and this one are never on screen together. Past the grace the panel
 * proceeds anyway — the missing decision then almost certainly means an ad
 * blocker kept the CMP from ever loading, and a hard gate would cost this
 * question to that whole segment; in the rare slow-CMP overlap the FC message
 * is a full-screen overlay and this banner just sits inert behind it until
 * the answer lands and `evaluate()` re-runs.
 *
 * WHEN IT SHOWS — every condition, and each is load-bearing:
 *  - `email` resolved (an anonymous visitor has no document to consent for);
 *  - the ads decision exists (the CMP question has priority over this one);
 *  - no answer stored on this device (once per device, either answer retires
 *    it — a consent prompt that returns on people who closed it is the
 *    invasiveness #5876 was trimmed to avoid);
 *  - the subscriber document EXISTS, carries NO proof and NO binding opt-out
 *    (`shouldOfferCommunicationsConsent`, fail-closed: a read failure means no
 *    banner, for the same reason the write path aborts).
 *
 * The formula on screen is `<ConsentNotice consentKey="communicationsOptIn">`
 * — the same function that produces the stored bytes, so what was shown and
 * what was recorded cannot drift. Accepting stamps the newsletter document —
 * server-side through `recordConsentViaEndpoint` when Firebase can prove
 * possession (`email_verified === true`), which also records the network of
 * origin; and, for the shell-account cohort the server refuses, falling back
 * to the client-side `recordCommunicationsConsent` unchanged (#5928, phase 2).
 * Either way it also stamps the travaso alerts (`upgradeBackfilledAlertConsent`
 * with this surface's own act — recording an activation click that did not
 * happen would fabricate the fact the register exists to establish). Declining
 * writes NOTHING: "not now" is not an opt-out, and the organic surfaces remain.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/services/i18n';
import ConsentNotice from '@/components/shared/ConsentNotice';
import { captureEvent } from '@/services/posthog';
import { needsAdsConsentDecision, onAdsConsentChange } from '@/services/adsConsent';
import { upgradeBackfilledAlertConsent } from '@/services/jobAlertService';
import { recordConsentViaEndpoint } from '@/services/newsletterRecordConsent';
import {
  COMMS_CONSENT_PROMPT_STORAGE_KEY,
  COMMUNICATIONS_BANNER_CONSENT_ACT,
  recordCommunicationsConsent,
  shouldOfferCommunicationsConsent,
} from '@/services/newsletterConsentUpgrade';

type Copy = {
  title: string;
  body: string;
  accept: string;
  decline: string;
  thanks: string;
};

// Inlined rather than routed through the locale JSON files: five strings across
// four locales, and the panel must not show a translation key (or Italian, to
// a German reader) at the exact moment a consent decision is being asked.
const COPY: Record<string, Copy> = {
  it: {
    title: 'Le nostre email',
    body: 'Questo indirizzo risulta iscritto alle nostre comunicazioni. Confermi di volerle ricevere?',
    accept: 'Sì, confermo',
    decline: 'Non ora',
    thanks: 'Registrato. Puoi cambiare idea in ogni momento dal centro preferenze.',
  },
  en: {
    title: 'Our emails',
    body: 'This address is subscribed to our communications. Do you confirm you want to receive them?',
    accept: 'Yes, I confirm',
    decline: 'Not now',
    thanks: 'Recorded. You can change your mind any time from the preference centre.',
  },
  de: {
    title: 'Unsere E-Mails',
    body: 'Diese Adresse ist für unsere Mitteilungen eingetragen. Bestätigen Sie, dass Sie sie erhalten möchten?',
    accept: 'Ja, ich bestätige',
    decline: 'Jetzt nicht',
    thanks: 'Gespeichert. Sie können Ihre Wahl jederzeit im Präferenzcenter ändern.',
  },
  fr: {
    title: 'Nos e-mails',
    body: 'Cette adresse est inscrite à nos communications. Confirmez-vous vouloir les recevoir ?',
    accept: 'Oui, je confirme',
    decline: 'Pas maintenant',
    thanks: 'Enregistré. Vous pouvez changer d’avis à tout moment depuis le centre de préférences.',
  },
};

type PromptAnswer = 'accepted' | 'dismissed';

/** Never throws: a broken localStorage reads as "not answered". */
function readPromptAnswer(): PromptAnswer | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(COMMS_CONSENT_PROMPT_STORAGE_KEY);
    return raw === 'accepted' || raw === 'dismissed' ? raw : null;
  } catch {
    return null;
  }
}

function writePromptAnswer(value: PromptAnswer): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMMS_CONSENT_PROMPT_STORAGE_KEY, value);
  } catch {
    /* quota / private mode — this visit still behaves as answered via state. */
  }
}

const THANKS_AUTO_DISMISS_MS = 3000;

// How long the CMP keeps exclusive claim on the consent slot while no ads
// decision exists. The FC loader is idle-deferred (timeout 4000ms) and the
// popup needs a beat to render and be answered; past this window the missing
// decision almost certainly means the CMP was blocked (ad blocker) and will
// never write one — so the communications question proceeds without it.
// Exported for tests/communications-consent-banner.test.tsx (fake timers).
export const ADS_DECISION_GRACE_MS = 15000;

export interface CommunicationsConsentBannerProps {
  /** The identified visitor's email (`authEmail` in App.tsx), or null while unknown. */
  email: string | null;
  /** Optional overrides (used by tests). */
  checkEligibility?: typeof shouldOfferCommunicationsConsent;
  recordViaServer?: typeof recordConsentViaEndpoint;
  recordConsent?: typeof recordCommunicationsConsent;
  upgradeConsent?: typeof upgradeBackfilledAlertConsent;
}

export default function CommunicationsConsentBanner({
  email,
  checkEligibility = shouldOfferCommunicationsConsent,
  recordViaServer = recordConsentViaEndpoint,
  recordConsent = recordCommunicationsConsent,
  upgradeConsent = upgradeBackfilledAlertConsent,
}: CommunicationsConsentBannerProps) {
  const { locale } = useTranslation();
  // Start hidden and decide in effects: the eligibility read touches
  // localStorage and Firestore, neither of which exists during SSR/prerender.
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'thanks'>('idle');

  useEffect(() => {
    if (!email) {
      setVisible(false);
      return;
    }
    if (readPromptAnswer() !== null) return;
    let cancelled = false;
    // The ads decision is written by the CMP bridge — a third-party script an
    // ad blocker routinely keeps from ever loading. For that segment the
    // decision stays `null` forever, and a hard gate here would mean the
    // communications question is never asked on any device with an ad blocker
    // (review round 1). Hence the grace: the CMP keeps priority for as long as
    // it can plausibly still show up (idle-deferred load + render), and after
    // that this panel takes the slot anyway. If the CMP popup is in fact open
    // past the grace, it is a full overlay: this banner sits inertly behind it
    // and re-evaluates the moment the answer lands.
    let graceElapsed = false;
    const evaluate = () => {
      if (cancelled) return;
      // The CMP popup owns the ads decision; until the bridge records one,
      // this slot stays empty (within the grace window).
      if (needsAdsConsentDecision() && !graceElapsed) {
        setVisible(false);
        return;
      }
      void checkEligibility(email).then((eligible) => {
        if (!cancelled && readPromptAnswer() === null) setVisible(eligible);
      });
    };
    evaluate();
    const graceTimer = setTimeout(() => {
      graceElapsed = true;
      evaluate();
    }, ADS_DECISION_GRACE_MS);
    // The CMP bridge writing the decision frees the slot — re-evaluate
    // without a reload.
    const off = onAdsConsentChange(() => evaluate());
    return () => {
      cancelled = true;
      clearTimeout(graceTimer);
      off();
    };
  }, [email, checkEligibility]);

  useEffect(() => {
    if (visible && status === 'idle') captureEvent('comms_consent_shown', { surface: 'consent_banner' });
  }, [visible, status]);

  useEffect(() => {
    if (status !== 'thanks') return;
    const id = window.setTimeout(() => setVisible(false), THANKS_AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  const accept = useCallback(async () => {
    if (!email) return;
    setStatus('saving');
    writePromptAnswer('accepted');
    // The write is awaited so the telemetry can tell the truth: the accepted
    // event carries the write's real outcome, because a device whose write
    // failed never re-prompts (the marker above) — without `recorded` that
    // loss would be permanent AND invisible.
    //
    // TRUSTED PATH FIRST (#5928): try the server, which writes the proof AND
    // the network of origin only when Firebase says `email_verified === true`
    // for this account. If it takes the write (`serverHandled`), the client
    // must NOT also write — the server already recorded it, with the IP a
    // browser cannot see. It refuses the shell-account cohort
    // (`email_verified: false`, the banner's majority), and for them we FALL
    // BACK to the exact client-side write of before, unchanged, minus the IP:
    // trusting their claim is the forgery the gate exists to stop.
    let recorded = false;
    let reason: string | null = null;
    let via: 'server' | 'client' = 'client';
    let server: Awaited<ReturnType<typeof recordViaServer>> = { serverHandled: false };
    try {
      server = await recordViaServer(email, locale);
    } catch {
      /* recordConsentViaEndpoint never throws by contract; belt and braces. */
    }
    if (server.serverHandled) {
      via = 'server';
      recorded = server.recorded;
      reason = server.reason ?? null;
    } else {
      // Fallback: the current client-side write. Same contract as before —
      // never throws, never creates, never overwrites an existing proof.
      let outcome: Awaited<ReturnType<typeof recordConsent>> = {
        recorded: false,
        reason: 'write-failed',
      };
      try {
        outcome = await recordConsent(email, locale);
      } catch {
        /* recordConsent never throws by contract; belt and braces. */
      }
      recorded = outcome.recorded;
      reason = outcome.reason ?? null;
    }
    captureEvent('comms_consent_accepted', {
      surface: 'consent_banner',
      recorded,
      reason,
      via,
    });
    // The alert-side upgrade stays fire-and-forget like every activation CTA —
    // a proof that fails to land must not surface an error — and runs on both
    // paths: it stamps the travaso ALERT documents, which the newsletter write
    // above (server or client) does not touch.
    void upgradeConsent(email, locale, { act: COMMUNICATIONS_BANNER_CONSENT_ACT }).catch(() => {});
    setStatus('thanks');
  }, [email, locale, recordViaServer, recordConsent, upgradeConsent]);

  const decline = useCallback(() => {
    writePromptAnswer('dismissed');
    captureEvent('comms_consent_declined', { surface: 'consent_banner' });
    setVisible(false);
  }, []);

  if (!visible) return null;
  const copy = COPY[locale] ?? COPY.it;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="comms-consent-title"
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-edge/50 bg-surface/98 backdrop-blur px-4 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] md:pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-[0_-4px_16px_rgba(0,0,0,0.12)]"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        {status === 'thanks' ? (
          <p className="min-w-0 flex-1 text-sm opacity-80">{copy.thanks}</p>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <p id="comms-consent-title" className="text-sm font-semibold">
                {copy.title}
              </p>
              <p className="mt-1 text-sm opacity-80">{copy.body}</p>
              <ConsentNotice
                consentKey="communicationsOptIn"
                locale={locale}
                className="mt-2 text-xs opacity-70 leading-relaxed block"
              />
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={decline}
                disabled={status === 'saving'}
                className="min-h-[44px] rounded-lg border border-edge/60 px-4 text-sm font-medium disabled:opacity-50"
              >
                {copy.decline}
              </button>
              <button
                type="button"
                onClick={accept}
                disabled={status === 'saving'}
                aria-busy={status === 'saving'}
                className="min-h-[44px] rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-80"
              >
                {copy.accept}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
