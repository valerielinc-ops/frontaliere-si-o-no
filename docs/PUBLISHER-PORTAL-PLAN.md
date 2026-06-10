# Publisher / Paid Job-Posting Portal — Implementation Plan

> Status: IN IMPLEMENTATION (branch `feat/publisher-portal`). Author: architecture review, 2026-06-10.
> Every file/collection cited below was verified against the working tree. Items I could not confirm are flagged **`da verificare: …`**.

---

## 0. Locked owner decisions (2026-06-10)

These supersede any earlier "HYPOTHESIS"/options text below where they conflict.

1. **Payments = Stripe, subscription model.** Each ad is a **recurring 30-day subscription** that **auto-renews until cancelled** (NOT a one-time Payment Link). Invoicing to a *ditta individuale / persona fisica*. → §6.2 / Task 4.
2. **Price = CHF 49 per ad *per location*, newsletter blast included.** The same ad text published to *N* locations counts as *N* billable ads (*N* × 49). → §6.10 / Task 2.
3. **Volume discount: > 2 ads → 10% increasing.** Progressive discount that grows with ad count beyond 2. Encoded as a single configurable tier table in `services/publisherPricing.ts` (default below, owner can tune one constant). → §6.10 / Task 2.
4. **Autopublish on payment.** No human review. UI tells the publisher the ad will be **"disponibile tra 1–2 ore"** — that wording maps to the deploy/SSG latency, not a review queue. → §6.4 / Task 6.
5. **Application system = generic for now.** Build the 3 modes generically; defer all PhysioMedical-specific wiring to `docs/PUBLISHER-PORTAL-physiomedical.md` *after* all phases land. → §6.8 / Task 7.
6. **Company + ad data entered by the publisher at ad-creation time** (company onboarding folded into the first ad-creation flow, not a separate prior step). → §5(b) / Task 5.

**Default discount table (tunable, §6.10):** 1–2 ads → 0% · 3 ads → 10% · then +5% per extra ad, capped 40%
(`3→10, 4→15, 5→20, …, ≥9→40`). Marked as the concrete reading of "10% a crescere"; owner confirms the curve.

**Go-live blockers that need the owner (cannot be done autonomously):** Stripe account + live API keys + Products/Prices + webhook signing secret; Firestore rules deploy; Cloud Functions deploy. All code is written against Remote-Config/env placeholders and flagged.

---

## 1. Executive summary

Today the site is a **$0-fixed-cost SEO funnel** monetised ~95% by AdSense. Jobs flow **only** from dedicated crawlers → `data/jobs/by-crawler/<key>.json` → `scripts/assemble-jobs-dataset.mjs` → static SSG pages emitted at build time. There is **no self-serve datore (employer) channel**: the only employer touchpoint is the contact form (`components/pages/ContactPage.tsx`, topic `contact.topic.jobPost`) which writes `contact_submissions` in Firestore and opens a `mailto:`.

The owner has decided to launch a **paid job-posting portal from day 1**. The single most important architectural insight is already proven by the codebase: **a publisher-submitted job is just another `data/jobs/by-crawler/<source>.json` slice** (the assembler is source-agnostic; the merge identity is `url → id → slug → title+company+location` per `scripts/assemble-jobs-dataset.mjs` lines 294–296, 17–22). So we do **not** invent a new publishing pipeline — we add a *self-serve front door* that produces a slice and a *runtime overlay* so the ad is visible **before** the next SSG build.

Recommended spine:

