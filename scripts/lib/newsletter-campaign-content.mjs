// scripts/lib/newsletter-campaign-content.mjs
//
// Contenuto AI della newsletter congelato per campagna (perf-plan email senders,
// C4). La newsletter e' una campagna SETTIMANALE che riprende su piu' giorni
// (`weekly_<lunedi>`): ogni ripresa rigenerava da zero il testo introduttivo e gli
// oggetti A/B di ogni lingua (la fase AI: 432 s su 487) e pagava il setup di
// omniroute e del Codex broker (111 s) solo per quelle chiamate.
//
// Qui il contenuto generato per `(campaign_id, locale)` si salva UNA volta in una
// collection SEPARATA, `newsletter_campaign_content/{campaignId}__{locale}`, e le
// riprese lo riusano finche' nessun fatto riportato nel testo e' diventato falso.
//
// PERCHE' UNA COLLECTION A PARTE. `newsletter_subscribers/_meta_` NON va bene: ogni
// scrittura su un documento di `newsletter_subscribers/{email}` attiva tre Cloud
// Function (welcomeOnConfirmation, syncNewsletterSubscriberAuth,
// backfillJobAlertOnNewsletterSignup). `newsletter_campaign_content` non ha nessun
// trigger (verificato in functions/index.js: i trigger sono su
// newsletter_subscribers/{email}[/private/personalization], assisted_applications,
// consulting_orders, publisher_jobs, applications, application_concierge_services,
// user_cv_profiles) e le sue regole sono admin-only (nessuna regola = nega).
//
// QUANDO UN CONTENUTO CONGELATO E' ANCORA VALIDO (`evaluateFrozenContent`). Tutte e
// cinque devono valere, altrimenti si rigenera come prima:
//   1. stessa campagna, stessa lingua, stesso insieme di varianti A/B;
//   2. stessa VERSIONE DEL PROMPT: `promptVersion()` hasha il modulo che costruisce i
//      prompt (services/newsletter-content-core.mjs) piu' una costante di schema,
//      quindi una modifica al prompt invalida da sola ogni contenuto congelato;
//   3. stessi FATTI TESTUALI (`inputsHash`): il testo del tool in evidenza, il fatto
//      della settimana (con fonte), la raccomandazione sul cambio, la direzione del
//      trend (rafforzamento/stabile/indebolimento) e le varianti. Sono i soli input
//      del prompt che il modello puo' riportare come parola, e cambiano solo a
//      cavallo di settimana o di scenario;
//   4. i FATTI NUMERICI non si sono mossi oltre la soglia: il cambio CHF/EUR (in
//      relativo) e la variazione settimanale (in punti percentuali) devono restare
//      entro `NEWSLETTER_CONTENT_FREEZE_RATE_THRESHOLD_PCT` (default 0,5);
//   5. nessun FATTO DEL GIORNO e' diventato falso: il prompt dice al modello la data
//      di oggi e il giorno della settimana (e quest'ultimo compare negli esempi di
//      oggetto), quindi il testo puo' scrivere «oggi», «lunedi», «15 novembre». Al
//      salvataggio si rileva se il testo contiene un riferimento di giorno
//      (`timeBoundMentions`): in quel caso il contenuto vale solo nello stesso
//      giorno UTC; con un solo nome di mese vale nello stesso mese; senza riferimenti
//      temporali vale per tutta la campagna.
//
// Un contenuto incompleto (briefing mancante o un oggetto A/B nullo) NON si congela:
// la run dopo ritenta, come oggi. In `dry-run` si legge ma non si scrive. Il kill
// switch Remote Config `NEWSLETTER_CAMPAIGN_CONTENT_FREEZE=off` ripristina la
// rigenerazione ad ogni run e non legge ne' scrive nulla.
//
// Ogni errore di lettura o scrittura e' fail-safe: si genera come oggi.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CAMPAIGN_CONTENT_COLLECTION = 'newsletter_campaign_content';
/** Cambia solo se cambia la FORMA del documento congelato. */
export const CAMPAIGN_CONTENT_SCHEMA = 1;
export const DEFAULT_RATE_THRESHOLD_PCT = 0.5;
export const FREEZE_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_MODULE = path.resolve(__dirname, '..', '..', 'services', 'newsletter-content-core.mjs');

/** `on` (default) | `off` (kill switch). Qualunque valore diverso da `off` lascia attivo il default. */
export function resolveFreezeMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'false' ? 'off' : 'on';
}

