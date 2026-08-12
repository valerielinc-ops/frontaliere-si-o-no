import {
 addDoc,
 collection,
 doc,
 getDoc,
 increment,
 serverTimestamp,
 setDoc,
 type Firestore,
} from 'firebase/firestore';
import { deriveAnalyticsPageContext } from './analyticsPageContext';
import { isNewsletterOptOutBinding } from './newsletterOptOut.mjs';
import { reportCaughtError } from '@/services/errorReporter';
import { NEWSLETTER_SUBSCRIBED_KEY as LOCAL_SUBSCRIBED_KEY } from '@/services/newsletterCtaState';
import { FUNCTIONS_BASE } from './functionsBase';

// Canonical key shared via services/newsletterCtaState (#3529 dedup).

const GEO_CACHE_KEY = 'newsletter_geo_snapshot_v1';
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type NewsletterPreferences = {
 exchangeRate?: boolean;
 traffic?: boolean;
 taxUpdates?: boolean;
 tips?: boolean;
 jobs?: boolean;
 tax?: boolean;
 general?: boolean;
 sanita?: boolean;
 finanza?: boolean;
 apprendistato?: boolean;
 stage?: boolean;
 lugano?: boolean;
 bellinzona?: boolean;
 mendrisio?: boolean;
 chiasso?: boolean;
};

export type NewsletterSubscriberStatus =
 | 'pending'
 | 'confirmed'
 | 'unsubscribed'
 | 'bounced'
 | 'complained'
 | 'suppressed';

export type NewsletterSourceChannel =
 | 'popup'
 | 'job_gate'
 | 'lead_magnet'
 | 'tax_calendar'
 | 'auth_google'
 | 'auth_facebook'
 | 'chatbot'
 | 'newsletter_page'
 | 'weekly_digest'
 | 'post_calc_cta'
 | 'newsletter_email_link'
 | 'resubscribe_link'
 | 'unsubscribe_link'
 | 'offerwall'
 | 'web_app'
 | string;

export type NewsletterGeoSource = 'profile_municipality' | 'ip_lookup' | 'manual' | 'none';

export type NewsletterUtm = {
 // Fields must be string | null (never undefined) — Firestore rejects
 // undefined values inside nested maps with "Unsupported field value:
 // undefined (found in field source_utm.medium ...)".
 source?: string | null;
 medium?: string | null;
 campaign?: string | null;
 content?: string | null;
 term?: string | null;
};

export type NewsletterJobContext = {
 slug?: string | null;
 company?: string | null;
 location?: string | null;
 category?: string | null;
 searchQuery?: string | null;
};

export type NewsletterGeoContext = {
 country?: string | null;
 region?: string | null;
 city?: string | null;
 source?: NewsletterGeoSource | null;
 capturedAt?: string | null;
};

export type NewsletterEventType =
 | 'subscribe_started'
 | 'subscribe_completed'
 | 'confirm'
 | 'send'
 | 'delivered'
 | 'open'
 | 'click'
 | 'unsubscribe'
 | 'bounce'
 | 'complaint'
 | 'suppressed';

export type NewsletterUpsertInput = {
 email: string;
 userId?: string | null;
 name?: string | null;
 source?: string | null;
 sourceChannel?: NewsletterSourceChannel | null;
 sourcePage?: string | null;
 sourceCta?: string | null;
 sourceComponent?: string | null;
 sourceRouteFamily?: string | null;
 locale?: string | null;
 signupLocale?: string | null;
 preferredLocale?: string | null;
 lastSeenLocale?: string | null;
 type?: string | null;
 leadMagnet?: string | null;
 preferences?: NewsletterPreferences | null;
 interests?: string[] | null;
 locationInterest?: string | null;
 sectorInterest?: string | null;
 sourceUtm?: NewsletterUtm | null;
 jobContext?: NewsletterJobContext | null;
 geo?: NewsletterGeoContext | null;
 isActive?: boolean;
 status?: NewsletterSubscriberStatus;
 metadata?: Record<string, any> | null;
 variant?: string | null;
 /** GDPR consent proof fields (Art. 7 + Mailjet policy 1d) */
 consentGiven?: boolean;
 consentText?: string | null;
 consentMethod?: 'email_checkbox' | 'google_oauth' | 'linkedin_oauth' | 'facebook_oauth' | string;
 consentUserAgent?: string | null;
 /**
  * Version of the `consentText` formula (`services/consentTexts.ts`). The text
  * itself is stored verbatim; this only says WHICH revision it is, so a later
  * rewording is distinguishable instead of silently retroactive.
  */
 consentTextVersion?: string | null;
 /**
  * Was `consentText` actually rendered to the person at this gate? `false`
  * everywhere today — see the header of `services/consentTexts.ts`. Recorded
  * rather than assumed: a stored formula nobody saw must not read like one
  * they did.
  */
 consentTextDisplayed?: boolean;
 /** What the person physically did: authentication / typed_email_submit / email_link_click. */
 consentAct?: string | null;
 /**
  * Network provenance of the consent, ALREADY TRUNCATED (/24 IPv4, /48 IPv6).
  *
  * The browser cannot see its own address, so this is normally absent on the
  * client write and stamped afterwards by the Cloud Function the signup path
  * already calls (`functions/index.js` → `newsletterSendConfirmation` /
  * `newsletterSendWelcome`), which reads `cf-connecting-ip` — the one header
  * an external caller cannot forge. The field is accepted here so there is a
  * single owner for the name and a server-side caller can write it inline.
  */
 consentIp?: string | null;
 /**
  * The caller asserts this write carries a DELIBERATE re-opt-in act by the
  * recipient — the only thing that may lift a recorded opt-out (see
  * `inferNewsletterSubscriptionState`). Never set it from an authentication
  * event: signing in is not consent to receive mail you already refused.
  */
 reconsent?: boolean;
};

export type NewsletterEventInput = {
 email: string;
 userId?: string | null;
 eventType: NewsletterEventType;
 campaignId?: string | null;
 messageId?: string | null;
 variant?: string | null;
 sectionId?: string | null;
 sourceLocale?: string | null;
 sourcePage?: string | null;
 sourceCta?: string | null;
 sourceChannel?: NewsletterSourceChannel | null;
 linkUrl?: string | null;
 linkLabel?: string | null;
 targetUrl?: string | null;
 jobSlug?: string | null;
 jobSearchQuery?: string | null;
 geoCountry?: string | null;
 metadata?: Record<string, any> | null;
};

export type NewsletterDeliveryInput = {
 email: string;
 campaignId: string;
 messageId?: string | null;
 variant?: string | null;
 locale?: string | null;
 status?: NewsletterEventType | null;
 sectionId?: string | null;
 clickedLink?: string | null;
 clickedLabel?: string | null;
};

const DEFAULT_PREFERENCES: NewsletterPreferences = {
 exchangeRate: true,
 traffic: true,
 taxUpdates: true,
 tips: false,
};

const CONFIRMED_NEWSLETTER_SOURCES = new Set([
 'signup',
 'auth_google',
 'auth_facebook',
 'auth_linkedin',
 'chatbot_google',
 'chatbot_facebook',
 'job_board_auth',
 'job_gate',
 'tax_calendar_google',
 'tax_calendar_facebook',
 'resubscribe_link',
 'newsletter_email_link',
]);

const ACTIVE_STATUS_EVENT_MAP: Partial<Record<NewsletterEventType, NewsletterSubscriberStatus>> = {
 delivered: 'confirmed',
 open: 'confirmed',
 click: 'confirmed',
 unsubscribe: 'unsubscribed',
 bounce: 'bounced',
 complaint: 'complained',
 suppressed: 'suppressed',
};

function nowIso(): string {
 return new Date().toISOString();
}

function sanitizeString(value: unknown): string | null {
 const normalized = String(value || '').trim();
 return normalized || null;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
 const seen = new Set<string>();
 const out: string[] = [];
 for (const value of values) {
 const normalized = sanitizeString(value);
 if (!normalized) continue;
 if (seen.has(normalized)) continue;
 seen.add(normalized);
 out.push(normalized);
 }
 return out;
}

function defaultPreferences(prefs?: NewsletterPreferences | null): NewsletterPreferences {
 return {
 ...DEFAULT_PREFERENCES,
 ...(prefs || {}),
 };
}

function normalizeSourceChannel(input: NewsletterUpsertInput): NewsletterSourceChannel {
 const explicit = sanitizeString(input.sourceChannel)?.toLowerCase();
 if (explicit) return explicit;

 const source = sanitizeString(input.source)?.toLowerCase() || 'web_app';
 if (source.includes('google')) return 'auth_google';
 if (source.includes('facebook')) return 'auth_facebook';
 if (source.startsWith('tax_calendar')) return 'tax_calendar';
 if (source.startsWith('lead_magnet')) return 'lead_magnet';
 if (source.startsWith('chatbot')) return 'chatbot';
 if (source.includes('job')) return 'job_gate';
 if (source.includes('popup')) return 'popup';
 if (source.includes('weekly_digest')) return 'weekly_digest';
 if (source.includes('post_calc')) return 'post_calc_cta';
 if (source.includes('newsletter_email_link')) return 'newsletter_email_link';
 if (source.includes('resubscribe')) return 'resubscribe_link';
 if (source.includes('unsubscribe')) return 'unsubscribe_link';
 return source;
}

