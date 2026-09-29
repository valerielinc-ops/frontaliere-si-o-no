/**
 * Stripe — one-time consulting session payment (replaces the dead Calendly
 * booking links on /consulenza/, issue: "This Calendly URL is not valid").
 *
 * Unlike stripePublisherCore.js / stripeReaderCore.js (both `verifyCaller`-
 * gated, entitlement tied to a Firebase account), this checkout is PUBLIC —
 * visitors are anonymous SEO-funnel searchers, not logged-in accounts, and
 * requiring auth before a one-off €49/€99 payment would kill conversion.
 * Same public-write posture as the `contact_submissions` / `applications`
 * collections (firestore.rules).
 *
 * One HTTP entry point (wired in functions/index.js):
 *   - createConsultingCheckout : anonymous visitor → Stripe Checkout Session
 *                                in `payment` mode (one-time, not subscription).
 *
 * Webhook events are NOT wired their own Cloud Function endpoint — Stripe
 * gets exactly ONE webhook endpoint/secret for the whole project. Instead,
 * handleConsultingWebhookEvent(event, {db, ts}) is dispatched INSIDE
 * stripePublisherCore.js's handleStripeWebhook, same shape as the existing
 * reader-subscription dispatch (stripeReaderCore.js) — short-circuits
 * (returns true) when the event belongs to this domain so the publisher-order
 * switch never double-processes it. Told apart from publisher/reader events
 * by `metadata.product === 'consulting'`, set at checkout creation.
 *
 * After payment, the client polls the resulting `consulting_orders/{sessionId}`
 * doc (doc id = Stripe Checkout Session id, an unguessable capability token
 * carried in the success-redirect URL) until status flips to 'paid', then
 * shows an intake form (topic, description, preferred date/time, contact
 * info). Submitting that form is a client-side Firestore `update` on the same
 * doc (gated by firestore.rules — only once, only after real payment, money
 * fields frozen). handleConsultingDetailsSubmitted is called from a Firestore
 * onDocumentWritten trigger (functions/index.js) when that update lands, and
 * emails both the customer and the internal inbox via the existing
 * multi-provider cascade (./emailCascade.js) — same precedent as
 * publisherApplicationsCore.js's handleForwardApplication.
 *
 * Secrets (Firebase Remote Config, via getRemoteConfigValue — same store as
 * every other Stripe/ESP key in this bundle):
 *   STRIPE_PRICE_CONSULTING_BASE    — id of a ONE-TIME Price = CHF 49.
 *   STRIPE_PRICE_CONSULTING_PREMIUM — id of a ONE-TIME Price = CHF 99.
 * Until an owner creates these Prices in the Stripe Dashboard and pushes them
 * via scripts/set-stripe-consulting-rc.mjs, checkout safe-fails with 500
 * (never a silent misconfiguration) — same convention as
 * STRIPE_PRICE_READER_NOADS.
 */

import { getStripe } from './stripePublisherCore.js';
import { getRemoteConfigValue, bridgeEmailCascadeCredentialsToEnv } from './remoteConfigSecrets.js';
import { sendEmailCascade, PROVIDERS, isProviderConfigured } from './emailCascade.js';

const CONSULTING_ORDERS_COLLECTION = 'consulting_orders';
const CONSULTING_PRODUCT = 'consulting';
const FROM_EMAIL = 'Frontaliere Ticino <confirmation@frontaliereticino.ch>';
// Domain-wide Cloudflare Email Routing catch-all already forwards every
// @frontaliereticino.ch address to the owner's inbox (see
// infra/cloudflare-email-worker/stop-reply-handler.js) — no new DNS/routing
// setup needed for this new local-part.
const INTERNAL_NOTIFY_EMAIL = 'consulenza@frontaliereticino.ch';

const TIER_PRICE_RC_KEY = {
  base: 'STRIPE_PRICE_CONSULTING_BASE',
  premium: 'STRIPE_PRICE_CONSULTING_PREMIUM',
};

