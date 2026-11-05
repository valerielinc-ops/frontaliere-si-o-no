/**
 * Validated discovery-article feed and stable newsletter selection.
 *
 * The feed crosses the site/corpus boundary over HTTP. Keep its public shape
 * narrow here as well as at the publisher: no trend query, source URL, or
 * internal attribution is accepted by the consumer. The selected localized
 * copy is frozen in Firestore once per weekly campaign and locale, so a later
 * API refresh cannot change the article midway through a resumed send.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISCOVERY_ARTICLES_ARTIFACT = 'data/discovery-articles.json';
export const DISCOVERY_ARTICLES_DESTINATION = 'data/discovery-articles.json';
export const DISCOVERY_ARTICLES_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DISCOVERY_ARTICLES_FUTURE_SKEW_MS = 5 * 60 * 1000;

const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const PROVIDERS = new Set(['google_trends', 'reddit', 'other']);
const SITE_ORIGIN = 'https://frontaliereticino.ch';
const MAX_RECENT_ARTICLE_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ROTATION_POOL = 12;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_FEED_PATH = path.join(ROOT, 'public', DISCOVERY_ARTICLES_DESTINATION);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, expected) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const isSafeText = (value) => typeof value === 'string'
  && value.trim().length > 0
  && !/[\u0000-\u001f\u007f]/u.test(value);

function isCanonicalArticleUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || !value) return false;
  let parsed;
  try {
    parsed = new URL(value, SITE_ORIGIN);
  } catch {
    return false;
  }
  return parsed.origin === SITE_ORIGIN
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && parsed.pathname.endsWith('/')
    && !parsed.pathname.startsWith('//');
}

function validateLocaleMaps(article, label) {
  const maps = ['title', 'excerpt', 'url'];
  for (const key of maps) {
    if (!isRecord(article[key])) throw new Error(`${label}.${key} must be an object`);
    for (const [locale, value] of Object.entries(article[key])) {
      if (!LOCALES.has(locale)) throw new Error(`${label}.${key} has unsupported locale ${locale}`);
      const valid = key === 'url' ? isCanonicalArticleUrl(value) : isSafeText(value);
      if (!valid) throw new Error(`${label}.${key}.${locale} is invalid`);
    }
  }
  const locales = Object.keys(article.title);
  if (locales.length === 0) throw new Error(`${label} has no localized title`);
  for (const locale of locales) {
    if (!Object.hasOwn(article.excerpt, locale) || !Object.hasOwn(article.url, locale)) {
      throw new Error(`${label} has incomplete ${locale} localization`);
    }
  }
  for (const locale of [...Object.keys(article.excerpt), ...Object.keys(article.url)]) {
    if (!Object.hasOwn(article.title, locale)) {
      throw new Error(`${label} has a ${locale} excerpt or URL without a title`);
    }
  }
}

/**
 * Parse and validate the public discovery index against its HTTP manifest.
 * `expectedBytes` and `expectedCount` are the manifest's file and count gates.
 *
 * @param {string} raw
 * @param {{expectedBytes:number, expectedCount:number, expectedCommit:string, now?:Date|number}} options
 * @returns {{schema:1,commit:string,generatedAt:string,count:number,articles:Array<object>}}
 */
export function parseDiscoveryArticleIndex(raw, {
  expectedBytes,
  expectedCount,
  expectedCommit,
  now = Date.now(),
} = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') !== expectedBytes) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} byte count differs from manifest`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} is not valid JSON: ${error.message}`);
  }
  if (!hasExactKeys(payload, ['schema', 'commit', 'generatedAt', 'count', 'articles'])
    || payload.schema !== 1
    || typeof payload.commit !== 'string'
    || !payload.commit
    || typeof payload.generatedAt !== 'string'
    || !Number.isSafeInteger(payload.count)
    || payload.count < 0
    || !Array.isArray(payload.articles)) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} has an invalid JSON contract`);
  }
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || payload.count !== expectedCount) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} count differs from manifest`);
  }
  if (payload.articles.length !== payload.count) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} count does not match articles`);
  }
  if (payload.commit !== expectedCommit) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} does not match manifest commit ${expectedCommit}`);
  }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const generatedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAtMs)
    || !Number.isFinite(nowMs)
    || generatedAtMs > nowMs + DISCOVERY_ARTICLES_FUTURE_SKEW_MS
    || nowMs - generatedAtMs > DISCOVERY_ARTICLES_MAX_AGE_MS) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} generatedAt is stale or in the future`);
  }

  const seenIds = new Set();
  payload.articles.forEach((article, index) => {
    const label = `${DISCOVERY_ARTICLES_ARTIFACT}.articles[${index}]`;
    if (!hasExactKeys(article, ['id', 'publishedAt', 'provider', 'title', 'excerpt', 'url'])
      || typeof article.id !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,199}$/iu.test(article.id)
      || seenIds.has(article.id)
      || typeof article.publishedAt !== 'string'
      || !Number.isFinite(Date.parse(article.publishedAt))
      || !PROVIDERS.has(article.provider)) {
      throw new Error(`${label} has an invalid article contract`);
    }
    seenIds.add(article.id);
    validateLocaleMaps(article, label);
  });

  return payload;
}

/**
 * Read the committed HTTP snapshot for newsletter use. Missing, malformed, or
 * stale data is optional content and therefore degrades to the existing email.
 */
export function loadDiscoveryArticleIndex({ filePath = DEFAULT_FEED_PATH, now = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[newsletter] discovery feed unavailable: ${error.message}`);
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
    return parseDiscoveryArticleIndex(raw, {
      expectedBytes: Buffer.byteLength(raw, 'utf8'),
      expectedCount: payload?.count,
      expectedCommit: payload?.commit,
      now,
    });
  } catch (error) {
    console.warn(`[newsletter] discovery feed ignored: ${error.message}`);
    return null;
  }
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function canonicalArticleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value, SITE_ORIGIN);
    if (parsed.origin !== SITE_ORIGIN || parsed.username || parsed.password) return null;
    const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    return `${SITE_ORIGIN}${pathname}`;
  } catch {
    return null;
  }
}

