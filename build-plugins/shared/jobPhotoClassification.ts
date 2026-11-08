import { getJobOgPhotoKey } from './jobOgImageCatalog.mjs';

export const JOB_PHOTO_KEYS = ['healthcare', 'hospitality', 'trades', 'office'] as const;
export type JobFallbackPhotoKey = (typeof JOB_PHOTO_KEYS)[number];

type JobPhotoClassificationInput = {
  category?: string;
  sector?: string;
  title?: string;
  titleByLocale?: Record<string, string | undefined>;
};

const JOB_PHOTO_KEYWORDS: Record<JobFallbackPhotoKey, string[]> = {
  healthcare: [
    'health', 'sanit', 'inferm', 'medic', 'farmac', 'pharma', 'biotech',
    'osped', 'clinica', 'assistenz', 'cura', 'pflege', 'soins', 'sante',
    'nursing', 'nurse', 'arzt',
  ],
  hospitality: [
    'hotel', 'hospitality', 'albergo', 'ristor', 'restaurant', 'camerier',
    'cuoc', 'chef', 'cucina', 'barista', 'housekeep', 'reception', 'turism',
    'catering', 'gastronom', 'servicefach', 'restauration', 'hoteller',
  ],
  trades: [
    'tecnic', 'elettric', 'idraulic', 'meccanic', 'ingegner', 'engineer',
    'manutenz', 'montator', 'saldat', 'produzion', 'magazzin', 'operator',
    'logistic', 'liefer', 'lager', 'werkstatt', 'bau', 'construction',
    'instandhalt', 'automation', 'technicien', 'atelier', 'installator',
    'technical', 'tech', 'manufacturing', 'industr', 'agricol', 'farm',
    'edil', 'cantiere', 'costruzion', 'building', 'architett',
  ],
  office: [
    'office', 'admin', 'amministr', 'administr', 'contab', 'segreter',
    'commercial', 'marketing', 'sales', 'vendit', 'commerc', 'retail',
    'dettaglio', 'back-office', 'risorse umane', 'human resources', 'hr',
    'analyst', 'finanz', 'finance', 'assicuraz', 'insurance', 'account',
    'legal', 'bureau', 'impiegat', 'assistant', 'education', 'formazione',
    'it',
  ],
};
const NEW_CONSTRUCTION_KEYWORDS = new Set([
  'edil', 'cantiere', 'costruzion', 'building', 'architett',
]);

// These words occur in many titles without identifying the visual role. For
// example, "operatore socio-sanitario" and "assistente di cura" are
// healthcare roles, while "cura del verde" is a trade. Let the employer
// sector/category break those ties instead of changing the cache key for a
// large set of otherwise stable cards.
const AMBIGUOUS_TITLE_KEYWORDS = new Set(['operator', 'assistant', 'cura']);
const JOB_TITLE_PHOTO_KEYWORDS: Record<JobFallbackPhotoKey, string[]> = Object.fromEntries(
  JOB_PHOTO_KEYS.map((key) => [
    key,
    JOB_PHOTO_KEYWORDS[key].filter((keyword) => !AMBIGUOUS_TITLE_KEYWORDS.has(keyword)),
  ]),
) as Record<JobFallbackPhotoKey, string[]>;
const LEGACY_JOB_PHOTO_KEYWORDS: Record<JobFallbackPhotoKey, string[]> = {
  ...JOB_PHOTO_KEYWORDS,
  trades: JOB_PHOTO_KEYWORDS.trades.filter((keyword) => !NEW_CONSTRUCTION_KEYWORDS.has(keyword)),
};

function normalizePhotoSearchText(...values: Array<string | undefined>): string {
  return values
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('it')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function findJobPhotoKey(
  searchText: string,
  keywordsByKey = JOB_PHOTO_KEYWORDS,
): JobFallbackPhotoKey | null {
  const searchTerms = new Set(searchText.split(/[^a-z0-9]+/).filter(Boolean));
  return JOB_PHOTO_KEYS.find((key) => keywordsByKey[key].some((keyword) => {
    if (keyword.length <= 3) return searchTerms.has(keyword);
    return searchText.includes(keyword);
  })) ?? null;
}

function classifyJobPhotoWithKeywords(
  job: JobPhotoClassificationInput,
  titleKeywordsByKey: Record<JobFallbackPhotoKey, string[]>,
  metadataKeywordsByKey: Record<JobFallbackPhotoKey, string[]>,
): JobFallbackPhotoKey {
  const italianRolePhotoKey = findJobPhotoKey(
    normalizePhotoSearchText(job.titleByLocale?.it),
    titleKeywordsByKey,
  );
  if (italianRolePhotoKey) return italianRolePhotoKey;

  const sourceRolePhotoKey = findJobPhotoKey(
    normalizePhotoSearchText(job.title),
    titleKeywordsByKey,
  );
  if (sourceRolePhotoKey) return sourceRolePhotoKey;

  const sectorText = normalizePhotoSearchText(job.category, job.sector);
  return findJobPhotoKey(sectorText, metadataKeywordsByKey) ?? 'office';
}

/** Prefer occupational words in the title; employer-sector metadata is only a fallback. */
export function classifyJobPhoto(job: JobPhotoClassificationInput): JobFallbackPhotoKey {
  return classifyJobPhotoWithKeywords(job, JOB_TITLE_PHOTO_KEYWORDS, JOB_PHOTO_KEYWORDS);
}

/** Select the rendered photo and only change fallback image URLs when classification changes. */
export function selectJobOgPhoto(job: JobPhotoClassificationInput, slug: string) {
  const catalogPhotoKey = getJobOgPhotoKey(slug);
  const photoKey = catalogPhotoKey ?? classifyJobPhoto(job);
  if (catalogPhotoKey) return { photoKey, urlPhotoKey: catalogPhotoKey };

  const previousPhotoKey = classifyJobPhotoWithKeywords(
    job,
    JOB_TITLE_PHOTO_KEYWORDS,
    LEGACY_JOB_PHOTO_KEYWORDS,
  );
  return {
    photoKey,
    urlPhotoKey: photoKey === previousPhotoKey ? undefined : photoKey,
  };
}