function parseUtmFromWindow(): NewsletterUtm | null {
 if (typeof window === 'undefined') return null;
 try {
 const url = new URL(window.location.href);
 const params = url.searchParams;
 const source = sanitizeString(params.get('utm_source'));
 const medium = sanitizeString(params.get('utm_medium'));
 const campaign = sanitizeString(params.get('utm_campaign'));
 const content = sanitizeString(params.get('utm_content'));
 const term = sanitizeString(params.get('utm_term'));
 if (!source && !medium && !campaign && !content && !term) return null;
 // Firestore rejects `undefined` field values inside nested maps with
 // `setDoc() called with invalid data. Unsupported field value: undefined
 // (found in field source_utm.medium ...)`. When a URL ships only a subset
 // of UTM parameters (common — e.g. perplexity referrals send just
 // `?utm_source=perplexity`), the missing dimensions MUST be `null`, not
 // `undefined`, or every One Tap subscriber write fails after sign-in.
 // 2026-05-18 PostHog triage: ranked as the highest-volume actionable error
 // in `auth.persistOneTapSubscriber`.
 return {
 source: source ?? null,
 medium: medium ?? null,
 campaign: campaign ?? null,
 content: content ?? null,
 term: term ?? null,
 };
 } catch {
 return null;
 }
}

function inferPageContext(sourcePage?: string | null, routeFamily?: string | null): { page: string | null; routeFamily: string | null } {
 const explicitPage = sanitizeString(sourcePage);
 const explicitRouteFamily = sanitizeString(routeFamily);
 if (typeof window === 'undefined') {
 return { page: explicitPage, routeFamily: explicitRouteFamily };
 }
 const path = explicitPage || `${window.location.pathname}${window.location.search}${window.location.hash}`;
 const derived = deriveAnalyticsPageContext(path);
 return {
 page: path,
 routeFamily: explicitRouteFamily || sanitizeString(derived.routeFamily),
 };
}

async function getNewsletterGeoSnapshot(): Promise<NewsletterGeoContext | null> {
 if (typeof window === 'undefined') return null;
 try {
 const cached = window.localStorage.getItem(GEO_CACHE_KEY);
 if (cached) {
 const parsed = JSON.parse(cached);
 if (parsed?.timestamp && Date.now() - Number(parsed.timestamp) < GEO_CACHE_TTL_MS && parsed?.data) {
 return parsed.data as NewsletterGeoContext;
 }
 }
 } catch {
 // ignore cache read issues
 }

 // Client-side IP lookup is disabled to avoid shipping third-party API keys.
 return null;
}

async function resolveCaptureDefaults(input: NewsletterUpsertInput) {
 const { page, routeFamily } = inferPageContext(input.sourcePage, input.sourceRouteFamily);

 // Use the site's active locale (it/en/de/fr) rather than navigator.language
 let siteLocale: string | null = null;
 try {
 const { getLocale } = await import('@/services/i18n');
 siteLocale = getLocale(); // 'it' | 'en' | 'de' | 'fr'
 } catch { /* fallback below */ }

 const locale = sanitizeString(input.locale || input.signupLocale || input.preferredLocale)
 || siteLocale || 'it';
 const sourceUtm = input.sourceUtm || parseUtmFromWindow();
 const geo = input.geo || (await getNewsletterGeoSnapshot());
 return {
 sourceChannel: normalizeSourceChannel(input),
 sourcePage: page,
 sourceRouteFamily: routeFamily,
 locale,
 signupLocale: sanitizeString(input.signupLocale) || locale,
 preferredLocale: sanitizeString(input.preferredLocale) || locale,
 lastSeenLocale: sanitizeString(input.lastSeenLocale) || locale,
 sourceUtm,
 geo,
 };
}

export function normalizeNewsletterEmail(raw: string): string {
 return String(raw || '').trim().toLowerCase();
}

/**
 * Is a recorded opt-out still binding on this document?
 *
 * Re-exported rather than defined here since #5711: the same question is asked
 * by the Node senders (scripts/send-newsletter.mjs, scripts/send-onboarding-drip.mjs)
 * and by the Cloud Function's `get_full_status`, and the answer changed shape —
 * an opt-out stamp is no longer deleted by a re-subscription, so "stamp present"
 * stopped being the whole rule. Three copies of a rule that just changed is how
 * the two spellings of #5673 drifted apart in the first place.
 *
 * The definition, the supersession rule and the reasoning live in
 * services/newsletterOptOut.mjs.
 */
export { isNewsletterOptOutBinding };

/**
 * The ONLY signals that may lift a recorded opt-out.
 *
 * `resubscribe_link` is the win-back / "riattiva" click — the recipient
 * deliberately asked to come back. `reconsent` is the explicit escape hatch
 * for any future caller that can prove the same thing. Everything else,
 * INCLUDING every `CONFIRMED_NEWSLETTER_SOURCES` entry, is an authentication
 * or a link click: neither is consent to resume mail the recipient refused.
 */
function isExplicitNewsletterReOptIn(input: NewsletterUpsertInput): boolean {
 if (input.reconsent === true) return true;
 return normalizeSourceChannel(input) === 'resubscribe_link';
}

export function inferNewsletterSubscriptionState(
 input: NewsletterUpsertInput,
 existing: Record<string, any> | undefined,
): { status: NewsletterSubscriberStatus; isActive: boolean } {
 const inferred = inferSubscriptionStateIgnoringOptOut(input, existing);

 // ── The opt-out is binding against EVERY write path (#5672) ───────────────
 //
 // Applied as a post-filter, and deliberately so: it can only ever DECLINE a
 // promotion to active, never invent a demotion. A write that already lands
 // inactive (an explicit `status: 'bounced'`, an `isActive: false`) passes
 // through byte-identically, so no webhook or suppression path changes.
 //
 // The ring it closes: unsubscribe → click any link in any old email → the
 // never-expiring `ac` autologin code signs the reader in → App.tsx's
 // auto-subscribe effect fires → `upsertNewsletterSubscriber(..., 'signup')`
 // → `confirmed`/active again. Measured 2026-08-12: 186 opt-outs resurrected
 // with no action by the recipient, 49 of whom received that day's brief.
 //
 // NOTE for anyone tempted to add `confirmed_at > unsubscribed_at`
 // supersession here, the way scripts/lib/suppressionDecay.mjs has it: those
 // 186 documents ALL carry a `confirmed_at` newer than their opt-out, because
 // the resurrection wrote one (`status === 'confirmed' && !wasConfirmed`
 // below). Such a rule would exempt exactly the cohort this guard exists for.
 // Only `resubscribe_link` / `reconsent` lift it.
 if (!inferred.isActive) return inferred;
 if (isExplicitNewsletterReOptIn(input)) return inferred;
 if (!isNewsletterOptOutBinding(existing)) return inferred;

 // Preserve what the document already says rather than inventing a state.
 // The one correction made is on `isActive`, and only in the direction the
 // opt-out demands: the 281 documents measured as `status: 'unsubscribed'`
 // yet still active are repaired on their next write instead of being
 // carried forward.
 const existingStatus = typeof existing?.status === 'string'
 ? (existing.status as NewsletterSubscriberStatus)
 : 'unsubscribed';
 const existingActive = existing?.isActive === true || existing?.active === true;
 return {
 status: existingStatus,
 isActive: existingStatus === 'unsubscribed' ? false : existingActive,
 };
}

function inferSubscriptionStateIgnoringOptOut(
 input: NewsletterUpsertInput,
 existing: Record<string, any> | undefined,
): { status: NewsletterSubscriberStatus; isActive: boolean } {
 const explicitStatus = input.status;
 const explicitIsActive = input.isActive;
 if (explicitStatus || explicitIsActive !== undefined) {
 return {
 status: explicitStatus || (explicitIsActive ? 'confirmed' : 'pending'),
 isActive: explicitIsActive ?? explicitStatus === 'confirmed',
 };
 }

 if (existing?.status === 'confirmed' || existing?.isActive === true || existing?.active === true) {
 return { status: 'confirmed', isActive: true };
 }

 const source = normalizeSourceChannel(input);
 if (CONFIRMED_NEWSLETTER_SOURCES.has(source)) {
 return { status: 'confirmed', isActive: true };
 }

 return { status: 'pending', isActive: false };
}

/**
 * Reads the recipient's REAL state to answer "may we (re)subscribe them?".
 *
 * Exists because the auto-subscribe-on-sign-in effect was guarded by a
 * localStorage flag alone — client-side, clearable, and cleared by the
 * unsubscribe handler itself, so the guard was always open for exactly the
 * people it had to protect.
 *
 * FAIL-CLOSED on a read error: the same `getDoc` runs inside
 * `captureNewsletterSubscriber`, so a failure here means the upsert would
 * fail too. The cost of a false positive is one missed auto-subscribe; the
 * cost of a false negative is mailing someone who opted out.
 */
