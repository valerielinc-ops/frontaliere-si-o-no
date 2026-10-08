/** Runtime catalog for corpus-owned canton article sections.
 *
 * The generated core describes the closed 24-section URL family. It is not an
 * activation list: D22 makes the edge registry published by the corpus the
 * only source of live state. A failed registry read returns no canton links,
 * which is safer than advertising a section whose corpus page may be 404.
 */

import type { Locale } from './i18n';
import type { CantonArticleSection } from './articleSections';
import { CANTON_ARTICLE_SECTION_CORE } from '../packages/articles/engine/shared/cantonArticleSectionCore.generated.mjs';
import {
  cantonDisplayName,
  cantonSectionLabel,
} from '../packages/articles/engine/shared/cantonSectionCopy.mjs';

export const CANTON_SECTION_REGISTRY_URL = 'https://cdn.frontaliereticino.ch/edge/sections/registry.json';

const TIMEOUT_MS = 4000;

export interface RuntimeCantonArticleSection {
  section: CantonArticleSection;
  canton: string;
  indexSlug: Record<Locale, string>;
  label: string;
  displayName: string;
}

interface RegistrySection {
  status?: unknown;
}

interface RegistryPayload {
  sections?: Record<string, RegistrySection>;
}

let liveSectionsPromise: Promise<RuntimeCantonArticleSection[]> | null = null;
let liveSectionIds = new Set<string>();

export function isCantonArticleSection(section: string): section is CantonArticleSection {
  return section.startsWith('canton-')
    && Object.prototype.hasOwnProperty.call(CANTON_ARTICLE_SECTION_CORE, section);
}

export function cantonSectionConfig(section: CantonArticleSection) {
  if (!isCantonArticleSection(section)) return null;
  return CANTON_ARTICLE_SECTION_CORE[section];
}

function runtimeSection(section: CantonArticleSection, locale: Locale): RuntimeCantonArticleSection | null {
  const entry = cantonSectionConfig(section);
  if (!entry) return null;
  return {
    section,
    canton: entry.canton,
    indexSlug: entry.indexSlug,
    label: cantonSectionLabel(section, locale),
    displayName: cantonDisplayName(section, locale),
  };
}

async function fetchLiveRegistry(): Promise<RuntimeCantonArticleSection[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(CANTON_SECTION_REGISTRY_URL, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return [];
    const payload = await response.json() as RegistryPayload;
    if (!payload || typeof payload.sections !== 'object' || payload.sections === null) return [];
    const live = Object.keys(CANTON_ARTICLE_SECTION_CORE)
      .filter((section): section is CantonArticleSection => payload.sections?.[section]?.status === 'live')
      .map((section) => runtimeSection(section, 'it'))
      .filter((entry): entry is RuntimeCantonArticleSection => entry !== null);
    liveSectionIds = new Set(live.map((entry) => entry.section));
    return live;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Live canton sections, cached for the lifetime of the SPA page. */
export function loadLiveCantonArticleSections(): Promise<RuntimeCantonArticleSection[]> {
  if (!liveSectionsPromise) liveSectionsPromise = fetchLiveRegistry();
  return liveSectionsPromise;
}

/** Synchronous route-parser seam for links discovered from the live registry. */
export function isLiveCantonArticleSectionCached(section: string): boolean {
  return liveSectionIds.has(section);
}

/** Localize the registry result without another network request. */
export function localizeCantonArticleSections(
  sections: readonly RuntimeCantonArticleSection[],
  locale: Locale,
): RuntimeCantonArticleSection[] {
  return sections.map((entry) => ({
    ...entry,
    label: cantonSectionLabel(entry.section, locale),
    displayName: cantonDisplayName(entry.section, locale),
  }));
}

/** Test seam: the next consumer re-reads the edge registry. */
export function __resetRuntimeArticleSections(): void {
  liveSectionsPromise = null;
  liveSectionIds = new Set();
}
