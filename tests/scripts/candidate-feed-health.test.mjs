import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCandidateFeedHealth,
  CANDIDATE_FEED_MAX_AGE_MS,
} from '../../scripts/ci/candidate-feed-health.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const freshAt = (ageMs = 60_000) => new Date(NOW - ageMs).toISOString();

function sourceFeed({ generatedAt = freshAt(), candidates = [] } = {}) {
  return JSON.stringify({ generatedAt, sources: {}, candidates });
}

function publicFeed({ generatedAt = freshAt(), candidates = [] } = {}) {
  return JSON.stringify({ schemaVersion: 1, generatedAt, candidates });
}

test('a fresh empty public feed is healthy and does not trigger mining or deployment', () => {
  assert.deepEqual(assessCandidateFeedHealth({
    publishedRaw: publicFeed(),
    sourceRaw: sourceFeed(),
    now: NOW,
  }), {
    publishedState: 'fresh',
    sourceState: 'fresh',
    publishedCandidateCount: 0,
    sourceCandidateCount: 0,
    recoveryTarget: 'none',
  });
});

test('a fresh source with a missing or stale CDN projection triggers only a deploy', () => {
  const missing = assessCandidateFeedHealth({
    publishedStatus: 404,
    publishedRaw: null,
    sourceRaw: sourceFeed(),
    now: NOW,
  });
  assert.equal(missing.recoveryTarget, 'deploy');
  assert.equal(missing.sourceState, 'fresh');

  const stale = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ generatedAt: freshAt(CANDIDATE_FEED_MAX_AGE_MS + 1) }),
    sourceRaw: sourceFeed(),
    now: NOW,
  });
  assert.equal(stale.publishedState, 'stale');
  assert.equal(stale.recoveryTarget, 'deploy');
});

test('a stale, missing, or invalid source triggers the existing miner', () => {
  for (const sourceRaw of [
    null,
    '{ invalid json',
    sourceFeed({ generatedAt: freshAt(CANDIDATE_FEED_MAX_AGE_MS + 1) }),
  ]) {
    const result = assessCandidateFeedHealth({
      publishedRaw: publicFeed(),
      sourceRaw,
      now: NOW,
    });
    assert.equal(result.recoveryTarget, 'mine');
  }
});

test('an invalid public schema triggers deploy without copying candidate text into diagnostics', () => {
  const result = assessCandidateFeedHealth({
    publishedRaw: JSON.stringify({ schemaVersion: 2, generatedAt: freshAt(), candidates: [{ keyword: 'private query' }] }),
    sourceRaw: sourceFeed(),
    now: NOW,
  });
  assert.equal(result.publishedState, 'invalid');
  assert.equal(result.recoveryTarget, 'deploy');
  assert.equal(JSON.stringify(result).includes('private query'), false);
});

test('candidate rows must match the bounded public schema', () => {
  const invalidCandidate = {
    id: 'bad-id',
    keyword: 'example',
    angle: null,
    locale: 'it',
    sources: ['google-news-rss'],
    totalScore: 0.5,
  };
  const result = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ candidates: [invalidCandidate] }),
    sourceRaw: sourceFeed(),
    now: NOW,
  });
  assert.equal(result.publishedState, 'invalid');
  assert.equal(result.recoveryTarget, 'deploy');
});

test('Reddit links must match the normalized public post URL shape', () => {
  const candidate = {
    id: 'a1b2c3d4',
    keyword: 'example',
    angle: null,
    locale: 'it',
    sources: ['reddit'],
    totalScore: 0.5,
    redditPermalink: 'https://www.reddit.com/r/ticino/comments/abc123/',
  };
  const valid = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ candidates: [candidate] }),
    sourceRaw: sourceFeed(),
    now: NOW,
  });
  assert.equal(valid.publishedState, 'fresh');

  const invalid = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ candidates: [{
      ...candidate,
      redditPermalink: 'https://www.reddit.com/r/ticino/redirect?target=https://example.test',
    }] }),
    sourceRaw: sourceFeed(),
    now: NOW,
  });
  assert.equal(invalid.publishedState, 'invalid');
});
