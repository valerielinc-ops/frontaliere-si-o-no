import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import {
  LOOP_CLOCK_CORPUS_REPOSITORY,
  LOOP_CLOCK_ENTRIES,
  LOOP_CLOCK_INPUT,
  loopClockInputValue,
} from './loopClockTable.js';
import {
  LOOP_CLOCK_ISSUES_MAX_PAGES,
  LOOP_CLOCK_ISSUES_PAGE_SIZE,
  summarizeUntriagedIssues,
} from './loopClockIssueCondition.js';

export { LOOP_CLOCK_ENTRIES } from './loopClockTable.js';

export const LOOP_CLOCK_TICK_MINUTES = 5;
export const LOOP_CLOCK_CLOUD_SCHEDULE = '*/5 * * * *';

const MINUTE_MS = 60_000;
const SITE_DEFAULT_OWNER = 'valerielinc-ops';
const SITE_DEFAULT_REPO = 'frontaliere-si-o-no';
const [CORPUS_OWNER, CORPUS_REPO] = LOOP_CLOCK_CORPUS_REPOSITORY.split('/');

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('scheduledAt must be a valid date');
  return date;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('loop clock entries must be a non-empty array');
  }
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id)) {
      throw new TypeError('loop clock entry ids must be unique');
    }
    if (!['site', 'corpus'].includes(entry.repo) || typeof entry.workflow !== 'string' || !entry.workflow) {
      throw new TypeError(`invalid loop clock entry: ${entry.id}`);
    }
    if (!Number.isInteger(entry.everyMinutes) || entry.everyMinutes <= 0
      || entry.everyMinutes % LOOP_CLOCK_TICK_MINUTES !== 0) {
      throw new TypeError(`invalid loop clock cadence: ${entry.id}`);
    }
    if (entry.inputs !== undefined) {
      const inputs = entry.inputs;
      if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || LOOP_CLOCK_INPUT in inputs
        || Object.values(inputs).some((value) => typeof value !== 'string')) {
        throw new TypeError(`invalid loop clock inputs: ${entry.id}`);
      }
    }
    ids.add(entry.id);
  }
}

function stableHash(value) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

/** Stable offset on the five-minute grid; no extra table field can drift. */
export function loopClockOffsetMinutes(entry) {
  validateEntries([entry]);
  const slots = entry.everyMinutes / LOOP_CLOCK_TICK_MINUTES;
  return (stableHash(entry.id) % slots) * LOOP_CLOCK_TICK_MINUTES;
}

function slotMinute(scheduledAt) {
  const minute = Math.floor(validDate(scheduledAt).getTime() / MINUTE_MS);
  // Cloud Scheduler hands over the nominal slot, but a delayed or hand-fired
  // tick can land a minute or two inside it: snap to the five-minute grid so
  // the entries of that slot still run instead of silently matching nothing.
  return minute - (minute % LOOP_CLOCK_TICK_MINUTES);
}

/** The five-minute slot a tick belongs to; it names the dispatched runs. */
export function loopClockSlot(scheduledAt) {
  return new Date(slotMinute(scheduledAt) * MINUTE_MS);
}

export function isLoopClockEntryDue(entry, scheduledAt) {
  const slot = slotMinute(scheduledAt);
  const offset = loopClockOffsetMinutes(entry);
  return ((slot - offset) % entry.everyMinutes + entry.everyMinutes) % entry.everyMinutes === 0;
}

export function dueLoopClockEntries(scheduledAt, entries = LOOP_CLOCK_ENTRIES) {
  validateEntries(entries);
  return entries.filter((entry) => isLoopClockEntryDue(entry, scheduledAt));
}

export function parseLoopClockDisabled(rawValue = '') {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return new Set();
  if (raw === '*') return '*';
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

function isDisabled(disabled, id) {
  return disabled === '*' || disabled.has(id);
}

async function readRemoteConfig(key, getRemoteConfigValueImpl, warnings) {
  try {
    const value = await getRemoteConfigValueImpl(key);
    return String(value ?? '').trim();
  } catch {
    warnings.push(`remote_config_unavailable:${key}`);
    return '';
  }
}

function siteConfigResult(config) {
  const pat = typeof config?.pat === 'string' ? config.pat.trim() : '';
  const owner = String(config?.owner || SITE_DEFAULT_OWNER).trim();
  const repo = String(config?.repo || SITE_DEFAULT_REPO).trim();
  if (!pat) return { failureReason: 'site_token_missing' };
  if (!owner || !repo) return { failureReason: 'site_repo_config_invalid' };
  return { pat, owner, repo };
}

function makeResult(entry, fields = {}) {
  return { id: entry.id, repo: entry.repo, workflow: entry.workflow, ...fields };
}

async function listUntriagedIssues({ owner, repo, token, fetchImpl }) {
  const issues = [];
  for (let page = 1; page <= LOOP_CLOCK_ISSUES_MAX_PAGES; page += 1) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&sort=created&direction=asc&per_page=${LOOP_CLOCK_ISSUES_PAGE_SIZE}&page=${page}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: githubApiHeaders(token),
    });
    if (!response.ok) throw new Error('condition_lookup_failed');
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new Error('condition_lookup_invalid');
    issues.push(...body);
    if (body.length < LOOP_CLOCK_ISSUES_PAGE_SIZE) return summarizeUntriagedIssues(issues);
  }
  throw new Error('condition_lookup_too_large');
}

