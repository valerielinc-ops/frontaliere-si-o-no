import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assessCandidateFeedHealth,
  CANDIDATE_FEED_MAX_AGE_MS,
} from '../../scripts/ci/candidate-feed-health.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const freshAt = (ageMs = 60_000) => new Date(NOW - ageMs).toISOString();
const HEALTH_WORKFLOW = readFileSync(new URL('../../.github/workflows/topic-candidate-feed-health.yml', import.meta.url), 'utf8');

test('recovery defers while a target workflow run is pending', () => {
  const statusSets = [...HEALTH_WORKFLOW.matchAll(/\[([^\]]+)\]\.includes\(run\.status\)/gu)]
    .map((match) => match[1]);
  assert.equal(statusSets.length, 3);
  for (const statuses of statusSets) assert.match(statuses, /['"]pending['"]/u);
});

test('candidate feed health has a native schedule as a fallback to the external loop clock', () => {
  assert.match(HEALTH_WORKFLOW, /schedule:/u);
  assert.match(HEALTH_WORKFLOW, /cron: '23 4,10,16,22 \* \* \*'/u);
  assert.match(HEALTH_WORKFLOW, /workflow_dispatch:/u);
});

function sourceFeed({
  generatedAt = freshAt(),
  candidates = [],
  sources = { googleNewsRss: { ok: true, candidates: 0 } },
} = {}) {
  return JSON.stringify({ generatedAt, sources, candidates });
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

test('a fresh source with every provider failed or missing is re-mined', () => {
  for (const sources of [
    {},
    {
      redditTicino: { ok: false, candidates: 0 },
      googleNewsRss: { ok: false, candidates: 0 },
    },
  ]) {
    const result = assessCandidateFeedHealth({
      publishedRaw: publicFeed(),
      sourceRaw: sourceFeed({ sources }),
      now: NOW,
    });
    expectHealthUnhealthySource(result);
  }
});

function expectHealthUnhealthySource(result) {
  assert.equal(result.sourceState, 'unhealthy');
  assert.equal(result.recoveryTarget, 'mine');
}

test('a fresh public projection from another source snapshot triggers only a deploy', () => {
  const result = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ generatedAt: freshAt(2 * 60_000) }),
    sourceRaw: sourceFeed({ generatedAt: freshAt(60_000) }),
    now: NOW,
  });
  assert.equal(result.publishedState, 'out_of_sync');
  assert.equal(result.sourceState, 'fresh');
  assert.equal(result.recoveryTarget, 'deploy');
});

test('a projection with the right timestamp but missing candidate identities is rebuilt', () => {
  const generatedAt = freshAt();
  const result = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ generatedAt, candidates: [] }),
    sourceRaw: sourceFeed({
      generatedAt,
      candidates: [{
        id: 'a1b2c3d4',
        keyword: 'Permesso G',
        angle: null,
        locale: 'it',
        sources: ['redditTicino'],
        totalScore: 0.5,
      }],
    }),
    now: NOW,
  });
  assert.equal(result.publishedState, 'out_of_sync');
  assert.equal(result.recoveryTarget, 'deploy');
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
  const sourceRaw = sourceFeed({ candidates: [{
    id: candidate.id,
    keyword: candidate.keyword,
    angle: candidate.angle,
    locale: candidate.locale,
    sources: ['redditTicino'],
    totalScore: candidate.totalScore,
    demandSignals: { redditUrl: candidate.redditPermalink },
  }] });
  const valid = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ candidates: [candidate] }),
    sourceRaw,
    now: NOW,
  });
  assert.equal(valid.publishedState, 'fresh');

  const invalid = assessCandidateFeedHealth({
    publishedRaw: publicFeed({ candidates: [{
      ...candidate,
      redditPermalink: 'https://www.reddit.com/r/ticino/redirect?target=https://example.test',
    }] }),
    sourceRaw,
    now: NOW,
  });
  assert.equal(invalid.publishedState, 'invalid');
});