- **Payments**: **Stripe Payment Links (Phase 1) → Stripe Checkout + webhook Cloud Function (Phase 2)**. Zero fixed cost, per-transaction fee only; webhook fits the existing Functions codebase (`functions/`, runtime nodejs20).
- **SSG-vs-dynamic**: **Hybrid.** Paid job is written to Firestore `publisher_jobs` immediately and surfaced in the SPA via a **runtime-fetched overlay** (same pattern as the per-canton job shard fetch `services/jobsService.ts`, which already pulls `/data/jobs-by-canton/<canton>.json` through `cdnDataUrl()`, and the same pattern as border-wait runtime-fetch). A scheduled **bot-direct-to-main commit** (the `GITHUB_PAT` + `scripts/load-rc-env.mjs` pattern already used repo-wide) writes the `by-crawler/publisher-submitted.json` slice so the **indexable static page** is emitted on the next deploy. The publisher gets instant visibility (SPA), and SEO catches up at the next build (~deploy 5–13 min + SSG ~43 min).
- **Auth/roles**: reuse Firebase Auth (`services/authService.ts`), add a `publishers` collection + a `role: 'publisher'` custom claim set by a Cloud Function; keep candidate accounts and publisher accounts in distinct collections.
- **Featured**: the `featured` boolean **already exists** on the job record and is **already rendered** (`components/community/JobBoard.tsx` lines 269, 524, 1582, 1603, 6196) and **already consumed by the newsletter ranker** (`services/newsletter-content.mjs`). Featured = paid upsell that sets this flag + a sort boost. No schema invention needed.
- **Targeted newsletter blast**: reuse `matchJobsForSubscriber` / `keywordRelevanceScore` (`services/newsletter-content.mjs`) against `newsletter_subscribers` + `job_alert_subscribers` to send a paid, role-targeted blast (e.g. the 7 "fisioterapista Ticino" subscribers).
- **Applications**: design all three modes (in-house collect+forward, external apply URL, forward-to-publisher-email). The site's general **silent-consent** (`services/consentService.ts`) covers *analytics/ads*; it does **NOT** cover transferring a candidate's PII to a third-party employer — that path needs **explicit per-application consent**.

**Phase-1 MVP goal**: the smallest paid path that lets **R&C PhysioMedical Group** publish 3 fisio ads (Lugano ×2, Locarno ×1), pay, go live in the SPA immediately, get a static page on next deploy, and notify matching fisio subscribers — monetising from day one.

---

## 2. Current state (verified files & collections)

### 2.1 Job pipeline (source-agnostic, build-time)
- Per-crawler slices: `data/jobs/by-crawler/<key>.json`, shape `{ crawlerKey, assembledAt, jobs: [...] }` (verified e.g. `data/jobs/by-crawler/abbott.json`).
- Assembler: `scripts/assemble-jobs-dataset.mjs` — reads `JOBS_SLICES_DIR = data/jobs/by-crawler` (line 294), merges by stable identity, last-write-wins by `assembledAt`, sorts by `postedDate`. Module API `writeJobsCrawlerSlice(crawlerKey, jobs)` (line 29).
- Stable id helpers: `scripts/lib/job-identity.mjs` (`buildStableJobIdentity`), `scripts/lib/job-url-key.mjs` (`assembleUrlKey`), `scripts/lib/dedicated-crawler-common.mjs` (`buildStableId`, slug truncation, quality scoring). Salary hardening: `scripts/lib/structured-salary.mjs` (`hardenJobsWithStructuredSalary`).
- **Verified job record fields** (from `data/jobs/by-crawler/abbott.json`): `id, slug, slugByLocale, company, companyKey, companyDomain, title, titleByLocale, description, descriptionByLocale, needsRetranslation, location, canton, url, source, sourceLang, crawledAt, addressLocality, addressRegion, addressCountry, country, category, contract, employmentType, experienceLevel, sector, currency, **featured**, postedDate, applyUrl, requirements, requirementsByLocale, jobReqId, previousSlugsByLocale, previousSlugs, firstSeenAt`. (Plus the salary/structured fields referenced in the brief: `salaryMin/Max, baseSalary, validThrough, streetAddress, postalCode`.)
- Static page emit: `build-plugins/jobsSeoPagesPlugin.ts` (already forwards `featured`, lines 4235/4257/8816) via `build-plugins/shared/seoPageShell.ts` → `buildSeoPageHtml`.

### 2.2 Runtime job delivery (SPA)
- `services/jobsService.ts`: per-canton shard fetch. `SHARD_BASE_PATH = '/data/jobs-by-canton'` (line 74), URL built via `cdnDataUrl()` (line 169) → **`/data/*` is CDN-offloaded** (consistent with the memory note that SPA-fetched data lives behind the CDN). IDB cache + ETag revalidation. 404 = "canton not yet built", SPA stays alive. **This is the hook for the runtime overlay.**

