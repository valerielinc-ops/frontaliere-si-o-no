#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectExperimentalCandidateFeed } from '../lib/experimentalCandidateFeedProjection.mjs';

export const CANDIDATE_FEED_URL = 'https://cdn.frontaliereticino.ch/data/experimental-candidate-feed.json';
export const CANDIDATE_FEED_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
export const CANDIDATE_FEED_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CANDIDATE_FEED_MAX_CANDIDATES = 100;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_PATH = path.join(ROOT, 'data', 'experimental-candidates.json');
const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const SOURCES = new Set(['reddit', 'google-news-rss']);
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validGeneratedAt(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return 'invalid';
  const generatedAtMs = Date.parse(value);
  if (!Number.isFinite(generatedAtMs)) return 'invalid';
  if (generatedAtMs > nowMs + CANDIDATE_FEED_MAX_FUTURE_SKEW_MS) return 'invalid';
  if (nowMs - generatedAtMs > CANDIDATE_FEED_MAX_AGE_MS) return 'stale';
  return 'fresh';
}

function validPublicCandidate(candidate) {
  if (!isRecord(candidate)) return false;
  const allowed = new Set(['id', 'keyword', 'angle', 'locale', 'sources', 'totalScore', 'redditPermalink']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) return false;
  if (typeof candidate.id !== 'string' || !/^[a-f0-9]{8}$/.test(candidate.id)) return false;
  if (typeof candidate.keyword !== 'string'
    || !candidate.keyword.trim()
    || candidate.keyword.trim() !== candidate.keyword
    || /[\u0000-\u001f\u007f]/u.test(candidate.keyword)
    || Array.from(candidate.keyword).length > 180) return false;
  if (!Object.hasOwn(candidate, 'angle')
    || (candidate.angle !== null && (typeof candidate.angle !== 'string'
      || candidate.angle.trim() !== candidate.angle
      || /[\u0000-\u001f\u007f]/u.test(candidate.angle)
      || Array.from(candidate.angle).length > 180))) return false;
  if (!LOCALES.has(candidate.locale)) return false;
  if (!Array.isArray(candidate.sources) || candidate.sources.length < 1 || candidate.sources.length > 5
    || candidate.sources.some((source) => !SOURCES.has(source))) return false;
  if (!Number.isFinite(candidate.totalScore) || candidate.totalScore < 0 || candidate.totalScore > 1) return false;
  if (candidate.redditPermalink != null) {
    if (!validRedditPermalink(candidate.redditPermalink) || !candidate.sources.includes('reddit')) return false;
  }
  return true;
}

