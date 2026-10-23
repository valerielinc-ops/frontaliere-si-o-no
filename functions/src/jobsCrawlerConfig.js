const DEFAULT_JOBS_CRAWLER_CONFIG = {
  domainWhitelist: [],
  domainBlacklist: [],
  minQualityScore: 4,
  minDescriptionChars: 80,
  aiLocalizationEnabled: true,
  aiLocalizationMaxJobsPerRun: 500,
  contentReuse: {
    enabled: true,
    similarityThreshold: 0.7,
    minSourceChars: 220,
    maxLengthDeltaRatio: 0.02,
  },
  companyPriority: {
    byDomain: {
      'vfc.com': 10,
      'swatchgroup.com': 8,
      'cler.ch': 8,
      'ubs.com': 7,
      'avaloq.com': 7,
      'nozominetworks.com': 6,
      'schindler.com': 6,
    },
    byName: {
      'vf international (the north face, timberland)': 10,
      'swatch group assembly': 8,
      'banca cler': 8,
      'ubs': 7,
      'avaloq': 7,
      'nozomi networks': 6,
      'schindler': 6,
    },
  },
  sourceSeeds: {
    byDomain: {
      'vfc.com': [
        'https://vfc.wd5.myworkdayjobs.com/vfc_careers?Location_Country=187134fccb084a0ea9b4b95f23890dbe',
      ],
      'swatchgroup.com': ['https://www.swatchgroup.com/en/job-finder'],
      'ubs.com': [
        'https://www.ubs.com/global/en/careers/search-jobs.html',
        'https://www.ubs.com/global/en/careers.html',
      ],
      'schindler.com': [
        'https://job.schindler.com',
        'https://www.schindler.com/com/internet/en/careers.html',
      ],
      'avaloq.com': ['https://www.avaloq.com/careers'],
      'nozominetworks.com': ['https://www.nozominetworks.com/company/careers/'],
      'medacta.com': ['https://www.medacta.com/EN/careers'],
      'mediamarkt.ch': [
        'https://careers.mediamarktsaturn.com/MediaMarktCH/?locale=de_CH&currentPage=1&pageSize=100&addresses%2Fcountry=CHE&orderBy=datePosted&isDesc=true',
      ],
      'cler.ch': [
        'https://www.cler.ch/it/banca-cler/jobs-und-karriere/cercare-candidatura/offene-stellen',
      ],
      'protectas.com': ['https://www.protectas.com/it-ch/carriere/offerte-di-lavoro/'],
      'zaugg.swiss': ['https://www.zaugg.swiss/stellen'],
    },
    byName: {},
  },
};

export const JOBS_CRAWLER_CONFIG_DEFAULTS = Object.freeze(DEFAULT_JOBS_CRAWLER_CONFIG);

export function normalizeHost(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';

  try {
    const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./, '');
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readArray(value, fallback, field, strict) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    if (strict) throw new Error(`invalid_${field}`);
    return fallback;
  }
  return value;
}

function readBoolean(value, fallback, field, strict) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    if (strict) throw new Error(`invalid_${field}`);
    return fallback;
  }
  return value;
}