### 2.3 Auth
- `services/authService.ts` (Google + Facebook + Google One Tap, lazy Firebase Auth), `services/firebase.ts` (lazy SDK, Remote Config, App Check w/ reCAPTCHA). User profiles in Firestore `users/{uid}` (`firestore.rules`).

### 2.4 Employer channel today
- `components/pages/ContactPage.tsx`: topics include `contact.topic.jobPost`; submit verifies reCAPTCHA (`services/recaptchaService` + Cloud Function `functions/src/recaptchaVerification.js`, action `CONTACT_FORM`, score floor 0.5), writes `contact_submissions` (rule: `allow create: if true`), opens `mailto:valerielinc@gmail.com`. No self-serve.

### 2.5 Newsletter & alerts
- Collections (verified in `firestore.rules`): `newsletter_subscribers/{email}` (+ `events`, `campaign_deliveries`, `private`), `job_alert_subscribers/{email}` (+ `alerts/{alertId}` with `userId`/`keywords[]`, `alert_deliveries`, `events`).
- Matching: `services/newsletter-content.mjs` — `matchJobsForSubscriber(subscriber, jobs, limit, locale, recentlyFeaturedSlugs)` (line 382), `keywordRelevanceScore` (line 320). `featured`-aware. Template: `services/newsletter-template.mjs`.
- Send: `scripts/send-newsletter.mjs` (Firebase admin `applicationDefault`, multi-provider cascade mailgun/resend/mailjet/mailtrap/maileroo, `--preview`/`--test --target-email`/`--send`). **Never `--send` locally** (memory/AGENTS).
- ESP webhooks: `functions/src/newsletter*WebhookCore.js`, subscription mgmt `functions/src/newsletterSubscriptionManagement.js`.

### 2.6 Analytics & views
- `services/analytics.ts` (Firebase Analytics → GA4, lazy; event catalog incl. `cta_click`, `select_content`, `funnel_step`). PostHog also present (free 1M/mo, **already exceeded once** — query/volume budget is a hard constraint).
- **Job view counter already exists**: `services/jobViewsService.ts` → Firestore `job_views/{canonical-IT-slug}` (rule: public read+write increment). Article equivalent `article_views`. **This is the analytics primitive to extend for publisher dashboards.**

### 2.7 Bot-direct-to-main commit (proven pattern)
- `scripts/load-rc-env.mjs` loads `GITHUB_PAT` from Remote Config; many scripts commit data to `main` (e.g. `scripts/update-weather.ts`, `scripts/backfill-*.mjs`). AGENTS.md: **a data-refresh that commits to `main` must pass the same test gate** (assemble-stats, migrate slugs, vitest) before commit — do not poison `main`.

### 2.8 Hard constraints (AGENTS.md / memory)
- Never disable AdSense Auto Ads; CLS fixes via reserved space only.
- Job structured data must include in **every** locale: `baseSalary, postalCode, streetAddress, title, description, datePosted, hiringOrganization.name, jobLocation, employmentType` — missing source ⇒ safe default, never drop the check.
- Never thin content <50 words indexed.
- Silent consent — no cookie/consent banner (analytics/ads). Privacy: canonical git identity, never hard-code PII.
- Static SSG via `buildSeoPageHtml`; SPA/static handoff is router-driven (`staticOverlay`), never DOM heuristic.
- **SEO automation moratorium**: no new build-plugin SEO landing while GSC 7-day avg position > 7.5 — *exceptions: bug fix, net-reducing consolidation, redirect/bridge emitter*. The portal **reuses the existing job-page emitter**; it does **not** add a new SEO landing type, so it is moratorium-compatible (job pages are organic content, not a new landing surface). **`da verificare:` confirm current `data/gsc-position-rolling.json` 7-day avg with owner before any net-new page family.**

---

## 3. Target architecture (textual flow diagrams)

