/**
 * Presentation metadata for assisted-application email cards.
 *
 * New orders persist these fields at checkout. Older pending orders predate
 * that projection, so the recovery digest can fill the same fields from the
 * public job-detail dataset and the stable CDN logo paths without touching the
 * order itself.
 */

const JOB_DETAIL_BASE = 'https://cdn.frontaliereticino.ch/data/job-detail';
const LOGO_BASE = 'https://cdn.frontaliereticino.ch';
const JOB_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const COMPANY_KEY_RE = /^[a-z0-9][a-z0-9-]{0,119}$/i;
const LOGO_PATHS = [
  '/images/brands/{key}.svg',
  '/images/brands/{key}.png',
  '/images/brands/{key}.jpg',
  '/images/brands/{key}.jpeg',
  '/images/brands/{key}.webp',
  '/images/logos/{key}.svg',
  '/images/logos/{key}.png',
  '/images/logos/{key}.jpg',
];
const FETCH_TIMEOUT_MS = 4000;

const logoLookupCache = new Map();

function timeoutSignal() {
  try {
    return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
  } catch {
    return undefined;
  }
}

function safeCompanyKey(order) {
  const value = String(order?.companyKey || order?.companyId || '').trim();
  return COMPANY_KEY_RE.test(value) ? value.toLowerCase() : '';
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1_000_000_000 ? number : null;
}

function boundedText(value, max) {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim();
  return result && result.length <= max ? result : '';
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizedBaseSalary(value) {
  if (!value || typeof value !== 'object') return null;
  const rawValue = value.value && typeof value.value === 'object' ? value.value : value;
  const minValue = finitePositiveNumber(rawValue.minValue);
  const maxValue = finitePositiveNumber(rawValue.maxValue);
  if (!minValue && !maxValue) return null;
  const result = { value: {} };
  if (minValue) result.value.minValue = minValue;
  if (maxValue) result.value.maxValue = maxValue;
  const unitText = boundedText(rawValue.unitText, 20);
  const currency = boundedText(value.currency || rawValue.currency, 5).toUpperCase();
  if (unitText) result.value.unitText = unitText;
  if (currency) result.currency = currency;
  return result;
}

async function fetchJobDetail(order, fetchImpl) {
  const jobId = String(order?.jobId || '').trim();
  if (!JOB_ID_RE.test(jobId)) return null;
  try {
    const response = await fetchImpl(`${JOB_DETAIL_BASE}/${encodeURIComponent(jobId)}.json`, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(),
    });
    if (!response?.ok) return null;
    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function resolveCompanyLogo(order, fetchImpl) {
  const key = safeCompanyKey(order);
  if (!key) return '';
  if (!logoLookupCache.has(key)) {
    const lookup = (async () => {
      const candidates = LOGO_PATHS.map((path) => `${LOGO_BASE}${path.replace('{key}', encodeURIComponent(key))}`);
      const available = await Promise.all(candidates.map(async (url) => {
        try {
          const response = await fetchImpl(url, { method: 'HEAD', signal: timeoutSignal() });
          return Boolean(response?.ok);
        } catch {
          return false;
        }
      }));
      return candidates[available.findIndex(Boolean)] || '';
    })();
    logoLookupCache.set(key, lookup);
  }
  return logoLookupCache.get(key);
}

function detailSalaryFields(detail) {
  const baseSalary = normalizedBaseSalary(detail?.baseSalary);
  const min = finitePositiveNumber(detail?.salaryMin) || finitePositiveNumber(baseSalary?.value?.minValue);
  const max = finitePositiveNumber(detail?.salaryMax) || finitePositiveNumber(baseSalary?.value?.maxValue);
  return { baseSalary, min, max };
}

/** Enrich one order without writing anything back to Firestore. */
export async function enrichAssistedApplicationOrder(order, { fetchImpl = fetch } = {}) {
  if (!order || typeof order !== 'object') return order;
  const needsDetail = !order.location || !order.canton || !order.contract
    || !order.baseSalary || !order.salaryMin || !order.salaryMax
    || !order.salaryCurrency || !order.postedDate || !order.firstSeenAt;
  const needsLogo = !isHttpsUrl(order.companyLogo);
  if (!needsDetail && !needsLogo) return order;

  const [detail, logoUrl] = await Promise.all([
    needsDetail ? fetchJobDetail(order, fetchImpl) : null,
    needsLogo ? resolveCompanyLogo(order, fetchImpl) : '',
  ]);
  if (!detail && !logoUrl) return order;

  const enriched = { ...order };
  if (logoUrl && !isHttpsUrl(enriched.companyLogo)) enriched.companyLogo = logoUrl;
  const location = boundedText(detail?.addressLocality || detail?.location, 200);
  const canton = boundedText(detail?.addressRegion || detail?.canton, 80);
  if (!enriched.companyKey && safeCompanyKey(order)) enriched.companyKey = safeCompanyKey(order);
  if (!enriched.location && location) enriched.location = location;
  if (!enriched.canton && canton) enriched.canton = canton;
  if (!enriched.contract && detail?.employmentType) enriched.contract = boundedText(detail.employmentType, 80);

  const salary = detailSalaryFields(detail);
  if (!enriched.baseSalary && salary.baseSalary) enriched.baseSalary = salary.baseSalary;
  if (!enriched.salaryMin && salary.min) enriched.salaryMin = salary.min;
  if (!enriched.salaryMax && salary.max) enriched.salaryMax = salary.max;
  if (!enriched.salaryCurrency && salary.baseSalary?.currency) enriched.salaryCurrency = salary.baseSalary.currency;
  if (!enriched.postedDate && detail?.postedDate) enriched.postedDate = boundedText(detail.postedDate, 40);
  if (!enriched.firstSeenAt && detail?.firstSeenAt) enriched.firstSeenAt = boundedText(detail.firstSeenAt, 40);
  if (!enriched.sector && detail?.sector) enriched.sector = boundedText(detail.sector, 100);
  return enriched;
}

export async function enrichAssistedApplicationOrders(orders, options = {}) {
  const list = Array.isArray(orders) ? orders : [];
  return Promise.all(list.map((order) => enrichAssistedApplicationOrder(order, options)));
}
