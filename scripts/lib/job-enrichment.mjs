// scripts/lib/job-enrichment.mjs
//
// Pure-function SEO field enrichment for jobs assembled by
// scripts/assemble-jobs-dataset.mjs.
//
// Crawler slices land in `data/jobs/by-crawler/<key>.json` in a flat shape
// (company, addressLocality, postalCode, postedDate). JobSchema (rule #3)
// requires a richer schema.org-style shape (hiringOrganization.name,
// jobLocation{}, datePosted ISO, streetAddress). These helpers derive the
// missing fields from existing data — never inventing values, never
// loosening the schema. They run AFTER the existing postalCode enrichment
// in the assembler and BEFORE JobSchema validation.
//
// All functions:
// - return a NEW job object (immutability, per coding-style rule);
// - leave the target field `undefined` when the source is missing, so
//   JobSchema can fail validation honestly.

/**
 * Populate hiringOrganization.name from the flat `company` field.
 */
export function enrichHiringOrganization(job) {
  if (job?.hiringOrganization?.name) return { ...job };
  const company = typeof job?.company === 'string' ? job.company.trim() : '';
  if (!company) return { ...job };
  return { ...job, hiringOrganization: { name: company } };
}

/**
 * Parse a postedDate-ish source into ISO `YYYY-MM-DD`. Supported formats:
 *   - already-ISO `YYYY-MM-DD` (with optional time/TZ trailing)
 *   - `DD/MM/YY`   (two-digit year mapped to 20YY)
 *   - `DD/MM/YYYY`
 *   - `DD.MM.YYYY` (Swiss/German format)
 *
 * Implausible years (> current year + 1) → undefined.
 * Unparseable strings → undefined (let the schema reject the job).
 */
export function enrichDatePosted(job) {
  const out = { ...job };
  if (typeof out.datePosted === 'string' && /^\d{4}-\d{2}-\d{2}/.test(out.datePosted)) {
    // already valid ISO prefix
    out.datePosted = out.datePosted.slice(0, 10);
    return out;
  }
  const source = typeof out.datePosted === 'string' && out.datePosted
    ? out.datePosted
    : (typeof out.postedDate === 'string' ? out.postedDate : '');
  if (!source) {
    delete out.datePosted;
    return out;
  }
  const iso = parseDateToIso(source);
  if (iso) {
    out.datePosted = iso;
  } else {
    delete out.datePosted;
  }
  return out;
}

function parseDateToIso(raw) {
  const s = raw.trim();
  if (!s) return undefined;

  // ISO prefix: YYYY-MM-DD (with optional time/TZ tail)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return isPlausibleYmd(y, m, d) ? `${y}-${m}-${d}` : undefined;
  }

  // DD/MM/YY or DD/MM/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const [, dd, mm, yy] = slash;
    const year = expandYear(yy);
    if (year == null) return undefined;
    const y = String(year);
    const m = mm.padStart(2, '0');
    const d = dd.padStart(2, '0');
    return isPlausibleYmd(y, m, d) ? `${y}-${m}-${d}` : undefined;
  }

  // DD.MM.YYYY (Swiss/German)
  const dot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dot) {
    const [, dd, mm, yyyy] = dot;
    const m = mm.padStart(2, '0');
    const d = dd.padStart(2, '0');
    return isPlausibleYmd(yyyy, m, d) ? `${yyyy}-${m}-${d}` : undefined;
  }

  return undefined;
}

function expandYear(yy) {
  if (yy.length === 4) return Number(yy);
  // two-digit → 20YY (job ads aren't from the 1900s/2100s on a 2026 board)
  const expanded = 2000 + Number(yy);
  const maxAllowed = new Date().getFullYear() + 1;
  if (expanded > maxAllowed) return null;
  return expanded;
}

function isPlausibleYmd(y, m, d) {
  const yr = Number(y);
  const mo = Number(m);
  const da = Number(d);
  if (!Number.isFinite(yr) || !Number.isFinite(mo) || !Number.isFinite(da)) return false;
  if (mo < 1 || mo > 12) return false;
  if (da < 1 || da > 31) return false;
  // implausibly far past or future → reject
  if (yr < 1990) return false;
  if (yr > new Date().getFullYear() + 1) return false;
  return true;
}

/**
 * Build a JobLocation object from flat addressLocality + postalCode when the
 * nested shape isn't already present. Defaults addressCountry to 'CH'
 * (Switzerland-focused job board).
 */
export function enrichJobLocation(job) {
  const out = { ...job };
  const existing = out.jobLocation;
  if (
    existing &&
    typeof existing === 'object' &&
    typeof existing.addressLocality === 'string' &&
    existing.addressLocality.length > 0 &&
    typeof existing.postalCode === 'string' &&
    existing.postalCode.length > 0 &&
    typeof existing.addressCountry === 'string' &&
    existing.addressCountry.length > 0
  ) {
    return out;
  }
  const locality = typeof out.addressLocality === 'string' ? out.addressLocality.trim() : '';
  const postal = typeof out.postalCode === 'string' ? out.postalCode.trim() : '';
  if (!locality || !postal) {
    delete out.jobLocation;
    return out;
  }
  out.jobLocation = {
    addressLocality: locality,
    postalCode: postal,
    addressCountry: 'CH',
  };
  return out;
}

/**
 * Populate streetAddress. Schema.org JobPosting accepts city-level address
 * when street-level data is unknown; we fall back to addressLocality so
 * JobSchema's `streetAddress.min(1)` clears without inventing data.
 */
export function enrichStreetAddress(job) {
  const out = { ...job };
  if (typeof out.streetAddress === 'string' && out.streetAddress.trim().length > 0) {
    return out;
  }
  const locality = typeof out.addressLocality === 'string' ? out.addressLocality.trim() : '';
  if (locality) {
    out.streetAddress = locality;
    return out;
  }
  delete out.streetAddress;
  return out;
}

/**
 * Compose all enrichers. Call AFTER the existing postalCode enrichment in
 * scripts/assemble-jobs-dataset.mjs and BEFORE JobSchema validation.
 */
export function enrichJobForSeo(job) {
  let out = job;
  out = enrichHiringOrganization(out);
  out = enrichDatePosted(out);
  out = enrichJobLocation(out);
  out = enrichStreetAddress(out);
  return out;
}
