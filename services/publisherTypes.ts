/**
 * Publisher portal — shared domain types (pure type module, no runtime).
 *
 * Firestore collections (see firestore.rules):
 *   publishers/{uid}            — account + company profile (owner-only)
 *   publisher_jobs/{jobId}      — one paid ad (owner read; public surface = CDN overlay)
 *   orders/{orderId}            — Stripe subscription / payment mirror
 *   publisher_job_events/{jobId}— view/apply-click counters (public increment)
 *   applications/{appId}        — candidate applications (PII; publisher-only read)
 *
 * Timestamps are stored as Firestore Timestamps server-side; in the SPA they are
 * read as epoch millis (number) after normalization, so types accept both.
 */

import type { Locale } from './i18n';

export type IsoTimestamp = number; // epoch millis (normalized client-side)

/** Locale-keyed translatable string map (it is the canonical source). */
export type LocalizedText = Partial<Record<Locale, string>>;

// ─── Publisher account / company ───────────────────────────────────────────

export type PublisherVerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

/** Legal form for invoicing (locked: ditta individuale / persona fisica). */
export type PublisherLegalForm = 'ditta_individuale' | 'persona_fisica' | 'azienda';

export interface PublisherCompany {
  /** Display name shown on job pages (hiringOrganization.name). */
  name: string;
  /** Stable key folded into company hubs (slugified name). */
  companyKey: string;
  /** Optional canonical website domain (used for future domain auto-verify). */
  domain?: string;
  /** Logo URL (Firebase Storage / CDN). */
  logoUrl?: string;
  legalForm?: PublisherLegalForm;
  /** Billing address — invoicing to ditta individuale / persona fisica. */
  vatOrFiscalId?: string;
  billingAddress?: PostalAddress;
}

export interface PostalAddress {
  streetAddress?: string;
  postalCode?: string;
  addressLocality?: string;
  addressRegion?: string; // canton
  addressCountry?: string; // ISO-2, e.g. 'CH'
}

export interface Publisher {
  uid: string;
  email: string;
  company: PublisherCompany;
  verification: PublisherVerificationStatus;
  /** Domain ownership (DNS TXT) verification — set by verifyPublisherDomain CF. */
  domainVerified?: boolean;
  domainVerifyToken?: string;
  /** Stripe customer id once a checkout has been initiated. */
  stripeCustomerId?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ─── Publisher job ad ───────────────────────────────────────────────────────

/**
 * Two product tiers (owner decision 2026-06-10):
 *   free      — enters the normal crawler flow: published straight into the
 *               by-crawler slice, NO featured, NO newsletter blast, apply is
 *               external-link only (exactly like a crawled job). No payment.
 *   sponsored — paid subscription: featured eligible, newsletter blast, all
 *               three apply modes, analytics. Goes through Stripe.
 */
export type PublisherTier = 'free' | 'sponsored';

/**
 * Lifecycle:
 *   draft           — being edited, never public
 *   pending_payment — sponsored: checkout created, awaiting Stripe confirmation
 *   paid            — sponsored: subscription active (set ONLY by webhook/Admin SDK)
 *   published       — free: live in the slice (client-settable, gated; free tier only)
 *   expired         — subscription cancelled / lapsed (webhook)
 *   rejected        — failed an automatic gate (thin content / dedup)
 *   archived        — publisher-archived from the dashboard. Removed from the
 *                     live slice, but the Stripe subscription stays ACTIVE: the
 *                     publisher paid for a slot/credit and can reuse it for a
 *                     new ad. Distinct from `expired` (which means billing died).
 *
 * "Live" (projected into the slice) = `paid` (sponsored) OR `published` (free).
 */
export type PublisherJobStatus =
  | 'draft'
  | 'pending_payment'
  | 'paid'
  | 'published'
  | 'expired'
  | 'rejected'
  | 'archived';

/** Status values that mean the ad is live and should be projected into the slice. */
export const LIVE_JOB_STATUSES: readonly PublisherJobStatus[] = ['paid', 'published'];

/** How candidates apply (locked: build all three generically). */
export type ApplyMode = 'external_url' | 'forward_email' | 'in_house';

export interface PublisherJobLocation {
  /** Human label entered by the publisher (e.g. "Lugano"). */
  label: string;
  canton?: string; // e.g. 'TI'
  address?: PostalAddress;
}

export interface PublisherJobApply {
  mode: ApplyMode;
  /** external_url → the publisher's apply link. */
  url?: string;
  /** forward_email / in_house → where we send the candidate data. */
  email?: string;
  /** Publisher's own privacy-policy URL (shown on the in-house/forward form). */
  privacyPolicyUrl?: string;
}

/**
 * One publisher ad. The same ad text can target multiple locations; billing
 * counts each (ad × location) pair as a unit (see services/publisherPricing.ts).
 * When published, this is projected into a `data/jobs/by-crawler/publisher-submitted.json`
 * slice (one job record per location) and into the runtime overlay.
 */
export interface PublisherJob {
  id: string;
  publisherUid: string;
  tier: PublisherTier;
  status: PublisherJobStatus;

  // Content (it canonical, other locales optional / auto-translated in Phase 2)
  title: string;
  titleByLocale?: LocalizedText;
  description: string; // min 50 words (automatic gate)
  descriptionByLocale?: LocalizedText;
  sourceLang: Locale;

  company: PublisherCompany;
  locations: PublisherJobLocation[];
  category?: string;
  sector?: string;
  employmentType?: string; // FULL_TIME / PART_TIME / ...
  contractType?: string;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;

  apply: PublisherJobApply;

  /** Paid upsell flag — reuses the existing `featured` job-record field. */
  featured?: boolean;
  /** Whether the role-targeted newsletter blast was sent (idempotency guard). */
  blastSentAt?: IsoTimestamp;

  /** Stripe linkage. */
  orderId?: string;
  subscriptionId?: string;

  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  /** Set when status flips to paid (drives 30-day renewal display + 1–2h notice). */
  paidAt?: IsoTimestamp;
}

// ─── Orders / Stripe mirror ─────────────────────────────────────────────────

export type OrderStatus =
  | 'created'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'refunded';

export interface Order {
  id: string;
  publisherUid: string;
  jobIds: string[];
  units: number;
  /** Net total in CHF for one renewal period (after discount). */
  amountChf: number;
  discountRate: number;
  currency: string; // 'CHF'
  status: OrderStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ─── Analytics events ───────────────────────────────────────────────────────

export interface PublisherJobEventCounters {
  jobId: string;
  views: number;
  applyClicks: number;
  updatedAt: IsoTimestamp;
}

// ─── Applications (in-house / forward modes) ────────────────────────────────

export interface Application {
  id: string;
  jobId: string;
  publisherUid: string; // denormalized for rule-based read scoping
  candidateName: string;
  candidateEmail: string;
  message?: string;
  cvUrl?: string;
  /** GDPR: explicit, logged consent to forward PII to the third-party employer. */
  consentGiven: boolean;
  consentText: string;
  forwardedAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
}
