#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { iterateJsonArrayFile, readJsonFile } from './lib/read-large-json.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  ATSFormCaptureError,
  captureATSApplicationForm,
  identifyATSProvider,
} from './lib/ats-application-form-capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLICES_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const STATE_PATH = path.join(ROOT, 'data', 'ats-application-forms.json');
const DEFAULT_MAX_PER_RUN = 350;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 20_000;
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const GONE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function canonicalJobUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    url.hostname = url.hostname.toLowerCase();
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return '';
  }
}

function captureKey(job, provider) {
  const sourceUrl = canonicalJobUrl(job.applyUrl || job.url);
  const identity = String(job.id || job.slug || sourceUrl || '').trim().toLowerCase();
  const suffix = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 12);
  return `${provider}:${identity || 'unknown'}:${suffix}`;
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { schemaVersion: 1, updatedAt: '', snapshots: {}, attempts: {} };
  const parsed = readJsonFile(STATE_PATH);
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
    throw new Error(`Unexpected ATS form state format at ${path.relative(ROOT, STATE_PATH)}`);
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' && !Array.isArray(parsed.snapshots) ? parsed.snapshots : {},
    attempts: parsed.attempts && typeof parsed.attempts === 'object' && !Array.isArray(parsed.attempts) ? parsed.attempts : {},
  };
}

function collectCandidates() {
  if (!fs.existsSync(SLICES_DIR)) throw new Error(`Crawler slices are missing: ${SLICES_DIR}`);
  const files = fs.readdirSync(SLICES_DIR).filter((file) => file.endsWith('.json')).sort();
  const candidates = new Map();
  for (const file of files) {
    const fullPath = path.join(SLICES_DIR, file);
    for (const job of iterateJsonArrayFile(fullPath)) {
      if (!job || typeof job !== 'object') continue;
      const provider = identifyATSProvider(job);
      if (!provider) continue;
      const key = captureKey(job, provider);
      if (!key || candidates.has(key)) continue;
      candidates.set(key, {
        key,
        provider,
        job,
        jobUrl: canonicalJobUrl(job.applyUrl || job.url),
        jobId: String(job.id || ''),
        jobSlug: String(job.slug || ''),
        sourceUrl: canonicalJobUrl(job.applyUrl || job.url),
      });
    }
  }
  return candidates;
}

function isSnapshotFresh(entry, candidate, nowMs) {
  if (!entry || entry.provider !== candidate.provider || entry.jobUrl !== candidate.jobUrl) return false;
  const checkedAt = Date.parse(entry.snapshot?.checkedAt || '');
  return Number.isFinite(checkedAt) && nowMs - checkedAt < SNAPSHOT_TTL_MS;
}

function nextAttemptIsFuture(attempt, candidate, nowMs) {
  if (!attempt || attempt.provider !== candidate.provider || attempt.jobUrl !== candidate.jobUrl) return false;
  const nextAt = Date.parse(attempt.nextAttemptAt || '');
  return Number.isFinite(nextAt) && nextAt > nowMs;
}

function attemptsInRoundRobin(candidates, state, nowMs, maxPerRun, refresh = false) {
  const byProvider = new Map();
  for (const candidate of candidates) {
    const entry = state.snapshots[candidate.key];
    if (!refresh && isSnapshotFresh(entry, candidate, nowMs)) continue;
    if (!refresh && nextAttemptIsFuture(state.attempts[candidate.key], candidate, nowMs)) continue;
    const list = byProvider.get(candidate.provider) || [];
    list.push(candidate);
    byProvider.set(candidate.provider, list);
  }
  for (const list of byProvider.values()) {
    list.sort((a, b) => {
      const aAt = Date.parse(state.attempts[a.key]?.attemptedAt || '') || 0;
      const bAt = Date.parse(state.attempts[b.key]?.attemptedAt || '') || 0;
      return aAt - bAt || a.key.localeCompare(b.key);
    });
  }

  const providers = [...byProvider.keys()].sort();
  const selected = [];
  while (providers.length && selected.length < maxPerRun) {
    for (let index = providers.length - 1; index >= 0; index -= 1) {
      const provider = providers[index];
      const candidate = byProvider.get(provider).shift();
      if (candidate) selected.push(candidate);
      if (byProvider.get(provider).length === 0) providers.splice(index, 1);
      if (selected.length >= maxPerRun) break;
    }
  }
  return selected;
}