function readNumber(value, fallback, field, min, max, strict) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    if (strict) throw new Error(`invalid_${field}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function readInteger(value, fallback, field, min, max, strict) {
  return Math.floor(readNumber(value, fallback, field, min, max, strict));
}

function normalizeDomainList(value, fallback, field, strict) {
  const values = readArray(value, fallback, field, strict);
  const normalized = [];
  for (const item of values) {
    const host = normalizeHost(item);
    if (!host) {
      if (strict && String(item ?? '').trim()) throw new Error(`invalid_${field}`);
      continue;
    }
    if (!normalized.includes(host)) normalized.push(host);
  }
  return normalized;
}

function normalizeNumberMap(value, fallback, field, strict) {
  if (value === undefined) return { ...fallback };
  if (!isPlainObject(value)) {
    if (strict) throw new Error(`invalid_${field}`);
    return { ...fallback };
  }

  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const trimmedKey = String(key).trim();
    const numeric = Number(rawValue);
    if (!trimmedKey || !Number.isFinite(numeric)) {
      if (strict) throw new Error(`invalid_${field}`);
      continue;
    }
    result[trimmedKey] = numeric;
  }
  return result;
}

export function normalizeSeedMap(value, fallback = {}, field = 'sourceSeeds', strict = false) {
  if (value === undefined) return { ...fallback };
  if (!isPlainObject(value)) {
    if (strict) throw new Error(`invalid_${field}`);
    return { ...fallback };
  }

  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeHost(key) || String(key).trim().toLowerCase();
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const seeds = [];
    for (const item of values) {
      const seed = String(item ?? '').trim();
      if (!seed) continue;
      if (!/^https?:\/\//i.test(seed)) {
        if (strict) throw new Error(`invalid_${field}`);
        continue;
      }
      if (!seeds.includes(seed)) seeds.push(seed);
    }
    if (normalizedKey && seeds.length) result[normalizedKey] = seeds;
  }
  return result;
}

export function normalizeJobsCrawlerConfig(raw, { strict = false } = {}) {
  const input = isPlainObject(raw) ? raw : {};
  if (strict && raw !== undefined && !isPlainObject(raw)) throw new Error('invalid_config');

  if (strict && input.contentReuse !== undefined && !isPlainObject(input.contentReuse)) {
    throw new Error('invalid_contentReuse');
  }
  if (strict && input.companyPriority !== undefined && !isPlainObject(input.companyPriority)) {
    throw new Error('invalid_companyPriority');
  }
  if (strict && input.sourceSeeds !== undefined && !isPlainObject(input.sourceSeeds)) {
    throw new Error('invalid_sourceSeeds');
  }
  const contentReuse = isPlainObject(input.contentReuse) ? input.contentReuse : {};
  const companyPriority = isPlainObject(input.companyPriority) ? input.companyPriority : {};
  const sourceSeeds = isPlainObject(input.sourceSeeds) ? input.sourceSeeds : {};

  return {
    domainWhitelist: normalizeDomainList(
      input.domainWhitelist,
      JOBS_CRAWLER_CONFIG_DEFAULTS.domainWhitelist,
      'domainWhitelist',
      strict,
    ),
    domainBlacklist: normalizeDomainList(
      input.domainBlacklist,
      JOBS_CRAWLER_CONFIG_DEFAULTS.domainBlacklist,
      'domainBlacklist',
      strict,
    ),
    minQualityScore: readInteger(
      input.minQualityScore,
      JOBS_CRAWLER_CONFIG_DEFAULTS.minQualityScore,
      'minQualityScore',
      4,
      10,
      strict,
    ),
    minDescriptionChars: readInteger(
      input.minDescriptionChars,
      JOBS_CRAWLER_CONFIG_DEFAULTS.minDescriptionChars,
      'minDescriptionChars',
      80,
      1200,
      strict,
    ),
    aiLocalizationEnabled: readBoolean(
      input.aiLocalizationEnabled,
      JOBS_CRAWLER_CONFIG_DEFAULTS.aiLocalizationEnabled,
      'aiLocalizationEnabled',
      strict,
    ),
    aiLocalizationMaxJobsPerRun: readInteger(
      input.aiLocalizationMaxJobsPerRun,
      JOBS_CRAWLER_CONFIG_DEFAULTS.aiLocalizationMaxJobsPerRun,
      'aiLocalizationMaxJobsPerRun',
      0,
      500,
      strict,
    ),
    contentReuse: {
      enabled: readBoolean(
        contentReuse.enabled,
        JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.enabled,
        'contentReuse.enabled',
        strict,
      ),
      similarityThreshold: readNumber(
        contentReuse.similarityThreshold,
        JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.similarityThreshold,
        'contentReuse.similarityThreshold',
        0.7,
        1,
        strict,
      ),
      minSourceChars: readInteger(
        contentReuse.minSourceChars,
        JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.minSourceChars,
        'contentReuse.minSourceChars',
        120,
        8000,
        strict,
      ),
      maxLengthDeltaRatio: readNumber(
        contentReuse.maxLengthDeltaRatio,
        JOBS_CRAWLER_CONFIG_DEFAULTS.contentReuse.maxLengthDeltaRatio,
        'contentReuse.maxLengthDeltaRatio',
        0.02,
        1,
        strict,
      ),
    },
    companyPriority: {
      byDomain: normalizeNumberMap(
        input.companyPriorityByDomain ?? companyPriority.byDomain,
        JOBS_CRAWLER_CONFIG_DEFAULTS.companyPriority.byDomain,
        'companyPriorityByDomain',
        strict,
      ),
      byName: normalizeNumberMap(
        input.companyPriorityByName ?? companyPriority.byName,
        JOBS_CRAWLER_CONFIG_DEFAULTS.companyPriority.byName,
        'companyPriorityByName',
        strict,
      ),
    },
    sourceSeeds: {
      byDomain: normalizeSeedMap(
        input.sourceSeedsByDomain ?? sourceSeeds.byDomain,
        JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byDomain,
        'sourceSeedsByDomain',
        strict,
      ),
      byName: normalizeSeedMap(
        input.sourceSeedsByName ?? sourceSeeds.byName,
        JOBS_CRAWLER_CONFIG_DEFAULTS.sourceSeeds.byName,
        'sourceSeedsByName',
        strict,
      ),
    },
  };
}