### 3.1 Publish flow (the core)
```
Publisher (authed, role=publisher)
  │  authoring form (SPA, new route /pubblica-annuncio or component)
  ▼
[Draft]  Firestore publisher_jobs/{jobId}  status=draft  (client write, rules-gated to owner uid)
  │  reCAPTCHA (action PUBLISH_JOB) + min-50-word gate + dedup vs extractStableJobId
  ▼
[Checkout]  Stripe Payment Link (P1) / Checkout Session (P2)
  │  success → Stripe webhook → Cloud Function publishJobPaid()
  ▼
[Paid]  publisher_jobs/{jobId}  status=paid, paidAt, expiresAt(+30d), featured?(if add-on)
  │
  ├─► (A) RUNTIME OVERLAY — instant SPA visibility
  │     CF mirrors paid jobs → /data/publisher-jobs/<canton>.json (CDN-offloaded, same
  │     transport as services/jobsService.ts shard fetch). SPA merges overlay into board.
  │
  └─► (B) SSG SLICE — indexable static page on next deploy
        scheduled GH Action (publisher-jobs-sync) reads paid publisher_jobs →
        writeJobsCrawlerSlice('publisher-submitted', jobs) → data/jobs/by-crawler/publisher-submitted.json
        → commit to main via GITHUB_PAT (load-rc-env) AFTER test gate → deploy → jobsSeoPagesPlugin emits page
```

### 3.2 Application flow (3 modes)
```
Candidate on job page → "Candidati"
  ├─ mode=external  → window.open(applyUrl)                         (no PII held by us)
  ├─ mode=forward   → in-house form → CF forwardApplication() emails publisher (publisher's privacy policy)
  └─ mode=inhouse   → in-house form → applications/{id} (PII, explicit consent) + CF notifies publisher
        analytics: trackUIInteraction('job','apply', mode)  → increments publisher_job_events
```

### 3.3 Analytics flow (zero PostHog query cost)
```
view  : trackJobView(job) [existing] → job_views/{slug}  +  publisher mirror counter
apply : CF/client increment publisher_job_events/{jobId} {views, applyClicks, applyByMode}
dash  : publisher dashboard reads aggregated counters directly (no PostHog query)
```

---

## 4. Data model (Firestore collections)

New collections (names proposed; reuse existing where noted):

### `publishers/{uid}`
Company account / onboarding ("censimento").
```
uid, ownerEmail, role:'publisher', companyName, companyKey, companyDomain,
logoUrl, vatNumber, addressLocality, postalCode, streetAddress, canton, country,
contactName, contactEmail, contactPhone, website,
verified:boolean, verifiedAt, createdAt, stripeCustomerId?, status:'active'|'suspended'
```
- `companyKey` aligns with the crawler `companyKey` so publisher jobs **fold into existing company hubs** (avoids duplicate company pages; cf. `companyHubSlugBuild` migros umbrella precedent).
- Logo: stored in **Firebase Storage** (`storageBucket` already configured in `services/firebase.ts`), `logoUrl` denormalised. `da verificare:` Storage rules (not in `firestore.rules`).

### `publisher_jobs/{jobId}`
The authored ad. Mirror of the **verified job-record shape** so the assembler ingests it unchanged.
```
jobId, publisherUid, status:'draft'|'pending_payment'|'paid'|'live'|'expired'|'rejected',
// job-record fields (must satisfy structured-data invariant per locale):
title, titleByLocale, description, descriptionByLocale, slug, slugByLocale,
company, companyKey, companyDomain, location, addressLocality, postalCode, streetAddress,
addressRegion, canton, country, category, sector, employmentType, contract,
salaryMin, salaryMax, currency, baseSalary, postedDate, validThrough, applyUrl,
applyMode:'external'|'forward'|'inhouse', applyEmail?,  // forward/inhouse target
source:'publisher-submitted', sourceLang,
featured:boolean, featuredUntil?,
orderId, paidAt, expiresAt, createdAt, updatedAt
```
- `id` for the assembler derived from `url` (synthetic canonical URL on `frontaliereticino.ch`) via `extractStableJobId` so dedup vs crawled jobs works.
- **Translation**: source-lang only at authoring; `needsRetranslation:true` triggers the existing translate pipeline (`services/locales/`, translate-pending) before SSG. `da verificare:` whether to gate go-live on translation or emit IT-first and backfill.

### `publisher_job_events/{jobId}`
Aggregated analytics counters (avoids PostHog query cost).
```
jobId, publisherUid, views, applyClicks,
applyByMode:{external,forward,inhouse}, lastViewAt,
daily:{ 'YYYY-MM-DD': {views, applyClicks} }   // bounded map, prune > expiry
```
- Written by the same fire-and-forget path as `job_views` (client increment) + CF for apply events. Dashboard reads this doc directly.

