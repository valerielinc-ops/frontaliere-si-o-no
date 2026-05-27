# Comprehensive Newsletter System Analysis — Frontaliere Ticino

## Executive Summary

The project implements a sophisticated newsletter system using **Resend** as the email service provider, **Firestore** as the database, and **Node.js scripts** for generation and sending. The system supports:
- **Multiple newsletter variants** (jobs, tax, general)
- **Double opt-in** confirmation flow
- **Resend webhooks** for tracking opens/clicks/bounces
- **Subscriber preferences** segmentation
- **Personalized links** with authentication tokens
- **HMAC-based unsubscribe tokens**

---

## 1. NEWSLETTER CREATION & GENERATION

### Location: Scripts & Services
- **Main sender**: `/scripts/send-newsletter.mjs` (816 lines)
- **Template builder**: `/scripts/newsletter-template.mjs` (342 lines)
- **Content derivation**: `/services/newsletter-content.mjs` (387 lines)

### What Gets Generated

The newsletter includes **dynamic & static sections**:

**Dynamic Content** (fetched from Firestore):
- Exchange rate (CHF/EUR) with week-over-week comparison
- Top 3 articles by views
- Weekly fact/stat
- Latest article with excerpt
- Market outlook (exchange rate insights + provider rankings)

**Rotating Elements**:
- Featured tool (cycles weekly through 6 predefined tools: Tax Credits, Pension Calculator, Health Insurance Compare, Payroll Simulator, Transport Cost, 3rd Pillar Simulator)

**Newsletter Variants** (configurable):

| Variant | Focus | Primary CTA | Sections |
|---------|-------|-----------|----------|
| **jobs** | Job listings | "Apri le offerte di oggi" | Recent jobs, city spotlight, job guide |
| **tax** | Tax/fiscal info | "Controlla le aliquote" | Exchange rate, tax changes, fiscal tools |
| **general** | Balanced | Mix of both | Jobs block, tax block, tool block |

**Content Structure** (all variants):
```
Hero section (headline + 3-line benefit summary)
↓
Exchange rate card (current rate + % change + previous week)
↓
Market outlook (provider rankings for best exchange)
↓
Top articles (3 most-read guides)
↓
Weekly fact (useful stat with source)
↓
Featured tool (CTA to one of 6 rotating calculators)
↓
Footer (unsubscribe + resubscribe + privacy links)
```

### Template Features

**Personalization per recipient**:
- Unsubscribe URL: HMAC-signed token per email
- Resubscribe URL: HMAC-signed token per email
- Newsletter auth links: Firebase Email Link tokens for auto-login on site clicks
- UTM parameters: `utm_source=newsletter&utm_medium=email&utm_campaign=weekly_YYYY-MM-DD`

**Email structure**:
- Single-column responsive HTML
- Inline CSS styling (for email client compatibility)
- Dark mode support via `@media (prefers-color-scheme: dark)`
- Schema.org EmailMessage markup for smart client actions

---

## 2. NEWSLETTER SENDING

### Email Service Provider: Resend

