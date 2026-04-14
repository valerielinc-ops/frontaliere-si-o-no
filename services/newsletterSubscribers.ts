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
import { reportCaughtError } from '@/services/errorReporter';

const LOCAL_SUBSCRIBED_KEY = 'newsletter_subscribed';

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
 | 'web_app'
 | string;

export type NewsletterGeoSource = 'profile_municipality' | 'ip_lookup' | 'manual' | 'none';

export type NewsletterUtm = {
 source?: string;
 medium?: string;
 campaign?: string;
 content?: string;
 term?: string;
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
 return { source: source || undefined, medium: medium || undefined, campaign: campaign || undefined, content: content || undefined, term: term || undefined };
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

export function inferNewsletterSubscriptionState(
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
 }

 await setDoc(ref, mergedData, { merge: true });

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
 await upsertNewsletterDelivery(db, {
 email,
 campaignId: input.campaignId || 'unknown',
 messageId: input.messageId || null,
 variant: input.variant || null,
 locale: input.sourceLocale || null,
 status: 'click',
 sectionId: input.sectionId || null,
 clickedLink: input.targetUrl || input.linkUrl || null,
 clickedLabel: input.linkLabel || null,
 });
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
 await upsertNewsletterDelivery(db, {
 email,
 campaignId: input.campaignId || 'unknown',
 messageId: input.messageId || null,
 variant: input.variant || null,
 locale: input.sourceLocale || null,
 status: input.eventType,
 sectionId: input.sectionId || null,
 clickedLink: input.targetUrl || input.linkUrl || null,
 clickedLabel: input.linkLabel || null,
 });
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

const FUNCTIONS_BASE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net';

export async function requestConfirmationEmail(email: string): Promise<{ success: boolean; error?: string }> {
 try {
 const { getLocale } = await import('@/services/i18n');
 const sourcePath = window.location.pathname || '/';
 const resp = await fetch(`${FUNCTIONS_BASE}/newsletterSendConfirmation`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ email: email.toLowerCase().trim(), locale: getLocale(), sourcePath }),
 });
 const data = await resp.json();
 return data as { success: boolean; error?: string };
 } catch (error: any) {
 console.warn('[newsletter] Failed to request confirmation email:', error?.message);
 reportCaughtError(error, 'newsletter.sendConfirmation');
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
 * Exchange an HMAC-based autologin code for a fresh Firebase custom token.
 * The code never expires — it's HMAC("autologin:"+email, NEWSLETTER_SECRET).
 * The Cloud Function validates the HMAC, finds/creates the user, and returns
 * a fresh custom token that's valid for 1 hour (but generated on-demand).
 */
export async function exchangeNewsletterAuthCode(
 email: string,
 code: string,
): Promise<{ success: boolean; authToken?: string; error?: string }> {
 try {
 const normalizedEmail = email.toLowerCase().trim();
 const endpoint = `${FUNCTIONS_BASE}/newsletterManageSubscription`;
 const url = `${endpoint}?action=exchange_auth_code&email=${encodeURIComponent(normalizedEmail)}&token=${encodeURIComponent(code)}&format=json`;
 const resp = await fetch(url);
 const data = await resp.json();
 if (resp.ok && data.success && data.authToken) {
 return { success: true, authToken: data.authToken };
 }
 return { success: false, error: data.error || 'exchange_failed' };
 } catch (error: any) {
 console.warn('[newsletter] Auth code exchange failed:', error?.message);
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
