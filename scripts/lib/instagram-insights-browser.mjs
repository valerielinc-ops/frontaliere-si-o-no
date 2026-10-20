/**
 * Read-only Instagram Insights collector for the authenticated Chrome profile.
 *
 * The official Insights API is not available in this installation, while the
 * owner already has a valid Professional Dashboard session in Chrome. This
 * adapter deliberately uses the visible dashboard only: it reads the content
 * cards, opens each card through the normal UI and parses the visible metric
 * labels. It never reads cookies, localStorage or private Graph requests.
 *
 * Ledger timestamps choose the eligible 72h cohort. The first CDN image of a
 * queued post identifies the card, because the dashboard detail view does not
 * expose a reliable publish timestamp in the visible DOM. Ambiguous or weak
 * image matches are rejected rather than attributed to the wrong creative.
 */
import sharp from 'sharp';

import {
  buildSnapshotDocument,
  selectSnapshotCandidates,
} from './instagram-insights-snapshot.mjs';

export const INSTAGRAM_INSIGHTS_CONTENT_URL = 'https://www.instagram.com/accounts/insights/content/?media_type=all&metric=views&sort_by=recent&timeframe=30&view_type=card';
export const INSTAGRAM_INSIGHTS_DETAIL_PATTERN = /\/insights\/media\/(\d+)/u;
export const INSTAGRAM_SOCIAL_IMAGE_BASE = 'https://cdn.frontaliereticino.ch/images/social/instagram/';
export const DEFAULT_VISUAL_MATCH_THRESHOLD = 0.00025;
export const DEFAULT_VISUAL_MATCH_MARGIN = 0.00005;
export const DEFAULT_IMAGE_FINGERPRINT_SIZE = 24;