export async function isNewsletterOptedOut(db: Firestore, email: string): Promise<boolean> {
 const normalized = normalizeNewsletterEmail(email);
 if (!normalized || !normalized.includes('@')) return false;
 try {
 const snap = await getDoc(doc(collection(db, 'newsletter_subscribers'), normalized));
 if (!snap.exists()) return false;
 return isNewsletterOptOutBinding(snap.data());
 } catch (err) {
 // Reported, not swallowed. `true` here and `true` for a real opt-out are
 // the same value and the same silence, so without this line a Firestore
 // outage or a rules change would suppress every auto-subscribe on the
 // site and look exactly like a quiet week — the failure mode of a
 // fail-closed default is that it is invisible while it is wrong. The
 // decision stays fail-closed; only its cause becomes visible.
 reportCaughtError(err, 'newsletter.optOutCheckUnavailable');
 return true;
 }
}

/**
 * The canonical field set an unsubscribe leaves on the subscriber document.
 *
 * Single definition on purpose: the SPA footer link and the RFC 8058 one-click
 * Cloud Function are two writers of the same fact, and until #5673 they wrote
 * different things — the SPA `unsubscribedAt` and no event, the function
 * `unsubscribed_at` plus an `unsubscribe` event. Everything that has to
 * RESPECT an opt-out (scripts/lib/suppressionDecay.mjs,
 * scripts/lib/mailtrapSuspensionClassify.mjs, scripts/send-newsletter.mjs)
 * reads the snake_case stamp, so the SPA path was invisible to all of them and
 * `restore-mailtrap-suspension-suppressions.mjs` put those people back to
 * `confirmed`.
 *
 * BOTH spellings are written: snake_case is what the scripts read, camelCase
 * keeps the 458 historic documents and every existing camelCase reader working
 * without a data migration.
 */
function buildNewsletterUnsubscribeFields(
 email: string,
 occurredAtIso: string,
 sourceChannel = 'unsubscribe_link',
): Record<string, any> {
 return {
 email,
 status: 'unsubscribed' as NewsletterSubscriberStatus,
 isActive: false,
 active: false,
 source: sourceChannel,
 unsubscribed_at: occurredAtIso,
 unsubscribedAt: occurredAtIso,
 updated_at: occurredAtIso,
 updatedAt: occurredAtIso,
 };
}

/**
 * SPA unsubscribe writer (the "Disiscriviti" link in the email body).
 *
 * Extracted out of App.tsx so the client half of the client↔scripts contract
 * finally HAS an import form: it was a contract nothing could reference, which
 * is why no guard noticed the two paths had drifted apart.
 *
 * The event is best-effort — the opt-out itself must land even if the
 * subcollection write fails — but it is written, which the SPA path never did.
 */
export async function unsubscribeNewsletterSubscriber(
 db: Firestore,
 input: { email: string; sourceChannel?: string; sourcePage?: string | null },
): Promise<{ ok: boolean; email: string; fields: Record<string, any> }> {
 const email = normalizeNewsletterEmail(input.email);
 const sourceChannel = sanitizeString(input.sourceChannel) || 'unsubscribe_link';
 if (!email || !email.includes('@')) {
 return { ok: false, email, fields: {} };
 }

 const fields = buildNewsletterUnsubscribeFields(email, nowIso(), sourceChannel);
 await setDoc(doc(collection(db, 'newsletter_subscribers'), email), fields, { merge: true });

 try {
 await recordNewsletterEvent(db, {
 email,
 eventType: 'unsubscribe',
 sourceChannel,
 sourcePage: input.sourcePage ?? null,
 });
 } catch (err) {
 reportCaughtError(err, 'newsletter.unsubscribeEvent');
 }

 return { ok: true, email, fields };
}

export function markNewsletterSubscribedLocally(): void {
 if (typeof window === 'undefined') return;
 try {
 window.localStorage.setItem(LOCAL_SUBSCRIBED_KEY, 'true');
 } catch {
 // no-op
 }
}

export async function recordNewsletterEvent(
 db: Firestore,
 input: NewsletterEventInput,
): Promise<void> {
 const email = normalizeNewsletterEmail(input.email);
 if (!email || !email.includes('@')) return;
 await addDoc(collection(doc(collection(db, 'newsletter_subscribers'), email), 'events'), {
 email,
 user_id: sanitizeString(input.userId),
 event_type: input.eventType,
 campaign_id: sanitizeString(input.campaignId),
 message_id: sanitizeString(input.messageId),
 variant: sanitizeString(input.variant),
 section_id: sanitizeString(input.sectionId),
 source_locale: sanitizeString(input.sourceLocale),
 source_page: sanitizeString(input.sourcePage),
 source_cta: sanitizeString(input.sourceCta),
 source_channel: sanitizeString(input.sourceChannel),
 link_url: sanitizeString(input.linkUrl),
 link_label: sanitizeString(input.linkLabel),
 target_url: sanitizeString(input.targetUrl),
 job_slug: sanitizeString(input.jobSlug),
 job_search_query: sanitizeString(input.jobSearchQuery),
 geo_country: sanitizeString(input.geoCountry),
 metadata: input.metadata || null,
 timestamp: serverTimestamp(),
 occurred_at: nowIso(),
 });
}

function buildDeliveryDocId(email: string, campaignId: string): string {
 return `${campaignId}__${normalizeNewsletterEmail(email)}`.replace(/[^a-z0-9@._-]+/gi, '-');
}

export async function upsertNewsletterDelivery(
 db: Firestore,
 input: NewsletterDeliveryInput,
): Promise<void> {
 const email = normalizeNewsletterEmail(input.email);
 if (!email || !email.includes('@') || !input.campaignId) return;

 const status = sanitizeString(input.status);
 const update: Record<string, any> = {
 email,
 campaign_id: input.campaignId,
 message_id: sanitizeString(input.messageId),
 variant: sanitizeString(input.variant),
 locale: sanitizeString(input.locale),
 updated_at: serverTimestamp(),
 updatedAt: serverTimestamp(),
 };

 if (status === 'send') update.sent_at = serverTimestamp();
 if (status === 'delivered') update.delivered_at = serverTimestamp();
 if (status === 'open') update.opened_at = serverTimestamp();
 if (status === 'click') {
 update.clicked_at = serverTimestamp();
 update.clicked_links = increment(1);
 update.last_clicked_url = sanitizeString(input.clickedLink);
 update.last_clicked_label = sanitizeString(input.clickedLabel);
 update.last_clicked_section = sanitizeString(input.sectionId);
 }
 if (status === 'bounce') update.bounced_at = serverTimestamp();
 if (status === 'complaint') update.complained_at = serverTimestamp();
 if (status === 'suppressed') update.suppressed_at = serverTimestamp();

 await setDoc(
 doc(collection(doc(collection(db, 'newsletter_subscribers'), email), 'campaign_deliveries'), buildDeliveryDocId(email, input.campaignId)),
 {
 email,
 campaign_id: input.campaignId,
 message_id: sanitizeString(input.messageId),
 variant: sanitizeString(input.variant),
 locale: sanitizeString(input.locale),
 created_at: serverTimestamp(),
 createdAt: serverTimestamp(),
 ...update,
 },
 { merge: true },
 );
}