function validRedditPermalink(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const rawAuthority = value.match(/^https:\/\/([^/?#]+)/iu)?.[1];
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'www.reddit.com'
      && !url.username && !url.password && !url.port
      && url.search === '' && url.hash === ''
      && rawAuthority?.toLowerCase() === 'www.reddit.com'
      && /^\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+(?:\/[^/]*)?\/?$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

function classifySource(raw, nowMs) {
  if (typeof raw !== 'string') return { state: 'missing', candidateCount: null };
  let source;
  try {
    source = JSON.parse(raw);
  } catch {
    return { state: 'invalid', candidateCount: null };
  }
  if (!isRecord(source) || !isRecord(source.sources) || !Array.isArray(source.candidates)) {
    return { state: 'invalid', candidateCount: null };
  }
  const freshness = validGeneratedAt(source.generatedAt, nowMs);
  const hasSuccessfulProvider = Object.values(source.sources).some((provider) => (
    isRecord(provider) && provider.ok === true
  ));
  if (freshness === 'fresh' && !hasSuccessfulProvider) {
    return { state: 'unhealthy', candidateCount: source.candidates.length };
  }
  return {
    state: freshness === 'fresh' ? 'fresh' : freshness === 'stale' ? 'stale' : 'invalid',
    candidateCount: source.candidates.length,
  };
}

function classifyPublished(raw, httpStatus, nowMs) {
  if (httpStatus !== 200) return { state: 'http_unavailable', candidateCount: null };
  if (typeof raw !== 'string') return { state: 'invalid', candidateCount: null };
  let feed;
  try {
    feed = JSON.parse(raw);
  } catch {
    return { state: 'invalid', candidateCount: null };
  }
  if (!isRecord(feed)
    || Object.keys(feed).some((key) => !['schemaVersion', 'generatedAt', 'candidates'].includes(key))
    || feed.schemaVersion !== 1
    || !Array.isArray(feed.candidates)
    || feed.candidates.length > CANDIDATE_FEED_MAX_CANDIDATES
    || feed.candidates.some((candidate) => !validPublicCandidate(candidate))) {
    return { state: 'invalid', candidateCount: Array.isArray(feed?.candidates) ? feed.candidates.length : null };
  }
  const freshness = validGeneratedAt(feed.generatedAt, nowMs);
  return {
    state: freshness === 'fresh' ? 'fresh' : freshness === 'stale' ? 'stale' : 'invalid',
    candidateCount: feed.candidates.length,
    feed,
  };
}

function samePublicCandidate(left, right) {
  return left.id === right.id
    && left.keyword === right.keyword
    && left.angle === right.angle
    && left.locale === right.locale
    && left.totalScore === right.totalScore
    && Array.isArray(left.sources)
    && Array.isArray(right.sources)
    && left.sources.length === right.sources.length
    && left.sources.every((source, index) => source === right.sources[index])
    && (left.redditPermalink ?? null) === (right.redditPermalink ?? null);
}

function samePublicProjection(expected, published) {
  return expected.schemaVersion === published.schemaVersion
    && expected.generatedAt === published.generatedAt
    && expected.candidates.length === published.candidates.length
    && expected.candidates.every((candidate, index) => (
      samePublicCandidate(candidate, published.candidates[index])
    ));
}

/**
 * Return a bounded recovery decision without exposing candidate text or URLs.
 * A fresh feed with zero candidates is valid; recovery is driven by freshness
 * and contract failures, never by editorially valid emptiness.
 */
export function assessCandidateFeedHealth({
  publishedRaw,
  publishedStatus = 200,
  sourceRaw,
  now = Date.now(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid date or epoch time');
  const published = classifyPublished(publishedRaw, publishedStatus, nowMs);
  const source = classifySource(sourceRaw, nowMs);
  const projectionInSync = source.state === 'fresh'
    && published.state === 'fresh'
    && samePublicProjection(projectExperimentalCandidateFeed(sourceRaw), published.feed);
  const publishedState = published.state === 'fresh'
    && source.state === 'fresh'
    && !projectionInSync
    ? 'out_of_sync'
    : published.state;
  const recoveryTarget = source.state === 'fresh'
    ? publishedState === 'fresh' ? 'none' : 'deploy'
    : 'mine';
  return {
    publishedState,
    sourceState: source.state,
    publishedCandidateCount: published.candidateCount,
    sourceCandidateCount: source.candidateCount,
    recoveryTarget,
  };
}

function appendOutput(outputPath, assessment) {
  if (!outputPath) return;
  fs.appendFileSync(outputPath, [
    `recovery_target=${assessment.recoveryTarget}`,
    `published_state=${assessment.publishedState}`,
    `source_state=${assessment.sourceState}`,
  ].join('\n') + '\n');
}

export async function runCandidateFeedHealth({
  fetchImpl = fetch,
  sourcePath = SOURCE_PATH,
  now = Date.now(),
  outputPath = process.env.GITHUB_OUTPUT,
} = {}) {
  let publishedStatus = 0;
  let publishedRaw = null;
  try {
    const response = await fetchImpl(CANDIDATE_FEED_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    publishedStatus = response.status;
    if (response.status === 200) publishedRaw = await response.text();
  } catch {
    publishedStatus = 0;
  }

  let sourceRaw = null;
  try {
    sourceRaw = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    sourceRaw = null;
  }

  const assessment = assessCandidateFeedHealth({ publishedRaw, publishedStatus, sourceRaw, now });
  appendOutput(outputPath, assessment);
  console.log(
    `CANDIDATE_FEED_HEALTH published=${assessment.publishedState}`
    + ` source=${assessment.sourceState} recovery=${assessment.recoveryTarget}`
    + ` published_count=${assessment.publishedCandidateCount ?? 'unknown'}`
    + ` source_count=${assessment.sourceCandidateCount ?? 'unknown'}`,
  );
  return assessment;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await runCandidateFeedHealth();
}