export function resolveRateThresholdPct(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return DEFAULT_RATE_THRESHOLD_PCT;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RATE_THRESHOLD_PCT;
}

export function contentDocId(campaignId, locale) {
  return `${campaignId}__${locale}`;
}

let cachedPromptVersion;

function computePromptVersion(readFile) {
  try {
    const hash = createHash('sha256').update(readFile(PROMPT_MODULE)).digest('hex').slice(0, 12);
    return `s${CAMPAIGN_CONTENT_SCHEMA}:${hash}`;
  } catch {
    return null;
  }
}

/**
 * Versione del prompt: la costante di schema piu' un hash del modulo che lo
 * costruisce. `null` se il modulo non si legge: senza versione nulla si congela e
 * nulla si riusa. `readFile` serve ai test.
 */
export function promptVersion({ readFile } = {}) {
  if (readFile) return computePromptVersion(readFile);
  if (cachedPromptVersion === undefined) cachedPromptVersion = computePromptVersion((file) => readFileSync(file));
  return cachedPromptVersion;
}

function round(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/** La stessa variazione settimanale che il prompt riporta (briefingSharedData). */
export function weeklyChangePct(exchangeRate) {
  const rate = Number(exchangeRate?.rate);
  const previous = Number(exchangeRate?.previousRate);
  return Number.isFinite(rate) && Number.isFinite(previous) && previous > 0
    ? ((rate - previous) / previous) * 100
    : 0;
}

/** La stessa soglia di direzione del prompt: oltre +-0,2 punti. */
export function trendBucket(pct) {
  return pct > 0.2 ? 'strengthening' : pct < -0.2 ? 'weakening' : 'stable';
}

/**
 * I fatti che il prompt di una lingua porta al modello.
 *
 *  - `inputsHash`: fatti TESTUALI e categorici (vedi la testata, punto 3);
 *  - `rate`, `previousRate`, `weeklyPct`: fatti NUMERICI, confrontati con soglia;
 *  - `date`, `month`: il giorno e il mese UTC in cui il testo e' stato scritto.
 */
export function buildFactsFingerprint({
  locale, variants = [], exchangeRate = null, exchangeInsight = null, weeklyFact = null, featuredTool = null, now = new Date(),
} = {}) {
  const weeklyPct = weeklyChangePct(exchangeRate);
  const canonical = JSON.stringify({
    locale,
    variants: [...variants].sort(),
    weeklyFact: weeklyFact ? { text: weeklyFact.text ?? null, source: weeklyFact.source ?? null } : null,
    featuredTool: featuredTool
      ? { title: featuredTool.title ?? null, description: featuredTool.description ?? null, toolUrl: featuredTool.toolUrl ?? null }
      : null,
    insight: exchangeInsight ? { summary: exchangeInsight.summary ?? null, trend: trendBucket(weeklyPct) } : null,
    hasRate: Boolean(exchangeRate),
  });
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  return {
    inputsHash: createHash('sha256').update(canonical).digest('hex').slice(0, 32),
    rate: round(Number(exchangeRate?.rate), 6),
    previousRate: round(Number(exchangeRate?.previousRate), 6),
    weeklyPct: round(weeklyPct, 4),
    date,
    month: date.slice(0, 7),
  };
}

// ── fatti del giorno citati nel testo ─────────────────────────────────────────
const WEEKDAYS = [
  'domenica', 'lunedi', 'lunedì', 'martedi', 'martedì', 'mercoledi', 'mercoledì', 'giovedi', 'giovedì', 'venerdi', 'venerdì', 'sabato',
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag',
  'dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi',
];
const RELATIVE_DAY = [
  'oggi', 'stasera', 'stanotte', 'ieri', 'domani', 'dopodomani', 'stamattina',
  'today', 'tonight', 'tomorrow', 'yesterday',
  'heute', 'heute abend', 'gestern', 'morgen', 'übermorgen', 'uebermorgen',
  "aujourd'hui", 'aujourd’hui', 'ce soir', 'demain', 'hier', 'après-demain',
];
const MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'januar', 'februar', 'märz', 'juni', 'juli', 'oktober', 'dezember',
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const escapeRx = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRx = (words) => new RegExp(`(?<![\\p{L}])(?:${words.map(escapeRx).join('|')})(?![\\p{L}])`, 'iu');
const WEEKDAY_RX = wordRx(WEEKDAYS);
const RELATIVE_RX = wordRx(RELATIVE_DAY);
const MONTH_RX = wordRx(MONTHS);
const DAY_MONTH_RX = new RegExp(`(?<![\\d])\\d{1,2}(?:\\.|º|°|er|st|nd|rd|th)?\\s+(?:de\\s+|of\\s+)?(?:${MONTHS.map(escapeRx).join('|')})(?![\\p{L}])`, 'iu');

// Numeric dates: ISO (2026-11-15), day.month.year / day/month/year, and day/month,
// day-month or day.month with a two-digit month (15/11, 15-11, 15.11). A one-digit month
// after a dot ("1.2%") is a decimal, not a date, and a number followed by % or more
// digits is never one.
const NUMERIC_DATE_RXS = [
  /(?<![\d.,/-])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)/,
  /(?<![\d.,/-])(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:\d{4}|\d{2})(?![\d%])/,
  /(?<![\d.,/-])(?:0?[1-9]|[12]\d|3[01])(?:[/-](?:0?[1-9]|1[0-2])|\.(?:0[1-9]|1[0-2]))(?![\d%]|[.,/-]\d)/,
];

