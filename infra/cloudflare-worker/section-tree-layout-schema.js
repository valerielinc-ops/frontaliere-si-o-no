// Runtime-neutral schema shared by the Worker and the publisher.
import { SECTION_TREE_FANOUT_SECTIONS } from './ticino-tree-bucket.js';

export const SECTION_TREE_LAYOUT_REGISTRY_KEY = 'edge/section-tree-layout.json';
export const SECTION_TREE_LAYOUT_CDN_BASE = 'https://cdn.frontaliereticino.ch';
export const SECTION_TREE_LAYOUT_REGISTRY_URL = new URL(
  SECTION_TREE_LAYOUT_REGISTRY_KEY,
  `${SECTION_TREE_LAYOUT_CDN_BASE}/`,
).toString();
const SECTION_NAME_RE = /^[a-z][a-z0-9-]*$/u;
const LOCALES = new Set(['it', 'en', 'de', 'fr']);

export function emptySectionTreeLayoutRegistry() {
  return { version: 1, sections: {} };
}

export function parseSectionTreeLayoutRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !value.sections || typeof value.sections !== 'object'
    || Array.isArray(value.sections)) {
    throw new Error('invalid section tree layout registry envelope');
  }

  const sections = {};
  for (const [section, entry] of Object.entries(value.sections)) {
    const timestamp = typeof entry?.since === 'string' ? Date.parse(entry.since) : Number.NaN;
    if (!SECTION_NAME_RE.test(section) || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || entry.layout !== 'hash-v1' || typeof entry.since !== 'string'
      || Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== entry.since
      || !entry.reason || typeof entry.reason !== 'object'
      || Array.isArray(entry.reason) || !LOCALES.has(entry.reason.locale)
      || typeof entry.reason.pct !== 'number' || !Number.isFinite(entry.reason.pct) || entry.reason.pct < 0) {
      throw new Error(`invalid section tree layout entry: ${section}`);
    }
    sections[section] = {
      layout: 'hash-v1',
      since: entry.since,
      reason: { locale: entry.reason.locale, pct: entry.reason.pct },
    };
  }

  return { version: 1, sections };
}

export function sectionTreeLayoutSections(registry) {
  return [...new Set([
    ...SECTION_TREE_FANOUT_SECTIONS,
    ...Object.keys(parseSectionTreeLayoutRegistry(registry).sections),
  ])].sort();
}
