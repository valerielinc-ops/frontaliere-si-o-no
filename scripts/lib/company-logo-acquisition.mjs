// These are publishing platforms, not the employer's brand domains. A
// companyDomain on one of them must not be sent to Google as the logo source.
const ATS_HOST_MARKERS = [
  'allibo.com',
  'altamiraweb.com',
  'apps.be.ch',
  'arca24.careers',
  'careers.softgarden.de',
  'softgarden.de',
  'csod.com',
  'concludis.de',
  'dualoo.com',
  'greenhouse.io',
  'icims.com',
  'intervieweb.it',
  'jobcloud.ch',
  'jobs.ch',
  'jobup.ch',
  'jobalino.ch',
  'myworkdayjobs.com',
  'ncoreplat.com',
  'oraclecloud.com',
  'personio.',
  'prospective.ch',
  'refline.ch',
  'reflinejobs.io',
  'recruitee.com',
  'recruitingapp-',
  'salesforce-sites.com',
  'smartrecruiters.com',
  'solique.ch',
  'successfactors.',
  'talent-soft.com',
  'talentics.ai',
  'teamtailor.com',
  'umantis.com',
  'workable.com',
  'zohorecruit.com',
];

export const DOMAIN_OVERRIDES = {
  'amina-bank': ['amina.ch'],
  'apleona-schweiz-ag': ['apleona.com'],
  'badrutts-palace': ['badruttspalace.com'],
  cippatrasporti: ['cippatrasporti.ch', 'cippa.ch'],
  'ferrovia-retica': ['rhb.ch'],
  'fisiocare-sagl': ['fisiocare.ch', 'fisiocare.com'],
  gmo: ['gmo.ch'],
  'gz-dielsdorf': ['gzdielsdorf.ch'],
  'elettra-1938': ['elettra1938.ch', 'elettra.ch'],
  'impresa-pizzarotti': ['pizzarotti.it'],
  jsafrasarasin: ['jsafrasarasin.ch', 'jsafrasarasin.com'],
  'kanton-aargau': ['ag.ch'],
  lonza: ['lonza.com'],
  michaelpage: ['michaelpage.ch', 'michaelpage.com'],
  'matterhorn-gotthard-bahn': ['mgb.ch'],
  'recruitingapp-1154': ['sgkb.ch'],
  // Issue #6504: these are employer-owned domains, never ATS or directory
  // hosts. yellowshark is first because it covers most of the affected jobs.
  answerconsulting: ['answerconsulting.ch'],
  yellowshark: ['yellowshark.com'],
  bucherer: ['bucherer.com', 'bucherer.ch'],
  'comadur-swatch-group': ['swatchgroup.com'],
  'edmond-de-rothschild': ['edmond-de-rothschild.com'],
  'nord-anglia': ['nordangliaeducation.com'],
  grischapersonal: ['grischapersonal.ch'],
  'gim-architekten': ['gim.ch'],
  imerys: ['imerys.com'],
  mediamarkt: ['mediamarkt.ch'],
  brefispersonal: ['brefis.ch'],
  parmag: ['parmag.ch'],
  endeso: ['endeso.ch'],
  'integra-biosciences': ['integra-biosciences.com'],
  benu: ['benu.ch'],
  'pantr-ch': ['pantr.ch'],
  kone: ['kone.com'],
  fisba: ['fisba.com'],
  'schweizerhof-flims': ['schweizerhof-flims.ch'],
  'blatters-hotel': ['blatters-hotel.ch'],
  'mcm-group': ['mcm-group.ch'],
  christinavassalli: ['christinavassalli.ch'],
  clariant: ['clariant.com'],
  neoproconseils: ['neoproconseils.ch'],
  '1a-hunkeler': ['1a-hunkeler.ch'],
  anicura: ['anicura.ch'],
  apply: ['leitpuls.ch'],
  artificialy: ['artificialy.com'],
  'atec-personal': ['atec-personal.ch'],
  'buersten-technik': ['buersten-technik.ch'],
  elprom: ['elprom.ch'],
  'farmacia-internazionale-dr-merloni': ['internationalpharmacy.swiss'],
  'mueller-steinmaur': ['mueller-steinmaur.ch'],
  'protectas-sa': ['protectas.com'],
};

export function normalizeDomain(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    raw = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return '';
  }
  return raw.replace(/^www\./, '').replace(/\.$/, '');
}

export function isAtsDomain(domain) {
  const value = normalizeDomain(domain);
  return !value
    || value === 'frontaliereticino.ch'
    || ATS_HOST_MARKERS.some((marker) => value === marker || value.endsWith(`.${marker}`) || value.includes(marker));
}

function addUnique(list, seen, value) {
  const domain = normalizeDomain(value);
  if (!domain || seen.has(domain)) return;
  seen.add(domain);
  list.push(domain);
}