const TIER_LABEL = {
  base: 'Consulenza Base (30 min)',
  premium: 'Consulenza Premium (60 min)',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── createConsultingCheckout ────────────────────────────────────────────

export async function handleCreateConsultingCheckout(req) {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };

  const body = req.body || {};
  const tier = body.tier === 'premium' ? 'premium' : body.tier === 'base' ? 'base' : null;
  if (!tier) return { status: 400, body: { ok: false, error: 'invalid_tier' } };

  const successUrl = String(body.successUrl || '');
  const cancelUrl = String(body.cancelUrl || '');
  if (!/^https:\/\//.test(successUrl) || !/^https:\/\//.test(cancelUrl)) {
    return { status: 400, body: { ok: false, error: 'invalid_redirect_urls' } };
  }
  const locale = ['it', 'en', 'de', 'fr'].includes(body.locale) ? body.locale : 'it';

  const priceId = await getRemoteConfigValue(TIER_PRICE_RC_KEY[tier]);
  if (!priceId) return { status: 500, body: { ok: false, error: 'consulting_price_not_configured' } };

  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { product: CONSULTING_PRODUCT, tier, locale },
  });

  return { status: 200, body: { ok: true, url: session.url } };
}

// ── handleConsultingWebhookEvent ────────────────────────────────────────
/**
 * Dispatched from stripePublisherCore.js's handleStripeWebhook. Returns
 * `true` when the event belongs to the consulting domain (and is fully
 * handled — short-circuits the publisher switch), `false` if not (falls
 * through to existing publisher-order handling, unchanged).
 *
 * @param {import('stripe').Event} event
 * @param {{ db: () => FirebaseFirestore.Firestore, ts: unknown }} ctx
 */
export async function handleConsultingWebhookEvent(event, { db: dbFn, ts }) {
  const obj = event.data?.object || {};

  if (event.type !== 'checkout.session.completed') return false;
  if (obj.metadata?.product !== CONSULTING_PRODUCT) return false;

  const tier = obj.metadata?.tier === 'premium' ? 'premium' : 'base';
  await dbFn().collection(CONSULTING_ORDERS_COLLECTION).doc(obj.id).set(
    {
      tier,
      locale: obj.metadata?.locale || 'it',
      status: 'paid',
      amountTotal: typeof obj.amount_total === 'number' ? obj.amount_total : null,
      currency: obj.currency || null,
      customerEmail: obj.customer_details?.email || obj.customer_email || null,
      stripeSessionId: obj.id,
      detailsSubmitted: false,
      createdAt: ts,
    },
    { merge: true },
  );
  return true;
}

// ── handleConsultingDetailsSubmitted ────────────────────────────────────
/**
 * Called from the notifyConsultingDetailsSubmitted Firestore trigger
 * (onDocumentWritten on consulting_orders/{orderId}) when the client's
 * intake-form update lands. Only acts on the false → true transition, so a
 * later unrelated write (there shouldn't be one — rules only allow this one
 * update) never double-sends.
 */
