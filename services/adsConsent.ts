/**
 * adsConsent — opt-in gate for ADVERTISING scripts only.
 *
 * Scope, decided by the owner in #5842 and deliberately narrow:
 *   - IN  scope: Auto Ads / AdSense (`adsbygoogle.js`), GPT (`gpt.js`), and
 *     Meta Pixel across the canonical site after explicit consent, including
 *     service funnel events and consented server-side Purchase events.
 *   - OUT of scope: GA4, PostHog, Clarity. Those stay covered by the honest
 *     disclosure shipped in #5832 and remain outside this advertising gate.
 *
 * ── Why a NEW storage key, and not `frontaliere_consent` ──────────────
 *
 * `services/consentService.ts` already persists a `frontaliere_consent` blob,
 * but it is NOT a record of a user choice: `setDefaultConsent()` writes
 * `{ analytics: true, advertising: true }` on the first page load of every
 * visitor, silently, with no UI ever shown. Reading `advertising` from that
 * blob would therefore return `true` for essentially the whole existing
 * audience — a gate that compiles, has tests, and blocks nobody.
 *
 * So ad consent lives in its own key with a three-valued reading, and only a
 * literal `'granted'` opens the gate:
 *
 *   null       → the visitor has not been asked / has not answered  → BLOCKED
 *   'denied'   → the visitor said no                                 → BLOCKED
 *   'granted'  → the visitor said yes                                → allowed
 *
 * Absence is blocking, and every failure mode of this module (no localStorage,
 * quota error, corrupted value, SSR/prerender with no `window`) collapses to
 * `null`. The gate fails CLOSED: a broken read serves no ads, it does not serve
 * ads unconditionally.
 *
 * ── Static pages share these constants, they do not re-type them ──────
 *
 * Statically generated pages do not run this module: they carry an inline
 * loader (`ADSENSE_LOADER_CONTENT` in build-plugins/constants.ts) that reads
 * localStorage directly, exactly like the `reader_noads_active` entitlement
 * check that already lives there. That loader string is *built from* the two
 * constants below, imported at build time — so the SPA gate and the static
 * shells cannot drift apart about which key means consent.
 * `tests/ads-consent-gate.test.ts` pins the emitted loader to them.
 * The static Meta Pixel loader reads the same consent key before contacting
 * Meta; its HTML snippet has no `noscript` beacon that could bypass the gate.
 */

/** localStorage key. Also consumed by build-plugins/constants.ts. */
export const ADS_CONSENT_STORAGE_KEY = 'frontaliere_ads_consent';
export const ADS_CONSENT_DECISION_AT_STORAGE_KEY = 'frontaliere_ads_consent_decision_at';

/** The only value that opens the gate. Also consumed by build-plugins/constants.ts. */
export const ADS_CONSENT_GRANTED = 'granted';
export const ADS_CONSENT_DENIED = 'denied';

export type AdsConsentValue = typeof ADS_CONSENT_GRANTED | typeof ADS_CONSENT_DENIED;
type AdsConsentWindow = Window & {
  __ftAdsConsentDecision?: AdsConsentValue;
  __ftAdsConsentDecisionAt?: number;
};

/**
 * Fired on same-tab changes; cross-tab changes arrive via the `storage` event.
 * Exported because the CMP→gate bridge (FC_CONSENT_BRIDGE_JS in
 * build-plugins/constants.ts, plus its byte-identical inline copy in
 * index.html) dispatches this same event from vanilla JS when the visitor
 * answers the Google Funding Choices message — every `onAdsConsentChange`
 * subscriber reacts to a CMP decision exactly as it reacted to the old banner.
 */
export const ADS_CONSENT_CHANGE_EVENT = 'frontaliere:ads-consent';
const CHANGE_EVENT = ADS_CONSENT_CHANGE_EVENT;

/**
 * Current stored decision, or `null` when the visitor has not answered.
 * Never throws: any failure reads as "no decision", which blocks.
 */
export function getAdsConsent(): AdsConsentValue | null {
  if (typeof window === 'undefined') return null;
  const memory = (window as AdsConsentWindow).__ftAdsConsentDecision;
  if (memory === ADS_CONSENT_GRANTED || memory === ADS_CONSENT_DENIED) return memory;
  try {
    const raw = window.localStorage.getItem(ADS_CONSENT_STORAGE_KEY);
    if (raw === ADS_CONSENT_GRANTED) return ADS_CONSENT_GRANTED;
    if (raw === ADS_CONSENT_DENIED) return ADS_CONSENT_DENIED;
    return null;
  } catch {
    return null;
  }
}

