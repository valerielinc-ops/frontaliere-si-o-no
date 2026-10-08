/** Runtime data boundary for hydrated canton thematic hubs (D20/D23).
 *
 * The corpus publishes the payload as JSON. The edge registry remains the
 * activation authority: this module accepts a hub only when the payload
 * commit is the same commit currently served by the edge registry and the
 * requested section is live. A missing, stale or malformed response returns
 * null so the prerendered corpus page can remain the safe fallback.
 */

import type { Locale } from '@/services/i18n';
import { articlesApiBase } from '@/services/articlesApiBase';
import type { CantonArticleSection } from '@/services/articleSections';
import {
  cantonSectionConfig,
  isCantonArticleSection,
  loadCantonSectionRegistry,
} from '@/services/runtimeArticleSections';

const LOCALES: readonly Locale[] = ['it', 'en', 'de', 'fr'];
const TIMEOUT_MS = 6000;

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
  if (value.sourceUrl !== undefined && !safeHref(value.sourceUrl)) return null;
  if (value.sourceUrl) fact.sourceUrl = value.sourceUrl;
  return fact;
}

function readDataItem(value: unknown): CantonHubDataItem | null {
  if (!isRecord(value) || !nonEmptyString(value.label)) return null;
  const item: CantonHubDataItem = { label: value.label };
  for (const field of ['value', 'detail'] as const) {
    const content = optionalString(value[field]);
    if (content) item[field] = content;
  }
  if (value.date !== undefined && !validDate(value.date)) return null;
  if (value.date) item.date = value.date;
  if (value.url !== undefined && !safeHref(value.url)) return null;
  if (value.url) item.url = value.url;
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
  if (value.sourceUrl !== undefined && !safeHref(value.sourceUrl)) return null;
  if (value.sourceUrl) block.sourceUrl = value.sourceUrl;
  if (value.updatedAt !== undefined && !validDate(value.updatedAt)) return null;
  if (value.updatedAt) block.updatedAt = value.updatedAt;
  return block;
}

function readCuratedArticle(value: unknown): CantonHubArticle | null {
  if (!isRecord(value) || !nonEmptyString(value.title) || !safeHref(value.url)) return null;
  const article: CantonHubArticle = { title: value.title, url: value.url };
  const excerpt = optionalString(value.excerpt);
  if (excerpt) article.excerpt = excerpt;
  if (value.date !== undefined && !validDate(value.date)) return null;
  if (value.date) article.date = value.date;
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
    || !Array.isArray(value.links)) return null;

  const keyFacts = value.keyFacts.map(readKeyFact);
  const dataBlocks = value.dataBlocks.map(readDataBlock);
  const curatedArticles = value.curatedArticles.map(readCuratedArticle);
  const links = value.links.map(readHubLink);
  if ([...keyFacts, ...dataBlocks, ...curatedArticles, ...links].some((item) => item === null)) return null;
  return {
    canton: value.canton as string,
    topic,
    locale,
    intro: value.intro,
    keyFacts: keyFacts as CantonHubKeyFact[],
    dataBlocks: dataBlocks as CantonHubDataBlock[],
    curatedArticles: curatedArticles as CantonHubArticle[],
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

async function fetchHubPayload(): Promise<HubPayload | null> {
  const registry = await loadCantonSectionRegistry();
  if (!registry) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${articlesApiBase()}/canton-hubs.json?commit=${encodeURIComponent(registry.commit)}`;
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as HubPayload;
    if (payload?.schema !== 1 || payload.commit !== registry.commit || !isRecord(payload.sections)) return null;
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let hubPayloadPromise: Promise<HubPayload | null> | null = null;

/** Fetch one locale of one live canton hub from the versioned corpus payload. */
export async function loadCantonTopicHub(
  section: CantonArticleSection,
  topic: string,
  locale: Locale,
): Promise<CantonTopicHubData | null> {
  if (!isCantonArticleSection(section) || !LOCALES.includes(locale)) return null;
  const config = cantonSectionConfig(section);
  if (!config?.topicHubs || !Object.prototype.hasOwnProperty.call(config.topicHubs, topic)) return null;
  const registry = await loadCantonSectionRegistry();
  if (!registry?.sections[section] || registry.sections[section].status !== 'live') return null;
  if (!hubPayloadPromise) hubPayloadPromise = fetchHubPayload();
  const payload = await hubPayloadPromise;
  if (!payload || !isRecord(payload.sections)) return null;
  const sectionPayload = payload.sections[section];
  if (!isRecord(sectionPayload)) return null;
  return readPayloadDocument(sectionPayload[topic], section, topic, locale);
}

export function __resetRuntimeCantonTopicHubs(): void {
  hubPayloadPromise = null;
}
