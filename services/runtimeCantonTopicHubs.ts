/** Runtime data boundary for hydrated canton thematic hubs (D20/D23).
 *
 * The corpus publishes the payload as JSON. The edge registry remains the
 * activation authority: this module reads the payload from the immutable
 * `registry.release.base` selected by that registry and accepts a hub only
 * when the payload commit is the same corpus commit currently served by the
 * registry and the requested section is live. A missing, stale or malformed
 * response returns null so the prerendered corpus page can remain the safe
 * fallback.
 */

import type { Locale } from '@/services/i18n';
import type { CantonArticleSection } from '@/services/articleSections';
import {
  CANTON_SECTION_REGISTRY_URL,
  cantonSectionConfig,
  isCantonArticleSection,
  loadCantonSectionRegistry,
  refreshCantonSectionRegistry,
} from '@/services/runtimeArticleSections';
import type { CantonSectionRegistry } from '@/services/runtimeArticleSections';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const TIMEOUT_MS = 6000;
const RELEASE_RETRY_DELAYS_MS = [0, 500, 1500] as const;
const HUB_FAILURE_BACKOFF_MS = [30_000, 120_000, 300_000] as const;
const CANTON_SECTION_CDN_ORIGIN = new URL(CANTON_SECTION_REGISTRY_URL).origin;
const CANTON_HUB_PAYLOAD_FILE = 'canton-hubs.json';

export interface CantonHubKeyFact {
  label: string;
  value: string;
  note?: string;
  sourceName?: string;
  sourceUrl?: string;
}

export interface CantonHubDataItem {
  label: string;
  value?: string;
  detail?: string;
  date?: string;
  url?: string;
}

export interface CantonHubDataBlock {
  id: string;
  title: string;
  description?: string;
  items: CantonHubDataItem[];
  sourceName?: string;
  sourceUrl?: string;
  updatedAt?: string;
}

export interface CantonHubArticle {
  title: string;
  url: string;
  excerpt?: string;
  date?: string;
}

export interface CantonHubLink {
  label: string;
  url: string;
  description?: string;
}

export interface CantonTopicHubData {
  canton: string;
  topic: string;
  locale: Locale;
  intro: string;
  keyFacts: CantonHubKeyFact[];
  dataBlocks: CantonHubDataBlock[];
  curatedArticles: CantonHubArticle[];
  /** Neutral canton news rail; absent only in pre-fallback payloads. */
  latestCantonArticles: CantonHubArticle[];
  links: CantonHubLink[];
  updatedAt: string;
}

