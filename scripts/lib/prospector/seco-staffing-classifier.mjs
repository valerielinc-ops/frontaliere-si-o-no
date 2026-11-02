import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';

/**
 * The checked-in registry is deliberately curated, not a claim that it is the
 * complete SECO register.  A non-match is therefore a residual `direct`
 * classification, and the result keeps its confidence/reason so reports do
 * not present that residual as an independently verified legal status.
 */
export const STAFFING_CLASSIFIER_VERSION = 1;
export const STAFFING_REGISTRY_RELATIVE_PATH = 'seco-staffing-registry.json';
export const STAFFING_REGISTRY_PATH = path.join(DATA_ROOT, STAFFING_REGISTRY_RELATIVE_PATH);

const LEGAL_FORM_TOKENS = new Set([
  'ag', 'gmbh', 'inc', 'llc', 'ltd', 'sa', 'sagl', 'sarl', 'sasu', 'spa', 'srl',
  'limited', 'societa', 'societe', 'company', 'co', 'cie',
]);
const GEOGRAPHY_TOKENS = new Set([
  'ch', 'schweiz', 'swiss', 'switzerland', 'suisse', 'svizzera', 'ticino',
]);

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function meaningfulTokens(value) {
  return tokenize(value).filter((token) => !LEGAL_FORM_TOKENS.has(token) && !GEOGRAPHY_TOKENS.has(token));
}

function compactTokens(value) {
  return meaningfulTokens(value).join(' ');
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

/**
 * Build aliases from the registry row, while retaining an explicit `aliases`
 * field if the registry grows one later.  The first meaningful token is the
 * important brand bridge: `Adecco Resources SA` must match SECO's `Adecco`.
 */
export function staffingAgencyAliases(agency = {}) {
  const rawName = String(agency?.name || '').trim();
  const tokens = meaningfulTokens(rawName);
  const explicit = Array.isArray(agency?.aliases) ? agency.aliases : [];
  const prefixes = [];
  for (let length = tokens.length; length >= 1; length -= 1) {
    prefixes.push(tokens.slice(0, length).join(' '));
  }
  return unique([
    compactTokens(rawName),
    ...prefixes,
    ...explicit.map(compactTokens),
  ]).filter((alias) => alias.length >= 3);
}

function normalizedRegistry(document, registryPath) {
  if (!document || !Array.isArray(document.agencies)) {
    return {
      available: false,
      malformed: true,
      path: registryPath,
      agencies: [],
      fetchedAt: null,
      curated: false,
    };
  }
  return {
    available: true,
    malformed: false,
    path: registryPath,
    agencies: document.agencies
      .filter((agency) => agency && typeof agency === 'object' && String(agency.name || '').trim())
      .map((agency) => ({
        ...agency,
        aliases: staffingAgencyAliases(agency),
      })),
    fetchedAt: document.fetchedAt || null,
    curated: document.curated === true,
    source: document.source || null,
    sourceLabel: document.sourceLabel || null,
  };
}

/**
 * Read the registry's actual shape (`{ agencies: [...] }`). A missing file is
 * an unknown classification, never permission to call every employer direct.
 */
export function loadStaffingRegistry(registryPath = STAFFING_REGISTRY_PATH) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      available: false,
      malformed: false,
      path: registryPath,
      agencies: [],
      fetchedAt: null,
      curated: false,
      missing: true,
    };
  }
  return normalizedRegistry(document, registryPath);
}

function aliasMatchesEmployer(alias, employerTokens) {
  const aliasTokens = alias.split(' ').filter(Boolean);
  if (!aliasTokens.length || aliasTokens.length > employerTokens.length) return false;
  for (let start = 0; start <= employerTokens.length - aliasTokens.length; start += 1) {
    if (aliasTokens.every((token, index) => employerTokens[start + index] === token)) return true;
  }
  return false;
}

/**
 * Classify one SECO employer name against a normalized registry.
 *
 * @param {string} employerName
 * @param {ReturnType<typeof loadStaffingRegistry>} [registry]
 */
export function classifyStaffingEmployer(employerName, registry = loadStaffingRegistry()) {
  const name = String(employerName || '').trim();
  const employerTokens = meaningfulTokens(name);
  const base = {
    classifierVersion: STAFFING_CLASSIFIER_VERSION,
    employerName: name,
    registryPath: registry?.path || STAFFING_REGISTRY_PATH,
    registryAvailable: registry?.available === true,
    registryCurated: registry?.curated === true,
  };
  if (!employerTokens.length) {
    return { ...base, classification: 'unknown', confidence: 'missing-employer-name', reason: 'missing-employer-name' };
  }
  if (!registry?.available) {
    return {
      ...base,
      classification: 'unknown',
      confidence: registry?.malformed ? 'malformed-registry' : 'registry-unavailable',
      reason: registry?.missing ? 'registry-missing' : 'registry-unavailable',
    };
  }

  for (const agency of registry.agencies) {
    const matchedAlias = agency.aliases.find((alias) => aliasMatchesEmployer(alias, employerTokens));
    if (!matchedAlias) continue;
    return {
      ...base,
      classification: 'agency',
      confidence: 'registry-alias',
      reason: 'matched-registry-agency',
      matchedAgency: agency.name,
      matchedAlias,
      agencyType: agency.type || null,
    };
  }

  return {
    ...base,
    classification: 'direct',
    confidence: registry.curated ? 'curated-registry-residual' : 'registry-residual',
    reason: 'not-matched-in-staffing-registry',
    matchedAgency: null,
    matchedAlias: null,
    agencyType: null,
  };
}
