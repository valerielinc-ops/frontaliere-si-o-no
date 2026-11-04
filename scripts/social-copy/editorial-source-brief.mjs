#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { classifyByRegex, CLUSTER_TAXONOMY } from '../lib/cluster-classifier-prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ARTICLE_DIRECTORY = path.join(ROOT, 'data', 'swiss-articles');
const DEFAULT_BLOG_ARTICLE_DIRECTORY = path.join(ROOT, 'data', 'blog-articles');
const DEFAULT_ARTICLE_DIRECTORIES = Object.freeze([DEFAULT_ARTICLE_DIRECTORY, DEFAULT_BLOG_ARTICLE_DIRECTORY]);
const DEFAULT_EVENT_DIRECTORY = path.join(ROOT, 'data', 'events', 'by-source');
const DEFAULT_DEMAND_VOCABULARY_PATH = path.join(ROOT, 'data', 'demand-vocabulary.json');
const DEFAULT_EXPERIMENTAL_CANDIDATES_PATH = path.join(ROOT, 'data', 'experimental-candidates.json');
const INVENTORY_DAYS = 30;
const EDITORIAL_HISTORY_DAYS = 365;
const EVENT_SOURCE_MAX_AGE_DAYS = 7;
const TOPIC_SOURCE_MAX_AGE_DAYS = 7;
const NEWS_ITEM_MAX_AGE_DAYS = 14;
const MIN_SEARCH_KEYWORDS_PER_CLUSTER = 10;
const MIN_NEWS_ITEMS_PER_CLUSTER = 3;
const MIN_NEWS_DOMAINS_PER_CLUSTER = 2;
const MAX_RECENT_TOPICS = 12;
const MAX_EVENT_CATEGORIES = 8;
const EVENT_CANTON = 'TI';
const DEMAND_CLUSTERS = new Set(CLUSTER_TAXONOMY);
const ALLOWED_CLUSTERS = new Set([
  'pratico', 'mobilita', 'generic', 'lavoro', 'salute', 'fiscale', 'novita', 'pensioni',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTopic(value) {
  return typeof value === 'string'
    && value.length <= 140
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function safeEventCategory(value) {
  if (typeof value !== 'string') return null;
  const category = value.replace(/[\r\n\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!category || category.length > 80 || /https?:|www\.|@/iu.test(category)) return null;
  return category;
}

function strictDate(value) {
  const date = String(value || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function sourceTimestamp(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageWithinDays(timestamp, asOfMs, maxAgeDays) {
  return timestamp !== null
    && timestamp <= asOfMs
    && asOfMs - timestamp <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function countBand(count) {
  if (count >= 50) return '50+';
  if (count >= 25) return '25-49';
  if (count >= 10) return '10-24';
  if (count >= 6) return '6-9';
  if (count >= 3) return '3-5';
  return String(count);
}

function buildSearchDemandCategories({ demandVocabularyPath, asOfMs }) {
  const empty = {
    available: false,
    status: 'missing',
    generatedAt: null,
    minimumKeywordCount: MIN_SEARCH_KEYWORDS_PER_CLUSTER,
    categories: [],
  };
  const payload = safeReadJson(demandVocabularyPath);
  if (!isRecord(payload)) return empty;
  const generatedAtMs = sourceTimestamp(payload.generatedAt);
  if (generatedAtMs === null) return { ...empty, status: 'invalid-timestamp' };
  const generatedAt = new Date(generatedAtMs).toISOString();
  if (generatedAtMs > asOfMs) return { ...empty, status: 'future-timestamp', generatedAt };
  if (!ageWithinDays(generatedAtMs, asOfMs, TOPIC_SOURCE_MAX_AGE_DAYS)) {
    return { ...empty, status: 'stale', generatedAt };
  }

  const buckets = new Map();
  for (const row of Array.isArray(payload.stableKeywords) ? payload.stableKeywords : []) {
    if (!isRecord(row) || !DEMAND_CLUSTERS.has(row.cluster)) continue;
    const termValue = typeof row.normalizedKeyword === 'string' && row.normalizedKeyword.trim()
      ? row.normalizedKeyword
      : typeof row.kw === 'string' ? row.kw : '';
    const term = termValue.normalize('NFKC').trim().toLowerCase();
    if (!term) continue;
    const sourceTypes = new Set(typeof row.source === 'string' ? row.source.split('+') : []);
    const searchSources = [];
    if (sourceTypes.has('gsc')) searchSources.push('search-console');
    if (sourceTypes.has('suggest')) searchSources.push('query-suggestions');
    if (!searchSources.length) continue;

    let bucket = buckets.get(row.cluster);
    if (!bucket) {
      bucket = { terms: new Set(), sources: new Set() };
      buckets.set(row.cluster, bucket);
    }
    bucket.terms.add(term);
    for (const source of searchSources) bucket.sources.add(source);
  }

  const categories = [...buckets.entries()]
    .filter(([, bucket]) => bucket.terms.size >= MIN_SEARCH_KEYWORDS_PER_CLUSTER)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, bucket]) => ({
      category,
      keywordCountBand: countBand(bucket.terms.size),
      sources: [...bucket.sources].sort(),
    }));
  return {
    available: categories.length > 0,
    status: categories.length > 0 ? 'available' : 'no-qualified-categories',
    generatedAt,
    minimumKeywordCount: MIN_SEARCH_KEYWORDS_PER_CLUSTER,
    categories,
  };
}

function safePublisherHost(value) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/^www\./u, '') || null;
  } catch {
    return null;
  }
}

function buildRecentPublisherNewsCategories({ experimentalCandidatesPath, asOfMs }) {
  const empty = {
    available: false,
    status: 'missing',
    generatedAt: null,
    itemMaxAgeDays: NEWS_ITEM_MAX_AGE_DAYS,
    minimumItemsPerCategory: MIN_NEWS_ITEMS_PER_CLUSTER,
    minimumPublisherDomainsPerCategory: MIN_NEWS_DOMAINS_PER_CLUSTER,
    categories: [],
  };
  const payload = safeReadJson(experimentalCandidatesPath);
  if (!isRecord(payload)) return empty;
  const generatedAtMs = sourceTimestamp(payload.generatedAt);
  if (generatedAtMs === null) return { ...empty, status: 'invalid-timestamp' };
  const generatedAt = new Date(generatedAtMs).toISOString();
  if (generatedAtMs > asOfMs) return { ...empty, status: 'future-timestamp', generatedAt };
  if (!ageWithinDays(generatedAtMs, asOfMs, TOPIC_SOURCE_MAX_AGE_DAYS)) {
    return { ...empty, status: 'stale', generatedAt };
  }

  const buckets = new Map();
  const seenItems = new Set();
  for (const row of Array.isArray(payload.candidates) ? payload.candidates : []) {
    if (!isRecord(row) || !Array.isArray(row.sources) || !row.sources.includes('googleNewsRss')) continue;
    const signals = isRecord(row.demandSignals) ? row.demandSignals : {};
    const publishedAtMs = sourceTimestamp(signals.googleNewsRssPubDate);
    if (!ageWithinDays(publishedAtMs, asOfMs, NEWS_ITEM_MAX_AGE_DAYS)) continue;
    const host = safePublisherHost(signals.googleNewsRssSourceUrl);
    if (!host) continue;
    const topicText = String(row.keyword || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!topicText) continue;
    const category = classifyByRegex(topicText);
    if (!DEMAND_CLUSTERS.has(category) || category === 'generic') continue;
    const itemKey = createHash('sha256').update(topicText.toLowerCase()).digest('hex');
    if (seenItems.has(itemKey)) continue;
    seenItems.add(itemKey);
    let bucket = buckets.get(category);
    if (!bucket) {
      bucket = { items: 0, domains: new Set() };
      buckets.set(category, bucket);
    }
    bucket.items += 1;
    bucket.domains.add(host);
  }

  const categories = [...buckets.entries()]
    .filter(([, bucket]) => bucket.items >= MIN_NEWS_ITEMS_PER_CLUSTER
      && bucket.domains.size >= MIN_NEWS_DOMAINS_PER_CLUSTER)
    .sort(([leftName, left], [rightName, right]) => right.items - left.items || leftName.localeCompare(rightName))
    .slice(0, CLUSTER_TAXONOMY.length)
    .map(([category, bucket]) => ({
      category,
      itemCountBand: countBand(bucket.items),
      publisherDomainCountBand: countBand(bucket.domains.size),
    }));
  return {
    available: categories.length > 0,
    status: categories.length > 0 ? 'available' : 'no-qualified-categories',
    generatedAt,
    itemMaxAgeDays: NEWS_ITEM_MAX_AGE_DAYS,
    minimumItemsPerCategory: MIN_NEWS_ITEMS_PER_CLUSTER,
    minimumPublisherDomainsPerCategory: MIN_NEWS_DOMAINS_PER_CLUSTER,
    categories,
  };
}

function buildTopicDiscoveryBrief({ demandVocabularyPath, experimentalCandidatesPath, asOfDate }) {
  const asOfMs = asOfDate.getTime();
  const searchDemand = buildSearchDemandCategories({ demandVocabularyPath, asOfMs });
  const recentPublisherNews = buildRecentPublisherNewsCategories({ experimentalCandidatesPath, asOfMs });
  return {
    schemaVersion: 1,
    source: 'privacy-screened-topic-discovery',
    available: searchDemand.available || recentPublisherNews.available,
    searchDemand,
    recentPublisherNews,
    interpretation: 'Only closed editorial categories and thresholded source counts are included. Raw search queries, news headlines, URLs, Reddit text, and identifiers are excluded. Signals are ideation context, not search volume, audience evidence, current facts, or proof of social trends; publishers must verify every claim against current authoritative sources.',
  };
}

function eventIdentity(event, date) {
  let source = '';
  try {
    const url = new URL(String(event?.url || ''));
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      url.search = '';
      url.hash = '';
      source = url.toString().replace(/\/$/u, '').toLowerCase();
    }
  } catch {
    // The public event may not expose a canonical URL; fall back to a private
    // in-memory digest of its source identity fields, never emitted in the brief.
  }
  if (!source) {
    source = [event?.id, event?.title, event?.comune, event?.canton, date]
      .map((value) => String(value || '').normalize('NFKC').trim().toLowerCase())
      .join('|');
  }
  return createHash('sha256').update(source).digest('hex');
}

function upcomingTicinoEventInventory({ eventDirectory, asOfDate, inventoryDays }) {
  const asOfMs = asOfDate.getTime();
  const firstDay = asOfDate.toISOString().slice(0, 10);
  const lastDay = new Date(asOfMs + inventoryDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nowMs = asOfMs;
  const categoryCounts = new Map();
  const seen = new Set();
  let unreadableSourceCount = 0;
  let freshSourceCount = 0;
  let latestSourceAt = null;

  let names = [];
  try {
    names = readdirSync(eventDirectory).filter((entry) => entry.endsWith('.json')).sort();
  } catch {
    return {
      available: false,
      source: 'upcoming-ticino-event-inventory',
      canton: EVENT_CANTON,
      windowDays: inventoryDays,
      sourceMaxAgeDays: EVENT_SOURCE_MAX_AGE_DAYS,
      eventCount: 0,
      sourceCount: 0,
      unreadableSourceCount: 0,
      categories: [],
      latestSourceAt: null,
    };
  }

  for (const name of names) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(path.join(eventDirectory, name), 'utf8'));
    } catch {
      unreadableSourceCount += 1;
      continue;
    }
    if (!isRecord(payload) || !Array.isArray(payload.events)) continue;
    const assembledAt = Date.parse(String(payload.assembledAt || ''));
    if (!Number.isFinite(assembledAt) || assembledAt > nowMs
      || nowMs - assembledAt > EVENT_SOURCE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) continue;
    freshSourceCount += 1;
    latestSourceAt = Math.max(latestSourceAt || 0, assembledAt);

    for (const event of payload.events) {
      if (!isRecord(event) || String(event.canton || '').trim().toUpperCase() !== EVENT_CANTON) continue;
      const date = strictDate(event.startDate);
      if (!date || date < firstDay || date > lastDay) continue;
      const identity = eventIdentity(event, date);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const category = safeEventCategory(event.category) || 'non-classificato';
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    }
  }

  const categories = [...categoryCounts]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, MAX_EVENT_CATEGORIES)
    .map(([name, count]) => ({ name, count }));
  const eventCount = [...categoryCounts.values()].reduce((sum, count) => sum + count, 0);
  return {
    available: eventCount > 0,
    source: 'upcoming-ticino-event-inventory',
    canton: EVENT_CANTON,
    windowDays: inventoryDays,
    sourceMaxAgeDays: EVENT_SOURCE_MAX_AGE_DAYS,
    eventCount,
    sourceCount: freshSourceCount,
    unreadableSourceCount,
    categories,
    latestSourceAt: latestSourceAt === null ? null : new Date(latestSourceAt).toISOString(),
  };
}