interface HubPayload {
  schema?: unknown;
  commit?: unknown;
  sections?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeHref(value: unknown): value is string {
  return typeof value === 'string'
    && (/^https:\/\/[^\s"<>]+$/i.test(value) || /^\/(?!\/)[^\s"<>]*$/.test(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readKeyFact(value: unknown): CantonHubKeyFact | null {
  if (!isRecord(value) || !nonEmptyString(value.label) || !nonEmptyString(value.value)) return null;
  const fact: CantonHubKeyFact = { label: value.label, value: value.value };
  const note = optionalString(value.note);
  const sourceName = optionalString(value.sourceName);
  if (note) fact.note = note;
  if (sourceName) fact.sourceName = sourceName;
  const sourceUrl = value.sourceUrl;
  if (sourceUrl !== undefined) {
    if (!safeHref(sourceUrl)) return null;
    fact.sourceUrl = sourceUrl;
  }
  return fact;
}

function readDataItem(value: unknown): CantonHubDataItem | null {
  if (!isRecord(value) || !nonEmptyString(value.label)) return null;
  const item: CantonHubDataItem = { label: value.label };
  for (const field of ['value', 'detail'] as const) {
    const content = optionalString(value[field]);
    if (content) item[field] = content;
  }
  const date = value.date;
  if (date !== undefined) {
    if (!validDate(date)) return null;
    item.date = date;
  }
  const url = value.url;
  if (url !== undefined) {
    if (!safeHref(url)) return null;
    item.url = url;
  }
  return item;
}

function readDataBlock(value: unknown): CantonHubDataBlock | null {
  if (!isRecord(value) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value.id ?? '')) || !nonEmptyString(value.title)) return null;
  if (!Array.isArray(value.items)) return null;
  const items = value.items.map(readDataItem);
  if (items.some((item): item is null => item === null)) return null;
  const block: CantonHubDataBlock = { id: value.id as string, title: value.title, items: items as CantonHubDataItem[] };
  const description = optionalString(value.description);
  const sourceName = optionalString(value.sourceName);
  if (description) block.description = description;
  if (sourceName) block.sourceName = sourceName;
  const sourceUrl = value.sourceUrl;
  if (sourceUrl !== undefined) {
    if (!safeHref(sourceUrl)) return null;
    block.sourceUrl = sourceUrl;
  }
  const updatedAt = value.updatedAt;
  if (updatedAt !== undefined) {
    if (!validDate(updatedAt)) return null;
    block.updatedAt = updatedAt;
  }
  return block;
}

function readCuratedArticle(value: unknown): CantonHubArticle | null {
  if (!isRecord(value) || !nonEmptyString(value.title) || !safeHref(value.url)) return null;
  const article: CantonHubArticle = { title: value.title, url: value.url };
  const excerpt = optionalString(value.excerpt);
  if (excerpt) article.excerpt = excerpt;
  const date = value.date;
  if (date !== undefined) {
    if (!validDate(date)) return null;
    article.date = date;
  }
  return article;
}

function readHubLink(value: unknown): CantonHubLink | null {
  if (!isRecord(value) || !nonEmptyString(value.label) || !safeHref(value.url)) return null;
  const link: CantonHubLink = { label: value.label, url: value.url };
  const description = optionalString(value.description);
  if (description) link.description = description;
  return link;
}

function readLocale(value: unknown, section: CantonArticleSection, topic: string, locale: Locale): CantonTopicHubData | null {
  if (!isRecord(value)
    || value.canton !== cantonSectionConfig(section)?.canton
    || value.topic !== topic
    || value.locale !== locale
    || !nonEmptyString(value.intro)
    || !validDate(value.updatedAt)
    || !Array.isArray(value.keyFacts)
    || !Array.isArray(value.dataBlocks)
    || !Array.isArray(value.curatedArticles)
    || (value.latestCantonArticles !== undefined && !Array.isArray(value.latestCantonArticles))
    || !Array.isArray(value.links)) return null;

  const keyFacts = value.keyFacts.map(readKeyFact);
  const dataBlocks = value.dataBlocks.map(readDataBlock);
  const curatedArticles = value.curatedArticles.map(readCuratedArticle);
  const latestCantonArticles = (Array.isArray(value.latestCantonArticles) ? value.latestCantonArticles : []).map(readCuratedArticle);
  const links = value.links.map(readHubLink);
  if ([...keyFacts, ...dataBlocks, ...curatedArticles, ...latestCantonArticles, ...links].some((item) => item === null)) return null;
  return {
    canton: value.canton as string,
    topic,
    locale,
    intro: value.intro,
    keyFacts: keyFacts as CantonHubKeyFact[],
    dataBlocks: dataBlocks as CantonHubDataBlock[],
    curatedArticles: curatedArticles as CantonHubArticle[],
    latestCantonArticles: latestCantonArticles as CantonHubArticle[],
    links: links as CantonHubLink[],
    updatedAt: value.updatedAt,
  };
}

function readPayloadDocument(
  value: unknown,
  section: CantonArticleSection,
  topic: string,
  locale: Locale,
): CantonTopicHubData | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.id !== `${section}:${topic}`
    || value.section !== section
    || value.canton !== cantonSectionConfig(section)?.canton
    || value.topic !== topic
    || !validDate(value.updatedAt)
    || typeof value.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.contentHash)
    || !isRecord(value.locales)) return null;
  return readLocale(value.locales[locale], section, topic, locale);
}

function hubPayloadUrl(registry: CantonSectionRegistry): string | null {
  const base = registry.release?.base;
  if (!base) return null;
  return new URL(`${base}${CANTON_HUB_PAYLOAD_FILE}`, `${CANTON_SECTION_CDN_ORIGIN}/`).toString();
}