### `applications/{appId}` (in-house mode only)
```
appId, jobId, publisherUid, candidateName, candidateEmail, candidatePhone?,
message?, cvUrl?(Storage), consentToShare:true, consentTimestamp, consentText,
locale, status:'new'|'forwarded'|'archived', createdAt, retentionExpiresAt(+90d)
```
- **PII**: explicit consent stored with the exact consent string + timestamp. Retention auto-purge via scheduled CF. Forward-to-publisher under publisher's policy.

### `orders/{orderId}` (payments)
```
orderId, publisherUid, jobIds:[...], product:'single'|'featured'|'blast'|'bundle',
amount, currency:'CHF', stripeSessionId|stripePaymentLinkRef, stripePaymentIntentId,
status:'created'|'paid'|'refunded'|'failed', paidAt, createdAt
```

### `featured_slots/{slotId}` (Phase 3, only if demand)
Inventory cap so featured doesn't dilute. Phase 1–2 can derive featured purely from `publisher_jobs.featured + featuredUntil` (no separate collection needed).

### Reused, unchanged
- `newsletter_subscribers`, `job_alert_subscribers` (blast targeting), `job_views`/`article_views` (view primitive), `contact_submissions` (fallback channel), `users` (candidate accounts), `config` (cache).

---

## 5. The seven features — options & recommendations

### (a) Job-ad authoring page (self-serve)
- **A. New SPA route + component** (e.g. `/pubblica-annuncio`, register in `services/router.ts` + nav state in `App.tsx`). Multi-step form, reCAPTCHA, live structured-data preview, min-50-word gate.
- **B. Extend `ContactPage.tsx` jobPost topic into a structured wizard.** Cheaper but conflates lead-capture with a paid product; poor UX.
- **C. External form (Typeform/Tally).** Off-platform, no $0 control, no auth tie-in.
- **Recommendation: A**, but Phase-1 MVP starts as a **focused single-page form** (not the full multi-step) to ship fast. The form must enforce the per-locale structured-data invariant client-side and refuse <50 words (AGENTS constraint).

### (b) Company onboarding / "censimento"
- **A. `publishers/{uid}` profile + manual verification** (owner approves in a lightweight admin view — there is already a "hidden admin route" in `services/router.ts` line 801).
- **B. Auto-verify via email-domain match** (companyDomain == verified MX). Lower friction, weaker trust.
- **C. No profile — capture company per-ad.** Causes duplicate/inconsistent company data, breaks company-hub folding.
- **Recommendation: A with B as accelerator.** Manual verify for Phase 1 (low volume, e.g. PhysioMedical), domain-match auto-verify later. Tie `companyKey` to the existing crawler key space to fold into company hubs.

### (c) Publisher analytics dashboard
- **A. Firestore aggregated counters (`publisher_job_events`) read directly.** Reuses the proven `job_views` increment pattern; **zero PostHog query cost**.
- **B. PostHog query API.** Violates the 1M/mo budget already breached; query cost; rejected.
- **C. GA4 Data API via Cloud Function.** Possible but adds GA4 quota + auth complexity; defer.
- **Recommendation: A.** Views via existing `trackJobView` mirrored to `publisher_job_events`; apply clicks via client/CF increment. Dashboard is a SPA view reading the publisher's own docs. (GA4/PostHog remain for the owner's global analytics, not the publisher dashboard.)

### (d) Featured / sponsored
- **A. Reuse the existing `featured` boolean** + `featuredUntil`; sort boost in `JobBoard.tsx` (already renders the star, lines 1603/6196) and in newsletter ranker (already `featured`-aware, `services/newsletter-content.mjs`).
- **B. New sponsorship collection + ad-style slots.** Over-engineered for current scale; risk of looking like cloaking to Google.
- **Recommendation: A.** Featured = paid upsell flag. **No cloaking**: featured jobs are real, indexable jobs shown to all users (a visible "Sponsorizzato" badge), only re-ordered — SEO-safe. Must **not** push AdSense layout (reserve space; never suppress Auto Ads).