/** Timestamp for the local choice. One-time migration timestamps prior explicit choices. */
export function getAdsConsentDecisionAt(): number {
  if (typeof window === 'undefined') return 0;
  const consentWindow = window as AdsConsentWindow;
  const memory = consentWindow.__ftAdsConsentDecisionAt;
  if (Number.isFinite(memory) && Number(memory) > 0) return Number(memory);

  let decision = consentWindow.__ftAdsConsentDecision;
  try {
    const storedRaw = window.localStorage.getItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY);
    const stored = Number(storedRaw);
    if (storedRaw && Number.isFinite(stored) && stored > 0) return stored;
  } catch { /* a current in-memory decision can still be migrated below */ }

  if (decision !== ADS_CONSENT_GRANTED && decision !== ADS_CONSENT_DENIED) {
    try {
      const storedDecision = window.localStorage.getItem(ADS_CONSENT_STORAGE_KEY);
      if (storedDecision === ADS_CONSENT_GRANTED) decision = ADS_CONSENT_GRANTED;
      else if (storedDecision === ADS_CONSENT_DENIED) decision = ADS_CONSENT_DENIED;
    } catch { /* without an explicit choice there is nothing to migrate */ }
  }
  if (decision !== ADS_CONSENT_GRANTED && decision !== ADS_CONSENT_DENIED) return 0;

  const migratedAt = Date.now();
  consentWindow.__ftAdsConsentDecision = decision;
  consentWindow.__ftAdsConsentDecisionAt = migratedAt;
  try { window.localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(migratedAt)); } catch { /* current session remains usable */ }
  return migratedAt;
}

/**
 * THE gate. Every advertising script injection in the codebase is guarded by
 * this returning `true` — see AdSenseBanner.loadAdSenseScript(),
 * GptAdSlot.ensureGptScript(), `useMetaPixelPageView()`, and the inline
 * ADSENSE_LOADER_CONTENT twin.
 */
export function isAdsConsentGranted(): boolean {
  return getAdsConsent() === ADS_CONSENT_GRANTED;
}

/**
 * Whether AdSense may request ads: the visitor answered the Funding Choices
 * message, either way. The TC string then tells Google what to serve: normal
 * ads with Purpose 1 consent, Limited Ads without it (no personalisation and
 * no advertising cookies; Google keeps cookies and local storage only for
 * invalid-traffic detection), which the AdSense account allows. Before an
 * answer nothing loads. Live probe on a job page with consent refused
 * (28-09): no AdSense request with the granted-only gate; with this one 4 of 5
 * slots filled and the held Offerwall rendered in 0.7 s. Google Ad Manager,
 * header bidding and the GPT rewarded ad stay behind `isAdsConsentGranted()`.
 */
export function isAdSenseAllowed(): boolean {
  return getAdsConsent() !== null;
}

/** Whether the banner still has to be shown (no decision recorded yet). */
export function needsAdsConsentDecision(): boolean {
  return getAdsConsent() === null;
}

/** Persist a decision and notify listeners in this tab. */
export function setAdsConsent(value: AdsConsentValue): void {
  if (typeof window === 'undefined') return;
  const decidedAt = Date.now();
  const consentWindow = window as AdsConsentWindow;
  consentWindow.__ftAdsConsentDecision = value;
  consentWindow.__ftAdsConsentDecisionAt = decidedAt;
  try {
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, value);
    window.localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(decidedAt));
  } catch {
    /* quota / private mode — the in-memory notification below still runs, so
       the current page behaves as chosen; the next page load re-asks. */
  }
  try {
    window.dispatchEvent(new CustomEvent<AdsConsentValue>(CHANGE_EVENT, { detail: value }));
  } catch {
    /* CustomEvent unavailable — listeners simply do not fire this tab. */
  }
}

export function grantAdsConsent(): void {
  setAdsConsent(ADS_CONSENT_GRANTED);
}

export function denyAdsConsent(): void {
  setAdsConsent(ADS_CONSENT_DENIED);
}

