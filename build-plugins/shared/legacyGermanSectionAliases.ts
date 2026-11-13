import cantonSlugFile from '../../data/canton-url-slugs.json';
import { resolveCantonSection } from './cantonSection';

// German job-board sections used the broad jobs-im prefix before the
// vocabulary was corrected. Keep this table shared by compatibility routing,
// legacy-page protection, and expired-page emission.
export const LEGACY_GERMAN_SECTION_ALIASES: ReadonlyMap<string, string> = (() => {
 const aliases = new Map<string, string>();
 const cantons = (cantonSlugFile as {
  cantons: Record<string, { de?: string }>;
 }).cantons || {};
 for (const cantonCode of Object.keys(cantons)) {
  const legacySlug = cantons[cantonCode]?.de;
  if (!legacySlug) continue;
  const legacySection = 'jobs-im-' + legacySlug;
  const canonicalSection = resolveCantonSection('de', cantonCode);
  if (legacySection !== canonicalSection) aliases.set(legacySection, canonicalSection);
 }
 return aliases;
})();

export interface LegacyGermanSectionPath {
 legacySection: string;
 canonicalSection: string;
 canonicalPath: string;
}

/** Resolve a path below an old non-TI German section to its current section. */
export function resolveLegacyGermanSectionPath(inputPath: string): LegacyGermanSectionPath | null {
 const pathname = String(inputPath || '').trim().split(/[?#]/, 1)[0];
 const normalized = '/' + pathname.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
 const segments = normalized.split('/').filter(Boolean);
 if (segments[0]?.toLowerCase() !== 'de') return null;
 const legacySection = String(segments[1] || '').toLowerCase();
 const canonicalSection = LEGACY_GERMAN_SECTION_ALIASES.get(legacySection);
 if (!canonicalSection) return null;
 const suffix = segments.slice(2);
 const canonicalPath = '/' + ['de', canonicalSection, ...suffix].join('/') + '/';
 return { legacySection, canonicalSection, canonicalPath };
}