### (e) Targeted newsletter blast
- **A. Reuse `matchJobsForSubscriber`/`keywordRelevanceScore`** to select subscribers whose `keywords[]`/`sector_interest`/`job_search_query` match the role, send via `scripts/send-newsletter.mjs` cascade as a paid add-on.
- **B. New bespoke blast pipeline.** Duplicates working infra.
- **Recommendation: A.** A new "single-job blast" mode in the send script (or a thin CF wrapper) that takes one paid `publisher_jobs` doc + a matched-subscriber segment. Respect Mailjet/cascade daily caps and the "never `--send` locally" rule (run via GH Action only).

### (f) Payments
- **A. Stripe Payment Links (P1) → Stripe Checkout + webhook CF (P2).** No fixed cost, per-transaction fee only (owner pays $0 fixed). Payment Link = a URL, zero integration to ship the MVP; webhook later for full automation.
- **B. PayPal.** Higher fees, clunkier CHF/Swiss UX.
- **C. Bank transfer / invoice (manual).** Zero integration but slow, manual reconciliation — acceptable as the *literal* Phase-0 for PhysioMedical if Stripe onboarding lags.
- **Recommendation: A.** Stripe is Swiss/CHF-friendly, supports Payment Links for instant launch, then `functions/` gets a `stripeWebhook` (nodejs20, same codebase) that flips `orders`/`publisher_jobs` to paid. **`da verificare:` Stripe account + CHF payout to owner's bank; add `stripe` npm dep (currently absent from `package.json`).**

### (g) Application system (3 modes — all designed)
- **(i) In-house collect+forward**: `applications/{appId}` with **explicit consent** (checkbox storing consent text + timestamp), CF `forwardApplication` emails the publisher, auto-retention purge. Best data/UX, highest GDPR responsibility.
- **(ii) External apply URL**: open publisher's `applyUrl` — we hold **no** PII. Simplest, lowest liability.
- **(iii) Forward-to-publisher-email**: in-house form, immediately forwarded to publisher's email **under the publisher's privacy policy** (we are processor, brief transient hold). Needs explicit consent + clear "your data goes to <company> under their policy" notice.
- **Recommendation: support all three, default (ii) external for Phase 1** (zero PII, ship fastest). (iii)/(i) in Phase 2–3 with the consent module. PhysioMedical MVP can use (ii) if they have an ATS URL, else (iii).

---

## 6. Architectural tensions — explicit decisions

1. **Static SSG vs dynamic publish** → **Hybrid (overlay + scheduled slice commit).** Instant SPA visibility via runtime overlay `/data/publisher-jobs/<canton>.json` (same `cdnDataUrl` transport as `services/jobsService.ts`); indexable static page via `writeJobsCrawlerSlice('publisher-submitted', …)` committed to `main` on a schedule, then SSG. Rationale: paid publishers must see their ad live in minutes (SPA), while SEO value accrues at next deploy. **`da verificare:` whether `/data/publisher-jobs/*` must be added to the CDN-offload manifest like other `/data/*` files** (memory: SPA-fetched files under `/data/` must be CDN-routed or they 404 live).

2. **Payments at $0 fixed** → **Stripe Checkout in `subscription` mode + webhook CF** (LOCKED §0.1: recurring 30-day auto-renew, not one-time). Per-transaction fee only. One Stripe **Subscription** per ad (line-item quantity = ad-location units); `cancel` (by publisher or non-payment) → webhook flips `publisher_jobs.status` → overlay/slice drop the job at next sync. Order/state machine in `orders` + `subscriptions` mirror + `publisher_jobs.status`. Webhook in `functions/` (nodejs20). Phase-1 may bootstrap with a Stripe-hosted Checkout link while the webhook is wired; Payment **Links** alone cannot express the per-unit quantity + discount, so Checkout Session (server-created) is the real path.

3. **Auth & roles** → **Firebase Auth + `publishers` collection + `role:'publisher'` custom claim** set by a CF on verification. Candidate `users/{uid}` and `publishers/{uid}` stay distinct. reCAPTCHA (action `PUBLISH_JOB`) on authoring + a per-publisher rate cap to deter spam.

