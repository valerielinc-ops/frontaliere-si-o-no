#!/usr/bin/env node

/**
 * Validate JSON artifacts immediately before a workflow commits them.
 *
 * This command is deliberately read-only: it parses the selected file and
 * checks the writer's public shape, but never rewrites the artifact and never
 * loads credentials. It is the final guard for workflows whose next step is a
 * data commit.
 */

import fs from 'node:fs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const URL_RE = /^https?:\/\//i;
const MODES = new Set(['workday', 'teaser_api', 'generic_ats', 'html', 'jsonld']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value) {
  return value === null || isFiniteNumber(value);
}

function isIso(value) {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isDate(value) {
  return typeof value === 'string' && DATE_RE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function isUrl(value) {
  if (typeof value !== 'string' || !URL_RE.test(value)) return false;
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateHistoryEnvelope(value, errors, label) {
  if (!isObject(value)) {
    add(errors, '$', `${label} deve essere un oggetto`);
    return false;
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    add(errors, 'entries', `${label} deve contenere almeno una voce`);
  } else if (value.entries.length > 104) {
    add(errors, 'entries', `${label} supera il limite di 104 voci`);
  }
  if (!isIso(value.updatedAt)) add(errors, 'updatedAt', 'timestamp ISO non valido');
  return true;
}

function validateOrderedDates(entries, errors) {
  const seen = new Set();
  let previous = '';
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const path = `entries[${index}]`;
    if (!isObject(entry)) {
      add(errors, path, 'voce non valida');
      continue;
    }
    if (!isDate(entry.date)) {
      add(errors, `${path}.date`, 'data YYYY-MM-DD non valida');
      continue;
    }
    if (seen.has(entry.date)) add(errors, `${path}.date`, 'data duplicata');
    if (previous && entry.date < previous) add(errors, `${path}.date`, 'date non ordinate');
    seen.add(entry.date);
    previous = entry.date;
  }
}

function validateEvergreen(value) {
  const errors = [];
  if (!validateHistoryEnvelope(value, errors, 'history evergreen')) return errors;
  validateOrderedDates(value.entries, errors);
  for (const [index, entry] of value.entries.entries()) {
    if (!Array.isArray(entry?.sections) || entry.sections.length === 0) {
      add(errors, `entries[${index}].sections`, 'sezioni mancanti');
      continue;
    }
    const sectionNames = new Set();
    for (const [sectionIndex, section] of entry.sections.entries()) {
      const path = `entries[${index}].sections[${sectionIndex}]`;
      if (!isObject(section) || typeof section.section !== 'string' || !section.section.trim()) {
        add(errors, path, 'sezione senza nome');
        continue;
      }
      if (sectionNames.has(section.section)) add(errors, `${path}.section`, 'sezione duplicata');
      sectionNames.add(section.section);
      for (const field of ['poolTotal', 'poolRemaining', 'poolConsumedPct']) {
        if (!isNullableNumber(section[field])) add(errors, `${path}.${field}`, 'numero o null richiesto');
      }
      if (section.poolTotal != null && section.poolTotal < 0) add(errors, `${path}.poolTotal`, 'non può essere negativo');
      if (section.poolRemaining != null && section.poolRemaining < 0) add(errors, `${path}.poolRemaining`, 'non può essere negativo');
      if (section.poolTotal != null && section.poolRemaining != null && section.poolRemaining > section.poolTotal) {
        add(errors, `${path}.poolRemaining`, 'non può superare poolTotal');
      }
      if (section.poolConsumedPct != null && (section.poolConsumedPct < 0 || section.poolConsumedPct > 100)) {
        add(errors, `${path}.poolConsumedPct`, 'deve stare tra 0 e 100');
      }
    }
  }
  return errors;
}

function validateFunnel(value) {
  const errors = [];
  if (!validateHistoryEnvelope(value, errors, 'history funnel')) return errors;
  validateOrderedDates(value.entries, errors);
  const today = new Date().toISOString().slice(0, 10);
  for (const [index, entry] of value.entries.entries()) {
    const path = `entries[${index}]`;
    // Older entries predate the currency-aware shape. The writer replaces the
    // entry for today's UTC date, so only that entry must expose the current
    // fields; historical rows remain backward-compatible and are still
    // checked wherever a field exists.
    const current = entry?.date === today;
    if (!isIso(entry?.generatedAt)) add(errors, `${path}.generatedAt`, 'timestamp ISO non valido');
    for (const field of ['errors', 'warnings']) {
      if (!Array.isArray(entry?.[field])) add(errors, `${path}.${field}`, 'array richiesto');
    }
    if (!isObject(entry?.sourcesOk)) {
      add(errors, `${path}.sourcesOk`, 'oggetto richiesto');
    } else {
      for (const field of ['cls', 'gsc', 'adsense']) {
        if (typeof entry.sourcesOk[field] !== 'boolean') add(errors, `${path}.sourcesOk.${field}`, 'boolean richiesto');
      }
    }
    for (const field of ['cls', 'gsc', 'adsense']) {
      if (entry?.[field] !== null && entry?.[field] !== undefined && !isObject(entry[field])) {
        add(errors, `${path}.${field}`, 'oggetto o null richiesto');
      }
    }
    if (isObject(entry?.cls)) {
      for (const field of ['p75Mobile', 'p75Desktop']) {
        if ((current || Object.hasOwn(entry.cls, field)) && !isNullableNumber(entry.cls[field])) {
          add(errors, `${path}.cls.${field}`, 'numero o null richiesto');
        }
      }
    }
    if (isObject(entry?.gsc)) {
      for (const field of ['avgPosition', 'clicksPerDay']) {
        if ((current || Object.hasOwn(entry.gsc, field)) && !isNullableNumber(entry.gsc[field])) {
          add(errors, `${path}.gsc.${field}`, 'numero o null richiesto');
        }
      }
      if (entry.gsc.ctrByBucket !== null && entry.gsc.ctrByBucket !== undefined && !isObject(entry.gsc.ctrByBucket)) {
        add(errors, `${path}.gsc.ctrByBucket`, 'oggetto o null richiesto');
      }
    }
    if (isObject(entry?.adsense)) {
      if (current && (typeof entry.adsense.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(entry.adsense.currencyCode))) {
        add(errors, `${path}.adsense.currencyCode`, 'codice valuta ISO a tre lettere richiesto');
      }
      for (const field of ['rpm', 'desktopRpm', 'revenuePerDay', 'rpmCHF', 'desktopRpmCHF', 'revenuePerDayCHF']) {
        if ((current || Object.hasOwn(entry.adsense, field)) && !isNullableNumber(entry.adsense[field])) {
          add(errors, `${path}.adsense.${field}`, 'numero o null richiesto');
        }
      }
    }
  }
  return errors;
}

function validateParserProposals(value) {
  const errors = [];
  if (!isObject(value) || !Array.isArray(value.proposals) || value.proposals.length === 0) {
    add(errors, '$', 'proposals deve contenere un array non vuoto');
    return errors;
  }
  if (!isIso(value.generatedAt)) add(errors, 'generatedAt', 'timestamp ISO non valido');
  if (value.proposals.length > 500) add(errors, 'proposals', 'supera il limite di 500 voci');
  const keys = new Set();
  for (const [index, proposal] of value.proposals.entries()) {
    const path = `proposals[${index}]`;
    if (!isObject(proposal)) {
      add(errors, path, 'voce non valida');
      continue;
    }
    for (const field of ['companyKey', 'companyName', 'companyWebsite', 'companyHost', 'notes']) {
      if (typeof proposal[field] !== 'string') add(errors, `${path}.${field}`, 'stringa richiesta');
    }
    if (typeof proposal.companyKey === 'string') {
      if (!proposal.companyKey.trim()) add(errors, `${path}.companyKey`, 'non può essere vuoto');
      if (keys.has(proposal.companyKey)) add(errors, `${path}.companyKey`, 'chiave duplicata');
      keys.add(proposal.companyKey);
    }
    if (typeof proposal.companyWebsite === 'string' && !isUrl(proposal.companyWebsite)) add(errors, `${path}.companyWebsite`, 'URL http(s) non valido');
    if (typeof proposal.companyHost === 'string' && !proposal.companyHost.trim()) add(errors, `${path}.companyHost`, 'non può essere vuoto');
    for (const field of ['sourceSeedsByDomain', 'sourceSeedsByName', 'crawlerMode']) {
      if (!Array.isArray(proposal[field])) add(errors, `${path}.${field}`, 'array richiesto');
    }
    for (const field of ['sourceSeedsByDomain', 'sourceSeedsByName']) {
      if (Array.isArray(proposal[field])) {
        if (proposal[field].length > 8) add(errors, `${path}.${field}`, 'supera il limite di 8 URL');
        proposal[field].forEach((url, urlIndex) => {
          if (!isUrl(url)) add(errors, `${path}.${field}[${urlIndex}]`, 'URL http(s) non valido');
        });
      }
    }
    if (Array.isArray(proposal.crawlerMode)) {
      for (const [modeIndex, mode] of proposal.crawlerMode.entries()) {
        if (!MODES.has(mode)) add(errors, `${path}.crawlerMode[${modeIndex}]`, `modalità non ammessa: ${String(mode)}`);
      }
    }
    if (proposal.confidence !== null && proposal.confidence !== undefined
      && (!isFiniteNumber(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)) {
      add(errors, `${path}.confidence`, 'numero tra 0 e 1 o null richiesto');
    }
    if (typeof proposal.applied !== 'boolean') add(errors, `${path}.applied`, 'boolean richiesto');
    if (proposal.appliedAt !== null && proposal.appliedAt !== undefined && !isIso(proposal.appliedAt)) {
      add(errors, `${path}.appliedAt`, 'timestamp ISO o null richiesto');
    }
  }
  return errors;
}

function validateUnemployment(value) {
  const errors = [];
  if (!isObject(value)) {
    add(errors, '$', 'dataset disoccupazione deve essere un oggetto');
    return errors;
  }
  if (!isFiniteNumber(value.rate) || value.rate < 0 || value.rate > 15) add(errors, 'rate', 'numero tra 0 e 15 richiesto');
  if (value.unit !== 'percent') add(errors, 'unit', 'deve essere percent');
  if (!PERIOD_RE.test(String(value.period || ''))) add(errors, 'period', 'periodo YYYY-MM non valido');
  if (!Array.isArray(value.history) || value.history.length === 0) {
    add(errors, 'history', 'array non vuoto richiesto');
  } else {
    if (value.history.length > 120) add(errors, 'history', 'supera il limite di 120 voci');
    let previous = '';
    const seen = new Set();
    for (const [index, row] of value.history.entries()) {
      const path = `history[${index}]`;
      if (!isObject(row) || !PERIOD_RE.test(String(row?.period || '')) || !isFiniteNumber(row?.rate) || row.rate < 0 || row.rate > 15) {
        add(errors, path, 'period e rate plausibili richiesti');
        continue;
      }
      if (seen.has(row.period)) add(errors, `${path}.period`, 'periodo duplicato');
      if (previous && row.period < previous) add(errors, `${path}.period`, 'history non ordinata');
      previous = row.period;
      seen.add(row.period);
    }
    const last = value.history.at(-1);
    if (last && (last.period !== value.period || Number(last.rate) !== Number(value.rate))) {
      add(errors, 'history', 'ultima voce non coincide con rate/period correnti');
    }
  }
  if (typeof value.sourceName !== 'string' || !value.sourceName.trim()) add(errors, 'sourceName', 'stringa non vuota richiesta');
  if (!isUrl(value.sourceUrl)) add(errors, 'sourceUrl', 'URL http(s) non valido');
  if (value.releaseUrl !== '' && value.releaseUrl !== null && value.releaseUrl !== undefined && !isUrl(value.releaseUrl)) {
    add(errors, 'releaseUrl', 'URL http(s), stringa vuota o null richiesto');
  }
  if (!isObject(value.seoText)) {
    add(errors, 'seoText', 'oggetto richiesto');
  } else {
    for (const locale of ['it', 'en', 'de', 'fr']) {
      if (typeof value.seoText[locale] !== 'string' || !value.seoText[locale].trim()) add(errors, `seoText.${locale}`, 'testo non vuoto richiesto');
    }
  }
  if (!isIso(value.fetchedAt)) add(errors, 'fetchedAt', 'timestamp ISO non valido');
  return errors;
}

function validateRate(value, path, errors) {
  if (!isFiniteNumber(value) || value < 0 || value > 100) {
    add(errors, path, 'percentuale numerica tra 0 e 100 richiesta');
  }
}

// The writers persist percentages rounded to four decimal places. Keep the
// tolerance explicit so a baseline cannot claim a clean scan while storing a
// rate unrelated to its offender/scanned counts.
const RATE_ROUNDING_TOLERANCE_PCT = 0.0001;

function validateDerivedRate(value, path, offenders, scanned, errors) {
  validateRate(value, path, errors);
  if (!isFiniteNumber(value)
    || !Number.isInteger(offenders)
    || !Number.isInteger(scanned)
    || offenders < 0
    || scanned < 0
    || offenders > scanned) return;

  const expected = scanned > 0 ? (offenders / scanned) * 100 : 0;
  if (Math.abs(value - expected) > RATE_ROUNDING_TOLERANCE_PCT) {
    add(errors, path, `deve coincidere con ${offenders}/${scanned} (${expected.toFixed(4)}%)`);
  }
}

function validateRateTolerance(value, errors) {
  if (!isObject(value)) {
    add(errors, 'tolerance', 'oggetto richiesto');
    return;
  }
  for (const field of ['relPct', 'absPp', 'minAbsDelta', 'maxDeltaPp']) {
    if (!isFiniteNumber(value[field]) || value[field] < 0) {
      add(errors, `tolerance.${field}`, 'numero non negativo richiesto');
    }
  }
}

function validateRateAggregate(value, errors) {
  if (!Number.isInteger(value.scanned) || value.scanned < 0) {
    add(errors, 'scanned', 'intero non negativo richiesto');
  }
  if (!Number.isInteger(value.totalOffenders) || value.totalOffenders < 0) {
    add(errors, 'totalOffenders', 'intero non negativo richiesto');
  } else if (Number.isInteger(value.scanned) && value.totalOffenders > value.scanned) {
    add(errors, 'totalOffenders', 'non può superare scanned');
  }
  validateDerivedRate(value.totalRatePct, 'totalRatePct', value.totalOffenders, value.scanned, errors);
}

function validateRateBuckets(value, errors) {
  if (!isObject(value.byFeature) || Object.keys(value.byFeature).length === 0) {
    add(errors, 'byFeature', 'oggetto non vuoto richiesto');
  } else {
    for (const [feature, bucket] of Object.entries(value.byFeature)) {
      const base = `byFeature.${feature}`;
      if (!isObject(bucket)) {
        add(errors, base, 'oggetto richiesto');
        continue;
      }
      if (!Number.isInteger(bucket.scanned) || bucket.scanned < 0) add(errors, `${base}.scanned`, 'intero non negativo richiesto');
      if (!Number.isInteger(bucket.offenders) || bucket.offenders < 0) {
        add(errors, `${base}.offenders`, 'intero non negativo richiesto');
      } else if (Number.isInteger(bucket.scanned) && bucket.offenders > bucket.scanned) {
        add(errors, `${base}.offenders`, 'non può superare scanned');
      }
      validateDerivedRate(bucket.ratePct, `${base}.ratePct`, bucket.offenders, bucket.scanned, errors);
    }
  }
  if (value.byLocale !== undefined) {
    if (!isObject(value.byLocale)) {
      add(errors, 'byLocale', 'oggetto richiesto');
    } else {
      for (const [locale, count] of Object.entries(value.byLocale)) {
        if (!Number.isInteger(count) || count < 0) add(errors, `byLocale.${locale}`, 'intero non negativo richiesto');
      }
    }
  }
}

function validateBfsSitemaps(value, errors) {
  if (!isObject(value.perSitemap) || Object.keys(value.perSitemap).length === 0) {
    add(errors, 'perSitemap', 'oggetto non vuoto richiesto');
    return;
  }
  for (const [sitemap, entry] of Object.entries(value.perSitemap)) {
    const base = `perSitemap.${sitemap}`;
    if (!isObject(entry)) {
      add(errors, base, 'oggetto richiesto');
      continue;
    }
    for (const field of ['total', 'reached', 'atDepthGtMax', 'deepest']) {
      if (!Number.isInteger(entry[field]) || entry[field] < 0) add(errors, `${base}.${field}`, 'intero non negativo richiesto');
    }
    if (Number.isInteger(entry.total) && Number.isInteger(entry.reached) && entry.reached > entry.total) {
      add(errors, `${base}.reached`, 'non può superare total');
    }
    if (Number.isInteger(entry.total) && Number.isInteger(entry.atDepthGtMax) && entry.atDepthGtMax > entry.total) {
      add(errors, `${base}.atDepthGtMax`, 'non può superare total');
    }
    validateDerivedRate(entry.ratePct, `${base}.ratePct`, entry.atDepthGtMax, entry.total, errors);
  }
}

function validateOrphanSitemaps(value, errors) {
  if (!isObject(value.perSitemap) || Object.keys(value.perSitemap).length === 0) {
    add(errors, 'perSitemap', 'oggetto non vuoto richiesto');
    return;
  }
  for (const [sitemap, entry] of Object.entries(value.perSitemap)) {
    const base = `perSitemap.${sitemap}`;
    if (!isObject(entry)) {
      add(errors, base, 'oggetto richiesto');
      continue;
    }
    if (!Number.isInteger(entry.total) || entry.total < 0) add(errors, `${base}.total`, 'intero non negativo richiesto');
    if (!Number.isInteger(entry.orphans) || entry.orphans < 0) {
      add(errors, `${base}.orphans`, 'intero non negativo richiesto');
    } else if (Number.isInteger(entry.total) && entry.orphans > entry.total) {
      add(errors, `${base}.orphans`, 'non può superare total');
    }
    validateDerivedRate(entry.ratePct, `${base}.ratePct`, entry.orphans, entry.total, errors);
    if (entry.examples !== undefined && (!Array.isArray(entry.examples) || entry.examples.some((url) => !isUrl(url)))) {
      add(errors, `${base}.examples`, 'array di URL http(s) richiesto');
    }
  }
}

function validateRateBaseline(value, kind) {
  const errors = [];
  if (!isObject(value)) {
    add(errors, '$', `${kind} baseline deve essere un oggetto`);
    return errors;
  }
  if (value.mode !== 'rate') add(errors, 'mode', 'deve essere rate');
  const generated = value.generatedAt ?? value.generated;
  if (!isIso(generated)) add(errors, 'generated/generatedAt', 'timestamp ISO non valido');
  validateRateTolerance(value.tolerance, errors);

  if (kind === 'bfs-depth') {
    if (value.version !== 2) add(errors, 'version', 'deve essere 2');
    if (!Number.isInteger(value.maxDepth) || value.maxDepth < 0) add(errors, 'maxDepth', 'intero non negativo richiesto');
    validateBfsSitemaps(value, errors);
    return errors;
  }

  if (kind === 'orphan-pages') {
    if (value.version !== 2) add(errors, 'version', 'deve essere 2');
    if (typeof value.scanMode !== 'string' || !value.scanMode.trim()) add(errors, 'scanMode', 'stringa non vuota richiesta');
    if (!Number.isInteger(value.totalSitemapUrls) || value.totalSitemapUrls < 0) add(errors, 'totalSitemapUrls', 'intero non negativo richiesto');
    if (!Number.isInteger(value.totalOrphans) || value.totalOrphans < 0) {
      add(errors, 'totalOrphans', 'intero non negativo richiesto');
    } else if (Number.isInteger(value.totalSitemapUrls) && value.totalOrphans > value.totalSitemapUrls) {
      add(errors, 'totalOrphans', 'non può superare totalSitemapUrls');
    }
    validateOrphanSitemaps(value, errors);
    return errors;
  }

  validateRateAggregate(value, errors);
  validateRateBuckets(value, errors);
  if (kind === 'title-length' && (!Number.isInteger(value.threshold) || value.threshold < 1)) {
    add(errors, 'threshold', 'intero positivo richiesto');
  }
  if (kind === 'text-html-ratio' && (!isFiniteNumber(value.threshold) || value.threshold < 0 || value.threshold > 100)) {
    add(errors, 'threshold', 'numero tra 0 e 100 richiesto');
  }
  return errors;
}

export function validateGeneratedData(kind, value) {
  switch (kind) {
    case 'evergreen':
      return validateEvergreen(value);
    case 'funnel':
      return validateFunnel(value);
    case 'parser-proposals':
      return validateParserProposals(value);
    case 'unemployment':
      return validateUnemployment(value);
    case 'bfs-depth':
    case 'orphan-pages':
    case 'text-html-ratio':
    case 'title-length':
    case 'title-no-disambig-hash':
    case 'h1-title-duplicates':
      return validateRateBaseline(value, kind);
    default:
      return [`$: kind non supportato: ${kind}`];
  }
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const kind = arg('--kind');
  const file = arg('--file');
  if (!kind || !file) {
    console.error('Uso: node scripts/ci/validate-generated-data.mjs --kind <evergreen|funnel|parser-proposals|unemployment|bfs-depth|orphan-pages|text-html-ratio|title-length|title-no-disambig-hash|h1-title-duplicates> --file <path>');
    process.exitCode = 2;
    return;
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`❌ ${file}: JSON non leggibile (${error.message})`);
    process.exitCode = 1;
    return;
  }
  const errors = validateGeneratedData(kind, value);
  if (errors.length > 0) {
    console.error(`❌ ${file}: ${errors.length} errore/i di coerenza (${kind})`);
    for (const error of errors) console.error(`   - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${file}: validazione ${kind} superata`);
}

if (process.argv[1] && process.argv[1].endsWith('validate-generated-data.mjs')) main();
