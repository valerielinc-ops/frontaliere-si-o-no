function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeIdentityUrl(value = '') {
  const raw = normalizeSpace(value);
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
      parsed.port = '';
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/g, '') || '/';
    return parsed.toString().toLowerCase();
  } catch {
    return raw.replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeLocaleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (Array.isArray(inner)) {
      out[key] = inner.map((item) => normalizeSpace(item)).filter(Boolean);
    } else {
      out[key] = normalizeSpace(inner);
    }
  }
  return out;
}

function identityFallback(job = {}) {
  return stableStringify({
    title: normalizeSpace(job.title || ''),
    company: normalizeSpace(job.company || ''),
    location: normalizeSpace(job.location || ''),
  });
}

export function buildStableJobIdentity(job = {}) {
  const rawUrl = normalizeIdentityUrl(job.url || '');
  if (rawUrl) return `url:${rawUrl}`;

  const rawId = normalizeSpace(job.id || job.externalId || job.jobId || '');
  if (rawId) return `id:${rawId.toLowerCase()}`;

  const rawSlug = normalizeSpace(job.slug || job.slugByLocale?.it || '');
  if (rawSlug) return `slug:${rawSlug.toLowerCase()}`;

  return `fallback:${identityFallback(job)}`;
}

export function comparableJobShape(job = {}) {
  return {
    title: normalizeSpace(job.title || ''),
    company: normalizeSpace(job.company || ''),
    companyKey: normalizeSpace(job.companyKey || ''),
    location: normalizeSpace(job.location || ''),
    canton: normalizeSpace(job.canton || ''),
    url: normalizeSpace(job.url || ''),
    applyUrl: normalizeSpace(job.applyUrl || ''),
    slug: normalizeSpace(job.slug || ''),
    description: normalizeSpace(job.description || ''),
    requirements: safeArray(job.requirements).map((item) => normalizeSpace(item)).filter(Boolean),
    postedDate: normalizeSpace(job.postedDate || ''),
    contract: normalizeSpace(job.contract || ''),
    category: normalizeSpace(job.category || ''),
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    titleByLocale: normalizeLocaleMap(job.titleByLocale),
    descriptionByLocale: normalizeLocaleMap(job.descriptionByLocale),
    requirementsByLocale: normalizeLocaleMap(job.requirementsByLocale),
    slugByLocale: normalizeLocaleMap(job.slugByLocale),
  };
}

export function jobsDiffer(previousJob = {}, currentJob = {}) {
  return stableStringify(comparableJobShape(previousJob)) !== stableStringify(comparableJobShape(currentJob));
}