4. **Moderation & quality** → **Autopublish on payment, NO human review** (LOCKED §0.4). The UI states "disponibile tra 1–2 ore" = the deploy/SSG latency, not a review queue. Quality is enforced by *automatic* gates at submit time (not by a human): reCAPTCHA (action `PUBLISH_JOB`) + per-publisher rate cap, **min-50-word description** (AGENTS thin-content rule), **per-locale structured-data completeness** (baseSalary/postalCode/streetAddress/title/description/datePosted/hiringOrganization.name/jobLocation/employmentType — missing ⇒ safe default, never drop the field), and **dedup** against crawled jobs via `extractStableJobId(url)` / `buildStableId` so a publisher can't double-list a job a crawler already has. A paid ad only flips to `status:'paid'` (→ overlay + slice) once the Stripe webhook confirms the subscription is active.

5. **Firestore data model** → §4. New: `publishers`, `publisher_jobs`, `publisher_job_events`, `applications`, `orders` (+ optional `featured_slots`). Reuse `newsletter_subscribers`/`job_alert_subscribers`/`job_views`. New `firestore.rules` blocks + indexes (`firestore.indexes.json`) for `publisher_jobs` by `publisherUid`/`status`/`canton`.

6. **Featured in listing & email** → reuse `featured` flag; sort boost + visible "Sponsorizzato" badge (no cloaking). In `JobBoard.tsx` ordering and `services/newsletter-content.mjs` ranker. **Never** displace or suppress AdSense; reserve layout space.

7. **Analytics pipeline** → extend `services/jobViewsService.ts` pattern to mirror into `publisher_job_events`; apply-click events via client/CF increment. Dashboard reads Firestore counters directly. **No PostHog queries** (budget breached once already).