const STRIP_SUFFIXES = [
  '-ag', '-sa', '-spa', '-gmbh', '-ltd', '-inc', '-llc', '-plc', '-nv', '-bv',
  '-co-kg', '-co', '-srl', '-sarl', '-sas', '-sagl',
  '-svizzera', '-suisse', '-schweiz', '-switzerland', '-svizzero',
  '-ticino', '-lugano', '-bellinzona', '-locarno', '-chiasso', '-mendrisio',
  '-italia', '-italy', '-france', '-germany', '-deutschland',
  '-group', '-groups', '-holding', '-international', '-global', '-europe', '-world',
];

function stripSuffixes(slug) {
  let value = slug;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of STRIP_SUFFIXES) {
      if (value.endsWith(suffix) && value.length > suffix.length) {
        value = value.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return value || slug;
}

/**
 * Audit mode is deliberately override-only: the audit input never authorizes
 * a domain derived from a company key, a job URL, or crawler metadata. The
 * legacy mode remains available for manual recovery and keeps its historical
 * guessed candidates; the weekly workflow must invoke `--from-audit`.
 */
export function domainCandidates(key, metadata = {}, options = {}) {
  const fromAudit = options === true || options?.fromAudit === true;
  const companyKey = String(key || '').trim();
  const candidates = [];
  const seen = new Set();
  const add = (value) => addUnique(candidates, seen, value);

  for (const domain of DOMAIN_OVERRIDES[companyKey] || []) add(domain);
  if (fromAudit) return candidates;

  for (const domain of metadata.companyDomains || []) {
    if (!isAtsDomain(domain)) add(domain);
  }
  for (const domain of metadata.urlHosts || []) {
    if (!isAtsDomain(domain)) add(domain);
  }

  const stripped = stripSuffixes(companyKey);
  const firstWord = companyKey.split('-')[0];
  add(`${companyKey}.ch`);
  add(`${companyKey}.com`);
  if (stripped !== companyKey) {
    add(`${stripped}.ch`);
    add(`${stripped}.com`);
  }
  if (firstWord.length > 1 && firstWord !== companyKey && firstWord !== stripped) {
    add(`${firstWord}.ch`);
    add(`${firstWord}.com`);
  }
  return candidates;
}

const AUDIT_STATUS_REASONS = {
  missing: 'nessun dominio ufficiale dichiarato',
  broken: 'sorgente ufficiale irraggiungibile o riferimento rotto',
  partial: 'copertura parziale',
  'pending-deploy': 'asset presente nel checkout, in attesa del deploy CDN',
  'low-quality': 'qualità insufficiente',
  'quality-unverified': 'qualità non verificabile',
  unverified: 'sorgente non verificabile',
};

const ACQUISITION_REASON_LABELS = {
  'no-official-domain': 'nessun dominio ufficiale dichiarato',
};

export function selectAuditCandidates(entries = []) {
  return entries.filter((entry) => (
    (entry?.status === 'missing'
      || entry?.status === 'low-quality'
      || Number(entry?.lowQualityJobCount || 0) > 0)
    && String(entry?.companyKey || '').trim()
  ));
}

export function auditIssueReason(company = {}) {
  const reason = String(company.reason || '').trim();
  return ACQUISITION_REASON_LABELS[reason] || reason
    || AUDIT_STATUS_REASONS[company.status]
    || 'anomalia logo non classificata';
}

export function buildResidualReport(report, acquisition = {}) {
  const results = new Map(
    (acquisition.targets || [])
      .filter((result) => result?.companyKey)
      .map((result) => [result.companyKey, result]),
  );
  const residual = (report.affectedCompanies || [])
    .filter((company) => results.get(company.companyKey)?.status !== 'verified')
    .map((company) => ({
      ...company,
      reason: auditIssueReason(results.get(company.companyKey) || company),
    }));

  const countCompanies = (status) => residual.filter((company) => company.status === status).length;
  const countJobs = (field, status = null) => residual
    .filter((company) => status === null || company.status === status)
    .reduce((sum, company) => sum + Number(company[field] || 0), 0);

  return {
    ...report,
    affectedCompanies: residual,
    companies: residual.filter((company) => company.status === 'missing'),
    missing: countCompanies('missing'),
    missingJobCount: countJobs('missingJobCount', 'missing'),
    broken: countCompanies('broken'),
    brokenJobCount: countJobs('brokenJobCount', 'broken'),
    pendingDeploy: residual.filter((company) => Number(company.pendingDeployJobCount || 0) > 0).length,
    pendingDeployJobCount: countJobs('pendingDeployJobCount'),
    partial: countCompanies('partial'),
    partialJobCount: countJobs('affectedJobCount', 'partial'),
    lowQuality: residual.filter((company) => Number(company.lowQualityJobCount || 0) > 0).length,
    lowQualityJobCount: countJobs('lowQualityJobCount'),
    qualityUnverified: residual.filter((company) => Number(company.qualityUnverifiedJobCount || 0) > 0).length,
    qualityUnverifiedJobCount: countJobs('qualityUnverifiedJobCount'),
    unverified: countCompanies('unverified'),
    unverifiedJobCount: countJobs('unverifiedJobCount', 'unverified'),
    acquisition: {
      acquired: Number(acquisition.acquired || 0),
      failed: Number(acquisition.failed || 0),
      qualityRejected: Number(acquisition.qualityRejected || 0),
    },
  };
}
