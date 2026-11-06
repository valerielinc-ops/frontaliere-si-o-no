import { inferAnyCanton, isKnownSwissMunicipality, normalizeCantonCode } from './target-swiss-locations.mjs';
import { resolveSwissLocalityCanton } from './swiss-locality-directory.mjs';

export { resolveSwissLocalityCanton };

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
  const withoutPostal = normalizeSpace(displayLocation)
    .replace(/^\d{4}(?:\s+|-(?=\p{L}))(?=\p{L})/u, '');
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

// A leading apprenticeship qualifier ("Lehrbeginn August 2027, Thun"); the
// trailing form is already handled by FEDERAL_LOCATION_QUALIFIER_RE.
const FEDERAL_LEADING_QUALIFIER_RE =
  /^(?:lehrbeginn|lehrstart|d[ée]but de l['’]apprentissage|inizio(?: dell['’]apprendistato)?|inizio formazione|start date|entry date|eintritt(?: per)?)\b[^,]*,\s*/i;
// The free-text `arbeitsort` names more than one place ("Payerne und
// Meiringen", "Bern & Zimmerwald", "Emmen<br/>Emmen") or appends notes
// ("Dübendorf - Im Pikettfall …", "Bern (und Homeoffice)").
const FEDERAL_LOCALITY_SEPARATOR_RE = /\s*(?:[/&;,(]|\s[-–]\s|\s(?:und|oder|et|ou)\s)\s*/i;
// Values that name no Swiss workplace at all.
const FEDERAL_NON_LOCALITY_RE =
  /^(?:ausland|abroad|estero|[ée]tranger|schweiz|suisse|svizzera|switzerland|weltweit|international|kosovo)\b/i;

function titleCaseIfShouting(value) {
  if (value !== value.toUpperCase() || value === value.toLowerCase()) return value;
  return value.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

/**
 * The vacancy's own workplace locality from the federal portal's free-text
 * `arbeitsort` attribute, or '' when it names no Swiss place.
 *
 * The jobs.admin.ch JSON-LD `jobLocation` carries the administrative unit's
 * address (for the armed forces: Bern, 174/184 VTG jobs on 2026-09-29), not
 * the workplace — "Verantwortliche/-r Ausbildungsanlagen" states "Arbeitsort:
 * Places d'armes, 1436 Chamblon" on the page and was published in Bern, and
 * the same apprenticeship offered in Hinwil and Bronschhofen collapsed into
 * two identical "Bern" listings. Seed metadata with this value as
 * `workplaceLocation` makes the shared engine publish the workplace.
 */
export function resolveFederalWorkplaceLocality(rawLocation = '', { isPlaced = null } = {}) {
  const decoded = String(rawLocation || '')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
  const display = normalizeFederalLocationDisplay(normalizeSpace(decoded))
    .replace(FEDERAL_LEADING_QUALIFIER_RE, '');
  const segments = display.split(FEDERAL_LOCALITY_SEPARATOR_RE);
  // A posting abroad ("Pristina, Kosovo") names a foreign city first; only a
  // place we can place in Switzerland survives next to a foreign marker
  // ("Stans-Oberdorf / Kosovo" is the Swiss base of a KFOR role).
  const mentionsAbroad = segments.some((part) => FEDERAL_NON_LOCALITY_RE.test(normalizeSpace(part)));
  for (const segment of segments) {
    const trimmed = normalizeSpace(segment).replace(/\)+$/, '');
    const candidate = trimmed
      .replace(/^\d{4}(?:\s+|-(?=\p{L}))/u, '')
      .replace(/\s+[A-Z]{2}$/, '')
      .trim();
    if (!candidate) continue;
    if (FEDERAL_NON_LOCALITY_RE.test(candidate)) return '';
    // Street lines ("Stauffacherstrasse 65") and other non-place fragments.
    if (!/^\p{L}[\p{L}'’. -]{1,60}$/u.test(candidate)) continue;
    const locality = titleCaseIfShouting(candidate);
    // The first segment is not always the place: "Places d'armes, 1436
    // Chamblon" opens with the kind of site. A candidate is the workplace
    // only when it is a Swiss locality — a known municipality, a place we can
    // put in a canton, or one the source itself pins with a canton marker
    // ("Grolley (FR)", "Zimmerwald BE", former municipalities missing from
    // the BFS list). Anything else is skipped for the next segment. A caller
    // that knows more about the posting (the region cantons the portal lists
    // next to it) may place a locality through `isPlaced`.
    const placedInSwitzerland = isKnownSwissMunicipality(locality)
      || Boolean(inferAnyCanton(locality))
      || Boolean(typeof isPlaced === 'function' && isPlaced(locality));
    if (placedInSwitzerland) return locality;
    if (mentionsAbroad) continue;
    if (federalCantonMarkerAfter(display, trimmed, candidate)) return locality;
  }
  return '';
}

/**
 * The explicit canton marker the source writes next to a locality: "Zimmerwald
 * BE" (same segment) or "Grolley (FR)" (the parenthesis is split off as the
 * next segment, so it is read from the display text right after the name).
 */
function federalCantonMarkerAfter(display, segment, candidate) {
  const sameSegment = segment.match(/\s([A-Z]{2})$/)?.[1];
  if (sameSegment && normalizeCantonCode(sameSegment)) return normalizeCantonCode(sameSegment);
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const following = display.match(new RegExp(`${escaped}\\s*\\(\\s*([A-Z]{2})\\s*\\)`, 'u'))?.[1];
  return following ? normalizeCantonCode(following) : '';
}

/**
 * Cantons a federal `region` facet names: "Ostschweiz (AI, AR, GL, GR, SG,
 * SH, TG)", "Tessin (TI)"; a posting may carry several regions. The first
 * code of a group is not the posting's canton — the group only bounds it.
 */
export function federalRegionCantons(regions = []) {
  const cantons = new Set();
  for (const region of [].concat(regions || [])) {
    for (const group of String(region || '').matchAll(/\(([^)]*)\)/g)) {
      for (const code of group[1].split(/[\s,;/]+/)) {
        if (/^[A-Z]{2}$/.test(code) && normalizeCantonCode(code)) cantons.add(normalizeCantonCode(code));
      }
    }
  }
  return cantons;
}

// Label of the workplace fact jobs.admin.ch prints under the title, per page
// language ("Arbeitsort: Amp-Strasse 12, 9552 Bronschhofen").
const FEDERAL_WORKPLACE_FACT_LABEL_RE =
  /^(?:arbeitsort|arbeitsorte|lieu de travail|lieux de travail|luogo di lavoro|luoghi di lavoro|place of work|workplace|work location)$/i;

/** Value of the workplace fact among the page's key facts, or ''. */
export function federalWorkplaceFactValue(facts = []) {
  const fact = (Array.isArray(facts) ? facts : [])
    .find((item) => FEDERAL_WORKPLACE_FACT_LABEL_RE.test(normalizeSpace(item?.label).replace(/:$/, '')));
  return fact ? normalizeSpace(fact.value) : '';
}

/**
 * Street line, CAP and locality of a federal workplace address: "Amp-Strasse
 * 12, 9552 Bronschhofen", "Places d'armes, 1436 Chamblon", "Schwäbis, 3602
 * Thun", "3003 Bern". The last segment holding a Swiss CAP and a locality is
 * the locality; what precedes it is the address line (a street or the site's
 * name). Null without a CAP — a free-text place is not an address.
 */
export function parseFederalWorkplaceAddress(value = '') {
  const text = normalizeSpace(String(value || '')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' '));
  if (!text) return null;
  const segments = text.split(/\s*,\s*/).filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const match = segments[index].match(/^(?:CH-)?(\d{4})\s+(\p{L}[\p{L}'’. /-]*?)(?:\s*\(([A-Z]{2})\)|\s+([A-Z]{2}))?$/u);
    if (!match) continue;
    return {
      streetAddress: segments.slice(0, index).join(', '),
      postalCode: match[1],
      addressLocality: normalizeSpace(match[2]),
      cantonMarker: normalizeCantonCode(match[3] || match[4] || ''),
    };
  }
  return null;
}

/**
 * The workplace address of a federal posting with its canton, or null when
 * the value is no address or its locality cannot be placed in one canton
 * (within `cantons` when given). A canton marker the source writes wins.
 */
export function resolveFederalWorkplaceAddress(value = '', { cantons = null } = {}) {
  const parsed = parseFederalWorkplaceAddress(value);
  if (!parsed) return null;
  const allowed = cantons && [...cantons].length > 0 ? new Set(cantons) : null;
  const canton = parsed.cantonMarker
    ? (!allowed || allowed.has(parsed.cantonMarker) ? parsed.cantonMarker : '')
    : resolveSwissLocalityCanton(parsed.addressLocality, { postalCode: parsed.postalCode, cantons: allowed });
  if (!canton) return null;
  const { cantonMarker, ...address } = parsed;
  return { ...address, canton };
}