/** Return public topic labels, dates, and aggregate coverage; omit article bodies and ranking data. */
export function buildEditorialSourceBrief({
  articleDirectory,
  articleDirectories = DEFAULT_ARTICLE_DIRECTORIES,
  eventDirectory = DEFAULT_EVENT_DIRECTORY,
  demandVocabularyPath = DEFAULT_DEMAND_VOCABULARY_PATH,
  experimentalCandidatesPath = DEFAULT_EXPERIMENTAL_CANDIDATES_PATH,
  asOf = new Date(),
  inventoryDays = INVENTORY_DAYS,
  maxRecentTopics = MAX_RECENT_TOPICS,
} = {}) {
  const asOfDate = new Date(asOf);
  const asOfMs = asOfDate.getTime();
  if (!Number.isFinite(asOfMs)) throw new TypeError('asOf must be a valid date');
  if (!Number.isSafeInteger(inventoryDays) || inventoryDays < 1 || inventoryDays > 365) {
    throw new TypeError('inventoryDays must be an integer between 1 and 365');
  }
  if (!Number.isSafeInteger(maxRecentTopics) || maxRecentTopics < 1 || maxRecentTopics > 50) {
    throw new TypeError('maxRecentTopics must be an integer between 1 and 50');
  }

  const cutoffMs = asOfMs - inventoryDays * 24 * 60 * 60 * 1000;
  const historyCutoffMs = asOfMs - EDITORIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const records = [];
  const historicalRecords = [];
  const seenArticles = new Set();
  let unreadable = 0;
  const directories = articleDirectory ? [articleDirectory] : articleDirectories;
  for (const directory of directories) {
    let names = [];
    try {
      names = readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let row;
      try {
        row = JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
      } catch {
        unreadable += 1;
        continue;
      }
      if (!isRecord(row) || !validTopic(row.slug)) continue;
      const publishedMs = Date.parse(String(row.publishedAt || ''));
      if (!Number.isFinite(publishedMs) || publishedMs < historyCutoffMs || publishedMs > asOfMs) continue;
      const articleIdentity = `${row.slug}|${publishedMs}`;
      if (seenArticles.has(articleIdentity)) continue;
      seenArticles.add(articleIdentity);
      const record = {
        publishedOn: new Date(publishedMs).toISOString().slice(0, 10),
        topic: row.slug,
        cluster: ALLOWED_CLUSTERS.has(row.cluster) ? row.cluster : 'non-classificato',
        publishedMs,
      };
      if (publishedMs >= cutoffMs) records.push(record);
      else historicalRecords.push(record);
    }
  }
  records.sort((left, right) => right.publishedMs - left.publishedMs || left.topic.localeCompare(right.topic));
  historicalRecords.sort((left, right) => right.publishedMs - left.publishedMs || left.topic.localeCompare(right.topic));
  const clusterCounts = {};
  for (const row of records) clusterCounts[row.cluster] = (clusterCounts[row.cluster] || 0) + 1;
  const historicalClusterCounts = {};
  for (const row of historicalRecords) {
    historicalClusterCounts[row.cluster] = (historicalClusterCounts[row.cluster] || 0) + 1;
  }
  const upcomingEvents = upcomingTicinoEventInventory({ eventDirectory, asOfDate, inventoryDays });
  const topicDiscovery = buildTopicDiscoveryBrief({
    demandVocabularyPath,
    experimentalCandidatesPath,
    asOfDate,
  });
  return {
    schemaVersion: 1,
    source: 'published-article-topic-inventory',
    generatedAt: asOfDate.toISOString(),
    windowDays: inventoryDays,
    available: records.length > 0,
    sourceCount: records.length,
    unreadableSourceCount: unreadable,
    clusters: Object.fromEntries(Object.entries(clusterCounts).sort(([a], [b]) => a.localeCompare(b))),
    recentTopics: records.slice(0, maxRecentTopics).map(({ publishedOn, topic, cluster }) => ({
      publishedOn,
      topic,
      cluster,
    })),
    historicalWindowDays: EDITORIAL_HISTORY_DAYS,
    historicalTopicCount: historicalRecords.length,
    historicalClusters: Object.fromEntries(Object.entries(historicalClusterCounts).sort(([a], [b]) => a.localeCompare(b))),
    historicalTopics: historicalRecords.slice(0, maxRecentTopics).map(({ publishedOn, topic, cluster, publishedMs }) => ({
      publishedOn,
      topic,
      cluster,
      ageDays: Math.floor((asOfMs - publishedMs) / (24 * 60 * 60 * 1000)),
    })),
    topicDiscovery,
    upcomingTicinoEvents: upcomingEvents,
    interpretation: 'Recent article topics and historical topics from the prior year are source-inventory context only; historical topics are ideation candidates, not current trends or performance evidence. Topic-discovery categories are thresholded aggregates, not search volume, audience evidence, or current facts. The brief contains no article claims, event details, audience data, rankings, or performance evidence; the publishing workflow must verify every fact against its current source.',
  };
}

if (isInvokedDirectly(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(buildEditorialSourceBrief())}\n`);
}