export async function captureNewsletterSubscriber(
 db: Firestore,
 input: NewsletterUpsertInput,
): Promise<{ existed: boolean; id: string; status: NewsletterSubscriberStatus }> {
 const email = normalizeNewsletterEmail(input.email);
 if (!email || !email.includes('@')) {
 throw new Error('Invalid email');
 }

 const ref = doc(collection(db, 'newsletter_subscribers'), email);
 const existing = await getDoc(ref);
 const existingData = existing.exists() ? existing.data() : undefined;

 // No new subscriber without a record of what they were told (#5678).
 //
 // 8.505 of 8.605 documents carry no `consent_text`, and the cause was never
 // this write — it was that most callers passed nothing. A guard here is what
 // stops the count from growing: the next signup path physically cannot create
 // a document without naming its formula, because it throws first.
 //
 // Scoped to CREATION on purpose, twice over:
 //  - the 8.505 existing documents keep working. Their text is not
 //    reconstructible and must not be invented, so a later write on one of
 //    them carries the gap forward instead of papering over it;
 //  - throwing is the safe failure. Every caller wraps this in try/catch and
 //    degrades to "not subscribed", which is the outcome we want from a path
 //    that cannot say what it disclosed.
 const resolvedConsentText =
 sanitizeString(input.consentText) || sanitizeString(existingData?.consent_text);
 if (!existing.exists() && !resolvedConsentText) {
 throw new Error(
 `newsletter/consent-text-required: refusing to create ${email} without a consent text. ` +
 'Pass consentProof(<key>, <method>) from services/consentTexts.ts.',
 );
 }

 const subscriptionState = inferNewsletterSubscriptionState(input, existingData);
 const resolved = await resolveCaptureDefaults(input);
 const sourceChannel = resolved.sourceChannel;
 const jobContext = input.jobContext || {};
 const interests = dedupeStrings([
 ...(input.interests || []),
 ...(Object.entries(defaultPreferences(input.preferences))
 .filter(([, enabled]) => Boolean(enabled))
 .map(([key]) => key)),
 sanitizeString(input.locationInterest),
 sanitizeString(input.sectorInterest),
 ]);

 const alreadyActive =
 existing.exists() &&
 (existingData?.isActive === true || existingData?.active === true);

 const wasConfirmed =
 existing.exists() &&
 (existingData?.status === 'confirmed' || existingData?.isActive === true || existingData?.active === true);

 const now = nowIso();
 const mergedData = {
 email,
 user_id: sanitizeString(input.userId) || sanitizeString(existingData?.user_id),
 name: sanitizeString(input.name) || sanitizeString(existingData?.name),
 source: sanitizeString(input.source) || sanitizeString(existingData?.source) || sourceChannel,
 source_channel: sourceChannel,
 source_page: sanitizeString(input.sourcePage) || sanitizeString(existingData?.source_page) || resolved.sourcePage,
 source_cta: sanitizeString(input.sourceCta) || sanitizeString(existingData?.source_cta),
 source_component: sanitizeString(input.sourceComponent) || sanitizeString(existingData?.source_component),
 source_route_family: sanitizeString(input.sourceRouteFamily) || sanitizeString(existingData?.source_route_family) || resolved.sourceRouteFamily,
 source_utm: input.sourceUtm || existingData?.source_utm || resolved.sourceUtm || null,
 locale: sanitizeString(input.locale) || sanitizeString(existingData?.locale) || resolved.locale,
 signup_locale: sanitizeString(input.signupLocale) || sanitizeString(existingData?.signup_locale) || resolved.signupLocale,
 preferred_locale: sanitizeString(input.preferredLocale) || sanitizeString(existingData?.preferred_locale) || resolved.preferredLocale,
 last_seen_locale: sanitizeString(input.lastSeenLocale) || sanitizeString(existingData?.last_seen_locale) || resolved.lastSeenLocale,
 type: sanitizeString(input.type) || sanitizeString(existingData?.type),
 leadMagnet: sanitizeString(input.leadMagnet) || sanitizeString(existingData?.leadMagnet),
 preferences: defaultPreferences(input.preferences || existingData?.preferences),
 interests,
 location_interest: sanitizeString(input.locationInterest) || sanitizeString(existingData?.location_interest),
 sector_interest: sanitizeString(input.sectorInterest) || sanitizeString(existingData?.sector_interest),
 job_slug: sanitizeString(jobContext.slug) || sanitizeString(existingData?.job_slug),
 job_company: sanitizeString(jobContext.company) || sanitizeString(existingData?.job_company),
 job_location: sanitizeString(jobContext.location) || sanitizeString(existingData?.job_location),
 job_category: sanitizeString(jobContext.category) || sanitizeString(existingData?.job_category),
 job_search_query: sanitizeString(jobContext.searchQuery) || sanitizeString(existingData?.job_search_query),
 geo_country: sanitizeString(input.geo?.country) || sanitizeString(existingData?.geo_country) || sanitizeString(resolved.geo?.country),
 geo_region: sanitizeString(input.geo?.region) || sanitizeString(existingData?.geo_region) || sanitizeString(resolved.geo?.region),
 geo_city: sanitizeString(input.geo?.city) || sanitizeString(existingData?.geo_city) || sanitizeString(resolved.geo?.city),
 geo_source: sanitizeString(input.geo?.source) || sanitizeString(existingData?.geo_source) || sanitizeString(resolved.geo?.source) || 'none',
 geo_captured_at: sanitizeString(input.geo?.capturedAt) || sanitizeString(existingData?.geo_captured_at) || sanitizeString(resolved.geo?.capturedAt),
 isActive: subscriptionState.isActive,
 active: subscriptionState.isActive,
 status: subscriptionState.status,
 variant: sanitizeString(input.variant) || sanitizeString(existingData?.variant),
 metadata: input.metadata || existingData?.metadata || null,
 consent_given: input.consentGiven ?? existingData?.consent_given ?? false,
 consent_given_at: input.consentGiven
 ? (existingData?.consent_given_at || now)
 : (existingData?.consent_given_at || null),
 consent_text: resolvedConsentText,
 consent_text_version: sanitizeString(input.consentTextVersion) || sanitizeString(existingData?.consent_text_version),
 // Tri-state on purpose: `null` means "never recorded" (every document written
 // before #5678) and must stay distinguishable from an explicit `false`.
 consent_text_displayed: typeof input.consentTextDisplayed === 'boolean'
 ? input.consentTextDisplayed
 : (typeof existingData?.consent_text_displayed === 'boolean' ? existingData.consent_text_displayed : null),
 consent_act: sanitizeString(input.consentAct) || sanitizeString(existingData?.consent_act),
 consent_method: sanitizeString(input.consentMethod) || sanitizeString(existingData?.consent_method) || sourceChannel,
 consent_source_url: sanitizeString(input.sourcePage) || (typeof window !== 'undefined' ? window.location.href : null) || sanitizeString(existingData?.consent_source_url),
 consent_user_agent: sanitizeString(input.consentUserAgent) || sanitizeString(existingData?.consent_user_agent) || (typeof navigator !== 'undefined' ? navigator.userAgent : null),
 // EXISTING VALUE WINS — the inverse of every other field here, and
 // deliberate. `consent_ip` must be the network the consent came from, not
 // the network of whatever write happened last. A sign-in six months later
 // from an office IP would otherwise overwrite the address that actually
 // proves the subscription, which is the one an art. 25 request asks for.
 consent_ip: sanitizeString(existingData?.consent_ip) || sanitizeString(input.consentIp),
 consent_ip_recorded_at: sanitizeString(existingData?.consent_ip)
 ? (sanitizeString(existingData?.consent_ip_recorded_at) || null)
 : (sanitizeString(input.consentIp) ? now : sanitizeString(existingData?.consent_ip_recorded_at)),
 subscribedAt: existingData?.subscribedAt || serverTimestamp(),
 subscribed_at: existingData?.subscribed_at || serverTimestamp(),
 created_at: existingData?.created_at || serverTimestamp(),
 updatedAt: serverTimestamp(),
 updated_at: serverTimestamp(),
 } as Record<string, any>;

 if (subscriptionState.status === 'confirmed' && !wasConfirmed) {
 mergedData.confirmed_at = serverTimestamp();
 mergedData.confirmedAt = serverTimestamp();
 }

 if (subscriptionState.status === 'unsubscribed') {
 mergedData.unsubscribed_at = serverTimestamp();
 mergedData.unsubscribedAt = serverTimestamp();
 }

 // A granted re-opt-in must actually LIFT the opt-out, or the win-back
 // "riattiva" click makes someone `confirmed` and permanently unmailable:
 // scripts/send-newsletter.mjs drops any row carrying either spelling of the
 // stamp, whatever `status` says.
 //
 // Until #5711 the lift was performed by DELETING both stamps, and that is
 // what destroyed the evidence — the record of an opt-out is exactly what an
 // art. 25 request asks for, and it is the signal the 186 resurrections of
 // #5672 were found by. The lift is now the re-opt-in stamp WRITTEN BESIDE
 // the opt-out: `isNewsletterOptOutBinding` compares the two and the newer
 // one wins, so the escape hatch opens without paying for it in evidence.
 //
 // `serverTimestamp()` is strictly later than a stamp already on the
 // document by construction, so the comparison cannot tie.
 if (subscriptionState.isActive && isNewsletterOptOutBinding(existingData)) {
 mergedData.resubscribed_at = serverTimestamp();
 mergedData.resubscribedAt = serverTimestamp();
 }

 // Explicit re-consent via the win-back "stay subscribed" link (App.tsx
 // resubscribe action → source: 'resubscribe_link'). scripts/lib/subscriberSunset.mjs
 // reads resubscribed_at/resubscribedAt to gate the sunset guard
 // (`reengagedAt >= winbackAt`) — without this stamp that guard is
 // unreachable and previously-sunsetted/winback subscribers who click
 // "stay" never actually get un-sunsetted. Unconditional (not gated on
 // !wasConfirmed): a winback recipient is typically still 'confirmed'
 // (non-engaging but mailable), so the confirmed_at transition guard above
 // would never fire for them.
 if (sourceChannel === 'resubscribe_link') {
 mergedData.resubscribed_at = serverTimestamp();
 mergedData.resubscribedAt = serverTimestamp();
 }

 await setDoc(ref, mergedData, { merge: true });

 // GA4 user-scoped `is_newsletter_subscriber` custom dimension (analytics
 // Stage 1, revenue-per-user segmentation). Fired on every genuine
 // new/confirmed subscribe write through this upsert path — guarded on
 // `status !== 'unsubscribed'` so a future unsubscribe-via-upsert caller
 // (none today; unsubscribe currently goes through a separate Cloud
 // Function endpoint) can't mis-flag the user as a subscriber.
 if (subscriptionState.status !== 'unsubscribed') {
 import('@/services/analytics').then(({ Analytics }) => {
 Analytics.setUserSegmentFlags({ isNewsletterSubscriber: true });
 }).catch(() => {});
 }

 const eventType: NewsletterEventType =
 subscriptionState.status === 'confirmed' && !wasConfirmed
 ? 'confirm'
 : 'subscribe_completed';

 await recordNewsletterEvent(db, {
 email,
 userId: input.userId || null,
 eventType,
 variant: input.variant || null,
 sourceLocale: mergedData.preferred_locale,
 sourcePage: mergedData.source_page,
 sourceCta: mergedData.source_cta,
 sourceChannel,
 jobSlug: mergedData.job_slug,
 jobSearchQuery: mergedData.job_search_query,
 geoCountry: mergedData.geo_country,
 metadata: {
 status: subscriptionState.status,
 source: mergedData.source,
 created_at: now,
 already_active: alreadyActive,
 },
 });

 return { existed: alreadyActive, id: email, status: subscriptionState.status };
}