function retryDelay({ outcome, status, retryAfterMs = 0, attemptCount = 1 }) {
  if (outcome === 'empty') return EMPTY_RETRY_MS;
  if (status === 404) return GONE_RETRY_MS;
  if (status === 429) return Math.max(retryAfterMs, 60 * 60 * 1000);
  const exponential = 6 * 60 * 60 * 1000 * (2 ** Math.max(0, Math.min(attemptCount - 1, 4)));
  return Math.min(exponential, MAX_RETRY_MS);
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function buildSidecarSnapshot(candidate, form, capturedAt) {
  return {
    provider: candidate.provider,
    jobId: candidate.jobId,
    jobSlug: candidate.jobSlug,
    jobUrl: candidate.jobUrl,
    snapshot: { ...form, checkedAt: capturedAt },
  };
}

async function main() {
  const now = new Date();
  const nowMs = now.getTime();
  const maxRaw = Number(option('max', process.env.ATS_FORM_CAPTURE_MAX || DEFAULT_MAX_PER_RUN));
  const concurrencyRaw = Number(option('concurrency', process.env.ATS_FORM_CAPTURE_CONCURRENCY || DEFAULT_CONCURRENCY));
  const maxPerRun = Number.isInteger(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 2000) : DEFAULT_MAX_PER_RUN;
  const concurrency = Number.isInteger(concurrencyRaw) && concurrencyRaw > 0 ? Math.min(concurrencyRaw, 8) : DEFAULT_CONCURRENCY;
  const providerFilter = option('provider').trim().toLowerCase();
  const refresh = process.argv.includes('--refresh');
  const state = readState();
  const initialEntries = JSON.stringify({ snapshots: state.snapshots, attempts: state.attempts });
  const candidates = collectCandidates();
  const liveKeys = new Set(candidates.keys());
  const filtered = [...candidates.values()].filter((candidate) => !providerFilter || candidate.provider === providerFilter);
  const selected = attemptsInRoundRobin(filtered, state, nowMs, maxPerRun, refresh);
  const stats = { discovered: candidates.size, eligible: filtered.length, selected: selected.length, captured: 0, empty: 0, failed: 0, rateLimited: 0 };
  const providerCooldowns = new Map();
  const recruiteeCache = new Map();
  const timeoutMs = Number(process.env.ATS_FORM_CAPTURE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  console.log(`ATS form capture: ${stats.discovered} supported jobs; ${stats.eligible} eligible; processing ${stats.selected} with concurrency ${concurrency}.`);

  await runWithConcurrency(selected, concurrency, async (candidate) => {
    const cooldown = providerCooldowns.get(candidate.provider) || 0;
    if (cooldown > Date.now()) return;
    const previousAttempt = state.attempts[candidate.key];
    const attemptCount = (Number(previousAttempt?.attemptCount) || 0) + 1;
    const attemptedAt = new Date().toISOString();
    try {
      const form = await captureATSApplicationForm(candidate.job, {
        checkedAt: attemptedAt,
        timeoutMs,
        recruiteeCache,
      });
      if (form?.fields?.length) {
        state.snapshots[candidate.key] = buildSidecarSnapshot(candidate, form, attemptedAt);
        state.attempts[candidate.key] = {
          provider: candidate.provider,
          jobUrl: candidate.jobUrl,
          attemptedAt,
          nextAttemptAt: new Date(Date.now() + SNAPSHOT_TTL_MS).toISOString(),
          attemptCount,
          outcome: 'captured',
        };
        stats.captured += 1;
      } else {
        state.attempts[candidate.key] = {
          provider: candidate.provider,
          jobUrl: candidate.jobUrl,
          attemptedAt,
          nextAttemptAt: new Date(Date.now() + EMPTY_RETRY_MS).toISOString(),
          attemptCount,
          outcome: 'empty',
        };
        stats.empty += 1;
      }
    } catch (error) {
      const status = error instanceof ATSFormCaptureError ? error.status : 0;
      const retryAfterMs = error instanceof ATSFormCaptureError ? error.retryAfterMs : 0;
      const outcome = status === 429 ? 'rate-limited' : status === 404 ? 'gone' : 'error';
      const delayMs = retryDelay({ outcome, status, retryAfterMs, attemptCount });
      if (status === 429) {
        providerCooldowns.set(candidate.provider, Date.now() + Math.max(retryAfterMs, 60 * 60 * 1000));
        stats.rateLimited += 1;
      } else {
        stats.failed += 1;
      }
      state.attempts[candidate.key] = {
        provider: candidate.provider,
        jobUrl: candidate.jobUrl,
        attemptedAt,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
        attemptCount,
        outcome,
        ...(status ? { status } : {}),
      };
      console.warn(`  ${candidate.provider}: ${outcome} for ${candidate.jobId || candidate.jobSlug || candidate.jobUrl}${status ? ` (HTTP ${status})` : ''}`);
    }
  });

  for (const key of Object.keys(state.snapshots)) {
    if (!liveKeys.has(key)) delete state.snapshots[key];
  }
  for (const key of Object.keys(state.attempts)) {
    if (!liveKeys.has(key)) delete state.attempts[key];
  }
  if (initialEntries !== JSON.stringify({ snapshots: state.snapshots, attempts: state.attempts })) {
    state.updatedAt = new Date().toISOString();
  }

  const previous = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, 'utf8') : '';
  const next = `${JSON.stringify(state, null, 2)}\n`;
  if (previous !== next) writeJsonAtomic(STATE_PATH, state);

  console.log(`ATS form capture complete: ${stats.captured} captured, ${stats.empty} empty, ${stats.failed} failed, ${stats.rateLimited} rate limited.`);
}

main().catch((error) => {
  console.error(`ATS application-form capture failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
