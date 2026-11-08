import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DISCOVERY_ARTICLES_ARTIFACT,
  checkDiscoveryArticleRoute,
  chooseDiscoveryArticle,
  loadDiscoveryArticleSnapshotFromHttp,
  MAX_HTTP_RETRIES,
  parseDiscoveryArticleIndex,
  parseDiscoveryManifest,
} from '../lib/newsletter-discovery-selection.mjs';
import { weeklyCampaignId } from '../lib/newsletter-ab-data.mjs';

const READINESS_SCHEMA = 1;
const READINESS_ALGORITHM = 'sha256-discovery-article-v2';
const MAX_ROUTE_PROOF_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ROUTE_TIMEOUT_MS = 8_000;
const DEFAULT_ROUTE_CONCURRENCY = 8;
const LOCALES = ['it', 'en', 'de', 'fr'];

function sortedLocaleMap(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

function articleSignature(article) {
  const canonical = {
    id: article.id,
    publishedAt: article.publishedAt,
    provider: article.provider,
    title: sortedLocaleMap(article.title),
    excerpt: sortedLocaleMap(article.excerpt),
    url: sortedLocaleMap(article.url),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function isValidReadiness(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== READINESS_SCHEMA
    || value.algorithm !== READINESS_ALGORITHM
    || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    return null;
  }
  const entries = {};
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.signature !== 'string'
      || !/^[a-f0-9]{64}$/u.test(entry.signature)
      || typeof entry.verifiedAt !== 'string'
      || !Array.isArray(entry.locales)
      || entry.locales.length === 0
      || entry.locales.some((locale) => !LOCALES.includes(locale))
      || new Set(entry.locales).size !== entry.locales.length) continue;
    const verifiedAtMs = Date.parse(entry.verifiedAt);
    if (!Number.isFinite(verifiedAtMs)
      || verifiedAtMs > nowMs + 5 * 60 * 1000
      || nowMs - verifiedAtMs > MAX_ROUTE_PROOF_AGE_MS) continue;
    entries[id] = {
      signature: entry.signature,
      verifiedAt: entry.verifiedAt,
      locales: [...entry.locales].sort(),
    };
  }
  return entries;
}

function readPreviousPair(indexFilePath, manifestFilePath, now) {
  try {
    const manifestRaw = fs.readFileSync(manifestFilePath, 'utf8');
    const indexRaw = fs.readFileSync(indexFilePath, 'utf8');
    const parsedManifest = parseDiscoveryManifest(manifestRaw);
    const index = parseDiscoveryArticleIndex(indexRaw, {
      expectedBytes: parsedManifest.expectedBytes,
      expectedCount: parsedManifest.expectedCount,
      expectedCommit: parsedManifest.expectedCommit,
      now,
    });
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    return {
      index,
      entries: isValidReadiness(parsedManifest.manifest.routeReadiness, nowMs) || {},
    };
  } catch {
    return null;
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return output;
}

async function verifyNewArticleRoutes(article, locales, options) {
  const checks = await runWithConcurrency(locales, options.concurrency, async (locale) => ({
    locale,
    ...(await checkDiscoveryArticleRoute(article, locale, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      retryDelayMs: options.retryDelayMs,
      sleepImpl: options.sleepImpl,
      now: options.now,
    })),
  }));
  const failed = checks.filter((check) => !check.ready);
  return { ready: failed.length === 0, failed };
}

function writeFileAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, content, { flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

/**
 * Replace the index and its compact manifest as one validated publication
 * pair. Both temporary files are complete before either public snapshot moves;
 * if either rename fails, restore the previous pair before returning an error.
 */
export function writeDiscoverySnapshotPairAtomically({ indexFilePath, manifestFilePath, rawIndex, compactManifest }) {
  const indexDirectory = path.dirname(indexFilePath);
  if (path.resolve(indexDirectory) !== path.resolve(path.dirname(manifestFilePath))) {
    throw new Error('discovery snapshot index and manifest must share a directory');
  }
  fs.mkdirSync(indexDirectory, { recursive: true });
  const previousIndex = fs.existsSync(indexFilePath) ? fs.readFileSync(indexFilePath) : null;
  const previousManifest = fs.existsSync(manifestFilePath) ? fs.readFileSync(manifestFilePath) : null;
  const indexTemporaryPath = path.join(indexDirectory, `.${path.basename(indexFilePath)}.${randomUUID()}.tmp`);
  const manifestTemporaryPath = path.join(indexDirectory, `.${path.basename(manifestFilePath)}.${randomUUID()}.tmp`);
  const manifestRaw = `${JSON.stringify(compactManifest, null, 2)}\n`;
  let indexRenamed = false;
  let manifestRenamed = false;

  const restore = (filePath, content) => {
    if (content === null) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    writeFileAtomically(filePath, content);
  };

  try {
    fs.writeFileSync(indexTemporaryPath, rawIndex, { flag: 'wx' });
    fs.writeFileSync(manifestTemporaryPath, manifestRaw, { flag: 'wx' });
    fs.renameSync(indexTemporaryPath, indexFilePath);
    indexRenamed = true;
    fs.renameSync(manifestTemporaryPath, manifestFilePath);
    manifestRenamed = true;
  } catch (error) {
    const restoreErrors = [];
    if (indexRenamed) {
      try { restore(indexFilePath, previousIndex); } catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (manifestRenamed) {
      try { restore(manifestFilePath, previousManifest); } catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError([error, ...restoreErrors], 'discovery snapshot pair write failed and rollback was incomplete');
    }
    throw error;
  } finally {
    fs.rmSync(indexTemporaryPath, { force: true });
    fs.rmSync(manifestTemporaryPath, { force: true });
  }
}

/**
 * Fetch, validate, route-check, and write one public discovery snapshot.
 * Unready pages are successful no-ops so the scheduled retry can recover
 * without replacing the last-known-good pair. A valid empty feed is published
 * as an empty snapshot so the site does not keep advertising a removed index.
 */
export async function syncDiscoveryArticleSnapshot({
  indexFilePath = path.resolve('public', DISCOVERY_ARTICLES_ARTIFACT),
  manifestFilePath = path.resolve('public/data/discovery-articles-manifest.json'),
  fetchImpl = globalThis.fetch,
  apiBase,
  now = new Date(),
  retries = 2,
  retryDelayMs = 300,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  routeTimeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
  routeRetries = MAX_HTTP_RETRIES,
  routeRetryDelayMs = 5_000,
  routeConcurrency = DEFAULT_ROUTE_CONCURRENCY,
  campaignId,
} = {}) {
  if (!Number.isSafeInteger(routeConcurrency) || routeConcurrency < 1 || routeConcurrency > 64) {
    throw new RangeError('routeConcurrency must be an integer between 1 and 64');
  }
  const pulled = await loadDiscoveryArticleSnapshotFromHttp({
    ...(apiBase ? { apiBase } : {}),
    fetchImpl,
    now,
    retries,
    retryDelayMs,
    sleepImpl,
  });
  const previous = readPreviousPair(indexFilePath, manifestFilePath, now);
  const previousArticles = new Map(previous?.index.articles.map((article) => [article.id, article]) || []);
  const previousProofs = previous?.entries || {};
  const routeReadinessEntries = {};
  const readinessFailures = [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const verifiedAt = new Date(nowMs).toISOString();
  const effectiveCampaignId = campaignId || weeklyCampaignId(now instanceof Date ? now : new Date(nowMs));
  const selectedLocalesByArticle = new Map();
  for (const locale of LOCALES) {
    const selected = chooseDiscoveryArticle(pulled.index, effectiveCampaignId, locale, { now });
    if (!selected) continue;
    const locales = selectedLocalesByArticle.get(selected.articleId) || [];
    locales.push(locale);
    selectedLocalesByArticle.set(selected.articleId, locales);
  }
  const pendingVerifications = [];

  for (const article of pulled.index.articles) {
    const locales = selectedLocalesByArticle.get(article.id) || [];
    if (locales.length === 0) continue;
    locales.sort();
    const signature = articleSignature(article);
    const priorProof = previousProofs[article.id];
    const priorArticle = previousArticles.get(article.id);
    if (priorArticle
      && priorProof?.signature === signature
      && locales.every((locale) => priorProof.locales.includes(locale))) {
      routeReadinessEntries[article.id] = priorProof;
      continue;
    }
    pendingVerifications.push({ article, locales, signature });
  }

  const verificationResults = await runWithConcurrency(
    pendingVerifications,
    routeConcurrency,
    async ({ article, locales, signature }) => ({
      articleId: article.id,
      signature,
      locales,
      ...(await verifyNewArticleRoutes(article, locales, {
        fetchImpl,
        timeoutMs: routeTimeoutMs,
        retries: routeRetries,
        retryDelayMs: routeRetryDelayMs,
        sleepImpl,
        now,
        concurrency: routeConcurrency,
      })),
    }),
  );
  for (const verification of verificationResults) {
    if (!verification.ready) {
      readinessFailures.push(...verification.failed.map((failure) => ({
        articleId: verification.articleId,
        locale: failure.locale,
        reason: failure.reason,
      })));
      continue;
    }
    routeReadinessEntries[verification.articleId] = {
      signature: verification.signature,
      verifiedAt,
      locales: verification.locales,
    };
  }

  if (readinessFailures.length > 0) {
    return {
      status: 'not-ready',
      changed: false,
      commit: pulled.index.commit,
      count: pulled.index.count,
      readinessFailures,
    };
  }

  const compactManifest = {
    ...pulled.compactManifest,
    routeReadiness: {
      schema: READINESS_SCHEMA,
      algorithm: READINESS_ALGORITHM,
      entries: routeReadinessEntries,
    },
  };
  const compactManifestRaw = `${JSON.stringify(compactManifest, null, 2)}\n`;
  let currentIndex = null;
  let currentManifest = null;
  try { currentIndex = fs.readFileSync(indexFilePath, 'utf8'); } catch { /* first snapshot */ }
  try { currentManifest = fs.readFileSync(manifestFilePath, 'utf8'); } catch { /* first snapshot */ }
  if (currentIndex === pulled.rawIndex && currentManifest === compactManifestRaw) {
    return { status: 'unchanged', changed: false, commit: pulled.index.commit, count: pulled.index.count };
  }

  writeDiscoverySnapshotPairAtomically({
    indexFilePath,
    manifestFilePath,
    rawIndex: pulled.rawIndex,
    compactManifest,
  });
  return { status: 'ready', changed: true, commit: pulled.index.commit, count: pulled.index.count };
}
