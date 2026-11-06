const EXPERIMENTAL_CANDIDATE_KEYWORD_MAX_LENGTH = 180;
const EXPERIMENTAL_CANDIDATE_ANGLE_MAX_LENGTH = 180;
const EXPERIMENTAL_CANDIDATE_FEED_MAX_COUNT = 100;
const EXPERIMENTAL_SOURCE_LABELS = new Map([
  ['redditTicino', 'reddit'],
  ['redditItaly', 'reddit'],
  ['redditLugano', 'reddit'],
  ['redditSwitzerland', 'reddit'],
  ['googleNewsRss', 'google-news-rss'],
]);
const EXPERIMENTAL_LOCALES = new Set(['it', 'en', 'de', 'fr']);

function emptyExperimentalCandidateFeed() {
  return { schemaVersion: 1, generatedAt: null, candidates: [] };
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedFeedText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const bounded = Array.from(cleaned).slice(0, maxLength).join('').trim();
  return bounded || null;
}

function normalizeRedditPermalink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const rawAuthority = value.match(/^https:\/\/([^/?#]+)/iu)?.[1];
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.reddit.com'
      || url.username || url.password || url.port
      || rawAuthority?.toLowerCase() !== 'www.reddit.com') return null;
    const match = url.pathname.match(/^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/[^/]*)?\/?$/iu);
    if (!match) return null;
    return `https://www.reddit.com/r/${match[1]}/comments/${match[2]}/`;
  } catch {
    return null;
  }
}

/** Return the strict, versioned public projection of the private miner file. */
export function projectExperimentalCandidateFeed(source) {
  if (typeof source !== 'string') return emptyExperimentalCandidateFeed();

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return emptyExperimentalCandidateFeed();
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates) || typeof parsed.generatedAt !== 'string') {
    return emptyExperimentalCandidateFeed();
  }
  const generatedAtMs = Date.parse(parsed.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return emptyExperimentalCandidateFeed();

  const candidates = [];
  for (const candidate of parsed.candidates) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || !/^[a-f0-9]{8}$/iu.test(candidate.id)) continue;

    const keyword = boundedFeedText(candidate.keyword, EXPERIMENTAL_CANDIDATE_KEYWORD_MAX_LENGTH);
    const locale = typeof candidate.locale === 'string' ? candidate.locale.toLowerCase() : '';
    const totalScore = candidate.totalScore;
    const sources = Array.isArray(candidate.sources)
      ? [...new Set(candidate.sources.flatMap((sourceLabel) => {
        const normalized = typeof sourceLabel === 'string' ? EXPERIMENTAL_SOURCE_LABELS.get(sourceLabel) : undefined;
        return normalized ? [normalized] : [];
      }))]
      : [];
    if (!keyword || !EXPERIMENTAL_LOCALES.has(locale) || sources.length === 0
      || typeof totalScore !== 'number' || !Number.isFinite(totalScore) || totalScore < 0 || totalScore > 1) continue;

    const projected = {
      id: candidate.id.toLowerCase(),
      keyword,
      angle: boundedFeedText(candidate.angle, EXPERIMENTAL_CANDIDATE_ANGLE_MAX_LENGTH),
      locale,
      sources,
      totalScore,
    };
    const redditPermalink = isRecord(candidate.demandSignals)
      ? normalizeRedditPermalink(candidate.demandSignals.redditUrl)
      : null;
    if (redditPermalink && sources.includes('reddit')) projected.redditPermalink = redditPermalink;
    candidates.push(projected);
    if (candidates.length >= EXPERIMENTAL_CANDIDATE_FEED_MAX_COUNT) break;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    candidates,
  };
}

export { emptyExperimentalCandidateFeed };