const METRIC_ALIASES = Object.freeze({
  views: ['visualizzazioni', 'views', 'impressions', 'visualizzazioni totali'],
  reach: ['account raggiunti', 'accounts reached', 'copertura', 'reach'],
  shares: ['condivisioni', 'shares'],
  saves: ['salvataggi', 'saves', 'saved'],
  comments: ['commenti', 'comments'],
  profileVisits: ['visite al profilo', 'profile visits', 'profile activity'],
  linkClicks: ['tocchi sul link esterno', 'link clicks', 'website clicks'],
  interactions: ['interazioni', 'interactions'],
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value) {
  const result = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return result || null;
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  let normalised = String(value).replace(/\s+/gu, '');
  const comma = normalised.includes(',');
  const dot = normalised.includes('.');
  if (comma && dot) {
    // The last separator is the decimal mark: 1.234,56 (it) or 1,234.56
    // (en). Remove the other separator as a grouping mark.
    if (normalised.lastIndexOf(',') > normalised.lastIndexOf('.')) {
      normalised = normalised.replaceAll('.', '').replace(',', '.');
    } else {
      normalised = normalised.replaceAll(',', '');
    }
  } else if (comma || dot) {
    const separator = comma ? ',' : '.';
    const parts = normalised.split(separator);
    const grouped = parts.length > 1 && parts.slice(1).every((part) => /^\d{3}$/u.test(part));
    normalised = grouped ? parts.join('') : normalised.replace(',', '.');
  }
  const parsed = Number(normalised);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normaliseLabel(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/gu, ' ')
    .trim();
}

function metricLabelPattern(labels) {
  return labels
    .map((label) => normaliseLabel(label).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
}

function readMetricFromText(body, labels) {
  const labelPattern = metricLabelPattern(labels);
  if (!labelPattern) return null;
  const source = String(body ?? '').replace(/\u00a0/gu, ' ');
  const lines = source.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = normaliseLabel(lines[index]);
    if (!new RegExp(`^(?:${labelPattern})$`, 'u').test(line)) continue;
    // The detail view renders a label once as a section heading and once next
    // to its value. Looking forward avoids borrowing the previous metric's
    // value when the current metric legitimately equals zero.
    for (const next of [lines[index + 1], lines[index + 2]]) {
      const match = String(next || '').match(/(?:^|\s)(\d[\d\s.,]*)(?:\s|$)/u);
      const parsed = positiveNumber(match?.[1]);
      if (parsed !== null) candidates.push(parsed);
    }
  }
  // A few dashboard builds render “Label 123” in one node.
  const inline = source.match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[:：-]?\\s*(\\d[\\d\\s.,]*)`, 'iu'));
  const inlineValue = positiveNumber(inline?.[1]);
  if (inlineValue !== null) candidates.push(inlineValue);
  return candidates.length ? candidates[0] : null;
}

/** Parse the visible Italian/English metric labels from a detail page. */
export function parseInstagramBrowserMetrics(bodyText) {
  const metrics = {};
  for (const [name, aliases] of Object.entries(METRIC_ALIASES)) {
    const value = readMetricFromText(bodyText, aliases);
    if (value !== null) metrics[name] = value;
  }
  const views = metrics.views ?? null;
  const explicitReach = metrics.reach ?? null;
  const audienceBase = explicitReach ?? views;
  return {
    views,
    reach: audienceBase,
    reachSource: explicitReach === null && views !== null ? 'views' : explicitReach === null ? null : 'reach',
    audienceMetric: explicitReach === null && views !== null ? 'views' : 'reach',
    shares: metrics.shares || 0,
    saves: metrics.saves || 0,
    comments: metrics.comments || 0,
    profileVisits: metrics.profileVisits || 0,
    linkClicks: metrics.linkClicks || 0,
    interactions: metrics.interactions ?? null,
  };
}

export function hasVisibleAudienceMetrics(metrics) {
  return metrics?.views !== null && metrics?.views !== undefined
    || metrics?.reach !== null && metrics?.reach !== undefined;
}

export function parseInstagramMediaId(value) {
  const match = String(value ?? '').match(INSTAGRAM_INSIGHTS_DETAIL_PATTERN);
  return match?.[1] || null;
}

function safeImageUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'cdn.frontaliereticino.ch') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Return the deterministic first cover uploaded by the Instagram poster. */
export function coverUrlForInstagramGroup(group) {
  const recorded = safeImageUrl(group?.storyImageUrl || group?.instagramStoryImageUrl);
  if (recorded) return recorded;
  const kind = text(group?.kind);
  const day = text(group?.day);
  if (!kind || !day) return null;
  if (kind === 'reel') {
    const sourceKind = text(group?.sourceKind) || 'article';
    const creativeId = text(group?.creativeId);
    if (!creativeId) return null;
    return `${INSTAGRAM_SOCIAL_IMAGE_BASE}reel-${encodeURIComponent(sourceKind)}-${encodeURIComponent(day)}-${encodeURIComponent(creativeId)}-0.jpg`;
  }
  if (!['article', 'job', 'border'].includes(kind)) return null;
  return `${INSTAGRAM_SOCIAL_IMAGE_BASE}${encodeURIComponent(kind)}-${encodeURIComponent(day)}-0.jpg`;
}

/**
 * Fingerprint a downloaded image using a tiny RGB thumbnail. The output is
 * intentionally small and contains no source image data.
 */
export async function fingerprintImage(input, { size = DEFAULT_IMAGE_FINGERPRINT_SIZE } = {}) {
  const { data, info } = await sharp(input)
    .resize(size, size, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels || 3;
  return Array.from(data, (value, index) => Number(value) / 255).filter((_, index) => index % channels < 3);
}

export function fingerprintDistance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return Infinity;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    total += difference * difference;
  }
  return total / left.length;
}

/**
 * Match each expected cover to one visible dashboard card. A card can only be
 * used once, and a close second candidate makes the match ambiguous.
 */
export function chooseVisualMatches(
  expected,
  actual,
  { threshold = DEFAULT_VISUAL_MATCH_THRESHOLD, margin = DEFAULT_VISUAL_MATCH_MARGIN } = {},
) {
  const matches = [];
  const unmatched = [];
  const usedActual = new Set();
  for (const item of expected || []) {
    const ranked = (actual || [])
      .map((candidate, index) => ({ index, distance: fingerprintDistance(item.fingerprint, candidate.fingerprint) }))
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort((a, b) => a.distance - b.distance || a.index - b.index);
    const best = ranked[0];
    const second = ranked.find((candidate) => candidate.index !== best?.index);
    if (!best || best.distance > threshold) {
      unmatched.push({ identity: item.identity, reason: 'visual-cover-not-found', distance: best?.distance ?? null });
      continue;
    }
    if (usedActual.has(best.index)) {
      unmatched.push({ identity: item.identity, reason: 'visual-cover-already-used' });
      continue;
    }
    if (second && second.distance - best.distance < margin) {
      unmatched.push({ identity: item.identity, reason: 'visual-cover-ambiguous', distance: best.distance });
      continue;
    }
    usedActual.add(best.index);
    matches.push({ expected: item, actual: actual[best.index], distance: best.distance });
  }
  return { matches, unmatched };
}

function browserPageState(url, bodyText) {
  const currentUrl = String(url || '');
  const body = normaliseLabel(bodyText);
  if (/accounts\/login|challenge|checkpoint/iu.test(currentUrl)) return 'login-required';
  if (!/insights|professional dashboard|dashboard/iu.test(body) && /login|accedi|log in/iu.test(body)) return 'login-required';
  if (/sorry, something went wrong|qualcosa e andato storto|try again/iu.test(body)) return 'page-error';
  return 'ready';
}

async function pageBody(page) {
  return page.locator('body').innerText({ timeout: 15_000 }).catch(() => '');
}

async function readVisibleCards(page) {
  return page.locator('[role="button"]').evaluateAll((buttons) => buttons.map((button, buttonIndex) => {
    const image = button.querySelector('img');
    if (!image || (!image.currentSrc && !image.src)) return null;
    return {
      buttonIndex,
      src: image.currentSrc || image.src,
      alt: image.alt || '',
      label: button.getAttribute('aria-label') || button.textContent || '',
    };
  }).filter(Boolean)).catch(() => []);
}

async function imageBytesFromPage(page, source, fetchImpl = fetch) {
  try {
    const encoded = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`image ${response.status}`);
      const buffer = await response.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
      return btoa(binary);
    }, source);
    return Buffer.from(encoded, 'base64');
  } catch {
    const response = await fetchImpl(source);
    if (!response?.ok) throw new Error(`image ${response?.status || 'unavailable'}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

async function readCardFingerprints(page, cards, fetchImpl = fetch) {
  const result = [];
  for (const card of cards) {
    try {
      const bytes = await imageBytesFromPage(page, card.src, fetchImpl);
      result.push({ ...card, fingerprint: await fingerprintImage(bytes) });
    } catch {
      // A stale CDN thumbnail is an unmatched card, never a reason to guess.
    }
  }
  return result;
}

async function openCardAndReadMetrics(page, card) {
  const before = page.url();
  // Current Instagram uses one visible thumbnail per card. The button index is
  // captured from the same DOM pass as the image, so rewritten CDN query
  // parameters cannot select a neighbouring card.
  const locator = page.locator('[role="button"]').nth(card.buttonIndex);
  await locator.click({ timeout: 15_000 });
  await page.waitForURL((url) => Boolean(parseInstagramMediaId(url.toString())), { timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(
    () => /visualizzazioni|views|interazioni|interactions/iu.test(document.body?.innerText || ''),
    undefined,
    { timeout: 10_000 },
  ).catch(() => {});
  const detailUrl = page.url();
  const body = await pageBody(page);
  const mediaId = parseInstagramMediaId(detailUrl);
  const metrics = parseInstagramBrowserMetrics(body);
  await page.goto(before, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return { mediaId, metrics, detailUrl };
}

function snapshotAddition(group, mediaId, metrics, { asOfIso, windowHours, distance }) {
  return {
    postId: String(mediaId),
    mediaId: String(mediaId),
    queueId: group.queueId || undefined,
    kind: group.kind,
    sourceKind: group.sourceKind || undefined,
    day: group.day || undefined,
    creativeId: group.creativeId,
    creativeBaseId: group.creativeBaseId || undefined,
    creativeVariant: group.creativeVariant || undefined,
    creativeLabel: group.creativeLabel || undefined,
    creativeObjective: group.creativeObjective || undefined,
    primaryMetric: group.primaryMetric || undefined,
    engagementMechanic: group.engagementMechanic || undefined,
    hookType: group.hookType || undefined,
    attentionMechanic: group.attentionMechanic || undefined,
    engagementLoop: group.engagementLoop || undefined,
    followUpFormat: group.followUpFormat || undefined,
    windowHours,
    snapshotAt: asOfIso,
    snapshotAgeHours: Math.round(Number(group.ageHours) * 1000) / 1000,
    matchMethod: 'browser-cover-fingerprint',
    visualMatchDistance: Math.round(distance * 1_000_000) / 1_000_000,
    ...metrics,
  };
}

/**
 * Collect eligible observations using one authenticated Playwright page.
 * This function is intentionally injectable so the metric/parser/matching
 * contract is testable without opening Chrome.
 */
export async function collectInstagramBrowserSnapshots({
  page,
  ledger,
  existing = null,
  asOf = new Date(),
  windowHours = 72,
  toleranceHours = 0,
  contentUrl = INSTAGRAM_INSIGHTS_CONTENT_URL,
  fetchImpl = fetch,
  threshold = DEFAULT_VISUAL_MATCH_THRESHOLD,
  margin = DEFAULT_VISUAL_MATCH_MARGIN,
  log = console,
} = {}) {
  if (!page || typeof page.goto !== 'function') throw new Error('an authenticated Playwright page is required');
  const asOfDate = new Date(asOf);
  const asOfIso = asOfDate.toISOString();
  const selected = selectSnapshotCandidates(ledger, existing, {
    asOf: asOfDate,
    windowHours,
    toleranceHours,
  });
  if (selected.candidates.length === 0) {
    return { status: 'nothing-ready', additions: [], candidates: 0, skipped: selected.skipped };
  }

  await page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.locator('[role="button"] img').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
  const body = await pageBody(page);
  const state = browserPageState(page.url(), body);
  if (state !== 'ready') {
    return { status: state, additions: [], candidates: selected.candidates.length, skipped: selected.skipped };
  }

  const cards = await readVisibleCards(page);
  const actual = await readCardFingerprints(page, cards, fetchImpl);
  const expected = [];
  const skipped = [...selected.skipped];
  for (const group of selected.candidates) {
    const coverUrl = coverUrlForInstagramGroup(group);
    if (!coverUrl) {
      skipped.push({ reason: 'cover-url-missing', identity: group.identity });
      continue;
    }
    try {
      const response = await fetchImpl(coverUrl);
      if (!response?.ok) throw new Error(`cover ${response?.status || 'unavailable'}`);
      expected.push({
        identity: group.identity,
        group,
        coverUrl,
        fingerprint: await fingerprintImage(Buffer.from(await response.arrayBuffer())),
      });
    } catch (error) {
      skipped.push({ reason: 'cover-fetch-failed', identity: group.identity, message: String(error.message || error).slice(0, 160) });
    }
  }

  const joined = chooseVisualMatches(expected, actual, { threshold, margin });
  skipped.push(...joined.unmatched.map((item) => ({ reason: item.reason, identity: item.identity })));
  const additions = [];
  for (const match of joined.matches) {
    try {
      const detail = await openCardAndReadMetrics(page, match.actual);
      if (!detail.mediaId) {
        skipped.push({ reason: 'detail-media-id-missing', identity: match.expected.identity });
        continue;
      }
      if (!hasVisibleAudienceMetrics(detail.metrics)) {
        skipped.push({ reason: 'visible-metrics-missing', identity: match.expected.identity });
        continue;
      }
      additions.push(snapshotAddition(match.expected.group, detail.mediaId, detail.metrics, {
        asOfIso,
        windowHours,
        distance: match.distance,
      }));
    } catch (error) {
      skipped.push({ reason: 'detail-read-failed', identity: match.expected.identity, message: String(error.message || error).slice(0, 160) });
      log.warn?.(`⚠️ Instagram browser Insights detail skipped: ${String(error.message || error).slice(0, 160)}`);
    }
  }
  return {
    status: additions.length ? 'snapshots-added' : 'nothing-collected',
    additions,
    candidates: selected.candidates.length,
    cards: cards.length,
    matched: joined.matches.length,
    skipped,
  };
}

/** Merge a browser pass into the existing snapshot document. */
export function mergeInstagramBrowserSnapshots(existing, result, { generatedAt = new Date(), windowHours = 72 } = {}) {
  return buildSnapshotDocument(existing, result?.additions || [], { generatedAt, windowHours });
}
