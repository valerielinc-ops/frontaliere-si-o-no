import {
  buildStableJobIdentity,
  jobsDiffer,
} from './job-identity.mjs';

const BASE_URL = 'https://frontaliereticino.ch';
const JOB_BOARD_ROOT_PATH = '/cerca-lavoro-ticino';
const JOB_BOARD_ROOT_URL = `${BASE_URL}${JOB_BOARD_ROOT_PATH}`;
const HISTORY_LIMIT = 180;
const COMPACT_AFTER_DAYS = 30;
const ZURICH_TIMEZONE = 'Europe/Zurich';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugifyTerm(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function normalizeCompanyKey(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalCompanyRouteSlug(company = '', companyKey = '') {
  const keyNorm = normalizeCompanyKey(companyKey);
  const companyNorm = normalizeCompanyKey(company);
  if (keyNorm.includes('lidl') || companyNorm.includes('lidl')) return 'lidl';
  return slugifyTerm(company);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function zurichDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZURICH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getCompanySummary(job = {}) {
  const name = normalizeSpace(job.company || 'Azienda');
  const key = canonicalCompanyRouteSlug(name, normalizeSpace(job.companyKey || ''));
  return {
    key: key || slugifyTerm(name) || 'azienda',
    name,
    url: `${JOB_BOARD_ROOT_URL}/azienda-${key || 'azienda'}`,
  };
}

function getLocationSummary(job = {}) {
  let name = normalizeSpace(job.location || 'Ticino');
  // Guard against company names or years mistakenly stored as location
  if (/^\d{4}\b/.test(name) || (job.company && name.toLowerCase().replace(/[.\s]/g, '') === job.company.toLowerCase().replace(/[.\s]/g, ''))) {
    name = 'Ticino';
  }
  const key = slugifyTerm(name) || 'ticino';
  return {
    key,
    name,
    url: `${JOB_BOARD_ROOT_URL}/ricerca-${key}`,
  };
}

function getTitleSummary(job = {}) {
  const name = normalizeSpace(job.titleByLocale?.it || job.title || 'Offerta lavoro');
  const key = slugifyTerm(name) || 'lavoro';
  return {
    key,
    name,
    url: `${JOB_BOARD_ROOT_URL}/ricerca-${key}`,
  };
}

function getSalaryNumbers(job = {}) {
  const minDirect = Number(job?.salaryMin);
  const maxDirect = Number(job?.salaryMax);
  const baseValue = job?.baseSalary?.value || {};
  const minBase = Number(baseValue?.minValue);
  const maxBase = Number(baseValue?.maxValue);
  const salaryMin = Number.isFinite(minDirect) && minDirect > 0 ? minDirect : (Number.isFinite(minBase) && minBase > 0 ? minBase : null);
  const salaryMax = Number.isFinite(maxDirect) && maxDirect > 0 ? maxDirect : (Number.isFinite(maxBase) && maxBase > 0 ? maxBase : null);
  if (!salaryMin && !salaryMax) return null;
  const min = salaryMin || salaryMax;
  const max = salaryMax || salaryMin;
  if (!min || !max) return null;
  return {
    min,
    max,
    midpoint: Math.round((min + max) / 2),
  };
}

function cloneEntry(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareLeaderItems(a, b, primary = 'count') {
  const primaryA = Number(a?.[primary] || 0);
  const primaryB = Number(b?.[primary] || 0);
  if (primaryB !== primaryA) return primaryB - primaryA;
  return String(a?.name || '').localeCompare(String(b?.name || ''), 'it', { sensitivity: 'base' });
}

function toLeaderItems(rawItems = [], mode = 'count') {
  return rawItems
    .map((item) => {
      const added = safeArray(item.addedKeys).length;
      const updated = safeArray(item.updatedKeys).length;
      const removed = safeArray(item.removedKeys).length;
      return {
        key: item.key,
        name: item.name,
        url: item.url,
        count: Number(item.count || 0),
        added,
        updated,
        removed,
      };
    })
    .sort((a, b) => compareLeaderItems(a, b, mode));
}

function upsertActionStat(list, descriptor, actionKey, jobKey) {
  const existing = list.find((item) => item.key === descriptor.key);
  const target = existing || {
    key: descriptor.key,
    name: descriptor.name,
    url: descriptor.url,
    addedKeys: [],
    updatedKeys: [],
    removedKeys: [],
  };
  const field = `${actionKey}Keys`;
  if (!target[field].includes(jobKey)) target[field].push(jobKey);
  if (!existing) list.push(target);
}

function createHistoryEntry(date, totalJobs) {
  return {
    date,
    totalJobs,
    added: 0,
    updated: 0,
    removed: 0,
    addedKeys: [],
    updatedKeys: [],
    removedKeys: [],
    companyStats: [],
    locationStats: [],
    titleStats: [],
  };
}

function finalizeHistoryEntry(entry) {
  const next = cloneEntry(entry);
  next.addedKeys = Array.from(new Set(safeArray(next.addedKeys))).sort();
  next.updatedKeys = Array.from(new Set(safeArray(next.updatedKeys))).sort();
  next.removedKeys = Array.from(new Set(safeArray(next.removedKeys))).sort();
  next.added = next.addedKeys.length;
  next.updated = next.updatedKeys.length;
  next.removed = next.removedKeys.length;

  for (const bucketKey of ['companyStats', 'locationStats', 'titleStats']) {
    next[bucketKey] = safeArray(next[bucketKey])
      .map((item) => ({
        ...item,
        addedKeys: Array.from(new Set(safeArray(item.addedKeys))).sort(),
        updatedKeys: Array.from(new Set(safeArray(item.updatedKeys))).sort(),
        removedKeys: Array.from(new Set(safeArray(item.removedKeys))).sort(),
      }))
      .filter((item) => item.addedKeys.length > 0 || item.updatedKeys.length > 0 || item.removedKeys.length > 0)
      .sort((a, b) => compareLeaderItems({
        name: a.name,
        count: safeArray(a.addedKeys).length + safeArray(a.updatedKeys).length + safeArray(a.removedKeys).length,
      }, {
        name: b.name,
        count: safeArray(b.addedKeys).length + safeArray(b.updatedKeys).length + safeArray(b.removedKeys).length,
      }));
  }

  return next;
}

/**
 * Merge duplicate entries that share the same date (from concurrent crawler pushes).
 * Keeps the highest totalJobs count and unions all *Keys and *Stats arrays.
 */
function deduplicateEntriesByDate(entries) {
  const byDate = new Map();
  for (const e of entries) {
    const existing = byDate.get(e.date);
    if (!existing) {
      byDate.set(e.date, e);
      continue;
    }
    // Merge: keep max totalJobs, union all key arrays
    existing.totalJobs = Math.max(existing.totalJobs || 0, e.totalJobs || 0);
    for (const field of ['addedKeys', 'updatedKeys', 'removedKeys']) {
      existing[field] = Array.from(new Set([...safeArray(existing[field]), ...safeArray(e[field])]));
    }
    existing.added = existing.addedKeys.length;
    existing.updated = existing.updatedKeys.length;
    existing.removed = existing.removedKeys.length;
    // Merge stat buckets
    for (const bucket of ['companyStats', 'locationStats', 'titleStats']) {
      const map = new Map();
      for (const item of [...safeArray(existing[bucket]), ...safeArray(e[bucket])]) {
        const key = item.key || item.name;
        const prev = map.get(key);
        if (!prev) {
          map.set(key, { ...item });
          continue;
        }
        for (const f of ['addedKeys', 'updatedKeys', 'removedKeys']) {
          prev[f] = Array.from(new Set([...safeArray(prev[f]), ...safeArray(item[f])]));
        }
        prev.name = prev.name || item.name;
        prev.url = prev.url || item.url;
      }
      existing[bucket] = Array.from(map.values());
    }
  }
  return Array.from(byDate.values());
}

export function buildJobKeysSnapshot(jobs = []) {
  return safeArray(jobs).map((job) => buildStableJobIdentity(job)).sort();
}

export function computeJobDiff(previousJobs = [], currentJobs = []) {
  const beforeMap = new Map();
  for (const job of safeArray(previousJobs)) beforeMap.set(buildStableJobIdentity(job), job);

  const afterMap = new Map();
  for (const job of safeArray(currentJobs)) afterMap.set(buildStableJobIdentity(job), job);

  const addedJobs = [];
  const updatedJobs = [];
  const removedJobs = [];

  for (const [key, currentJob] of afterMap.entries()) {
    const previousJob = beforeMap.get(key);
    if (!previousJob) {
      addedJobs.push(currentJob);
      continue;
    }
    if (jobsDiffer(previousJob, currentJob)) {
      updatedJobs.push(currentJob);
    }
  }

  for (const [key, previousJob] of beforeMap.entries()) {
    if (!afterMap.has(key)) removedJobs.push(previousJob);
  }

  return { addedJobs, updatedJobs, removedJobs };
}

export function updateJobsStatsHistory(existingHistory = {}, diff = {}, currentJobs = [], options = {}) {
  const now = options.now || new Date().toISOString();
  const limit = options.historyLimit || HISTORY_LIMIT;
  const date = zurichDate(now);
  const history = {
    version: Number(existingHistory?.version || 1),
    generatedAt: new Date(now).toISOString(),
    entries: safeArray(existingHistory?.entries).map((entry) => cloneEntry(entry)),
  };

  let entry = history.entries.find((item) => item.date === date);
  if (!entry) {
    entry = createHistoryEntry(date, safeArray(currentJobs).length);
    history.entries.push(entry);
  }

  entry.totalJobs = safeArray(currentJobs).length;

  const actionMap = [
    ['added', safeArray(diff?.addedJobs)],
    ['updated', safeArray(diff?.updatedJobs)],
    ['removed', safeArray(diff?.removedJobs)],
  ];

  for (const [actionKey, jobs] of actionMap) {
    for (const job of jobs) {
      const jobKey = buildStableJobIdentity(job);
      const field = `${actionKey}Keys`;
      if (!entry[field].includes(jobKey)) entry[field].push(jobKey);
      upsertActionStat(entry.companyStats, getCompanySummary(job), actionKey, jobKey);
      upsertActionStat(entry.locationStats, getLocationSummary(job), actionKey, jobKey);
      upsertActionStat(entry.titleStats, getTitleSummary(job), actionKey, jobKey);
    }
  }

  history.entries = history.entries
    .map((item) => finalizeHistoryEntry(item))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limit);

  // Deduplicate entries by date — merge duplicate entries from concurrent crawler pushes
  history.entries = deduplicateEntriesByDate(history.entries);

  // Compact old entries: strip verbose fields for entries older than COMPACT_AFTER_DAYS
  // to keep the history file under GitHub's 100 MB file size limit.
  const compactCutoff = zurichDate(
    new Date(new Date(now).getTime() - COMPACT_AFTER_DAYS * 86_400_000).toISOString()
  );
  for (const e of history.entries) {
    if (e.date < compactCutoff) {
      e.addedKeys = [];
      e.updatedKeys = [];
      e.removedKeys = [];
      e.companyStats = [];
      e.locationStats = [];
      e.titleStats = [];
    }
  }

  return history;
}

function buildCurrentLeaders(currentJobs = [], projector) {
  const map = new Map();
  for (const job of safeArray(currentJobs)) {
    const descriptor = projector(job);
    if (!descriptor?.key) continue;
    const existing = map.get(descriptor.key) || {
      key: descriptor.key,
      name: descriptor.name,
      url: descriptor.url,
      count: 0,
    };
    existing.count += 1;
    map.set(descriptor.key, existing);
  }
  return Array.from(map.values()).sort((a, b) => compareLeaderItems(a, b, 'count'));
}

function aggregateActionLeaders(entries = [], bucketKey = 'companyStats', actionKey = 'addedKeys') {
  const map = new Map();
  for (const entry of entries) {
    for (const item of safeArray(entry?.[bucketKey])) {
      const keys = Array.from(new Set(safeArray(item?.[actionKey])));
      if (keys.length === 0) continue;
      const existing = map.get(item.key) || {
        key: item.key,
        name: item.name,
        url: item.url,
        addedKeys: [],
        updatedKeys: [],
        removedKeys: [],
      };
      existing.addedKeys = Array.from(new Set([...existing.addedKeys, ...safeArray(item.addedKeys)]));
      existing.updatedKeys = Array.from(new Set([...existing.updatedKeys, ...safeArray(item.updatedKeys)]));
      existing.removedKeys = Array.from(new Set([...existing.removedKeys, ...safeArray(item.removedKeys)]));
      map.set(item.key, existing);
    }
  }
  return toLeaderItems(Array.from(map.values()), 'added');
}

function summarizeSalaryCoverage(currentJobs = []) {
  const salaryRows = safeArray(currentJobs)
    .map((job) => getSalaryNumbers(job))
    .filter(Boolean);

  if (salaryRows.length === 0) {
    return {
      jobsWithSalary: 0,
      coveragePct: 0,
      avgMin: 0,
      avgMax: 0,
      avgMid: 0,
      medianMid: 0,
    };
  }

  const mids = salaryRows.map((row) => row.midpoint).sort((a, b) => a - b);
  const midIndex = Math.floor(mids.length / 2);
  const medianMid = mids.length % 2 === 0
    ? Math.round((mids[midIndex - 1] + mids[midIndex]) / 2)
    : mids[midIndex];

  const avg = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

  return {
    jobsWithSalary: salaryRows.length,
    coveragePct: Number(((salaryRows.length / Math.max(safeArray(currentJobs).length, 1)) * 100).toFixed(1)),
    avgMin: avg(salaryRows.map((row) => row.min)),
    avgMax: avg(salaryRows.map((row) => row.max)),
    avgMid: avg(salaryRows.map((row) => row.midpoint)),
    medianMid,
  };
}

function buildSalaryLeaders(currentJobs = [], projector) {
  const map = new Map();
  for (const job of safeArray(currentJobs)) {
    const salary = getSalaryNumbers(job);
    if (!salary) continue;
    const descriptor = projector(job);
    if (!descriptor?.key) continue;
    const current = map.get(descriptor.key) || {
      key: descriptor.key,
      name: descriptor.name,
      url: descriptor.url,
      count: 0,
      totalMin: 0,
      totalMax: 0,
      totalMid: 0,
    };
    current.count += 1;
    current.totalMin += salary.min;
    current.totalMax += salary.max;
    current.totalMid += salary.midpoint;
    map.set(descriptor.key, current);
  }

  const CONFIDENCE_THRESHOLD = 5;
  return Array.from(map.values())
    .map((item) => {
      const avgMin = Math.round(item.totalMin / item.count);
      const avgMid = Math.round(item.totalMid / item.count);
      const weight = Math.min(item.count / CONFIDENCE_THRESHOLD, 1);
      return {
        key: item.key,
        name: item.name,
        url: item.url,
        count: item.count,
        avgMin,
        avgMax: Math.round(item.totalMax / item.count),
        avgMid,
        weightedSalary: Math.round(avgMin + weight * (avgMid - avgMin)),
      };
    })
    .sort((a, b) => b.weightedSalary - a.weightedSalary || b.count - a.count || String(a.name).localeCompare(String(b.name), 'it', { sensitivity: 'base' }));
}

function lastDaysEntries(entries = [], now, days) {
  const today = new Date(`${zurichDate(now)}T00:00:00.000Z`);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  return safeArray(entries).filter((entry) => {
    const parsed = new Date(`${entry.date}T00:00:00.000Z`);
    return parsed >= cutoff && parsed <= today;
  });
}

export function buildJobsStatsSummary(currentJobs = [], history = {}, options = {}) {
  const now = options.now || new Date().toISOString();
  const entries = safeArray(history?.entries).map((entry) => finalizeHistoryEntry(entry));
  const todayEntry = entries.find((entry) => entry.date === zurichDate(now)) || createHistoryEntry(zurichDate(now), safeArray(currentJobs).length);
  const last7d = lastDaysEntries(entries, now, 7);
  const last30d = lastDaysEntries(entries, now, 30);

  const summarizeAction = (sourceEntries) => ({
    added: sourceEntries.reduce((sum, entry) => sum + Number(entry.added || 0), 0),
    updated: sourceEntries.reduce((sum, entry) => sum + Number(entry.updated || 0), 0),
    removed: sourceEntries.reduce((sum, entry) => sum + Number(entry.removed || 0), 0),
  });
  const salaryCoverage = summarizeSalaryCoverage(currentJobs);

  return {
    generatedAt: new Date(now).toISOString(),
    links: {
      allJobs: JOB_BOARD_ROOT_URL,
    },
    totals: {
      activeJobs: safeArray(currentJobs).length,
      activeCompanies: buildCurrentLeaders(currentJobs, getCompanySummary).length,
      activeLocations: buildCurrentLeaders(currentJobs, getLocationSummary).length,
      todayAdded: Number(todayEntry.added || 0),
      todayUpdated: Number(todayEntry.updated || 0),
      todayRemoved: Number(todayEntry.removed || 0),
      last7d: summarizeAction(last7d),
      last30d: summarizeAction(last30d),
    },
    history: entries.map((entry) => ({
      date: entry.date,
      totalJobs: Number(entry.totalJobs || 0),
      added: Number(entry.added || 0),
      updated: Number(entry.updated || 0),
      removed: Number(entry.removed || 0),
    })),
    leaders: {
      topCompaniesActive: buildCurrentLeaders(currentJobs, getCompanySummary).slice(0, 8),
      topLocationsActive: buildCurrentLeaders(currentJobs, getLocationSummary).slice(0, 8),
      topCompaniesAddedToday: toLeaderItems(todayEntry.companyStats, 'added').filter((item) => item.added > 0).slice(0, 8),
      topCompaniesAdded30d: aggregateActionLeaders(last30d, 'companyStats', 'addedKeys').filter((item) => item.added > 0).slice(0, 8),
      topLocationsAdded30d: aggregateActionLeaders(last30d, 'locationStats', 'addedKeys').filter((item) => item.added > 0).slice(0, 8),
      topTitlesAdded30d: aggregateActionLeaders(last30d, 'titleStats', 'addedKeys').filter((item) => item.added > 0).slice(0, 8),
    },
    salary: {
      coverage: salaryCoverage,
      leaders: {
        topSalaryCompanies: buildSalaryLeaders(currentJobs, getCompanySummary).slice(0, 8),
        topSalaryLocations: buildSalaryLeaders(currentJobs, getLocationSummary).slice(0, 8),
        topSalaryTitles: buildSalaryLeaders(currentJobs, getTitleSummary).slice(0, 8),
      },
    },
  };
}

/**
 * Migrate history titleStats entries from raw (often German/English) titles to
 * Italian locale titles. Entries whose name matches a known raw title are
 * re-keyed; entries that collapse onto the same Italian key are merged.
 */
function migrateHistoryTitleLocale(history, currentJobs) {
  const titleMap = new Map();
  for (const job of safeArray(currentJobs)) {
    const rawTitle = normalizeSpace(job.title || '');
    const itTitle = normalizeSpace(job.titleByLocale?.it || '');
    if (itTitle && rawTitle && itTitle !== rawTitle) {
      titleMap.set(rawTitle, itTitle);
    }
  }
  if (titleMap.size === 0) return;

  for (const entry of safeArray(history.entries)) {
    const stats = safeArray(entry.titleStats);
    if (stats.length === 0) continue;

    const merged = new Map();
    for (const item of stats) {
      const itName = titleMap.get(item.name) || item.name;
      const itKey = slugifyTerm(itName) || item.key;
      const existing = merged.get(itKey);
      if (existing) {
        existing.addedKeys = Array.from(new Set([...existing.addedKeys, ...safeArray(item.addedKeys)]));
        existing.updatedKeys = Array.from(new Set([...existing.updatedKeys, ...safeArray(item.updatedKeys)]));
        existing.removedKeys = Array.from(new Set([...existing.removedKeys, ...safeArray(item.removedKeys)]));
      } else {
        merged.set(itKey, {
          key: itKey,
          name: itName,
          url: `${JOB_BOARD_ROOT_URL}/ricerca-${itKey}`,
          addedKeys: [...safeArray(item.addedKeys)],
          updatedKeys: [...safeArray(item.updatedKeys)],
          removedKeys: [...safeArray(item.removedKeys)],
        });
      }
    }
    entry.titleStats = Array.from(merged.values());
  }
}

export function buildJobsStatsArtifacts(options = {}) {
  const previousJobs = safeArray(options.previousJobs);
  const currentJobs = safeArray(options.currentJobs);
  const existingHistory = options.existingHistory || {};
  const now = options.now || new Date().toISOString();
  const diff = computeJobDiff(previousJobs, currentJobs);
  const history = updateJobsStatsHistory(existingHistory, diff, currentJobs, {
    now,
    historyLimit: options.historyLimit || HISTORY_LIMIT,
  });
  migrateHistoryTitleLocale(history, currentJobs);
  const summary = buildJobsStatsSummary(currentJobs, history, { now });
  return { diff, history, summary };
}