export async function handleConsultingDetailsSubmitted(before, after) {
  if (!after || after.detailsSubmitted !== true) return { ok: true, skipped: 'not_submitted' };
  if (before?.detailsSubmitted === true) return { ok: true, skipped: 'already_notified' };

  await bridgeEmailCascadeCredentialsToEnv();
  if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) {
    return { ok: false, error: 'no_email_provider_configured' };
  }

  const tierLabel = TIER_LABEL[after.tier] || TIER_LABEL.base;
  const customerEmail = String(after.customerEmail || '').trim();

  const customerHtml =
    `<h2>Grazie per aver prenotato la tua consulenza!</h2>` +
    `<p><strong>Pacchetto:</strong> ${esc(tierLabel)}</p>` +
    `<p><strong>Argomento:</strong> ${esc(after.topic)}</p>` +
    `<p><strong>Periodo preferito:</strong> ${esc(after.preferredDateStart)} — ${esc(after.preferredDateEnd)}</p>` +
    `<p>Ti contatteremo entro 24 ore lavorative per confermare data e ora esatte.</p>`;

  const internalHtml =
    `<h2>Nuova consulenza pagata — ${esc(tierLabel)}</h2>` +
    `<p><strong>Cliente:</strong> ${esc(after.contactName)} (${esc(customerEmail)})</p>` +
    `<p><strong>Telefono:</strong> ${esc(after.contactPhone || 'non fornito')}</p>` +
    `<p><strong>Argomento:</strong> ${esc(after.topic)}</p>` +
    `<p><strong>Descrizione:</strong><br>${esc(after.description)}</p>` +
    `<p><strong>Periodo preferito:</strong> ${esc(after.preferredDateStart)} — ${esc(after.preferredDateEnd)}</p>` +
    `<p><strong>Fascia oraria:</strong> ${esc((after.preferredTimeWindow || []).join(', '))}</p>` +
    `<p><strong>Stripe session:</strong> ${esc(after.stripeSessionId)}</p>`;

  const emails = [
    {
      payload: { from: FROM_EMAIL, to: customerEmail, subject: `Conferma prenotazione — ${tierLabel}`, html: customerHtml },
      recipient: { email: customerEmail },
      meta: {},
    },
    {
      payload: { from: FROM_EMAIL, to: INTERNAL_NOTIFY_EMAIL, subject: `Nuova consulenza pagata — ${tierLabel}`, html: internalHtml },
      recipient: { email: INTERNAL_NOTIFY_EMAIL },
      meta: {},
    },
  ];

  const { failed } = await sendEmailCascade(emails);
  if (failed.length > 0) return { ok: false, error: `send_failed:${failed[0].error || 'unknown'}` };
  return { ok: true };
}

// ── handleConsultingOrderPaid ───────────────────────────────────────────
/**
 * A paid consultation used to depend entirely on the success page: whoever
 * closed the tab before the intake form was never contacted and the internal
 * inbox never learned about the payment (same defect as the assisted
 * application, 2026-09-29). On the paid transition, email the customer a link
 * back to the intake form and tell the internal inbox. Claimed in a
 * transaction (`paidNotifiedAt`) so the at-least-once trigger sends once; the
 * claim is released when the provider fails.
 */
const CONSULTING_PAGE_BY_LOCALE = {
  it: '/consulenza/',
  en: '/en/consulting/',
  de: '/de/beratung/',
  fr: '/fr/consultation/',
};

const PAID_COPY = {
  it: {
    subject: 'Pagamento ricevuto: completa la prenotazione della consulenza',
    lead: 'grazie per il pagamento. Per fissare la consulenza ci servono l’argomento, una breve descrizione e le tue disponibilità.',
    cta: 'Completa la prenotazione',
    alt: 'Se il link non si apre, scrivi a consulenza@frontaliereticino.ch con queste informazioni.',
  },
  en: {
    subject: 'Payment received: complete your consultation booking',
    lead: 'thank you for your payment. To schedule the consultation we need the topic, a short description and your availability.',
    cta: 'Complete the booking',
    alt: 'If the link does not open, write to consulenza@frontaliereticino.ch with these details.',
  },
  de: {
    subject: 'Zahlung erhalten: Schliesse die Buchung deiner Beratung ab',
    lead: 'danke für deine Zahlung. Um die Beratung zu planen, brauchen wir das Thema, eine kurze Beschreibung und deine Verfügbarkeit.',
    cta: 'Buchung abschliessen',
    alt: 'Wenn sich der Link nicht öffnet, schreib an consulenza@frontaliereticino.ch mit diesen Angaben.',
  },
  fr: {
    subject: 'Paiement reçu : finalisez la réservation de votre consultation',
    lead: 'merci pour votre paiement. Pour planifier la consultation, nous avons besoin du sujet, d’une brève description et de vos disponibilités.',
    cta: 'Finaliser la réservation',
    alt: 'Si le lien ne s’ouvre pas, écrivez à consulenza@frontaliereticino.ch avec ces informations.',
  },
};