const stripMarkup = (text) => String(text ?? '').replace(/<[^>]+>/g, ' ');

/**
 * Quali riferimenti temporali contiene il testo generato.
 *  - `day`: un giorno della settimana, una parola relativa («oggi») o una data
 *    giorno+mese: il testo vale solo il giorno in cui e' stato scritto;
 *  - `month`: un nome di mese senza giorno: vale nello stesso mese.
 */
export function timeBoundMentions(texts) {
  const text = stripMarkup(Array.isArray(texts) ? texts.filter(Boolean).join(' \n ') : texts);
  const day = WEEKDAY_RX.test(text) || RELATIVE_RX.test(text) || DAY_MONTH_RX.test(text)
    || NUMERIC_DATE_RXS.some((rx) => rx.test(text));
  const month = MONTH_RX.test(text);
  return { day, month };
}

function contentTexts(content) {
  return [content?.briefing, ...Object.values(content?.subjects || {})];
}

/** Il contenuto e' completo: briefing e un oggetto per ogni variante. */
export function isCompleteContent(content, variants) {
  if (!content || typeof content.briefing !== 'string' || content.briefing.trim() === '') return false;
  return variants.every((variant) => typeof content.subjects?.[variant] === 'string' && content.subjects[variant].trim() !== '');
}

/**
 * @returns {{ usable: boolean, reason: string }}
 */
export function evaluateFrozenContent(doc, {
  campaignId, locale, variants, facts, promptVersion: currentPromptVersion, thresholdPct = DEFAULT_RATE_THRESHOLD_PCT,
}) {
  if (!doc || typeof doc !== 'object') return { usable: false, reason: 'missing' };
  if (!currentPromptVersion) return { usable: false, reason: 'prompt-version-unknown' };
  if (doc.schema !== CAMPAIGN_CONTENT_SCHEMA) return { usable: false, reason: 'schema' };
  if (doc.campaign_id !== campaignId || doc.locale !== locale) return { usable: false, reason: 'identity' };
  if (doc.prompt_version !== currentPromptVersion) return { usable: false, reason: 'prompt-version' };
  const expectedVariants = [...variants].sort().join('|');
  if (!Array.isArray(doc.variant_ids) || [...doc.variant_ids].sort().join('|') !== expectedVariants) {
    return { usable: false, reason: 'variants' };
  }
  const content = { briefing: doc.briefing, subjects: doc.subjects };
  if (!isCompleteContent(content, variants)) return { usable: false, reason: 'incomplete' };
  const frozen = doc.facts;
  if (!frozen || typeof frozen !== 'object') return { usable: false, reason: 'facts-missing' };
  if (frozen.inputsHash !== facts.inputsHash) return { usable: false, reason: 'facts-changed' };

  // Fatti numerici: il cambio in relativo, la variazione settimanale in punti.
  const rateNow = facts.rate;
  const rateThen = frozen.rate;
  if ((rateNow === null) !== (rateThen === null)) return { usable: false, reason: 'rate-availability' };
  if (rateNow !== null) {
    if (!(rateThen > 0)) return { usable: false, reason: 'rate-invalid' };
    if ((Math.abs(rateNow - rateThen) / rateThen) * 100 > thresholdPct) return { usable: false, reason: 'rate-moved' };
    if (Math.abs((facts.weeklyPct ?? 0) - (frozen.weeklyPct ?? 0)) > thresholdPct) return { usable: false, reason: 'weekly-change-moved' };
  }

  // Fatti del giorno citati nel testo.
  const bound = doc.time_bound || {};
  if (bound.day && frozen.date !== facts.date) return { usable: false, reason: 'day-bound' };
  if (bound.month && frozen.month !== facts.month) return { usable: false, reason: 'month-bound' };
  return { usable: true, reason: 'ok' };
}