async function fetchHubPayload(registry: CantonSectionRegistry): Promise<HubPayload | null> {
  const url = hubPayloadUrl(registry);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as HubPayload;
    // Keep the structural check separate from release selection. In normal
    // operation the immutable path and root commit agree; if a stale handoff
    // or an edge misroute returns a newer body, the caller must confirm that
    // body against a fresh registry before adopting it.
    if (payload?.schema !== 1 || !nonEmptyString(payload.commit) || !isRecord(payload.sections)) return null;
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let hubPayloadCache: { key: string; promise: Promise<HubPayload | null> } | null = null;
const hubLoadPromises = new Map<string, Promise<CantonTopicHubData | null>>();
const hubFailureBackoff = new Map<string, { failures: number; retryAt: number }>();

function registryReleaseKey(registry: CantonSectionRegistry): string {
  return `${registry.commit}\0${registry.release?.base ?? ''}`;
}

function loadHubPayload(registry: CantonSectionRegistry): Promise<HubPayload | null> {
  const key = registryReleaseKey(registry);
  if (hubPayloadCache?.key === key) return hubPayloadCache.promise;
  const promise = fetchHubPayload(registry);
  hubPayloadCache = { key, promise };
  return promise;
}

async function waitForReleaseRetry(attempt: number): Promise<void> {
  const delayMs = RELEASE_RETRY_DELAYS_MS[attempt];
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function hubKey(section: CantonArticleSection, topic: string, locale: Locale): string {
  return `${section}:${topic}:${locale}`;
}

function readPayloadHub(
  payload: HubPayload,
  section: CantonArticleSection,
  topic: string,
  locale: Locale,
): CantonTopicHubData | null {
  if (!isRecord(payload.sections)) return null;
  const sectionPayload = payload.sections[section];
  if (!isRecord(sectionPayload)) return null;
  return readPayloadDocument(sectionPayload[topic], section, topic, locale);
}

function markHubUnavailable(key: string): void {
  const previous = hubFailureBackoff.get(key);
  const failures = (previous?.failures ?? 0) + 1;
  const delayIndex = Math.min(failures - 1, HUB_FAILURE_BACKOFF_MS.length - 1);
  hubFailureBackoff.set(key, {
    failures,
    retryAt: Date.now() + HUB_FAILURE_BACKOFF_MS[delayIndex],
  });
}

async function loadCantonTopicHubOnce(
  section: CantonArticleSection,
  topic: string,
  locale: Locale,
): Promise<CantonTopicHubData | null> {
  if (!isCantonArticleSection(section) || !LOCALES.includes(locale)) return null;
  const config = cantonSectionConfig(section);
  if (!config?.topicHubs || !Object.prototype.hasOwnProperty.call(config.topicHubs, topic)) return null;
  for (let attempt = 0; attempt < RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
    await waitForReleaseRetry(attempt);
    const registry = await loadCantonSectionRegistry();
    if (!registry?.sections[section] || registry.sections[section].status !== 'live') return null;
    const payload = await loadHubPayload(registry);
    if (payload) {
      if (payload.commit === registry.commit) {
        const data = readPayloadHub(payload, section, topic, locale);
        if (data) return data;
      } else if (nonEmptyString(payload.commit)) {
        // The first registry read may be the release identity retained by the
        // page's static/SPA handoff. Confirm the payload's identity against a
        // fresh edge registry before using it. If they agree, adopt the newer
        // release immediately; no second stale query or page reload is needed.
        refreshCantonSectionRegistry();
        const freshRegistry = await loadCantonSectionRegistry();
        if (freshRegistry?.commit === payload.commit
          && freshRegistry.sections[section]?.status === 'live') {
          const data = readPayloadHub(payload, section, topic, locale);
          if (data) {
            hubPayloadCache = { key: registryReleaseKey(freshRegistry), promise: Promise.resolve(payload) };
            return data;
          }
        }
      }
    }

    // Keep D20 fail-closed: discard the cached result and re-read both
    // authorities. This covers an object not yet staged and aborted reads,
    // without ever retrying for the lifetime of the page.
    hubPayloadCache = null;
    if (attempt < RELEASE_RETRY_DELAYS_MS.length - 1) refreshCantonSectionRegistry();
  }
  return null;
}

export function __resetRuntimeCantonTopicHubs(): void {
  hubPayloadCache = null;
  hubLoadPromises.clear();
  hubFailureBackoff.clear();
}

/**
 * Fetch one locale of one live canton hub from the versioned corpus payload.
 * Concurrent mounts share one bounded attempt, and a failed key is cooled down
 * so a remount cannot turn a release skew into an unbounded fetch loop.
 */
export function loadCantonTopicHub(
  section: CantonArticleSection,
  topic: string,
  locale: Locale,
): Promise<CantonTopicHubData | null> {
  if (!isCantonArticleSection(section) || !LOCALES.includes(locale)) return Promise.resolve(null);
  const key = hubKey(section, topic, locale);
  const inFlight = hubLoadPromises.get(key);
  if (inFlight) return inFlight;
  const blocked = hubFailureBackoff.get(key);
  if (blocked && blocked.retryAt > Date.now()) return Promise.resolve(null);

  const promise = loadCantonTopicHubOnce(section, topic, locale)
    .then((data) => {
      if (data) hubFailureBackoff.delete(key);
      else markHubUnavailable(key);
      return data;
    })
    .finally(() => {
      hubLoadPromises.delete(key);
    });
  hubLoadPromises.set(key, promise);
  return promise;
}