const GREETING = { it: 'Ciao,', en: 'Hi,', de: 'Hallo,', fr: 'Bonjour,' };

export function consultingIntakeUrl(orderId, locale) {
  const path = CONSULTING_PAGE_BY_LOCALE[locale] || CONSULTING_PAGE_BY_LOCALE.it;
  const url = new URL(`https://frontaliereticino.ch${path}`);
  url.searchParams.set('consulting_checkout', 'success');
  url.searchParams.set('session_id', String(orderId));
  return url.toString();
}

export async function handleConsultingOrderPaid(before, after, orderId, { db } = {}) {
  if (!after || after.status !== 'paid' || before?.status === 'paid') return { ok: true, skipped: 'no_paid_transition' };
  if (after.detailsSubmitted === true) return { ok: true, skipped: 'details_already_submitted' };

  const orderRef = db.collection(CONSULTING_ORDERS_COLLECTION).doc(String(orderId));
  const claimed = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    const current = snapshot.exists ? snapshot.data() || {} : null;
    if (!current || current.paidNotifiedAt) return false;
    transaction.set(orderRef, { paidNotifiedAt: new Date() }, { merge: true });
    return true;
  });
  if (!claimed) return { ok: true, skipped: 'already_notified' };

  const release = () => orderRef.set({ paidNotifiedAt: null }, { merge: true });
  await bridgeEmailCascadeCredentialsToEnv();
  if (!PROVIDERS.some((p) => isProviderConfigured(p.id))) {
    await release();
    return { ok: false, error: 'no_email_provider_configured' };
  }

  const locale = PAID_COPY[after.locale] ? after.locale : 'it';
  const copy = PAID_COPY[locale];
  const tierLabel = TIER_LABEL[after.tier] || TIER_LABEL.base;
  const customerEmail = String(after.customerEmail || '').trim();
  const link = consultingIntakeUrl(orderId, locale);
  const emails = [];
  if (customerEmail) {
    emails.push({
      payload: {
        from: FROM_EMAIL,
        to: customerEmail,
        subject: copy.subject,
        html: `<p>${esc(GREETING[locale])}</p><p>${esc(copy.lead)}</p>`
          + `<p><strong>${esc(tierLabel)}</strong></p>`
          + `<p><a href="${esc(link)}">${esc(copy.cta)}</a></p><p>${esc(copy.alt)}</p>`,
        text: `${GREETING[locale]}\n\n${copy.lead}\n\n${tierLabel}\n\n${copy.cta}: ${link}\n\n${copy.alt}`,
      },
      recipient: { email: customerEmail },
      meta: {},
    });
  }
  emails.push({
    payload: {
      from: FROM_EMAIL,
      to: INTERNAL_NOTIFY_EMAIL,
      subject: `Consulenza pagata, modulo non ancora compilato — ${tierLabel}`,
      html: `<p>Pagamento Stripe confermato; il cliente non ha ancora compilato il modulo di prenotazione.</p>`
        + `<p><strong>Cliente:</strong> ${esc(customerEmail || 'email non disponibile')}</p>`
        + `<p><strong>Pacchetto:</strong> ${esc(tierLabel)}</p>`
        + `<p><strong>Stripe session:</strong> ${esc(orderId)}</p>`
        + `<p>Al cliente è partita l’email con il link al modulo. Se non lo compila, contattalo direttamente.</p>`,
      ...(customerEmail ? { replyTo: customerEmail } : {}),
    },
    recipient: { email: INTERNAL_NOTIFY_EMAIL },
    meta: {},
  });

  const { failed } = await sendEmailCascade(emails);
  if (failed.length > 0) {
    await release();
    return { ok: false, error: `send_failed:${failed[0].error || 'unknown'}` };
  }
  return { ok: true };
}

export { CONSULTING_ORDERS_COLLECTION, CONSULTING_PRODUCT };