export async function recordNewsletterClick(
 db: Firestore,
 input: NewsletterEventInput,
): Promise<void> {
 const email = normalizeNewsletterEmail(input.email);
 if (!email || !email.includes('@')) return;
 const ref = doc(collection(db, 'newsletter_subscribers'), email);
 await setDoc(
 ref,
 {
 email,
 last_click_at: serverTimestamp(),
 lastClickAt: serverTimestamp(),
 last_clicked_url: sanitizeString(input.targetUrl || input.linkUrl),
 last_clicked_section: sanitizeString(input.sectionId),
 click_count: increment(1),
 clickCount: increment(1),
 updatedAt: serverTimestamp(),
 updated_at: serverTimestamp(),
 },
 { merge: true },
 );
 if (input.campaignId) {
 // No fallback id here — a shared 'unknown' doc across unrelated
 // campaigns would collide clicks onto the same canonical delivery
 // doc (#3798 sibling sweep, same collision class already fixed on
 // the send path). Skip the attribution write; upsertNewsletterDelivery
 // requires a real campaignId anyway.
 await upsertNewsletterDelivery(db, {
 email,
 campaignId: input.campaignId,
 messageId: input.messageId || null,
 variant: input.variant || null,
 locale: input.sourceLocale || null,
 status: 'click',
 sectionId: input.sectionId || null,
 clickedLink: input.targetUrl || input.linkUrl || null,
 clickedLabel: input.linkLabel || null,
 });
 }
 await recordNewsletterEvent(db, input);
}

export async function applyNewsletterDeliveryEvent(
 db: Firestore,
 input: NewsletterEventInput,
): Promise<void> {
 const email = normalizeNewsletterEmail(input.email);
 if (!email || !email.includes('@')) return;
 const status = ACTIVE_STATUS_EVENT_MAP[input.eventType];
 const update: Record<string, any> = {
 email,
 updatedAt: serverTimestamp(),
 updated_at: serverTimestamp(),
 };

 if (input.eventType === 'send') {
 update.last_sent_at = serverTimestamp();
 update.lastSentAt = serverTimestamp();
 update.send_count = increment(1);
 update.sendCount = increment(1);
 }
 if (input.eventType === 'delivered') {
 update.last_delivered_at = serverTimestamp();
 }
 if (input.eventType === 'open') {
 update.last_open_at = serverTimestamp();
 update.lastOpenAt = serverTimestamp();
 update.open_count = increment(1);
 update.openCount = increment(1);
 }
 if (input.eventType === 'click') {
 update.last_click_at = serverTimestamp();
 update.lastClickAt = serverTimestamp();
 update.click_count = increment(1);
 update.clickCount = increment(1);
 update.last_clicked_url = sanitizeString(input.targetUrl || input.linkUrl);
 update.last_clicked_section = sanitizeString(input.sectionId);
 }
 if (input.eventType === 'bounce') update.last_bounced_at = serverTimestamp();
 if (input.eventType === 'complaint') update.last_complained_at = serverTimestamp();
 if (status) {
 update.status = status;
 update.isActive = status === 'confirmed';
 update.active = status === 'confirmed';
 }

 await setDoc(doc(collection(db, 'newsletter_subscribers'), email), update, { merge: true });
 if (input.campaignId) {
 // Same collision class as recordNewsletterClick above — no 'unknown'
 // fallback, skip the attribution write instead of colliding on a
 // shared canonical doc.
 await upsertNewsletterDelivery(db, {
 email,
 campaignId: input.campaignId,
 messageId: input.messageId || null,
 variant: input.variant || null,
 locale: input.sourceLocale || null,
 status: input.eventType,
 sectionId: input.sectionId || null,
 clickedLink: input.targetUrl || input.linkUrl || null,
 clickedLabel: input.linkLabel || null,
 });
 }
 await recordNewsletterEvent(db, input);
}

export async function upsertNewsletterSubscriber(
 db: Firestore,
 input: NewsletterUpsertInput,
): Promise<{ existed: boolean; id: string; status: NewsletterSubscriberStatus }> {
 // FRO-19: Rate limiting
 const rateCheck = checkSubscriptionRateLimit();
 if (!rateCheck.allowed) {
 throw new Error(`Rate limited. Retry after ${Math.ceil(rateCheck.retryAfterMs / 1000)}s.`);
 }
 recordSubscriptionAttempt();
 const result = await captureNewsletterSubscriber(db, input);

 // FRO-24: Send confirmation email for new pending subscribers
 if (result.status === 'pending' && !result.existed) {
 markNewsletterPendingLocally(input.email);
 requestConfirmationEmail(input.email).catch((err) => {
 console.warn('[newsletter] Confirmation email request failed (non-blocking):', err?.message || err);
 reportCaughtError(err, 'newsletter.requestConfirmationEmail');
 });
 }

 // Welcome email for new PRE-CONFIRMED subscribers (Google One Tap,
 // Google/Facebook/LinkedIn sign-in, job-unlock gates — ~82% of all
 // signups). These are written client-side straight to Firestore with no
 // double opt-in step, so unlike the 'pending' branch above they never hit
 // a confirmation-link Cloud Function — this is their only welcome
 // touchpoint. Symmetric to the branch above and equally non-blocking: the
 // 17 existing upsertNewsletterSubscriber callers must observe
 // byte-identical behavior for every other case.
 if (result.status === 'confirmed' && !result.existed) {
 requestWelcomeEmail(input.email).catch((err) => {
 console.warn('[newsletter] Welcome email request failed (non-blocking):', err?.message || err);
 reportCaughtError(err, 'newsletter.requestWelcomeEmail');
 });
 }

 return result;
}

// ─── Newsletter confirmation helpers (FRO-24) ───────────────

const NEWSLETTER_PENDING_EMAIL_KEY = 'newsletter_pending_email';
const NEWSLETTER_PENDING_SINCE_KEY = 'newsletter_pending_since';

export function markNewsletterPendingLocally(email: string): void {
 if (typeof window === 'undefined') return;
 try {
 window.localStorage.setItem(NEWSLETTER_PENDING_EMAIL_KEY, email.toLowerCase().trim());
 window.localStorage.setItem(NEWSLETTER_PENDING_SINCE_KEY, Date.now().toString());
 } catch {
 // no-op
 }
}

export function getNewsletterPendingEmail(): { email: string; since: number } | null {
 if (typeof window === 'undefined') return null;
 try {
 const email = window.localStorage.getItem(NEWSLETTER_PENDING_EMAIL_KEY);
 const since = parseInt(window.localStorage.getItem(NEWSLETTER_PENDING_SINCE_KEY) || '0', 10);
 if (!email || !email.includes('@')) return null;
 return { email, since };
 } catch {
 return null;
 }
}

export function clearNewsletterPendingLocally(): void {
 if (typeof window === 'undefined') return;
 try {
 window.localStorage.removeItem(NEWSLETTER_PENDING_EMAIL_KEY);
 window.localStorage.removeItem(NEWSLETTER_PENDING_SINCE_KEY);
 } catch {
 // no-op
 }
}