export function buildFrozenDocument({
  campaignId, locale, variants, content, facts, promptVersion: version, campaignLocales = [], now = new Date(),
}) {
  return {
    schema: CAMPAIGN_CONTENT_SCHEMA,
    campaign_id: campaignId,
    locale,
    prompt_version: version,
    variant_ids: [...variants],
    // Le lingue che la prima run della campagna ha dovuto generare: la sonda del
    // workflow le legge per sapere quali documenti deve trovare.
    campaign_locales: [...campaignLocales],
    briefing: content.briefing,
    subjects: Object.fromEntries(variants.map((variant) => [variant, content.subjects[variant]])),
    facts,
    time_bound: timeBoundMentions(contentTexts(content)),
    created_at: now instanceof Date ? now : new Date(now),
  };
}

export async function loadFrozenContent(db, campaignId, locale) {
  const snap = await db.collection(CAMPAIGN_CONTENT_COLLECTION).doc(contentDocId(campaignId, locale)).get();
  return snap.exists ? (snap.data() || null) : null;
}

export async function saveFrozenContent(db, document) {
  await db.collection(CAMPAIGN_CONTENT_COLLECTION)
    .doc(contentDocId(document.campaign_id, document.locale))
    .set(document);
}

/** Il cambio memorizzato da `config/exchange_rate`, normalizzato come lo legge la newsletter. */
export async function fetchStoredExchangeRate(db, { warn = console.warn } = {}) {
  try {
    const doc = await db.collection('config').doc('exchange_rate').get();
    if (!doc.exists) return null;
    const data = doc.data();
    const rawRate = Number(data.rate || 0.94);
    const normalize = (v) => (v > 0 && v < 0.8 ? 1 / v : v);
    const rate = normalize(rawRate);
    // previousRate may not be stored — will be enriched from history later
    const rawPrev = data.previousRate ? Number(data.previousRate) : null;
    const previousRate = rawPrev ? normalize(rawPrev) : null;
    return { rate, previousRate };
  } catch (e) {
    warn('⚠️ Exchange rate fetch failed:', e.message);
    return null;
  }
}

/**
 * Il fornitore del contenuto di una lingua: riusa il congelato se valido, altrimenti
 * genera e (se `persist`) congela.
 *
 * @param {object} deps
 * @param {object|null} deps.db
 * @param {'on'|'off'} deps.mode
 * @param {boolean} deps.persist       scrivere il contenuto generato (solo `send`)
 * @param {string} deps.campaignId
 * @param {string[]} deps.variants
 * @param {number} deps.thresholdPct
 * @param {string[]} [deps.campaignLocales] le lingue che questa run deve generare
 * @param {(ctx: object) => Promise<{briefing: string|null, subjects: object}|null>} deps.generate
 * @param {(content: object) => {briefing: string|null, subjects: object}|null} [deps.revalidate]
 *        rivalida il contenuto congelato con le funzioni di accettazione correnti
 * @param {{count?: Function, set?: Function}} [deps.metrics]
 * @param {() => Date} [deps.now]
 */
