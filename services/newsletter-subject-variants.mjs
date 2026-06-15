/**
 * newsletter-subject-variants.mjs — Subject-line A/B test definitions.
 *
 * Goal: optimize newsletter open-rate PER SENDING PROVIDER by trying different
 * subject-line styles. Each subscriber is deterministically assigned a variant
 * for a given campaign (stable across the daily cron re-runs of the same weekly
 * campaign, rotating across campaigns). The cascade then picks a provider by
 * quota — independent of the variant — so every provider sees a ~50/50 mix of
 * variants, making the provider×variant open-rate cross-tab valid.
 *
 * IMPORTANT — variant assignment is DETERMINISTIC, so the reporting script
 * (`scripts/newsletter-ab-report.mjs`) can RE-COMPUTE the variant for any
 * (email, campaignId) without relying on what was persisted. That makes the
 * report immune to the per-provider divergence in webhook delivery-doc ids /
 * campaign-id extraction. The variant is still persisted at send time + tagged
 * on the outgoing email for observability and for the Resend webhook that reads
 * `tags.variant`.
 *
 * Single source of truth: both `buildSubjectPrompt` (AI prompt biasing) and the
 * send pipeline (fallback subjects) import from here — no copy-pasted variant
 * text that could drift.
 */

// NOTE: this module is browser-safe by construction — it is reachable from the
// client bundle (services/newsletterPreview.ts → services/newsletter-content.mjs
// → getVariantStyleDirective). It must therefore NOT import any `node:` builtin.
// The lone crypto-dependent helper (`assignSubjectVariant`, server-only: send +
// A/B report) lives in ./newsletter-subject-assign.mjs so `node:crypto` never
// leaks into the SPA graph (a static `node:crypto` import here makes rollup fail
// the whole client build: "createHash is not exported by __vite-browser-external").

/** Lowercase+trim — must match scripts/send-newsletter.mjs normalizeEmail. */
export function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/**
 * The two A/B variants. Two is the statistically-cheapest contrast and maps to
 * the two dominant subject-line schools:
 *   - `concreto`  → specificity-forward: numbers, locations, concrete benefit.
 *   - `curioso`   → curiosity-forward: question / curiosity-gap / FOMO.
 *
 * `styleDirective[locale]` is injected into the AI subject prompt (kept in the
 * target language to prevent the model drifting to Italian). `fallback[locale]`
 * is used when AI generation fails — each MUST satisfy the inlineQaCheck gate
 * (10..60 chars, no trailing "..."/"…", ≥1 three-letter word). Validated by
 * tests/newsletter-subject-variants.test.ts.
 */
export const SUBJECT_VARIANTS = [
  {
    id: 'concreto',
    label: 'Concrete / number-and-benefit',
    styleDirective: {
      it: 'STILE A/B "concreto": punta su numero + luogo + beneficio tangibile. Forme tipo "📊 3 aziende assumono a Lugano" o "💰 Simula il netto 2026 in 30 sec". Specifico e diretto, niente mistero.',
      en: 'A/B STYLE "concrete": lead with a number + location + tangible benefit. Forms like "📊 3 companies hiring in Lugano" or "💰 Simulate your 2026 net pay in 30 sec". Specific and direct, no mystery.',
      de: 'A/B-STIL "konkret": Zahl + Ort + greifbarer Nutzen. Formen wie "📊 3 Firmen stellen in Lugano ein" oder "💰 Nettolohn 2026 in 30 Sek berechnen". Konkret und direkt, kein Rätsel.',
      fr: 'STYLE A/B "concret" : un chiffre + un lieu + un bénéfice tangible. Formes comme "📊 3 entreprises recrutent à Lugano" ou "💰 Simule ton net 2026 en 30 sec". Précis et direct, pas de mystère.',
    },
    fallback: {
      it: '📊 Frontaliere: cambio, lavori e netto 2026',
      en: '📊 Frontaliere: rates, jobs & 2026 net pay',
      de: '📊 Grenzgänger: Kurs, Jobs & Netto 2026',
      fr: '📊 Frontalier : taux, emplois & net 2026',
    },
  },
  {
    id: 'curioso',
    label: 'Curiosity / question hook',
    styleDirective: {
      it: 'STILE A/B "curioso": apri un curiosity gap o una domanda che il lettore DEVE risolvere aprendo. Forme tipo "⚡ Il tasso CHF scende: quanto perdi?" o "🤔 Permesso G o B? Il calcolo che conta". Crea tensione, non svelare la risposta.',
      en: 'A/B STYLE "curious": open a curiosity gap or a question the reader MUST resolve by opening. Forms like "⚡ The CHF rate is dropping: how much are you losing?" or "🤔 Permit G or B? The calc that matters". Build tension, do not reveal the answer.',
      de: 'A/B-STIL "neugierig": eine Neugier-Lücke oder Frage, die der Leser nur durch Öffnen löst. Formen wie "⚡ CHF-Kurs fällt: wie viel verlierst du?" oder "🤔 Bewilligung G oder B? Die Rechnung zählt". Spannung aufbauen, die Antwort nicht verraten.',
      fr: 'STYLE A/B "curieux" : ouvre un manque de curiosité ou une question que le lecteur DOIT résoudre en ouvrant. Formes comme "⚡ Le taux CHF baisse : combien tu perds ?" ou "🤔 Permis G ou B ? Le calcul qui compte". Crée la tension, ne révèle pas la réponse.',
    },
    fallback: {
      it: '🤔 Frontaliere: quanto stai perdendo ora?',
      en: '🤔 Frontaliere: how much are you losing now?',
      de: '🤔 Grenzgänger: wie viel verlierst du gerade?',
      fr: '🤔 Frontalier : combien perds-tu en ce moment ?',
    },
  },
];

/** Default variant id — used when none can be assigned. */
export const DEFAULT_VARIANT_ID = SUBJECT_VARIANTS[0].id;

/** @returns {string[]} ordered list of variant ids. */
export function listVariantIds() {
  return SUBJECT_VARIANTS.map((v) => v.id);
}

/** @returns {object|null} the variant config for `id`, or null. */
export function getSubjectVariant(id) {
  return SUBJECT_VARIANTS.find((v) => v.id === id) || null;
}

// `assignSubjectVariant` (the only `node:crypto` consumer) lives in the
// server-only ./newsletter-subject-assign.mjs to keep this module browser-safe
// (see the header note). Import it from there in send/report scripts.

/**
 * Variant-specific fallback subject for a locale, with safe degradation:
 * unknown variant/locale → first variant's IT fallback.
 * @returns {string}
 */
export function getVariantFallback(variantId, locale) {
  const variant = getSubjectVariant(variantId) || SUBJECT_VARIANTS[0];
  return variant.fallback[locale] || variant.fallback.it;
}

/**
 * Style directive for the AI subject prompt. Empty string for unknown variant
 * so callers can unconditionally concatenate.
 * @returns {string}
 */
export function getVariantStyleDirective(variantId, locale) {
  const variant = getSubjectVariant(variantId);
  if (!variant) return '';
  return variant.styleDirective[locale] || variant.styleDirective.it || '';
}
