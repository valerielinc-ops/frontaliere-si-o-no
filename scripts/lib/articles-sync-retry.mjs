/**
 * Retry the complete article sync when the published HTTP release moves between
 * the corpus and artifact pulls or an artifact contradicts its pinned manifest.
 * Other skips and failures keep their existing fail-closed behavior.
 */

export const MAX_ARTICLE_SYNC_ATTEMPTS = 3;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const MOVED_RELEASE_RE = /^the published API moved from [0-9a-f]{40} to [0-9a-f]{40} while this run was working;/;

export function isPublishedApiMovement(reason) {
  return typeof reason === 'string' && MOVED_RELEASE_RE.test(reason);
}

export async function retryArticleSyncPair({
  runCorpus,
  runApi,
  maxAttempts = MAX_ARTICLE_SYNC_ATTEMPTS,
  onRetry = () => {},
}) {
  const limit = Number.isSafeInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : MAX_ARTICLE_SYNC_ATTEMPTS;

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const corpus = await runCorpus({ attempt });
    if (!corpus || corpus.exitCode !== 0) {
      return {
        status: 'failed',
        stage: 'corpus',
        exitCode: corpus?.exitCode || 1,
        attempts: attempt,
      };
    }
    if (corpus.skipped) {
      const reason = corpus.reason || 'the corpus pull skipped without a reason';
      if (!isPublishedApiMovement(reason) || attempt === limit) {
        return { status: 'skipped', stage: 'corpus', reason, attempts: attempt };
      }
      onRetry({ attempt, nextAttempt: attempt + 1, stage: 'corpus', reason });
      continue;
    }
    if (typeof corpus.commit !== 'string' || !FULL_SHA_RE.test(corpus.commit)) {
      return {
        status: 'failed',
        stage: 'corpus',
        exitCode: 1,
        reason: 'the corpus pull did not publish a full commit pin',
        attempts: attempt,
      };
    }

    const api = await runApi({ attempt, commit: corpus.commit });
    if (!api || api.exitCode !== 0) {
      if (api?.retryableSnapshot === true && attempt < limit) {
        const reason = api.reason || 'a manifest-pinned HTTP artifact did not match its snapshot';
        onRetry({
          attempt,
          nextAttempt: attempt + 1,
          stage: 'api-snapshot',
          commit: corpus.commit,
          reason,
        });
        continue;
      }
      return {
        status: 'failed',
        stage: 'api',
        exitCode: api?.exitCode || 1,
        ...(api?.reason ? { reason: api.reason } : {}),
        attempts: attempt,
      };
    }
    if (api.skipped) {
      const reason = api.reason || 'the published API pull skipped without a reason';
      if (!isPublishedApiMovement(reason)) {
        return { status: 'skipped', stage: 'api', reason, attempts: attempt };
      }
      if (attempt === limit) {
        return { status: 'skipped', stage: 'api', reason, attempts: attempt };
      }
      onRetry({ attempt, nextAttempt: attempt + 1, commit: corpus.commit, reason });
      continue;
    }

    if (api.commit !== corpus.commit) {
      return {
        status: 'failed',
        stage: 'api',
        exitCode: 1,
        reason: `the API pull completed with pin ${api.commit || '<missing>'}, expected ${corpus.commit}`,
        attempts: attempt,
      };
    }
    return { status: 'success', commit: corpus.commit, attempts: attempt };
  }

  return {
    status: 'failed',
    stage: 'retry',
    exitCode: 1,
    reason: 'article sync ended without a terminal result',
    attempts: limit,
  };
}