export async function requestConfirmationEmail(
 email: string,
 purpose?: 'confirm' | 'login',
): Promise<{ success: boolean; error?: string }> {
 try {
 const { getLocale } = await import('@/services/i18n');
 const sourcePath = window.location.pathname || '/';
 const resp = await fetch(`${FUNCTIONS_BASE}/newsletterSendConfirmation`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 email: email.toLowerCase().trim(),
 locale: getLocale(),
 sourcePath,
 // 'login' makes the CF send the link even to an already-confirmed
 // subscriber (the link both confirms — a no-op — and auto-logs in).
 ...(purpose ? { purpose } : {}),
 }),
 });
 const data = await resp.json();
 return data as { success: boolean; error?: string };
 } catch (error: any) {
 console.warn('[newsletter] Failed to request confirmation email:', error?.message);
 reportCaughtError(error, 'newsletter.sendConfirmation');
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Request the post-signup welcome email for a PRE-CONFIRMED subscriber
 * (Google One Tap, Google/Facebook/LinkedIn sign-in, job-unlock gates —
 * written client-side straight to Firestore, no confirmation-link step).
 * Mirrors requestConfirmationEmail's fetch style / error handling / non-
 * throwing contract; called by upsertNewsletterSubscriber, never throws.
 */
export async function requestWelcomeEmail(
 email: string,
): Promise<{ success: boolean; error?: string }> {
 try {
 const { getLocale } = await import('@/services/i18n');
 const resp = await fetch(`${FUNCTIONS_BASE}/newsletterSendWelcome`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 email: email.toLowerCase().trim(),
 locale: getLocale(),
 }),
 });
 const data = await resp.json();
 return data as { success: boolean; error?: string };
 } catch (error: any) {
 console.warn('[newsletter] Failed to request welcome email:', error?.message);
 reportCaughtError(error, 'newsletter.sendWelcome');
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

export async function confirmNewsletterSubscription(
 email: string,
 token: string,
): Promise<{ success: boolean; error?: string; alreadyConfirmed?: boolean; authToken?: string }> {
 try {
 const { getLocale } = await import('@/services/i18n');
 const locale = getLocale();
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=confirm&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&locale=${locale}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return {
 success: true,
 alreadyConfirmed: data.alreadyConfirmed || false,
 authToken: data.authToken || undefined,
 };
 }
 return { success: false, error: 'confirmation_failed' };
 } catch (error: any) {
 console.warn('[newsletter] Confirmation verification failed:', error?.message);
 reportCaughtError(error, 'newsletter.confirmSubscription');
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Exchange an autologin code for a fresh Firebase custom token.
 *
 * The Cloud Function validates the code, finds/creates the user, and returns a
 * custom token valid for 1 hour (generated on demand).
 *
 * Since #5685 it can refuse an AUTHENTIC code: `auth_code_expired` past the
 * TTL, `auth_code_revoked` past the subscriber's revocation watermark,
 * `autologin_disabled` when they opted out of being signed in by a link. Those
 * three come back with `optOutEligible: true` — the code cannot open a session
 * but is still good enough to record an opt-out, which is why an unsubscribe
 * must be routed to unsubscribeViaCloudFunction instead of giving up.
 */
export async function exchangeNewsletterAuthCode(
 email: string,
 code: string,
): Promise<{ success: boolean; authToken?: string; error?: string; optOutEligible?: boolean }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=exchange_auth_code&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(code)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success && data.authToken) {
 return { success: true, authToken: data.authToken };
 }
 return { success: false, error: data.error || 'exchange_failed', optOutEligible: data.optOutEligible === true };
 } catch (error: any) {
 console.warn('[newsletter] Auth code exchange failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Record an opt-out through the Cloud Function, with no session at all (#5685).
 *
 * THE FALLBACK THAT KEEPS THE EXIT OPEN. The footer unsubscribe link built by
 * makeUnsubscribeUrl / makeAuthenticatedActionUrl lands on the site root and is
 * decided by App.tsx, which needs a signed-in session for its client-side
 * Firestore write. When the autologin exchange refuses — the code expired, was
 * revoked, the subscriber turned autologin off, the link never carried an `ac`
 * at all (the #5672 shape), the network failed — the old code showed "Link non
 * valido" and the person could not leave. That is the defect the LPD art. 25/32
 * complaint behind this whole wave was about.
 *
 * `credential` is whatever the URL carries: the `token` email HMAC first, an
 * `ac` autologin code second. handleSubscriptionManagement accepts EITHER for
 * `action=unsubscribe` (verifyOptOutCredential), and neither has to be live.
 *
 * Deliberately unsubscribe-only. There is no resubscribe twin: putting somebody
 * BACK on a list from a stale credential is the #5672 resurrection, and the
 * asymmetry is the point.
 */
export async function unsubscribeViaCloudFunction(
 email: string,
 credential: string,
): Promise<{ success: boolean; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 if (!normalizedEmail || !credential) return { success: false, error: 'missing_credential' };
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=unsubscribe&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(credential)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json().catch(() => ({}));
 if (resp.ok && data?.success !== false) return { success: true };
 return { success: false, error: data?.error || `http_${resp.status}` };
 } catch (error: any) {
 console.warn('[newsletter] Cloud Function unsubscribe failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Read the autologin-enabled flag for a subscriber.
 * Uses the same HMAC token as unsubscribe (just the email, no prefix).
 * Returns { enabled: true } by default for subscribers without the field set.
 */
export async function getAutologinStatus(
 email: string,
 token: string,
): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=get_autologin_status&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return { success: true, enabled: data.enabled !== false };
 }
 return { success: false, error: data.error || 'read_failed' };
 } catch (error: any) {
 console.warn('[newsletter] Read autologin status failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Toggle the autologin-enabled flag for a subscriber (HMAC-authed).
 * When enabled=false, scheduled newsletter + job alert emails to this
 * address will NOT include the `ac` autologin code in internal links.
 */
export async function toggleAutologin(
 email: string,
 token: string,
 enabled: boolean,
): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=toggle_autologin&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&enabled=${enabled ? 'true' : 'false'}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return { success: true, enabled: data.enabled === true };
 }
 return { success: false, error: data.error || 'write_failed' };
 } catch (error: any) {
 console.warn('[newsletter] Toggle autologin failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Invalidate every autologin link ALREADY SENT to this address (#5685).
 *
 * Stamps the `autologin_revoked_before` watermark, after which no code issued
 * earlier can open a session — the answer to "I forwarded one of your emails
 * and it signs the recipient in as me". Needs the email HMAC `token`, the same
 * credential the rest of the preference centre uses.
 *
 * Does NOT affect the ability to unsubscribe: the opt-out credential check is
 * revocation-blind on purpose (verifyOptOutCredential).
 */
export async function revokeAutologinLinks(
 email: string,
 token: string,
): Promise<{ success: boolean; revokedAt?: string; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=revoke_autologin&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) return { success: true, revokedAt: data.revokedAt };
 return { success: false, error: data.error || 'write_failed' };
 } catch (error: any) {
 console.warn('[newsletter] Revoke autologin failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

// ─── Subscription preferences controller (HMAC token mode) ─────

export type SubscriptionAlertSummary = {
 id: string;
 keywords: string[];
 locations: string[];
 sectors: string[];
 frequency: string;
 /**
  * `true` when the user manually pinned this cadence (frequency change or
  * creation via this UI) — the adaptive-frequency engine leaves it alone.
  * Absent/false on legacy alerts predating the engine: engine-managed.
  */
 frequencyOverride: boolean;
 /**
 * SOLELY the soft-delete flag — `false` means the doc was soft-deleted by
 * services/jobAlertService.ts's deleteAlert() and must never be surfaced.
 * `get_full_status` already filters these out server-side, so every alert
 * reaching the client has `active: true`. Never write this via update —
 * use `paused` for pause/resume (issue #4298 follow-up fix).
 */
 active: boolean;
 /** Pause/resume toggle, orthogonal to `active`. See `active` doc above. */
 paused: boolean;
 /**
  * Pinned scope (#5012). `specificCompanyKey` is the canonical
  * `/aziende/<slug>/` slug of a followed employer (CompanyAlert);
  * `specificJobId` pins a single ad. Both null = a normal keyword/geo alert.
  * The matcher has hard-filtered on these since day one; before #5012 nothing
  * read them back, so a followed employer was invisible and un-unfollowable.
  */
 specificCompanyKey: string | null;
 specificJobId: string | null;
 createdAt: number | null;
};

/**
 * What the reader can pin for the daily brief (#5415 §3.7). `null`/absent means
 * the engine picks the cadence from engagement; 'off' stops the bulletin alone,
 * leaving the weekly newsletter and the job alerts untouched.
 *
 * Kept in step with FREQUENCY_OVERRIDES in scripts/lib/dailyBriefCadence.mjs by
 * tests/daily-brief-preferences.test.ts — the sender cannot import this file.
 */
export const DAILY_BRIEF_FREQUENCIES = ['daily', 'every-2', 'every-3', 'every-5', 'weekly', 'off'] as const;
export type DailyBriefFrequency = typeof DAILY_BRIEF_FREQUENCIES[number];

export type FullSubscriptionStatus = {
 success: boolean;
 email?: string;
 newsletter?: {
 subscribed: boolean;
 autologinEnabled: boolean;
 /** Daily-brief cadence pinned by the reader, or null when the engine drives it (#5415 §3.7). */
 dailyBriefFrequency?: DailyBriefFrequency | null;
 /** Days between sends the engine currently computes — shown so "automatic" is legible. */
 dailyBriefTier?: number | null;
 };
 alerts?: SubscriptionAlertSummary[];
 error?: string;
};

/**
 * Read full subscription status (newsletter + alerts) for an email via HMAC token.
 * Backend route: ?action=get_full_status. Used by the public preferences page.
 */
export async function getFullSubscriptionStatus(
 email: string,
 token: string,
): Promise<FullSubscriptionStatus> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=get_full_status&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return {
 success: true,
 email: typeof data.email === 'string' ? data.email : normalizedEmail,
 newsletter: {
 subscribed: data.newsletter?.subscribed === true,
 autologinEnabled: data.newsletter?.autologinEnabled !== false,
 dailyBriefFrequency: DAILY_BRIEF_FREQUENCIES.includes(data.newsletter?.dailyBriefFrequency)
 ? data.newsletter.dailyBriefFrequency
 : null,
 dailyBriefTier: typeof data.newsletter?.dailyBriefTier === 'number' ? data.newsletter.dailyBriefTier : null,
 },
 alerts: Array.isArray(data.alerts)
 ? data.alerts.map((a: any) => ({
 id: String(a.id || ''),
 keywords: Array.isArray(a.keywords) ? a.keywords.map(String) : [],
 locations: Array.isArray(a.locations) ? a.locations.map(String) : [],
 sectors: Array.isArray(a.sectors) ? a.sectors.map(String) : [],
 frequency: typeof a.frequency === 'string' ? a.frequency : 'weekly',
 frequencyOverride: a.frequencyOverride === true,
 active: a.active !== false,
 paused: a.paused === true,
 createdAt: typeof a.createdAt === 'number' ? a.createdAt : null,
 }))
 : [],
 };
 }
 return { success: false, error: data?.error || 'read_failed' };
 } catch (error: any) {
 console.warn('[newsletter] getFullSubscriptionStatus failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Toggle the newsletter subscription for an HMAC-authed email.
 * subscribed=true → status:'subscribed', isActive:true. subscribed=false → unsubscribe.
 */
export async function toggleNewsletterSubscription(
 email: string,
 token: string,
 subscribed: boolean,
): Promise<{ success: boolean; subscribed?: boolean; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=toggle_newsletter_subscription&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&subscribed=${subscribed ? 'true' : 'false'}&format=json`;
 // POST, not GET, and only because of the re-opt-in direction (#5711): the
 // handler refuses `subscribed=true` on a GET so that no state change putting
 // somebody BACK on a list can be produced by following a URL. The params stay
 // on the query string — functions/index.js merges query and body for POST, so
 // this is one verb changing, not a payload move.
 const resp = await fetch(url, { method: 'POST' });
 const data = await resp.json();
 if (resp.ok && data.success) {
 return { success: true, subscribed: data.subscribed === true };
 }
 return { success: false, error: data?.error || 'write_failed' };
 } catch (error: any) {
 console.warn('[newsletter] toggleNewsletterSubscription failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Pin (or release) the daily brief's send cadence for an HMAC-authed email.
 *
 * `frequency: null` hands the channel back to the engagement engine; 'off'
 * stops the bulletin without touching the weekly newsletter or the job alerts.
 * Backend route: ?action=set_daily_brief_frequency.
 */
export async function setDailyBriefFrequency(
 email: string,
 token: string,
 frequency: DailyBriefFrequency | null,
): Promise<{ success: boolean; dailyBriefFrequency?: DailyBriefFrequency | null; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=set_daily_brief_frequency&email=${encodeURIComponent(normalizedEmail)}`
 + `&token=${encodeURIComponent(token)}&daily_brief_frequency=${encodeURIComponent(frequency ?? 'auto')}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return { success: true, dailyBriefFrequency: data.dailyBriefFrequency ?? null };
 }
 return { success: false, error: data?.error || 'write_failed' };
 } catch (error: any) {
 console.warn('[newsletter] setDailyBriefFrequency failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Delete a job alert by id for an HMAC-authed email.
 * Backend hard-deletes the doc at job_alert_subscribers/{email}/alerts/{alertId}.
 */
export async function deleteJobAlert(
 email: string,
 token: string,
 alertId: string,
): Promise<{ success: boolean; alertId?: string; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=delete_alert&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(token)}&alert_id=${encodeURIComponent(alertId)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return { success: true, alertId: typeof data.alert_id === 'string' ? data.alert_id : alertId };
 }
 return { success: false, error: data?.error || 'delete_failed' };
 } catch (error: any) {
 console.warn('[newsletter] deleteJobAlert failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * `'immediate'` (#5012 phase 2) is a CompanyAlert-only cadence: it routes the
 * alert to the event-driven sender (scripts/send-company-alerts.mjs) instead of
 * the daily digest. Kept in this union so the token-mode preferences page can
 * READ BACK and display a followed-employer alert instead of mislabelling it
 * — the shape must round-trip through the Cloud Function, which is why
 * `normalizeFrequency` in functions/src/newsletterSubscriptionManagement.js
 * accepts it too. It is deliberately NOT offered in the generic frequency
 * picker: an immediate cadence without an employer pin would mean an email per
 * job across the whole board.
 */
export type JobAlertFrequency = 'daily' | 'weekly' | 'immediate';

export type JobAlertSummary = {
 id: string;
 keywords: string[];
 locations: string[];
 sectors: string[];
 frequency: JobAlertFrequency | string;
 frequencyOverride: boolean;
 active: boolean;
 /** Pause/resume toggle, orthogonal to `active`. Issue #4298 follow-up fix. */
 paused: boolean;
 /** Pinned scope (#5012) — see SubscriptionAlertSummary above. */
 specificCompanyKey: string | null;
 specificJobId: string | null;
 createdAt: string | number | null;
 lastMatchedAt?: string | null;
 email?: string | null;
};

export type JobAlertPatch = {
 keywords?: string[];
 locations?: string[];
 sectors?: string[];
 frequency?: JobAlertFrequency;
 /** Use `in` semantics at the call site: pass `true` to pin, `false` to reset to engine-managed. */
 frequencyOverride?: boolean;
 /**
 * Pause/resume toggle. Never send `active` here — that field is SOLELY the
 * soft-delete flag (services/jobAlertService.ts's deleteAlert()); update_alert
 * on the backend ignores it. Issue #4298 follow-up fix.
 */
 paused?: boolean;
 /**
  * Pinned scope (#5012). Pass `null` to CLEAR the pin and turn a CompanyAlert
  * back into a normal alert — `in` semantics at the call site, same as
  * `frequencyOverride`/`paused`.
  */
 specificCompanyKey?: string | null;
 specificJobId?: string | null;
};

export type JobAlertCreatePayload = {
 keywords: string[];
 locations: string[];
 sectors: string[];
 frequency: JobAlertFrequency;
 /**
  * Pinned scope (#5012). A CompanyAlert is created with EMPTY keywords and
  * locations plus a `specificCompanyKey` — the pin is the filter. Before
  * #5012 the backend rejected exactly that shape with `missing_filters`.
  */
 specificCompanyKey?: string | null;
 specificJobId?: string | null;
};

function normalizeAlertResponse(a: any): JobAlertSummary {
 return {
 id: String(a?.id || ''),
 keywords: Array.isArray(a?.keywords) ? a.keywords.map(String) : [],
 locations: Array.isArray(a?.locations) ? a.locations.map(String) : [],
 sectors: Array.isArray(a?.sectors) ? a.sectors.map(String) : [],
 frequency: typeof a?.frequency === 'string' ? a.frequency : 'weekly',
 frequencyOverride: a?.frequencyOverride === true,
 active: a?.active !== false,
 paused: a?.paused === true,
 specificCompanyKey: typeof a?.specificCompanyKey === 'string' && a.specificCompanyKey
 ? a.specificCompanyKey
 : null,
 specificJobId: typeof a?.specificJobId === 'string' && a.specificJobId ? a.specificJobId : null,
 createdAt: a?.createdAt ?? null,
 lastMatchedAt: a?.lastMatchedAt ?? null,
 email: typeof a?.email === 'string' ? a.email : null,
 };
}

/**
 * Update fields on a job alert by id (HMAC-authed).
 * Backend route: ?action=update_alert. Only the fields supplied in `patch`
 * are written (merge:true). List fields are sent as CSV strings.
 */
export async function updateJobAlert(
 email: string,
 token: string,
 alertId: string,
 patch: JobAlertPatch,
): Promise<{ success: boolean; alert?: JobAlertSummary; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const params = new URLSearchParams();
 params.set('action', 'update_alert');
 params.set('email', normalizedEmail);
 params.set('token', token);
 params.set('alert_id', alertId);
 params.set('format', 'json');
 if (patch.keywords !== undefined) params.set('keywords', patch.keywords.join(','));
 if (patch.locations !== undefined) params.set('locations', patch.locations.join(','));
 if (patch.sectors !== undefined) params.set('sectors', patch.sectors.join(','));
 if (patch.frequency !== undefined) params.set('frequency', patch.frequency);
 // `in` (not `!== undefined`) so callers can deliberately reset to
 // engine-managed (`false`), not just pin (`true`) — see
 // components/preferences/SubscriptionPreferencesController.tsx.
 if ('frequencyOverride' in patch) params.set('frequency_override', patch.frequencyOverride ? 'true' : 'false');
 // `in` so callers can deliberately resume (`false`), not just pause (`true`).
 if ('paused' in patch) params.set('paused', patch.paused ? 'true' : 'false');
 // `in` so callers can deliberately CLEAR the pin by passing `null` (#5012).
 if ('specificCompanyKey' in patch) params.set('specific_company_key', patch.specificCompanyKey || '');
 if ('specificJobId' in patch) params.set('specific_job_id', patch.specificJobId || '');
 const url = `${FUNCTIONS_BASE}/newsletterManageSubscription?${params.toString()}`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return {
 success: true,
 alert: data.alert ? normalizeAlertResponse(data.alert) : undefined,
 };
 }
 return { success: false, error: data?.error || 'update_failed' };
 } catch (error: any) {
 console.warn('[newsletter] updateJobAlert failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

/**
 * Create a new job alert (HMAC-authed).
 * Backend route: ?action=create_alert. List fields sent as CSV strings.
 * Backend caps total alerts per user at 10.
 */
export async function createJobAlert(
 email: string,
 token: string,
 payload: JobAlertCreatePayload,
): Promise<{ success: boolean; alert?: JobAlertSummary; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const params = new URLSearchParams();
 params.set('action', 'create_alert');
 params.set('email', normalizedEmail);
 params.set('token', token);
 params.set('format', 'json');
 params.set('keywords', payload.keywords.join(','));
 params.set('locations', payload.locations.join(','));
 params.set('sectors', payload.sectors.join(','));
 params.set('frequency', payload.frequency);
 if (payload.specificCompanyKey) params.set('specific_company_key', payload.specificCompanyKey);
 if (payload.specificJobId) params.set('specific_job_id', payload.specificJobId);
 const url = `${FUNCTIONS_BASE}/newsletterManageSubscription?${params.toString()}`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success) {
 return {
 success: true,
 alert: data.alert ? normalizeAlertResponse(data.alert) : undefined,
 };
 }
 return { success: false, error: data?.error || 'create_failed' };
 } catch (error: any) {
 console.warn('[newsletter] createJobAlert failed:', error?.message);
 return { success: false, error: error?.message || 'unknown_error' };
 }
}

// ─── Email provider helper (FRO-23) ─────────────────────────

const EMAIL_PROVIDERS: Array<{ domains: string[]; name: string; url: string; mobileUrl?: string }> = [
 { domains: ['gmail.com', 'googlemail.com'], name: 'Gmail', url: 'https://mail.google.com', mobileUrl: 'googlegmail://' },
 { domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.it'], name: 'Outlook', url: 'https://outlook.live.com', mobileUrl: 'ms-outlook://' },
 { domains: ['yahoo.com', 'yahoo.it', 'yahoo.co.uk', 'ymail.com'], name: 'Yahoo Mail', url: 'https://mail.yahoo.com', mobileUrl: 'ymail://' },
 { domains: ['icloud.com', 'me.com', 'mac.com'], name: 'iCloud Mail', url: 'https://www.icloud.com/mail' },
 { domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'], name: 'Proton Mail', url: 'https://mail.proton.me', mobileUrl: 'protonmail://' },
 { domains: ['libero.it'], name: 'Libero Mail', url: 'https://mail.libero.it' },
 { domains: ['virgilio.it'], name: 'Virgilio Mail', url: 'https://mail.virgilio.it' },
 { domains: ['tiscali.it'], name: 'Tiscali Mail', url: 'https://mail.tiscali.it' },
 { domains: ['bluewin.ch'], name: 'Bluewin', url: 'https://mail.bluewin.ch' },
];

function isMobileDevice(): boolean {
 if (typeof navigator === 'undefined') return false;
 return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function getEmailProviderInfo(email: string): { name: string; url: string } | null {
 const domain = email.split('@')[1]?.toLowerCase();
 if (!domain) return null;
 const match = EMAIL_PROVIDERS.find((p) => p.domains.includes(domain));
 if (!match) return null;
 return { name: match.name, url: match.url };
}

/**
 * Open the user's email provider — tries native app on mobile, falls back to web.
 * Uses custom URL schemes (googlegmail://, ms-outlook://) to trigger native apps.
 */
export function openEmailProvider(email: string): void {
 const domain = email.split('@')[1]?.toLowerCase();
 if (!domain) return;
 const match = EMAIL_PROVIDERS.find((p) => p.domains.includes(domain));
 if (!match) return;

 if (isMobileDevice() && match.mobileUrl) {
 // Try native app scheme; if it fails (app not installed), the browser stays on current page
 // After a short delay, fall back to the web URL
 const fallbackTimer = setTimeout(() => {
 window.open(match.url, '_blank');
 }, 1500);

 // If the app opens successfully, the page loses focus — clear the fallback
 const onBlur = () => {
 clearTimeout(fallbackTimer);
 window.removeEventListener('blur', onBlur);
 };
 window.addEventListener('blur', onBlur);

 window.location.href = match.mobileUrl;
 } else {
 window.open(match.url, '_blank');
 }
}

// ─── Engagement scoring (FRO-17) ────────────────────────────

export type EngagementLevel = 'hot' | 'warm' | 'cool' | 'cold' | 'dormant';

export function calculateEngagementScore(subscriber: {
 send_count?: number;
 open_count?: number;
 click_count?: number;
 last_open_at?: string | null;
 last_click_at?: string | null;
 last_sent_at?: string | null;
 subscribed_at?: string | null;
}): { score: number; level: EngagementLevel } {
 const sendCount = Number(subscriber.send_count) || 0;
 const openCount = Number(subscriber.open_count) || 0;
 const clickCount = Number(subscriber.click_count) || 0;

 // Open rate component (0-40 points)
 const openRate = sendCount > 0 ? openCount / sendCount : 0;
 const openScore = Math.min(40, Math.round(openRate * 80));

 // Click rate component (0-30 points)
 const clickRate = sendCount > 0 ? clickCount / sendCount : 0;
 const clickScore = Math.min(30, Math.round(clickRate * 150));

 // Recency component (0-30 points)
 const now = Date.now();
 const lastEngagement = subscriber.last_click_at || subscriber.last_open_at;
 let recencyScore = 0;
 if (lastEngagement) {
 const daysSince = (now - new Date(lastEngagement).getTime()) / (1000 * 60 * 60 * 24);
 if (daysSince < 7) recencyScore = 30;
 else if (daysSince < 14) recencyScore = 25;
 else if (daysSince < 30) recencyScore = 18;
 else if (daysSince < 60) recencyScore = 10;
 else if (daysSince < 90) recencyScore = 5;
 }

 const score = Math.min(100, openScore + clickScore + recencyScore);

 let level: EngagementLevel;
 if (score >= 70) level = 'hot';
 else if (score >= 50) level = 'warm';
 else if (score >= 30) level = 'cool';
 else if (score >= 10) level = 'cold';
 else level = 'dormant';

 return { score, level };
}

// ─── Rate limiting (FRO-19) ─────────────────────────────────

const SUBSCRIBE_RATE_LIMIT_KEY = 'newsletter_rate_limit';
const SUBSCRIBE_RATE_LIMIT_MS = 30_000; // 30 seconds between subscription attempts
const SUBSCRIBE_RATE_LIMIT_MAX = 3; // Max 3 attempts per window

export function checkSubscriptionRateLimit(): { allowed: boolean; retryAfterMs: number } {
 if (typeof window === 'undefined') return { allowed: true, retryAfterMs: 0 };
 try {
 const raw = window.sessionStorage.getItem(SUBSCRIBE_RATE_LIMIT_KEY);
 if (!raw) return { allowed: true, retryAfterMs: 0 };
 const state = JSON.parse(raw) as { attempts: number; windowStart: number };
 const now = Date.now();
 const elapsed = now - state.windowStart;

 if (elapsed > SUBSCRIBE_RATE_LIMIT_MS) {
 return { allowed: true, retryAfterMs: 0 };
 }

 if (state.attempts >= SUBSCRIBE_RATE_LIMIT_MAX) {
 return { allowed: false, retryAfterMs: SUBSCRIBE_RATE_LIMIT_MS - elapsed };
 }

 return { allowed: true, retryAfterMs: 0 };
 } catch {
 return { allowed: true, retryAfterMs: 0 };
 }
}

export function recordSubscriptionAttempt(): void {
 if (typeof window === 'undefined') return;
 try {
 const now = Date.now();
 const raw = window.sessionStorage.getItem(SUBSCRIBE_RATE_LIMIT_KEY);
 let state = { attempts: 0, windowStart: now };
 if (raw) {
 state = JSON.parse(raw);
 if (now - state.windowStart > SUBSCRIBE_RATE_LIMIT_MS) {
 state = { attempts: 0, windowStart: now };
 }
 }
 state.attempts += 1;
 window.sessionStorage.setItem(SUBSCRIBE_RATE_LIMIT_KEY, JSON.stringify(state));
 } catch {
 // no-op
 }
}