export function createCampaignContentProvider({
  db, mode = 'on', persist = false, campaignId, variants, thresholdPct = DEFAULT_RATE_THRESHOLD_PCT, campaignLocales = [],
  generate, revalidate = null, metrics = {}, log = console.log, warn = console.warn, now = () => new Date(),
  version = promptVersion(),
}) {
  const count = (name, n = 1) => metrics.count?.(name, n);
  const active = mode === 'on' && Boolean(db) && Boolean(campaignId) && Boolean(version);
  return async function contentForLocale(ctx) {
    const locale = ctx.locale;
    if (!active) {
      count('aiContentFreezeInactive');
      return generate(ctx);
    }
    const facts = buildFactsFingerprint({ ...ctx, variants, now: now() });
    let reason = 'missing';
    try {
      const doc = await loadFrozenContent(db, campaignId, locale);
      const verdict = evaluateFrozenContent(doc, { campaignId, locale, variants, facts, promptVersion: version, thresholdPct });
      reason = verdict.reason;
      if (verdict.usable) {
        const revalidated = revalidate
          ? revalidate({ briefing: doc.briefing, subjects: doc.subjects })
          : { briefing: doc.briefing, subjects: doc.subjects };
        if (revalidated && isCompleteContent(revalidated, variants)) {
          count('aiContentFrozenReused');
          log(`   🧊 ${locale}: reusing the frozen newsletter content of ${campaignId} (no LLM call)`);
          return revalidated;
        }
        reason = 'revalidation-failed';
      }
    } catch (error) {
      reason = 'read-failed';
      warn(`   ⚠️  frozen newsletter content (${locale}) unreadable — generating as before (${String(error?.message || error).slice(0, 120)})`);
    }
    count('aiContentGenerated');
    count(`aiContentGenerated.${reason}`);
    const generated = await generate(ctx);
    if (persist && isCompleteContent(generated, variants)) {
      try {
        await saveFrozenContent(db, buildFrozenDocument({
          campaignId, locale, variants, content: generated, facts, promptVersion: version, campaignLocales, now: now(),
        }));
        count('aiContentFrozenSaved');
      } catch (error) {
        warn(`   ⚠️  frozen newsletter content (${locale}) not saved (${String(error?.message || error).slice(0, 120)})`);
      }
    }
    return generated;
  };
}

/**
 * Sonda economica del workflow: serve ancora un LLM per questa campagna? Legge solo
 * i documenti congelati della campagna corrente (al piu' 4) e, tramite `factsFor`, gli
 * stessi fatti che legge il sender. Risponde `needsLlm: false` solo se OGNI lingua
 * necessaria ha un contenuto congelato che `evaluateFrozenContent` giudica valido con
 * la STESSA fingerprint, la stessa soglia e la stessa data del sender (nessun hash
 * sostituito, nessuna soglia piu' larga o piu' stretta): sonda e sender non possono
 * divergere. Ogni dubbio o errore, e ogni input non riproducibile, e' `needsLlm: true`.
 *
 * @param {object} deps
 * @param {(locale: string) => Promise<{exchangeRate: object|null, exchangeInsight: object|null, weeklyFact: object|null, featuredTool: object|null}|null>} deps.factsFor
 *        i fatti del prompt di una lingua, calcolati con le funzioni del sender
 *        (scripts/lib/newsletter-weekly-facts.mjs); `null` = non riproducibili.
 */
export async function probeFrozenContent({
  db, campaignId, variants, thresholdPct = DEFAULT_RATE_THRESHOLD_PCT, locales = FREEZE_LOCALES,
  promptVersion: version = promptVersion(), now = () => new Date(), factsFor,
}) {
  const fail = (reason) => ({ needsLlm: true, reason });
  try {
    if (!db || !campaignId || !version || !variants?.length || typeof factsFor !== 'function') return fail('inputs');
    const docs = await Promise.all(locales.map((locale) => loadFrozenContent(db, campaignId, locale).then((doc) => [locale, doc])));
    const present = docs.filter(([, doc]) => doc);
    if (present.length === 0) return fail('no-frozen-content');
    // Le lingue necessarie: quelle che la prima run ha dichiarato (tutte e quattro se mancano).
    const declared = new Set();
    for (const [, doc] of present) {
      for (const locale of Array.isArray(doc.campaign_locales) ? doc.campaign_locales : []) declared.add(locale);
    }
    const needed = declared.size > 0 ? locales.filter((locale) => declared.has(locale)) : [...locales];
    const at = now();
    for (const locale of needed) {
      const doc = docs.find(([l]) => l === locale)?.[1];
      if (!doc) return fail(`missing:${locale}`);
      const inputs = await factsFor(locale);
      if (!inputs || !inputs.exchangeRate || !inputs.exchangeInsight || !inputs.weeklyFact || !inputs.featuredTool) {
        return fail(`facts-unavailable:${locale}`);
      }
      const facts = buildFactsFingerprint({ locale, variants, ...inputs, now: at });
      const verdict = evaluateFrozenContent(doc, { campaignId, locale, variants, facts, promptVersion: version, thresholdPct });
      if (!verdict.usable) return fail(`${locale}:${verdict.reason}`);
    }
    return { needsLlm: false, reason: 'all-frozen' };
  } catch (error) {
    return fail(`error:${String(error?.message || error).slice(0, 80)}`);
  }
}