async function dispatchEntry({ entry, slot, context, fetchImpl, conditionLookup }) {
  if (context.failureReason) {
    return makeResult(entry, { dispatched: false, failed: true, reason: context.failureReason });
  }

  let conditionState;
  if (entry.condition === 'untriaged-issues') {
    try {
      const condition = await conditionLookup(context.owner, context.repo, context.pat);
      if (condition.count === 0) {
        return makeResult(entry, { dispatched: false, reason: 'condition_no_untriaged_issues' });
      }
      conditionState = 'condition_untriaged_issues';
    } catch {
      // A failed search must not hide the triage sweep; the workflow itself is
      // idempotent and remains the safer fallback than losing a pending issue.
      conditionState = 'condition_lookup_failed';
    }
  }

  const url = `${GITHUB_API}/repos/${context.owner}/${context.repo}/actions/workflows/${entry.workflow}/dispatches`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: githubApiHeaders(context.pat, { 'Content-Type': 'application/json' }),
      // The marker input only names the run; the observer counts a dispatch
      // as the clock's own by that marker alone. Entry inputs come first so
      // nothing in the table can overwrite it.
      body: JSON.stringify({
        ref: 'main',
        inputs: { ...entry.inputs, [LOOP_CLOCK_INPUT]: loopClockInputValue(entry, slot) },
      }),
    });
    if (!response.ok) {
      return makeResult(entry, {
        dispatched: false,
        failed: true,
        reason: `dispatch_failed:${response.status}`,
        ...(conditionState ? { condition: conditionState } : {}),
      });
    }
    return makeResult(entry, {
      dispatched: true,
      status: response.status,
      ...(conditionState ? { condition: conditionState } : {}),
    });
  } catch {
    return makeResult(entry, {
      dispatched: false,
      failed: true,
      reason: 'dispatch_failed:network',
      ...(conditionState ? { condition: conditionState } : {}),
    });
  }
}

export class LoopClockDispatchError extends Error {
  constructor(report) {
    const failedIds = report.results.filter((result) => result.failed).map((result) => result.id);
    super(`loop_clock_dispatch_failed:${failedIds.join(',')}`);
    this.name = 'LoopClockDispatchError';
    this.results = report.results;
    this.report = report;
  }
}

/**
 * Dispatch every table entry due at a Cloud Scheduler tick. The per-entry
 * outcomes are deliberately data-only: credentials and upstream response
 * bodies never enter a result or an error message.
 */
export async function dispatchLoopClock({
  scheduledAt = new Date(),
  fetchImpl = fetch,
  getRepoConfigImpl = getRepoConfig,
  getRemoteConfigValueImpl = getRemoteConfigValue,
  entries = LOOP_CLOCK_ENTRIES,
} = {}) {
  const tick = validDate(scheduledAt);
  validateEntries(entries);
  const slot = loopClockSlot(tick);
  const due = dueLoopClockEntries(tick, entries);
  const warnings = [];
  const disabledRaw = await readRemoteConfig('LOOP_CLOCK_DISABLED', getRemoteConfigValueImpl, warnings);
  const disabled = parseLoopClockDisabled(disabledRaw);

  let siteContext = null;
  if (due.some((entry) => entry.repo === 'site' && !isDisabled(disabled, entry.id))) {
    try {
      siteContext = siteConfigResult(await getRepoConfigImpl());
    } catch {
      siteContext = { failureReason: 'site_repo_config_unavailable' };
    }
  }

  let corpusToken = '';
  if (due.some((entry) => entry.repo === 'corpus' && !isDisabled(disabled, entry.id))) {
    corpusToken = await readRemoteConfig('GITHUB_PAT_NANAKO', getRemoteConfigValueImpl, warnings);
  }

  const conditionCache = new Map();
  const conditionLookup = (owner, repo, token) => {
    const key = `${owner}/${repo}`;
    if (!conditionCache.has(key)) {
      conditionCache.set(key, listUntriagedIssues({ owner, repo, token, fetchImpl }));
    }
    return conditionCache.get(key);
  };

  const results = await Promise.all(due.map(async (entry) => {
    try {
      if (isDisabled(disabled, entry.id)) return makeResult(entry, { dispatched: false, reason: 'disabled' });

      // A missing corpus token is a failure, exactly like a missing site
      // token: as a plain skip every corpus entry would stop dispatching
      // while the tick keeps reporting success.
      const context = entry.repo === 'site'
        ? siteContext
        : corpusToken
          ? { pat: corpusToken, owner: CORPUS_OWNER, repo: CORPUS_REPO }
          : { failureReason: 'corpus_token_missing' };
      return await dispatchEntry({ entry, slot, context, fetchImpl, conditionLookup });
    } catch {
      return makeResult(entry, {
        dispatched: false,
        failed: true,
        reason: 'dispatch_failed:unexpected',
      });
    }
  }));

  const report = Object.freeze({
    scheduledAt: tick.toISOString(),
    dueCount: due.length,
    results,
    warnings,
  });
  if (results.some((result) => result.failed)) throw new LoopClockDispatchError(report);
  return report;
}