/**
 * Reopen the Google Funding Choices consent message, so a new answer lands in
 * its TC string and, through the CMP bridge, in our key.
 *
 * `window.googlefc` always exists (the bridge creates it), but
 * `showRevocationMessage` arrives only with Funding Choices, which is
 * idle-deferred. Once it is there, call it directly: a callback pushed on
 * `callbackQueue` for CONSENT_DATA_READY after that event has fired never runs
 * (live probe, 28-09: nothing shown in 6 s; the direct call showed the message
 * in 0.2 s). Before that, queue it for CONSENT_DATA_READY, once: a second
 * click before Funding Choices loads must not open the message twice. When
 * Funding Choices never loads (ad blocker) the queued call stays inert.
 */

export function reopenAdsConsentMessage(): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as unknown as {
      googlefc?: { callbackQueue?: unknown[]; showRevocationMessage?: () => void; __ftRevocationQueued?: boolean };
    };
    const gfc = (w.googlefc = w.googlefc ?? {});
    if (typeof gfc.showRevocationMessage === 'function') {
      gfc.showRevocationMessage();
      return;
    }
    if (gfc.__ftRevocationQueued) return;
    gfc.__ftRevocationQueued = true;
    (gfc.callbackQueue = gfc.callbackQueue ?? []).push({
      CONSENT_DATA_READY: () => {
        gfc.__ftRevocationQueued = false;
        try {
          w.googlefc?.showRevocationMessage?.();
        } catch {
          /* fail-soft: the stored decision stays as it is */
        }
      },
    });
  } catch {
    /* Funding Choices threw or the queue is unavailable: nothing to reopen. */
  }
}

/**
 * Whether Funding Choices' consent message is on screen (its body-level
 * `fc-consent-root`, displayed): what a reopened message is checked against,
 * since `showRevocationMessage()` reports nothing back.
 */
export function isAdsConsentMessageOnScreen(doc: Document = document): boolean {
  return Array.from(doc.querySelectorAll<HTMLElement>('.fc-consent-root')).some((el) => {
    if (!el.isConnected) return false;
    const style = doc.defaultView?.getComputedStyle(el);
    return style?.display !== 'none' && style?.visibility !== 'hidden';
  });
}

/**
 * Subscribe to decisions. Covers the same tab (CustomEvent) and other tabs
 * (`storage`), so accepting in one tab lets an already-open tab load its ads
 * without a reload. Returns an unsubscribe function.
 */
export function onAdsConsentChange(listener: (value: AdsConsentValue | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onLocal = (event: Event) => {
    const value = (event as CustomEvent).detail;
    const memory = window as AdsConsentWindow;
    if (value === ADS_CONSENT_GRANTED || value === ADS_CONSENT_DENIED) {
      memory.__ftAdsConsentDecision = value;
      const decidedAt = Date.now();
      memory.__ftAdsConsentDecisionAt = decidedAt;
      try { window.localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(decidedAt)); } catch { /* in-memory choice remains usable */ }
    } else {
      delete memory.__ftAdsConsentDecision;
      delete memory.__ftAdsConsentDecisionAt;
    }
    listener(getAdsConsent());
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ADS_CONSENT_STORAGE_KEY || e.key === ADS_CONSENT_DECISION_AT_STORAGE_KEY) {
      const memory = window as AdsConsentWindow;
      if (e.key === ADS_CONSENT_DECISION_AT_STORAGE_KEY
        && e.newValue !== null
        && Number(memory.__ftAdsConsentDecisionAt) === Number(e.newValue)) {
        try {
          if (memory.__ftAdsConsentDecision === window.localStorage.getItem(ADS_CONSENT_STORAGE_KEY)) return;
        } catch { /* process the storage event when the current decision cannot be confirmed */ }
      }
      delete memory.__ftAdsConsentDecision;
      delete memory.__ftAdsConsentDecisionAt;
      const decision = getAdsConsent();
      if (decision) {
        const decidedAt = getAdsConsentDecisionAt() || Date.now();
        memory.__ftAdsConsentDecision = decision;
        memory.__ftAdsConsentDecisionAt = decidedAt;
      }
      listener(getAdsConsent());
    }
  };
  window.addEventListener(CHANGE_EVENT, onLocal as EventListener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal as EventListener);
    window.removeEventListener('storage', onStorage);
  };
}
