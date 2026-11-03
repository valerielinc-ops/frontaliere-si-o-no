/** Shared storage/API contract for the private Instagram Story insights path. */
export const INSTAGRAM_STORY_METRIC_FIELDS = Object.freeze({
  views: 'views',
  reach: 'reach',
  totalInteractions: 'total_interactions',
  replies: 'replies',
  shares: 'shares',
  follows: 'follows',
  profileVisits: 'profile_visits',
  tapsForward: 'navigation',
  tapsBack: 'navigation',
  exits: 'navigation',
  swipesForward: 'navigation',
});

export const INSTAGRAM_STORY_METRICS = Object.freeze(Object.keys(INSTAGRAM_STORY_METRIC_FIELDS));
export const INSTAGRAM_STORY_MEASUREMENT_WINDOWS = Object.freeze([
  Object.freeze({ id: 'first-hour', minHours: 0, maxHours: 1 }),
  Object.freeze({ id: 'near-24h', minHours: 22, maxHours: 24 }),
]);
export const INSTAGRAM_STORY_MEASUREMENT_WINDOW_IDS = Object.freeze(
  INSTAGRAM_STORY_MEASUREMENT_WINDOWS.map(({ id }) => id),
);
export const INSTAGRAM_STORY_RETENTION_DAYS = 100;
export const INSTAGRAM_STORY_MAX_ROWS = 400;
