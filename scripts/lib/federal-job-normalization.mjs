function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const FEDERAL_LOCATION_QUALIFIER_RE =
  /,\s*(?:lehrbeginn|lehrstart|debut de l['’]apprentissage|début de l['’]apprentissage|inizio(?: dell['’]apprendistato)?|inizio formazione|start date|entry date|eintritt(?: per)?|ab august|ab september|ab oktober|ab november|ab dezember|ab januar|ab februar|ab marz|ab märz|ab april|ab mai|ab juni|ab juli)\b[\s\S]*$/i;

const FEDERAL_COMPANY_PLACEHOLDER_RE =
  /\b(?:eidgen[oö]ssisches departement|departement federal|département fédéral|dipartimento federale)\b/i;

function normalizeFederalLocationDisplay(raw = '') {
  const clean = normalizeSpace(raw)
    .replace(FEDERAL_LOCATION_QUALIFIER_RE, '')
    .replace(/,\s*schweiz$/i, '')
    .replace(/\s*[;|]\s*schweiz$/i, '')
    .trim();
  return clean;
}

function extractFederalLocality(displayLocation = '') {
  const withoutPostal = normalizeSpace(displayLocation).replace(/^\d{4}\s+/, '');
  return withoutPostal.replace(/\s*\(([A-Z]{2})\)\s*$/i, '').trim();
}

function inferFederalCanton(displayLocation = '', fallback = '') {
  const match = normalizeSpace(displayLocation).match(/\(([A-Z]{2})\)\s*$/i);
  return (match?.[1] || fallback || '').toUpperCase();
}

export function isFederalJobsPortalUrl(rawUrl = '') {
  try {
    const host = new URL(String(rawUrl || '')).hostname.toLowerCase();
    return host === 'jobs.admin.ch' || host.endsWith('.admin.ch');
  } catch {
    return false;
  }
}

export function normalizeFederalJobLocation(rawLocation = '', fallbackCanton = '') {
  const location = normalizeFederalLocationDisplay(rawLocation);
  const addressLocality = extractFederalLocality(location);
  const canton = inferFederalCanton(location, fallbackCanton);

  return {
    location,
    addressLocality,
    canton,
  };
}

export function normalizeFederalDepartmentCompany(rawCompany = '', fallbackCompany = '') {
  const company = normalizeSpace(rawCompany);
  if (!company) return normalizeSpace(fallbackCompany);
  if (FEDERAL_COMPANY_PLACEHOLDER_RE.test(company)) return normalizeSpace(fallbackCompany || company);
  return company;
}