/**
 * Drop the optional discovery card when the personalized selector already
 * chose the same article. The returned null is also what the delivery ledger
 * must record for that recipient.
 */
export function omitDuplicateDiscoveryArticle(selection, personalizedArticle) {
  if (!selection || !personalizedArticle) return selection || null;
  const discoveryArticle = selection.article || selection;
  const discoveryId = selection.articleId || discoveryArticle.id || null;
  const personalizedId = personalizedArticle.id || null;
  if (discoveryId && personalizedId && discoveryId === personalizedId) return null;
  const discoveryUrl = canonicalArticleUrl(discoveryArticle.url);
  const personalizedUrl = canonicalArticleUrl(personalizedArticle.url);
  if (discoveryUrl && personalizedUrl && discoveryUrl === personalizedUrl) return null;
  return selection;
}

/**
 * Choose a recently published, localized item deterministically for previews.
 * Send mode persists this result before sending and reuses it on every resume.
 */
export function chooseDiscoveryArticle(index, campaignId, locale, { now = Date.now() } = {}) {
  if (!index || !Array.isArray(index.articles) || !LOCALES.has(locale)) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const candidates = index.articles
    .filter((article) => {
      const publishedAt = Date.parse(article?.publishedAt || '');
      return Number.isFinite(publishedAt)
        && publishedAt <= nowMs + DISCOVERY_ARTICLES_FUTURE_SKEW_MS
        && nowMs - publishedAt <= MAX_RECENT_ARTICLE_AGE_MS
        && isSafeText(article?.title?.[locale])
        && isSafeText(article?.excerpt?.[locale])
        && isCanonicalArticleUrl(article?.url?.[locale]);
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_ROTATION_POOL);
  if (!candidates.length) return null;
  const picked = candidates[fnv1a32(`${campaignId}\u0000${locale}`) % candidates.length];
  return {
    articleId: picked.id,
    provider: picked.provider,
    article: {
      id: picked.id,
      provider: picked.provider,
      title: picked.title[locale],
      excerpt: picked.excerpt[locale],
      url: picked.url[locale],
    },
  };
}

function validateStoredSelection(value, locale) {
  if (value === null) return null;
  if (!isRecord(value)
    || typeof value.articleId !== 'string'
    || !PROVIDERS.has(value.provider)
    || !isRecord(value.article)
    || value.article.id !== value.articleId
    || value.article.provider !== value.provider
    || !isSafeText(value.article.title)
    || !isSafeText(value.article.excerpt)
    || !isCanonicalArticleUrl(value.article.url)) {
    throw new Error(`frozen newsletter discovery selection is invalid for ${locale}`);
  }
  return value;
}

/**
 * Freeze one selection in `newsletter_subscribers/_meta_/campaign_discovery`
 * using the same weekly campaign key as the recipient resume ledger. A stored
 * null is meaningful: the campaign started without an eligible discovery item.
 */
export async function freezeCampaignDiscoverySelection(db, campaignId, locale, index, {
  now = new Date(),
  allowNewSelection = true,
} = {}) {
  if (!db?.collection || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore is required to freeze newsletter discovery content');
  }
  if (typeof campaignId !== 'string' || !campaignId || !LOCALES.has(locale)) {
    throw new TypeError('campaignId and a supported locale are required');
  }
  const reference = db.collection('newsletter_subscribers')
    .doc('_meta_')
    .collection('campaign_discovery')
    .doc(campaignId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const existing = snapshot.exists ? snapshot.data() : {};
    const selections = isRecord(existing?.selections) ? existing.selections : {};
    if (Object.hasOwn(selections, locale)) return validateStoredSelection(selections[locale], locale);

    const selection = allowNewSelection
      ? chooseDiscoveryArticle(index, campaignId, locale, { now })
      : null;
    const value = selection
      ? {
          articleId: selection.articleId,
          provider: selection.provider,
          // Store the small public localized copy too. If the API index later
          // advances or is briefly absent, resumes still render the same item.
          article: selection.article,
        }
      : null;
    const timestamp = now instanceof Date ? now : new Date(now);
    transaction.set(reference, {
      campaign_id: campaignId,
      ...(snapshot.exists ? {} : { created_at: timestamp }),
      updated_at: timestamp,
      selections: { [locale]: value },
    }, { merge: true });
    return value;
  });
}

/** Preview/test selection is deterministic but never writes campaign state. */
export function nonPersistedDiscoverySelection(index, campaignId, locale, options) {
  return chooseDiscoveryArticle(index, campaignId, locale, options);
}