**Configuration**:
- **API Endpoint**: `https://api.resend.com/emails/batch`
- **API Key**: `RESEND_API_KEY` environment variable
- **Sender Email**: `newsletter@frontaliereticino.ch` (domain must be verified)
- **Sender Name**: "Frontaliere Ticino"
- **Batch Size**: 50 emails per request (Resend's batch limit)

**Send Modes** (controlled by `send-newsletter.mjs`):

1. **Preview Mode** (`--preview`)
   - Outputs HTML to stdout
   - No Firebase required
   - No email sent

2. **Test Mode** (`--test --target-email admin@example.com`)
   - Sends to single specified admin email
   - Requires `NEWSLETTER_ENABLE_SEND=true`
   - Gated by `NEWSLETTER_EXPERIMENTAL_MODE` check

3. **Send Mode** (`--send`)
   - Sends to all active subscribers
   - Requires `NEWSLETTER_ENABLE_SEND=true`
   - Gated by `NEWSLETTER_EXPERIMENTAL_MODE` check
   - Logs delivery to Firestore

4. **Analyze Mode** (`--analyze`)
   - Prints JSON summary of newsletter content
   - No send

### Safety Gates

**Default**: Sends are **blocked** unless:
```
NEWSLETTER_EXPERIMENTAL_MODE === false  (default: true)
AND
NEWSLETTER_ENABLE_SEND === 'true'       (default: not set)
```

This prevents accidental mass sends during development.

### Sending Process

```
1. Fetch subscribers from Firestore:
   - Collection: newsletter_subscribers
   - Filter: isActive === true
   - Extract: email, locale, source_channel

2. Personalize HTML for each recipient:
   - Replace {{UNSUBSCRIBE_URL}} with HMAC token
   - Replace {{RESUBSCRIBE_URL}} with HMAC token
   - Wrap internal links with newsletter auth tokens
   - Add subscriber_key tracking parameter

3. Build email object:
   - from: "Frontaliere Ticino <newsletter@frontaliereticino.ch>"
   - to: [recipient.email]
   - subject: Dynamic (variant-based)
   - html: Personalized template
   - headers: List-Unsubscribe, X-Entity-Ref-ID
   - tags: campaign_id, variant, subscriber_locale, source_channel

4. Send in batches of 50:
   - POST to Resend /emails/batch
   - Wait for 200 OK
   - Log delivery to newsletter_campaign_deliveries collection
   - Increment send_count on subscriber record

5. Log send event:
   - Collection: newsletter_sends
   - Data: sentAt, recipientCount, subject, sections, status
```

### Email Headers

Each email includes RFC 2369 compliance headers:
```
List-Unsubscribe: <https://frontaliereticino.ch/?action=unsubscribe&email=...&token=...>,
                  <mailto:newsletter@frontaliereticino.ch?subject=Unsubscribe%20Frontaliere%20Weekly&body=...>
X-Entity-Ref-ID: campaign-key-email-hash
X-Newsletter-Variant: jobs|tax|general
X-Newsletter-Campaign: weekly_YYYY-MM-DD
X-Subscriber-Locale: it-IT|fr-FR|de-DE|en-EN
X-Source-Channel: newsletter_page|popup|auth_google|etc
```

---

## 3. EMAIL CONFIRMATION / SUBSCRIPTION FLOW

### Double Opt-In (DOI) Implementation

**Confirmation Status States**:
- `pending` — Email submitted, awaiting confirmation
- `confirmed` — Confirmed (clicked link, received email, or auto-confirmed)
- `unsubscribed` — User clicked unsubscribe
- `bounced` — Hard bounce from email provider
- `complained` — User marked as spam
- `suppressed` — ISP suppression list

**Subscription Flow**:

```
User submits email
    ↓
Frontend validates email (format, MX record, gibberish check)
    ↓
Save to Firestore:
    - Collection: newsletter_subscribers
    - Status: pending
    - isActive: false
    ↓
Return confirmation message:
    "Check your inbox to confirm subscription"
    ↓
User receives confirmation email (via Resend)
    ↓
On Resend webhook (email.delivered or email.opened or email.clicked):
    - Status → confirmed
    - isActive → true
    ↓
User is now receiving newsletters
```

### Subscription Forms

**Component**: `/components/community/Newsletter.tsx` (404 lines)
- Full-page newsletter signup
- Email input with domain autocomplete
- Preference checkboxes (exchangeRate, traffic, taxUpdates, tips)
- Name field (optional)
- Google OAuth option (auto-subscribe on sign-in)
- MX record validation (async, fail-open)
- Firestore upsert with timeout (8s max)

**Component**: `/components/shared/SubscriptionCTA.tsx` (313 lines)
- Post-calculator inline banner
- Auto-dismiss after 14 days
- Countdown to next Monday send
- Preview teaser (3-item list)
- Streamlined 1-field form
- Achievement unlock on subscribe

**Component**: `/components/community/NewsletterPopup.tsx` (huge, modal)
- Full modal with signup form
- Preference preferences
- OAuth buttons
- Exit-intent trigger (configurable)

### Email Validation

**Frontend validation** (`EmailInput.tsx`):
- Strict format check: `[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}`
- Local part checks: min 2 chars, no leading/trailing dots
- Gibberish detection: analyzes vowel ratio, consonant runs, entropy, keyboard mashing
- Domain structure: must have TLD, not purely numeric
- Disposable domain list: blocks 15+ known fake domains
- Mailcheck typo detection: suggests common corrections
- MX record check: async DNS lookup via dns.google API (4s timeout, fail-open)

**Common domains** (autocomplete):
Gmail, Outlook, Hotmail, Yahoo, iCloud, ProtonMail, Libero, Virgilio, Swiss providers (Bluewin, Sunrise, Hispeed)

### Firestore Structure

**Collection**: `newsletter_subscribers`
**Document ID**: email address (normalized, lowercase)

**Fields**:
```typescript
{
  email: string;                    // Normalized lowercase
  user_id?: string;                 // Firebase Auth UID if linked
  name?: string;                    // Optional name
  status: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced' | 'complained' | 'suppressed';
  isActive: boolean;                // Can receive newsletters
  active: boolean;                  // Duplicate of isActive
  
  // Source tracking
  source: string;                   // e.g., "newsletter_page", "auth_google", "popup"
  source_channel: string;           // Normalized channel
  source_page: string;              // URL where signup happened
  source_cta: string;               // Specific CTA button
  source_component: string;         // Component name
  source_route_family: string;      // Route family (calculator, newsletter, etc)
  source_utm?: {                    // UTM parameters at signup
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
  };
  
  // Preferences
  preferences: {
    exchangeRate: boolean;
    traffic: boolean;
    taxUpdates: boolean;
    tips: boolean;
  };
  
  // Interest data
  interests: string[];              // Derived from preferences + extras
  location_interest?: string;       // Geographic interest
  sector_interest?: string;         // Job sector interest
  
  // Job context (if subscribed from job board)
  job_slug?: string;
  job_company?: string;
  job_location?: string;
  job_category?: string;
  job_search_query?: string;
  
  // Geo data (auto-captured via IP or profile)
  geo_country?: string;
  geo_region?: string;
  geo_city?: string;
  geo_source: 'ip_lookup' | 'profile_municipality' | 'manual' | 'none';
  geo_captured_at?: string;
  
  // Localization
  locale: string;                   // Current locale (it-IT, fr-FR, etc)
  signup_locale: string;            // Signup locale
  preferred_locale?: string;
  last_seen_locale?: string;
  
  // Timestamps
  subscribedAt: Timestamp;
  confirmed_at?: Timestamp;         // When status → confirmed
  unsubscribedAt?: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  
  // Metrics
  send_count: number;               // Total sends
  open_count: number;               // Total opens
  click_count: number;              // Total clicks
  last_sent_at?: Timestamp;
  last_open_at?: Timestamp;
  last_click_at?: Timestamp;
  last_clicked_url?: string;
  last_clicked_section?: string;
  
  // Metadata
  variant?: string;                 // Preferred variant
  metadata?: Record<string, any>;
  leadMagnet?: string;              // Lead magnet type (if applicable)
}
```

### Legacy Duplicate Handling

When unsubscribing or resubscribing, the system:
1. Updates the normalized email (lowercase)
2. Finds all legacy documents with same email (different cases)
3. Merges them into the primary doc
4. Sets `mergedInto`, `legacyMergedAt`, `legacyMergeReason`

This prevents duplicate sends to the same email with different cases.

---

## 4. TRACKING & ANALYTICS

### Resend Webhooks

**Webhook Secret**: `RESEND_WEBHOOK_SECRET`
**Handler**: `/server/newsletterResendWebhook.js`
**Core Logic**: `/functions/src/newsletterResendWebhookCore.js`

**Webhook Events** → Firestore status updates:

| Resend Event | Status | Action |
|--------------|--------|--------|
| `email.sent` | — | Increment send_count |
| `email.delivered` | confirmed | Log delivery timestamp |
| `email.opened` | confirmed | Increment open_count, log open_at |
| `email.clicked` | confirmed | Increment click_count, log URL & section |
| `email.bounced` | bounced | Mark inactive |
| `email.complained` | complained | Mark inactive |
| `email.suppressed` | suppressed | Mark inactive |
| `email.failed` | suppressed | Mark inactive |

### Click Tracking

**How it works**:
1. Resend wraps all links in tracking proxies
2. Webhook payload includes:
   - `click.link` — clicked URL
   - `click.section_id` — where in email
   - `click.link_label` — link text

3. Data stored in Firestore:
   - `newsletter_subscribers`: subscriber's click_count, last_clicked_url, last_clicked_section
   - `newsletter_campaign_deliveries`: clicked_at, last_clicked_url, last_clicked_label, last_clicked_section, clicked_links
   - `newsletter_events`: event_type='click' with all metadata

### UTM Parameters

**Automatic insertion** in all links:
```
utm_source=newsletter
utm_medium=email
utm_campaign=weekly_YYYY-MM-DD
```

**Example**:
```
/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/?utm_source=newsletter&utm_medium=email&utm_campaign=weekly_2025-01-13
```

### Analytics Collections

**1. newsletter_subscribers** (as above)

**2. newsletter_campaign_deliveries**
```
{
  email: string;
  campaign_id: string;              // weekly_2025-01-13
  message_id: string;               // Resend message ID
  variant: string;                  // jobs | tax | general
  locale: string;                   // it-IT, fr-FR, etc
  source_channel: string;           // Where subscriber came from
  sent_at: Timestamp;
  delivered_at?: Timestamp;
  opened_at?: Timestamp;
  clicked_at?: Timestamp;
  bounced_at?: Timestamp;
  complained_at?: Timestamp;
  suppressed_at?: Timestamp;
  last_clicked_url?: string;
  last_clicked_label?: string;
  last_clicked_section?: string;
  clicked_links: number;            // Count of link clicks
  updated_at: Timestamp;
}
```

**3. newsletter_events** (unbounded log)
```
{
  email: string;
  event_type: 'send' | 'delivered' | 'open' | 'click' | 'bounce' | 'complaint' | 'suppressed';
  campaign_id: string;
  message_id: string;
  variant: string;
  section_id?: string;              // For click events
  source_locale: string;
  source_channel: string;
  link_url?: string;                // For click events
  link_label?: string;              // For click events
  target_url?: string;              // Duplicate of link_url
  metadata: any;                    // Raw webhook payload
  timestamp: Timestamp;
  occurred_at: string;              // ISO string from Resend
}
```

### Open Tracking

Resend uses **tracking pixels** (1x1 transparent GIF) automatically added to email HTML.
- Logs when email is opened
- Sends `email.opened` webhook
- Updates subscriber status → confirmed
- Updates open_count

---

## 5. UNSUBSCRIBE FLOW

### Unsubscribe URL Format

```
https://frontaliereticino.ch/?action=unsubscribe&email=user@example.com&token=HMAC_SHA256_HEX
```

**Token generation**:
```javascript
HMAC('sha256', NEWSLETTER_SECRET, email.toLowerCase()) → 64-char hex string
```

**Implementation**: `/services/send-newsletter.mjs#makeUnsubscribeUrl`

### Unsubscribe Handling

**Location**: `/App.tsx` lines ~614-700

**Flow**:

```
User clicks unsubscribe link
    ↓
URL parameter detection:
    - action=unsubscribe
    - email=...
    - token=... (optional, for verification)
    ↓
If token present:
    - Verify HMAC signature
    - If invalid → show error
    ↓
Update Firestore:
    - Set isActive = false
    - Set status = 'unsubscribed'
    - Set unsubscribedAt = now
    - source = 'unsubscribe_link'
    ↓
Find & merge legacy duplicates
    ↓
Clear localStorage['newsletter_subscribed']
    ↓
Show confirmation: "Du hast dich abgemeldet"
    ↓
No further emails sent to this address
```

### Fallback: Mailto Unsubscribe

In email headers, also provide:
```
<mailto:newsletter@frontaliereticino.ch?subject=Unsubscribe%20Frontaliere%20Weekly&body=Please%20unsubscribe%20user@example.com>
```

---

## 6. RESUBSCRIBE FLOW

**Resubscribe URL**:
```
https://frontaliereticino.ch/?action=resubscribe&email=user@example.com&token=...
```

**Flow** (same HMAC verification):

```
User clicks resubscribe link
    ↓
Verify HMAC token
    ↓
Upsert to Firestore:
    - email: normalized
    - isActive: true
    - active: true
    - source: 'resubscribe_link'
    ↓
Find & merge legacy duplicates
    ↓
Mark locally as subscribed
    ↓
Show confirmation: "Iscrizione riattivata"
    ↓
Next newsletter included
```

---

## 7. DATA STORAGE (FIRESTORE)

### Collections Summary

| Collection | Purpose | Docs | Key Fields |
|-----------|---------|------|-----------|
| **newsletter_subscribers** | Subscriber master record | ~5K+ | email, status, isActive, preferences, locale |
| **newsletter_campaign_deliveries** | Per-send delivery tracking | ~50K+ | email, campaign_id, variant, delivered/opened/clicked |
| **newsletter_events** | Unbounded audit log | ~200K+ | email, event_type, campaign_id, timestamp |
| **newsletter_sends** | Log of send operations | ~52 | sentAt, recipientCount, subject, sections, status |
| **user_profiles** | (Secondary source) | — | email (may have subscribers) |

### Indexing

**Recommended indexes**:
```
newsletter_subscribers:
  - (isActive, created_at)
  - (status, updated_at)
  - (source_channel, created_at)
  - (geo_country, created_at)

newsletter_campaign_deliveries:
  - (email, campaign_id)
  - (campaign_id, opened_at)
  - (campaign_id, clicked_at)

newsletter_events:
  - (campaign_id, event_type, timestamp)
  - (email, timestamp)
```

---

## 8. NEWSLETTER CONTENT DETAILS

### Content Sources

**Exchange Rate**:
- Firestore query: collection('exchange_rates').orderBy('date', 'desc').limit(1)
- Fields: rate, previousRate, timestamp
- Used in exchange rate card + market outlook

**Top Articles**:
- Firestore query: collection('articles').where('published', '==', true).orderBy('views', 'desc').limit(10)
- Top 3 selected for newsletter
- Fields: title, url, views, readingMinutes

**Weekly Fact**:
- Hard-coded per week or fetched from content collection
- Shows "Numero utile da sapere" section
- Example: "Switzerland unemployment: 2.4%"

**Latest Article**:
- Fetched from articles collection
- Shows full excerpt + featured image
- "Approfondimento della settimana" section

**Featured Tool** (rotating):
1. Calcola il tuo Credito d'Imposta
2. Pianifica la tua Pensione
3. Confronta le Casse Malati
4. Simula la Busta Paga
5. Calcola il Costo dell'Auto
6. Simulatore 3° Pilastro

Cycles weekly: week index = `Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % 6`

### Content Variants

**Jobs Variant**:
- Hero: "Le offerte da aprire prima degli altri"
- Cards:
  1. 3 recent job listings (title, company, location, contract type)
  2. City spotlight (most active location with company highlights)
  3. Job guide (official sources vs aggregators)
- Enhancements: topJobs, clusterPages (job landing pages), evergreen

**Tax Variant**:
- Hero: "Quello che cambia davvero per il tuo netto"
- Cards:
  1. Tax change analysis (exchange rate insight + best day)
  2. Tax case study (aliquotes + distance > 20km rules)
  3. Tax tool (featured calculator + NASpI guide)
- Enhancements: topJobs (nursing focus), clusterPages (tax), evergreen

**General Variant** (default):
- Hero: "Le 3 cose utili da aprire questa settimana"
- Cards:
  1. Jobs block (3 recent + city spotlight)
  2. Tax block (aliquotes + weekly fact)
  3. Tool block (featured tool + top article)
- Enhancements: all enabled

---

## 9. SCHEDULING & AUTOMATION

### GitHub Actions Workflow

**Location**: `.github/workflows/send-newsletter.yml` (109 lines)

**Trigger**: Manual dispatch (`workflow_dispatch`)

**Inputs**:
- `mode`: preview | test | send (default: test)
- `target_email`: For test mode
- `subject`: Override subject line
- `sections`: Comma-separated list (exchange, articles, fact, tool)
- `section_order`: Reorder sections
- `variant`: jobs | tax | general (default: general)
- `enhancements`: topJobs, clusterPages, evergreen

**Execution**:
1. Checkout code
2. Setup Node 22
3. Install dependencies
4. Load Firebase credentials from `FIREBASE_SERVICE_ACCOUNT_JSON` secret
5. Load runtime config from Firebase Remote Config (`load-rc-env.mjs`)
6. Run `scripts/send-newsletter.mjs` with parameters

**Environment Secrets** (must be set in GitHub):
```
FIREBASE_SERVICE_ACCOUNT_JSON  — Firebase Admin SDK JSON
RESEND_API_KEY                 — Resend API key
NEWSLETTER_SECRET              — HMAC secret for unsubscribe tokens
NEWSLETTER_FROM                — Sender email (optional)
```

### Current Status (Safety Locks)

- **Default**: `NEWSLETTER_EXPERIMENTAL_MODE=true` → sends blocked
- **To enable production sends**:
  1. Verify domain in Resend
  2. Add DNS verification record
  3. Set `NEWSLETTER_EXPERIMENTAL_MODE=false`
  4. Set `NEWSLETTER_ENABLE_SEND=true`

### Future: Scheduled Sends

No CRON job currently configured, but workflow is ready for:
```yaml
schedule:
  - cron: '0 8 * * 1'  # Every Monday at 8:00 AM UTC
```

---

## 10. KEY FILES REFERENCE

| File | Lines | Purpose |
|------|-------|---------|
| `scripts/send-newsletter.mjs` | 816 | Main sender script (fetch, build, send) |
| `scripts/newsletter-template.mjs` | 342 | Email HTML template builder |
| `services/newsletter-content.mjs` | 387 | Content derivation by variant |
| `services/newsletterSubscribers.ts` | 703 | Firestore subscriber operations |
| `components/community/Newsletter.tsx` | 404 | Full-page signup form |
| `components/shared/SubscriptionCTA.tsx` | 313 | Post-calculator inline CTA |
| `components/shared/EmailInput.tsx` | 412 | Email field with validation |
| `functions/src/newsletterResendWebhookCore.js` | 233 | Webhook event processing |
| `server/newsletterResendWebhook.js` | 1 | Export wrapper for webhook |
| `.github/workflows/send-newsletter.yml` | 109 | Send automation workflow |
| `App.tsx` | ~2100 | App-level unsubscribe/resubscribe handling |
| `tests/newsletter-*.test.ts` | ~62 | Webhook event tests |

---

## 11. MISSING PIECES / FUTURE IMPROVEMENTS

1. **CRON scheduled sends** — Currently manual only
2. **A/B testing** — No variant splitting by recipient
3. **Segmentation** — Preferences tracked but not used for content variations
4. **Bounce handling** — Captured in webhooks but no auto-removal from sender
5. **Complaint handling** — Logged but not escalated
6. **List health** — No auto-cleanup of suppressed/complained addresses
7. **Rate limiting** — No per-domain rate limit handling
8. **Preference center** — Users can't update preferences after signup
9. **Mobile-first testing** — Limited testing on various email clients
10. **Admin dashboard** — No UI for analytics or subscriber management

---

## 12. SECURITY CONSIDERATIONS

✅ **Implemented**:
- HMAC-signed unsubscribe/resubscribe URLs
- Firebase App Check (if enabled)
- Firestore security rules (check project config)
- Secret storage in GitHub Secrets
- Normalized email handling (lowercase)
- Strict email validation

⚠️ **Should verify**:
- Firestore security rules permit only authorized operations
- `RESEND_WEBHOOK_SECRET` is properly verified for incoming webhooks
- `NEWSLETTER_SECRET` rotation policy
- API key rotation policy
- Subscriber data export compliance (GDPR)

---

## 13. PERFORMANCE NOTES

- **Batch size**: 50 emails per Resend request (API limit)
- **Personalization**: Per-recipient link wrapping (async Promise.all)
- **Newsletter auth**: Firebase Email Link generation (slow, consider caching)
- **Firestore**: Batch writes for delivery logging (minimize API calls)
- **Webhook processing**: Fast path (no heavy computation)

**For 10K subscribers**:
- 200 API calls to Resend (~200ms each)
- 10K Firestore writes (~5-10ms each)
- Total send time: ~10-15 minutes

---

End of Analysis
