/**
 * Ownership predicates for career boards shared by multiple real employers.
 *
 * A trusted host proves that a posting belongs to the board, not that it
 * belongs to the broad/group crawler. Keep these predicates pure so the live
 * crawlers and the checked-in slice reconciliation use the same boundary.
 */

function normalized(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Return the dedicated crawler that owns a jobs.migros.ch posting, or null
 * when the posting remains in the Migros umbrella crawler.
 */
export function dedicatedMigrosOwner(jobOrUrl = {}) {
  const job = typeof jobOrUrl === 'string' ? { url: jobOrUrl } : (jobOrUrl || {});
  const url = normalized(job.url);
  const company = normalized(job.company);

  if (/\/job\/denner(?:-[^/]+)?\//.test(url) || /\bdenner\b/.test(company)) return 'denner';
  if (/\/job\/migrolino\//.test(url) || /\bmigrolino\b/.test(company)) return 'migrolino';
  if (/\/job\/migros-genossenschafts-bund\//.test(url)) return 'migros-hq';
  return null;
}

/** Return the dedicated crawler that owns a shared Swiss Post record. */
export function dedicatedPostOwner(value = '') {
  const text = normalized(value);
  if (/\b(postauto|carpostal|postbus|autopostale)\b/.test(text)) return 'postauto';
  if (/\bpostfinance\b/.test(text)) return 'postfinance';
  return null;
}

/** Swiss Post's board also publishes PostAuto and PostFinance vacancies. */
export function isDedicatedPostBrand(value = '') {
  return dedicatedPostOwner(value) !== null;
}

/** Return the dedicated crawler that owns a shared jobs.fr.ch posting. */
export function dedicatedFribourgOwner(job = {}) {
  job = job || {};
  const key = normalized(job.companyKey).replace(/[^a-z0-9]+/g, '-');
  const text = normalized(`${job.company || ''} ${job.title || ''} ${job.department || ''}`);
  if (key === 'rfsm-fribourg') return key;
  if (key === 'hfr-hopital-fribourgeois') return key;
  if (/\b(rfsm|fnpg)\b/.test(text)
    || text.includes('reseau fribourgeois de sante mentale')
    || text.includes('freiburger netzwerk fur psychische gesundheit')) return 'rfsm-fribourg';
  if (/\bhfr\b/.test(text)
    || text.includes('hopital fribourgeois')
    || text.includes('freiburger spital')) return 'hfr-hopital-fribourgeois';
  return null;
}

/** jobs.fr.ch also hosts RFSM/FNPG and HFR vacancies. */
export function isDedicatedFribourgEmployer(job = {}) {
  return dedicatedFribourgOwner(job) !== null;
}

/**
 * Exact OSC ownership on concorsi.ti.ch. Health-related cantonal roles outside
 * OSC remain with the general cantonal-administration crawler.
 */
export function isCantonTicinoOscPosting(job = {}) {
  job = job || {};
  const key = normalized(job.companyKey).replace(/[^a-z0-9]+/g, '-');
  if (key === 'canton-ticino-osc') return true;
  const titleAndDepartment = normalized(`${job.title || ''} ${job.department || job.dept || ''}`);
  return titleAndDepartment.includes('organizzazione sociopsichiatrica cantonale')
    || /\bosc\b/.test(titleAndDepartment);
}
