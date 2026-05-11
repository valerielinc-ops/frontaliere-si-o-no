import cantonSlugFile from '../../data/canton-url-slugs.json';
import municipalitiesFile from '../../data/canton-municipalities.json';

export type CantonLocale = 'it' | 'en' | 'de' | 'fr';
export const AGGREGATE_KEY = '_AGGREGATE_';

const SECTION_LEGACY_TI: Record<CantonLocale, string> = {
  it: 'cerca-lavoro-ticino',
  en: 'find-jobs-ticino',
  de: 'jobs-im-tessin',
  fr: 'trouver-emploi-tessin',
};

const SECTION_PREFIX_BY_LOCALE: Record<CantonLocale, string> = {
  it: 'cerca-lavoro', en: 'find-jobs', de: 'jobs-in', fr: 'trouver-emploi',
};

type CantonSlugEntry = { it: string; en: string; de: string; fr: string; dePrefix?: string };
const cantons: Record<string, CantonSlugEntry> = cantonSlugFile.cantons as Record<string, CantonSlugEntry>;
const cantonGroups: Record<string, { members: string[] }> = (cantonSlugFile.cantonGroups ?? {}) as Record<string, { members: string[] }>;
const aggregateSlugs: Record<CantonLocale, string> = cantonSlugFile.aggregate as Record<CantonLocale, string>;

const memberToGroup: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [group, info] of Object.entries(cantonGroups)) {
    for (const member of info.members) out[member] = group;
  }
  return out;
})();

export function resolveCantonGroup(cantonCode: string): string {
  const code = String(cantonCode || '').toUpperCase().trim();
  if (!code) return 'TI';
  return memberToGroup[code] ?? code;
}

function getCantonUrlSlug(code: string, locale: CantonLocale): string {
  if (code === AGGREGATE_KEY) return aggregateSlugs[locale] ?? aggregateSlugs.it;
  const entry = cantons[code];
  return entry?.[locale] ?? aggregateSlugs[locale] ?? aggregateSlugs.it;
}

export function resolveCantonSection(locale: CantonLocale, cantonCode: string): string {
  const raw = String(cantonCode || '').toUpperCase();
  if (!raw || raw === 'TI') return SECTION_LEGACY_TI[locale];
  if (raw === AGGREGATE_KEY) {
    return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(AGGREGATE_KEY, locale)}`;
  }
  const code = resolveCantonGroup(raw);
  if (locale === 'de') {
    const entry = cantons[code];
    if (entry?.dePrefix) return `${entry.dePrefix}${entry.de}`;
  }
  return `${SECTION_PREFIX_BY_LOCALE[locale]}-${getCantonUrlSlug(code, locale)}`;
}

const CITY_TO_CANTON: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const cantonsData = (municipalitiesFile as { cantons: Record<string, { municipalities: string[] }> }).cantons;
  for (const [canton, info] of Object.entries(cantonsData)) {
    for (const city of info.municipalities) {
      out[city.toLowerCase().split(' (')[0].trim()] = canton;
    }
  }
  return out;
})();

export function resolveJobCanton(job: { canton?: string; location?: string }): string {
  const explicit = String(job.canton || '').toUpperCase().trim();
  if (explicit && (cantons[explicit] || memberToGroup[explicit])) {
    return resolveCantonGroup(explicit);
  }
  const city = String(job.location || '').toLowerCase().split(/[,(]/)[0].trim();
  if (city && CITY_TO_CANTON[city]) return resolveCantonGroup(CITY_TO_CANTON[city]);
  return 'TI';
}

export const ALL_CANTON_CODES: readonly string[] = Object.freeze(Object.keys(cantons).sort());