8. **In-house application GDPR** → **explicit consent ≠ silent analytics consent.** The site's silent consent (`services/consentService.ts`) covers analytics/ads cookies only. Sending a candidate's name/email/CV to a third-party employer is a **new processing purpose** → requires an explicit, logged consent checkbox (text + timestamp in `applications`) — this is *not* a "cookie banner" (no AGENTS conflict; it's a transactional consent on a form the user actively submits). Retention purge via scheduled CF.

9. **i18n & a11y** → all new user-facing strings in `services/locales/` for **it/en/de/fr**; new routes in sitemap; accessible names on buttons, `width/height/alt` on logos; contrast ≥4.5:1; semantic tokens only (no inline hex, no `text-slate-400` on light). New publisher pages → `WhatsNewModal.tsx` entry.

10. **Pricing/packaging (LOCKED §0.2/0.3)** — encoded in `services/publisherPricing.ts`:
    - **Unit = 1 ad in 1 location = CHF 49 / 30 days, auto-renewing subscription, newsletter blast included.**
    - **Same ad in N locations = N units** (N × 49). Billing quantity = number of (ad × location) pairs.
    - **Volume discount, >2 units, progressive:** default table `3→10%, 4→15%, 5→20%, 6→25%, 7→30%, 8→35%, ≥9→40%` (single `DISCOUNT_TIERS` constant; "10% a crescere" — owner confirms the curve).
    - Featured / extra blast as future Stripe add-on products (Phase 2/3), not required for the locked base.
    - All amounts in **CHF**, applied as a per-renewal discount on the subscription total.

---

## 7. Rollout phases

### Phase 1 — Paid MVP (closes the PhysioMedical lead)
**Smallest paid path to publish 3 fisio ads, go live instantly, notify fisio subscribers, monetise.**
- Stripe **Payment Link** for "Pacchetto 3 annunci" (or 3× single) — no integration code.
- `publishers/{uid}` (manual verify) + `publisher_jobs/{jobId}` write from a focused authoring form (one route in `services/router.ts`, reCAPTCHA action `PUBLISH_JOB`, min-50-word + per-locale structured-data gate).
- After payment confirmed (manually marked in admin for P1, or webhook in P2): job set `status:'paid'`.
- **Instant visibility**: runtime overlay `/data/publisher-jobs/TI.json` merged in `services/jobsService.ts` consumer / board.
- **Indexable page**: a GH Action runs `writeJobsCrawlerSlice('publisher-submitted', …)` → commits `data/jobs/by-crawler/publisher-submitted.json` to `main` (test-gated, `GITHUB_PAT`) → SSG emits the page.
- **Featured**: reuse existing `featured` flag (PhysioMedical bundle = featured).
- **Blast**: one targeted `send-newsletter.mjs` run (GH Action) to fisio-matched subscribers via `matchJobsForSubscriber`.
- **Apply**: mode (ii) external (PhysioMedical apply URL) or (iii) forward-to-email.
- i18n: it primary, en/de/fr keys for the new UI.
- **Complexity: M. Risk: M** (Firestore rules for `publisher_jobs`; overlay/CDN-offload wiring; bot-commit test gate). Payment is L (Payment Link).

### Phase 2 — Automation & self-serve
- Stripe **Checkout + webhook CF** (`functions/stripeWebhook`) → auto status flip, `orders`.
- Auto-translate publisher jobs (it→en/de/fr) before SSG.
- `publisher_job_events` analytics + publisher **dashboard** SPA view (views/apply clicks).
- Application modes (i) in-house + (iii) forward with **explicit consent module** + retention CF.
- Self-serve featured + blast as Stripe add-on products.
- **Complexity: L. Risk: M** (webhook security, GDPR consent, PII retention).

### Phase 3 — Scale & polish
- Domain-match auto-verify, multi-seat publisher accounts.
- `featured_slots` inventory cap; sponsored email placement tuning.
- Auto-publish (post-payment, spam-modeled) replacing manual review.
- Company-hub folding for publisher companies (`companyKey` → existing hub builder).
- **Complexity: L. Risk: M.**

---

## 8. Constraints respected — checklist

- [x] **AdSense Auto Ads** never disabled; featured re-orders only, reserves layout space.
- [x] **Structured data** invariant: authoring form enforces `baseSalary/postalCode/streetAddress/title/description/datePosted/hiringOrganization.name/jobLocation/employmentType` per locale; missing ⇒ safe default, never drop the check. Reuses `hardenJobsWithStructuredSalary`.
- [x] **No cookie/consent banner**: silent analytics consent untouched. Application PII consent is a transactional form checkbox (distinct purpose), not a banner.
- [x] **SSG shell**: indexable pages via existing `jobsSeoPagesPlugin` → `buildSeoPageHtml`; no new heuristic; SPA/static handoff stays router-driven.
- [x] **SEO moratorium**: reuses existing job-page emitter (organic content), adds no new SEO landing family. `da verificare:` GSC 7-day avg position before any net-new page type.
- [x] **Privacy**: no hard-coded PII; secrets (Stripe, PAT) via Remote Config / `process.env` (`scripts/load-rc-env.mjs`), never committed.
- [x] **Thin content**: min-50-word gate on description.
- [x] **bot-direct-to-main**: slice commit passes the test gate (assemble-stats + migrate slugs + vitest) before pushing to `main`.

---

## 9. Open questions for the owner

1. **Stripe**: confirm a Stripe account + CHF payout. OK to add the `stripe` npm dep (Phase 2) and a webhook CF? Phase-1 Payment Link acceptable, or prefer manual invoice for PhysioMedical first?
2. **Pricing** (§6.10): confirm single/featured/blast/bundle numbers.
3. **Moderation**: manual approve every paid ad in Phase 1 (recommended), or auto-publish on payment?
4. **Application default mode**: external URL (zero PII) vs forward-to-email vs in-house collect for PhysioMedical?
5. **Translation gate**: emit publisher jobs IT-first and backfill en/de/fr, or block go-live until 4 locales translated (affects structured-data-per-locale invariant timing)?
6. **CDN offload**: confirm `/data/publisher-jobs/*` must be added to the CDN-offload manifest (else SPA fetch 404s live). `da verificare:` exact manifest file.
7. **GSC position** (moratorium): current `data/gsc-position-rolling.json` 7-day avg — above or below 7.5? (Confirms whether even reusing the emitter needs sign-off.)
8. **Firebase Storage rules** for publisher logos + candidate CVs (`da verificare:` Storage rules not present in repo `firestore.rules`).
9. **PhysioMedical specifics**: legal company name, `companyKey`, addresses (Lugano ×2 + Locarno), apply URL/email, logo — needed to seed the first 3 ads.
