/**
 * Automatic Instagram community loop.
 *
 * This is deliberately a small Graph API client rather than a browser scraper:
 * comments, permitted private replies, inbound conversations and Stories all
 * have an official API surface. The Mac host calls this module after the
 * publishing robot, so the normal cadence has no per-post human step.
 *
 * The state file stores only hashes of platform object ids. Raw comments,
 * usernames and message text never enter the repository or the local journal.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { GRAPH_API } from './instagram-graph-constants.mjs';
import { buildInstagramCommunityOutcomeSnapshot } from './instagram-community-outcomes.mjs';
import { matchInstagramMedia } from './instagram-media-matching.mjs';
import { isAmbiguousSocialPublishResponse } from './social-publish-outcome.mjs';
import {
  markSocialPublishReservationPublished,
  releaseSocialPublishReservation,
  reserveSocialPublishBatch,
  socialPublishReservationKey,
} from './social-publish-reservations.mjs';

export const COMMUNITY_STATE_SCHEMA_VERSION = 2;
export const COMMUNITY_INTERACTION_RETENTION_DAYS = 130;
export const MAX_STORED_COMMUNITY_INTERACTIONS = 5_000;
export const MAX_COMMENT_REPLIES_PER_RUN = 20;
export const MAX_PRIVATE_REPLIES_PER_RUN = 10;
export const MAX_DM_REPLIES_PER_RUN = 10;
export const MAX_STORIES_PER_RUN = 3;
export const MAX_MEDIA_PER_RUN = 25;
export const MAX_CONVERSATIONS_PER_RUN = 25;
export const DM_RESPONSE_WINDOW_HOURS = 24;
export const PRIVATE_REPLY_WINDOW_HOURS = 168;
export const STORY_MIN_AGE_HOURS = 24;
export const STORY_MAX_AGE_HOURS = 72;
export const GRAPH_REQUEST_TIMEOUT_MS = 30_000;
export const STORY_STATUS_MAX_ATTEMPTS = 8;
export const STORY_STATUS_DELAY_MS = 2_000;

const MEDIA_FIELDS = Object.freeze([
  'id',
  'timestamp',
  'media_type',
  'permalink',
  'media_url',
  'thumbnail_url',
]);

const COMMENT_FIELDS = 'id,text,from,timestamp,username,replies';
const CONVERSATION_FIELDS = 'id,updated_time,participants';
const MESSAGE_FIELDS = 'id,from,to,message,created_time,attachments';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim();
  return result || null;
}

function timestamp(value) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function id(value) {
  return text(value);
}

function firstText(...values) {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return null;
}

function encodeId(value) {
  return encodeURIComponent(String(value));
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function apiError(payload, status) {
  const message = firstText(payload?.error?.message, payload?.error?.error_user_msg, payload?.message)
    || `HTTP ${status || 'unknown'}`;
  return { message: String(message).replace(/access_token[=:][^\s&]+/gi, 'access_token=[REDACTED]').slice(0, 300) };
}

function safeLog(log, level, message) {
  const fn = log?.[level] || log?.log;
  if (typeof fn === 'function') fn.call(log, message);
}

async function request(method, pathSuffix, {
  accessToken,
  params = {},
  body = null,
  fetchImpl = fetch,
  timeoutMs = GRAPH_REQUEST_TIMEOUT_MS,
} = {}) {
  const url = new URL(`${GRAPH_API}/${pathSuffix}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Authorization: `Bearer ${accessToken}` };
  const options = { method, headers };
  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    options.body = body;
  } else if (body !== null) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (typeof AbortSignal?.timeout === 'function') options.signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetchImpl(url.toString(), options);
    let payload = {};
    let parseFailed = false;
    try {
      payload = await response?.json?.() || {};
    } catch {
      payload = {};
      parseFailed = true;
    }
    if (!response?.ok || payload?.error || parseFailed) {
      const uncertain = method === 'POST'
        && (isAmbiguousSocialPublishResponse(response) || (response?.ok && parseFailed));
      return {
        ok: false,
        status: response?.status,
        ...(uncertain ? { uncertain: true } : {}),
        error: apiError(payload, response?.status),
      };
    }
    return { ok: true, status: response?.status, data: payload };
  } catch (error) {
    return {
      ok: false,
      ...(method === 'POST' ? { uncertain: true } : {}),
      error: { message: String(error?.message || error).slice(0, 300) },
    };
  }
}

export async function graphGet(pathSuffix, params, accessToken, options = {}) {
  return request('GET', pathSuffix, { ...options, params, accessToken });
}

export async function graphFormPost(pathSuffix, params, accessToken, options = {}) {
  return request('POST', pathSuffix, {
    ...options,
    accessToken,
    body: new URLSearchParams(Object.entries(params || {}).map(([key, value]) => [key, String(value)])),
  });
}

export async function graphJsonPost(pathSuffix, body, accessToken, options = {}) {
  return request('POST', pathSuffix, { ...options, accessToken, body });
}

async function listPaged(pathSuffix, params, accessToken, {
  fetchImpl = fetch,
  maxPages = 3,
} = {}) {
  const rows = [];
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    const pageParams = { ...params };
    if (after) pageParams.after = after;
    const result = await graphGet(pathSuffix, pageParams, accessToken, { fetchImpl });
    if (!result.ok) throw new Error(result.error?.message || `Instagram Graph API ${result.status || 'error'}`);
    if (Array.isArray(result.data?.data)) rows.push(...result.data.data.filter(isRecord));
    after = text(result.data?.paging?.cursors?.after);
    if (!after) break;
  }
  return rows;
}

export async function listAccountMedia(accountId, accessToken, {
  fetchImpl = fetch,
  maxPages = 3,
  fields = MEDIA_FIELDS,
} = {}) {
  return listPaged(`${encodeId(accountId)}/media`, {
    fields: fields.join(','),
    limit: String(MAX_MEDIA_PER_RUN),
  }, accessToken, { fetchImpl, maxPages });
}

export async function listMediaComments(mediaId, accessToken, { fetchImpl = fetch } = {}) {
  return listPaged(`${encodeId(mediaId)}/comments`, {
    fields: COMMENT_FIELDS,
    limit: '100',
  }, accessToken, { fetchImpl, maxPages: 2 });
}

export async function listConversations(accountId, accessToken, {
  fetchImpl = fetch,
  pageId = null,
  pageAccessToken = null,
} = {}) {
  const usePageAuth = Boolean(text(pageId) && text(pageAccessToken));
  const conversationAccountId = usePageAuth ? pageId : accountId;
  const conversationToken = usePageAuth ? pageAccessToken : accessToken;
  return listPaged(`${encodeId(conversationAccountId)}/conversations`, {
    platform: 'instagram',
    fields: CONVERSATION_FIELDS,
    limit: String(MAX_CONVERSATIONS_PER_RUN),
  }, conversationToken, { fetchImpl, maxPages: 2 });
}

export async function listConversationMessages(conversationId, accessToken, { fetchImpl = fetch } = {}) {
  return listPaged(`${encodeId(conversationId)}/messages`, {
    fields: MESSAGE_FIELDS,
    limit: '50',
  }, accessToken, { fetchImpl, maxPages: 2 });
}

function postedRows(ledger) {
  if (Array.isArray(ledger)) return ledger.filter(isRecord);
  return isRecord(ledger) && Array.isArray(ledger.posted) ? ledger.posted.filter(isRecord) : [];
}

function rowIdentity(row) {
  return firstText(
    row.instagramMediaId,
    row.instagram_media_id,
    row.mediaId,
    row.media_id,
    row.queueId,
    row.queue_id,
    row.id,
  );
}

/** Group the five ledger rows of a carousel without retaining their content. */
export function groupPostedLedgerForAutomation(ledger) {
  const groups = new Map();
  for (const row of postedRows(ledger)) {
    const kind = firstText(row.kind, row.contentKind, row.content_kind) || 'unknown';
    const day = firstText(row.day);
    const creativeId = firstText(row.creativeId, row.creative_id);
    const mediaId = firstText(row.instagramMediaId, row.instagram_media_id, row.mediaId, row.media_id);
    const queueId = firstText(row.queueId, row.queue_id);
    const identity = mediaId || queueId || `${kind}:${day || 'unknown'}:${creativeId || rowIdentity(row) || 'unknown'}`;
    const rowTs = timestamp(row.ts || row.postedAt || row.confirmedAt || row.createdAt);
    const group = groups.get(identity) || {
      identity,
      mediaId,
      queueId,
      kind,
      day,
      creativeId,
      creativeBaseId: firstText(row.creativeBaseId, row.creative_base_id),
      creativeVariant: firstText(row.creativeVariant, row.creative_variant),
      primaryMetric: firstText(row.primaryMetric, row.primary_metric),
      followUpFormat: firstText(row.followUpFormat, row.follow_up_format),
      permalink: firstText(row.permalink),
      storyImageUrl: firstText(row.instagramStoryImageUrl, row.storyImageUrl, row.story_image_url),
      publishedAtMs: rowTs,
      entries: 0,
    };
    group.mediaId ||= mediaId;
    group.queueId ||= queueId;
    group.creativeId ||= creativeId;
    group.creativeBaseId ||= firstText(row.creativeBaseId, row.creative_base_id);
    group.creativeVariant ||= firstText(row.creativeVariant, row.creative_variant);
    group.primaryMetric ||= firstText(row.primaryMetric, row.primary_metric);
    group.followUpFormat ||= firstText(row.followUpFormat, row.follow_up_format);
    group.permalink ||= firstText(row.permalink);
    group.storyImageUrl ||= firstText(row.instagramStoryImageUrl, row.storyImageUrl, row.story_image_url);
    group.publishedAtMs = group.publishedAtMs === null
      ? rowTs
      : rowTs === null ? group.publishedAtMs : Math.min(group.publishedAtMs, rowTs);
    group.entries += 1;
    groups.set(identity, group);
  }
  return [...groups.values()];
}

/**
 * Join confirmed ledger groups to the account's media. Timestamp matches are
 * rejected when two posts are equally close; a false join would send a reply
 * under the wrong creative and poison the experiment.
 */
export function matchLedgerGroupsToMedia(groups, media, { maxDistanceMinutes = 45 } = {}) {
  return matchInstagramMedia(groups, media, {
    maxDistanceMinutes,
    missingMediaIdReason: 'ledger-media-id-not-available',
  });
}

export function hashAction(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\u0000')).digest('hex');
}

export function emptyCommunityState() {
  return {
    schemaVersion: COMMUNITY_STATE_SCHEMA_VERSION,
    updatedAt: null,
    trackingStartedAt: null,
    actions: [],
    interactions: [],
    interactionsTruncated: false,
  };
}

function validCommunityInteraction(interaction) {
  return isRecord(interaction)
    && Object.keys(interaction).length === 9
    && Object.keys(interaction).every((key) => [
      'key', 'source', 'surface', 'receivedAt', 'observedAt', 'classification', 'status', 'responseAt', 'escalationReason',
    ].includes(key))
    && /^[a-f0-9]{64}$/u.test(String(interaction.key || ''))
    && ['graph', 'browser'].includes(interaction.source)
    && ['comments', 'directMessages'].includes(interaction.surface)
    && ['safe-acknowledgement', 'safe-redirect', 'needs-human'].includes(interaction.classification)
    && ['responded', 'needs-human', 'outside-window', 'age-unknown', 'delivery-failed', 'delivery-uncertain', 'reply-limit-reached'].includes(interaction.status)
    && (interaction.receivedAt === null || timestamp(interaction.receivedAt) !== null)
    && timestamp(interaction.observedAt) !== null
    && (interaction.responseAt === null || timestamp(interaction.responseAt) !== null)
    && (interaction.escalationReason === null || [
      'personal-or-sensitive', 'source-required', 'outside-window', 'timestamp-unavailable',
      'delivery-failed', 'delivery-uncertain', 'reply-limit-reached', 'empty-or-unreadable',
    ].includes(interaction.escalationReason));
}

export function loadCommunityState(file) {
  const fallback = emptyCommunityState();
  if (!file || !existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.actions)) return fallback;
    return {
      schemaVersion: COMMUNITY_STATE_SCHEMA_VERSION,
      updatedAt: text(parsed.updatedAt),
      trackingStartedAt: isoOrNull(parsed.trackingStartedAt),
      actions: parsed.actions.flatMap((action) => (
        isRecord(action)
          && /^[a-f0-9]{64}$/u.test(String(action.key || ''))
          && ['sent', 'uncertain'].includes(text(action.status))
          ? [{ key: action.key, kind: String(action.kind || '').slice(0, 80), status: action.status, at: text(action.at) }]
          : []
      )).slice(-1000),
      interactions: (Array.isArray(parsed.interactions) ? parsed.interactions : [])
        .filter(validCommunityInteraction)
        .slice(-MAX_STORED_COMMUNITY_INTERACTIONS),
      interactionsTruncated: parsed.interactionsTruncated === true,
    };
  } catch {
    return fallback;
  }
}

function saveCommunityState(file, state) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
}

function hasAction(state, key) {
  return state.actions.some((action) => action.key === key && ['sent', 'uncertain'].includes(action.status));
}

function hasUncertainAction(state, key) {
  return state.actions.some((action) => action.key === key && action.status === 'uncertain');
}

function actionTimestamp(state, key) {
  return state.actions.find((action) => action.key === key && action.status === 'sent')?.at || null;
}

export function recordCommunityAction(state, file, { key, kind, at, status = 'sent' }) {
  if (!['sent', 'uncertain'].includes(status)) throw new Error('community action status must be sent or uncertain');
  const existing = state.actions.find((action) => action.key === key);
  if (existing?.status === 'sent' || existing?.status === status) return;
  state.trackingStartedAt ||= new Date(at).toISOString();
  state.actions = [...state.actions.filter((action) => action.key !== key), {
    key,
    kind,
    status,
    at: new Date(at).toISOString(),
  }].slice(-1000);
  state.updatedAt = new Date(at).toISOString();
  saveCommunityState(file, state);
}

function isoOrNull(value) {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

/** Persist only a hash and bounded categorical/timestamp metadata for one inbound interaction. */
export function recordCommunityInteraction(state, file, {
  platformId,
  source = 'graph',
  surface,
  receivedAt = null,
  observedAt = new Date(),
  classification = 'needs-human',
  status = 'needs-human',
  responseAt = null,
  escalationReason = null,
} = {}) {
  if (!['graph', 'browser'].includes(source) || !['comments', 'directMessages'].includes(surface)) return null;
  const observedAtIso = isoOrNull(observedAt);
  if (!observedAtIso) return null;
  const key = hashAction('community-interaction', source, surface, platformId);
  const receivedAtIso = isoOrNull(receivedAt);
  const responseAtIso = isoOrNull(responseAt);
  const previous = state.interactions.find((item) => item.key === key);
  const effectiveStatus = previous?.status === 'responded' && status !== 'responded'
    ? 'responded'
    : status;
  const effectiveResponseAt = previous?.responseAt && responseAtIso
    ? (Date.parse(previous.responseAt) <= Date.parse(responseAtIso) ? previous.responseAt : responseAtIso)
    : previous?.responseAt || responseAtIso;
  const event = {
    key,
    source,
    surface,
    receivedAt: previous?.receivedAt || receivedAtIso,
    observedAt: observedAtIso,
    classification,
    status: effectiveStatus,
    responseAt: effectiveResponseAt,
    escalationReason: effectiveStatus === 'responded' ? null : escalationReason,
  };
  state.trackingStartedAt ||= observedAtIso;
  const nextInteractions = [
    ...state.interactions.filter((item) => item.key !== key),
    event,
  ].filter((item) => {
    const anchor = timestamp(item.receivedAt || item.observedAt);
    return anchor !== null && anchor >= Date.parse(observedAtIso) - COMMUNITY_INTERACTION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  }).sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  if (nextInteractions.length > MAX_STORED_COMMUNITY_INTERACTIONS) state.interactionsTruncated = true;
  state.interactions = nextInteractions.slice(-MAX_STORED_COMMUNITY_INTERACTIONS);
  state.updatedAt = observedAtIso;
  saveCommunityState(file, state);
  return event;
}

const recordAction = recordCommunityAction;

function commentReplies(comment) {
  if (Array.isArray(comment?.replies)) return comment.replies;
  if (Array.isArray(comment?.replies?.data)) return comment.replies.data;
  return [];
}

function ownReplyExists(comment, accountId) {
  return commentReplies(comment).some((reply) => String(reply?.from?.id || reply?.from?.pk || '') === String(accountId));
}

function commentAuthorId(comment) {
  return firstText(comment?.from?.id, comment?.from?.pk, comment?.user?.id);
}

function messageAuthorId(message) {
  return firstText(message?.from?.id, message?.from?.pk, message?.sender?.id);
}

function messageText(message) {
  return firstText(message?.message, message?.text);
}

function compareNewest(a, b) {
  return (timestamp(b?.created_time || b?.timestamp) || 0) - (timestamp(a?.created_time || a?.timestamp) || 0);
}

export function shouldSendPrivateReply(commentText) {
  const value = String(commentText || '').trim();
  return /^[123]$/u.test(value)
    || classifyInstagramCommunityInteraction({ surface: 'comments', text: value }).classification === 'safe-redirect';
}

const SIMPLE_LINK_REQUEST = /^(?:(?:ciao|salve)[,!\s]*)?(?:(?:dove\s+(?:trovo|posso\s+trovare)\s+(?:il\s+)?)|(?:(?:mi\s+)?(?:puoi\s+)?(?:mandare|mandi|inviare|invi|girare|giri|passare|passi)\s+)?)(?:il\s+)?(?:link|collegamento|la\s+guida|una\s+guida|la\s+pagina|info|informazioni)(?:\s+per\s+[\p{L}\p{N}\s'-]{1,60})?[?.!]*$/iu;
const SENSITIVE_CONTENT = /(?:\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[\s().-]*){8,}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b|codice\s+fiscale|\biban\b|numero\s+di\s+telefono|indirizzo\s+(?:di\s+)?casa|busta\s+paga|il\s+mio\s+caso|mio\s+datore|la\s+mia\s+azienda|mi\s+hanno\s+licenziat|\b(?:avvocato|denuncia|urgente|malattia|infortunio)\b)/iu;

/** Allow only non-factual acknowledgements and simple link redirects without human review. */
export function classifyInstagramCommunityInteraction({ surface, text: rawText } = {}) {
  const value = String(rawText || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!value) return { classification: 'needs-human', escalationReason: 'empty-or-unreadable' };
  if (/^grazie per (?:il commento|averci scritto|aver partecipato)/iu.test(value)) {
    return { classification: 'needs-human', escalationReason: 'source-required' };
  }
  if (SENSITIVE_CONTENT.test(value)) return { classification: 'needs-human', escalationReason: 'personal-or-sensitive' };
  if (surface === 'comments' && /^\s*[123](?:[.)!?,\s]|$)/u.test(value)) {
    return { classification: 'safe-acknowledgement', escalationReason: null };
  }
  if (surface === 'comments' && value.length <= 120
    && /^(?:grazie|utilissimo|bellissimo|ottimo|bravi|complimenti|interessante)(?:\b|[.!?\s])/iu.test(value)
    && !value.includes('?')) {
    return { classification: 'safe-acknowledgement', escalationReason: null };
  }
  if (SIMPLE_LINK_REQUEST.test(value)) {
    return { classification: 'safe-redirect', escalationReason: null };
  }
  return { classification: 'needs-human', escalationReason: 'source-required' };
}

export function buildPublicCommentReply({ commentText = '', primaryMetric = 'comments' } = {}) {
  const normalized = text(commentText) || '';
  const choice = normalized.match(/^\s*([123])(?:[.)\s]|$)/)?.[1];
  if (choice) {
    return `Grazie per aver scelto ${choice}: registriamo la preferenza per questa creatività.`;
  }
  if (primaryMetric === 'shares') {
    return 'Grazie per il commento: continuiamo ad aggiornare le guide con riferimenti verificabili.';
  }
  if (primaryMetric === 'saves') {
    return 'Grazie per il commento: lavoriamo per rendere le guide più utili da consultare.';
  }
  return 'Grazie per il commento. Continuiamo ad aggiornare le guide con riferimenti verificabili.';
}

export function buildPrivateReply({ permalink = '' } = {}) {
  const link = isHttpUrl(permalink) ? permalink : null;
  return link
    ? `Grazie per aver partecipato. Qui trovi il riferimento del post: ${link} Per casi personali, non inviare dati sensibili.`
    : 'Grazie per aver partecipato. Prepariamo le risposte usando fonti verificabili; per casi personali, non inviare dati sensibili.';
}

export function buildDirectMessageReply() {
  return 'Grazie per averci scritto. Le guide aggiornate sono su frontaliereticino.ch/.';
}

export async function waitForStoryContainer(containerId, accessToken, {
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxAttempts = STORY_STATUS_MAX_ATTEMPTS,
  delayMs = STORY_STATUS_DELAY_MS,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await graphGet(encodeId(containerId), { fields: 'status_code' }, accessToken, { fetchImpl });
    if (result.ok && result.data?.status_code === 'FINISHED') return true;
    if (result.ok && ['ERROR', 'EXPIRED'].includes(result.data?.status_code)) return false;
    if (attempt < maxAttempts) await sleepImpl(delayMs);
  }
  return false;
}

/** Publish one static visual Story; interactive stickers are not guessed. */
export async function publishStory({ igUserId, accessToken, imageUrl, fetchImpl = fetch, sleepImpl } = {}) {
  if (!igUserId || !accessToken || !isHttpUrl(imageUrl)) return { ok: false, reason: 'story credentials or image missing' };
  const container = await graphFormPost(`${encodeId(igUserId)}/media`, {
    media_type: 'STORIES',
    image_url: imageUrl,
  }, accessToken, { fetchImpl });
  if (!container.ok || !container.data?.id) {
    return { ok: false, reason: `story container failed: ${container.error?.message || container.status || 'unknown'}` };
  }
  const ready = await waitForStoryContainer(container.data.id, accessToken, { fetchImpl, sleepImpl });
  if (!ready) return { ok: false, reason: `story container ${container.data.id} never reached FINISHED` };
  const published = await graphFormPost(`${encodeId(igUserId)}/media_publish`, {
    creation_id: container.data.id,
  }, accessToken, { fetchImpl });
  if (!published.ok || !published.data?.id) {
    const uncertain = isAmbiguousSocialPublishResponse(published)
      || (published.status >= 200 && published.status < 300 && !published.data?.id);
    return {
      ok: false,
      ...(uncertain ? { uncertain: true } : {}),
      reason: `story publish failed: ${published.error?.message || published.status || 'unknown'}`,
    };
  }
  return { ok: true, mediaId: published.data.id };
}

export function resolveInstagramCommunityMode(env = process.env) {
  const configured = String(env.SOCIAL_ROBOT_MODE || '').trim().toLowerCase();
  if (configured === 'live') return 'live';
  if (configured === 'off') return 'off';
  return 'dry';
}

function resultTemplate(mode) {
  return {
    status: mode === 'live' ? 'starting' : mode === 'off' ? 'disabled' : 'dry-run',
    mode,
    mediaMatched: 0,
    commentsSeen: 0,
    commentsReplied: 0,
    privateRepliesSent: 0,
    conversationsSeen: 0,
    directMessagesSent: 0,
    storiesAttempted: 0,
    storiesPublished: 0,
    storiesSkipped: 0,
    errors: [],
  };
}

function addError(result, error) {
  const message = String(error?.message || error || 'unknown error').replace(/access_token[=:][^\s&]+/gi, 'access_token=[REDACTED]').slice(0, 240);
  if (!result.errors.includes(message)) result.errors.push(message);
}

function ageHours(atMs, nowMs) {
  return atMs === null ? null : (nowMs - atMs) / 3_600_000;
}

/**
 * Execute one unattended pass. The caller supplies the ledger so the same
 * worker can run from the Mac snapshot without importing the full site.
 */
export async function runInstagramCommunityAutomation({
  accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
  // Facebook Login can authorize the same community surfaces with the Page
  // token already used by the social stack. This fallback is intentionally
  // local to community actions; Insights still requires the Instagram token.
  accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN,
  pageId = process.env.FB_PAGE_ID,
  pageAccessToken = process.env.FB_PAGE_ACCESS_TOKEN,
  ledger = { posted: [] },
  statePath = null,
  mode = resolveInstagramCommunityMode(),
  now = new Date(),
  fetchImpl = fetch,
  sleepImpl,
  log = console,
  reservationRepoRoot = process.cwd(),
  socialPublishReservations = {
    reserveBatch: reserveSocialPublishBatch,
    markPublished: markSocialPublishReservationPublished,
    release: releaseSocialPublishReservation,
  },
} = {}) {
  const result = resultTemplate(mode);
  if (mode !== 'live') return result;
  const graphAccessToken = firstText(accessToken, pageAccessToken);
  if (!text(accountId) || !graphAccessToken) {
    result.status = 'credentials-missing';
    return result;
  }

  const nowMs = timestamp(now) || Date.now();
  const state = loadCommunityState(statePath);
  state.trackingStartedAt ||= new Date(nowMs).toISOString();
  const persist = (key, kind, status = 'sent') => recordAction(state, statePath, { key, kind, at: nowMs, status });
  let media = [];
  try {
    media = await listAccountMedia(accountId, graphAccessToken, { fetchImpl });
  } catch (error) {
    addError(result, error);
    safeLog(log, 'warn', `⚠️ Instagram community media sync: ${error.message || error}`);
  }

  const joined = matchLedgerGroupsToMedia(groupPostedLedgerForAutomation(ledger), media);
  result.mediaMatched = joined.matches.length;

  let commentAttempted = 0;
  let privateAttempted = 0;
  for (const { group, media: mediaItem } of joined.matches.slice(0, MAX_MEDIA_PER_RUN)) {
    let comments;
    try {
      comments = await listMediaComments(mediaItem.id, graphAccessToken, { fetchImpl });
    } catch (error) {
      addError(result, error);
      continue;
    }
    for (const comment of comments) {
      const commentId = id(comment.id);
      if (!commentId) continue;
      result.commentsSeen += 1;
      if (String(commentAuthorId(comment)) === String(accountId)) continue;
      const receivedAtCandidate = timestamp(comment.timestamp || comment.created_time);
      const receivedAtMs = receivedAtCandidate !== null && receivedAtCandidate <= nowMs ? receivedAtCandidate : null;
      const receivedAt = receivedAtMs === null ? null : new Date(receivedAtMs).toISOString();
      const classification = classifyInstagramCommunityInteraction({ surface: 'comments', text: comment.text });
      const publicKey = hashAction('comment-reply', commentId);
      const privateKey = hashAction('comment-private-reply', commentId);
      const ownReplies = commentReplies(comment)
        .filter((reply) => String(reply?.from?.id || reply?.from?.pk || '') === String(accountId))
        .map((reply) => ({ at: timestamp(reply.timestamp || reply.created_time) }))
        .filter((reply) => receivedAtMs === null || reply.at === null || reply.at >= receivedAtMs)
        .sort((left, right) => (left.at || 0) - (right.at || 0));
      const existingResponseAt = ownReplies[0]?.at
        ? new Date(ownReplies[0].at).toISOString()
        : actionTimestamp(state, publicKey) || actionTimestamp(state, privateKey);
      const uncertainReply = hasUncertainAction(state, publicKey) || hasUncertainAction(state, privateKey);
      if (ownReplyExists(comment, accountId) || existingResponseAt || (!uncertainReply && (hasAction(state, publicKey) || hasAction(state, privateKey)))) {
        recordCommunityInteraction(state, statePath, {
          platformId: commentId,
          source: 'graph',
          surface: 'comments',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'responded',
          responseAt: existingResponseAt,
        });
        continue;
      }
      if (uncertainReply) {
        recordCommunityInteraction(state, statePath, {
          platformId: commentId,
          source: 'graph',
          surface: 'comments',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'delivery-uncertain',
          escalationReason: 'delivery-uncertain',
        });
        continue;
      }
      if (classification.classification === 'needs-human') {
        recordCommunityInteraction(state, statePath, {
          platformId: commentId,
          source: 'graph',
          surface: 'comments',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'needs-human',
          escalationReason: classification.escalationReason,
        });
        continue;
      }
      recordCommunityInteraction(state, statePath, {
        platformId: commentId,
        source: 'graph',
        surface: 'comments',
        receivedAt,
        observedAt: nowMs,
        classification: classification.classification,
        status: 'needs-human',
        escalationReason: null,
      });
      if (commentAttempted < MAX_COMMENT_REPLIES_PER_RUN) {
        commentAttempted += 1;
        const reply = await graphFormPost(`${encodeId(commentId)}/replies`, {
          message: buildPublicCommentReply({
            commentText: comment.text,
            primaryMetric: group.primaryMetric,
          }),
        }, graphAccessToken, { fetchImpl });
        if (reply.ok) {
          persist(publicKey, 'comment-reply');
          result.commentsReplied += 1;
          recordCommunityInteraction(state, statePath, {
            platformId: commentId,
            source: 'graph',
            surface: 'comments',
            receivedAt,
            observedAt: nowMs,
            classification: classification.classification,
            status: 'responded',
            responseAt: nowMs,
          });
        } else if (reply.uncertain === true) {
          persist(publicKey, 'comment-reply', 'uncertain');
          addError(result, reply.error);
          recordCommunityInteraction(state, statePath, {
            platformId: commentId,
            source: 'graph',
            surface: 'comments',
            receivedAt,
            observedAt: nowMs,
            classification: classification.classification,
            status: 'delivery-uncertain',
            escalationReason: 'delivery-uncertain',
          });
          continue;
        } else {
          addError(result, reply.error);
          recordCommunityInteraction(state, statePath, {
            platformId: commentId,
            source: 'graph',
            surface: 'comments',
            receivedAt,
            observedAt: nowMs,
            classification: classification.classification,
            status: 'delivery-failed',
            escalationReason: 'delivery-failed',
          });
        }
      } else {
        recordCommunityInteraction(state, statePath, {
          platformId: commentId,
          source: 'graph',
          surface: 'comments',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'reply-limit-reached',
          escalationReason: 'reply-limit-reached',
        });
      }

      const authorId = commentAuthorId(comment);
      const commentAge = ageHours(timestamp(comment.timestamp || comment.created_time), nowMs);
      if (
        authorId
        && shouldSendPrivateReply(comment.text)
        && commentAge !== null
        && commentAge >= 0
        && commentAge <= PRIVATE_REPLY_WINDOW_HOURS
        && !hasAction(state, privateKey)
        && privateAttempted < MAX_PRIVATE_REPLIES_PER_RUN
      ) {
        privateAttempted += 1;
        const privateReply = await graphFormPost(`${encodeId(commentId)}/private_replies`, {
          message: buildPrivateReply({ permalink: firstText(mediaItem.permalink, group.permalink) }),
        }, graphAccessToken, { fetchImpl });
        if (privateReply.ok) {
          persist(privateKey, 'comment-private-reply');
          result.privateRepliesSent += 1;
          recordCommunityInteraction(state, statePath, {
            platformId: commentId,
            source: 'graph',
            surface: 'comments',
            receivedAt,
            observedAt: nowMs,
            classification: classification.classification,
            status: 'responded',
            responseAt: actionTimestamp(state, privateKey) || nowMs,
          });
        } else if (privateReply.uncertain === true) {
          persist(privateKey, 'comment-private-reply', 'uncertain');
          addError(result, privateReply.error);
          recordCommunityInteraction(state, statePath, {
            platformId: commentId,
            source: 'graph',
            surface: 'comments',
            receivedAt,
            observedAt: nowMs,
            classification: classification.classification,
            status: 'delivery-uncertain',
            escalationReason: 'delivery-uncertain',
          });
        } else {
          addError(result, privateReply.error);
        }
      }
    }
  }

  try {
    const conversations = await listConversations(accountId, graphAccessToken, {
      fetchImpl,
      pageId,
      pageAccessToken,
    });
    const messageAccessToken = text(pageId) && text(pageAccessToken) ? pageAccessToken : graphAccessToken;
    const selfIds = new Set([String(accountId), String(pageId || '')].filter(Boolean));
    for (const conversation of conversations.slice(0, MAX_CONVERSATIONS_PER_RUN)) {
      const conversationId = id(conversation.id);
      if (!conversationId) continue;
      let messages;
      try {
        messages = (await listConversationMessages(conversationId, messageAccessToken, { fetchImpl })).sort(compareNewest);
      } catch (error) {
        addError(result, error);
        continue;
      }
      result.conversationsSeen += 1;
      const chronological = messages
        .map((message) => ({
          message,
          senderId: messageAuthorId(message),
          at: timestamp(message?.created_time || message?.timestamp),
        }))
        .sort((left, right) => (left.at || 0) - (right.at || 0));
      const latestInbound = chronological.filter((entry) => entry.senderId && !selfIds.has(String(entry.senderId))).at(-1);
      if (!latestInbound || !id(latestInbound.message?.id)) continue;
      const latest = latestInbound.message;
      const senderId = latestInbound.senderId;
      const body = messageText(latest);
      const messageAt = latestInbound.at !== null && latestInbound.at <= nowMs ? latestInbound.at : null;
      const receivedAt = messageAt === null ? null : new Date(messageAt).toISOString();
      const classification = classifyInstagramCommunityInteraction({ surface: 'directMessages', text: body });
      const messageKey = hashAction('direct-message', latest.id);
      const responseAfterInbound = messageAt === null ? null : chronological.find((entry) => (
        entry.senderId && selfIds.has(String(entry.senderId)) && entry.at !== null && entry.at >= messageAt
      ));
      if (responseAfterInbound || actionTimestamp(state, messageKey) || (hasAction(state, messageKey) && !hasUncertainAction(state, messageKey))) {
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'responded',
          responseAt: responseAfterInbound?.at ? new Date(responseAfterInbound.at).toISOString() : actionTimestamp(state, messageKey),
        });
        continue;
      }
      if (hasUncertainAction(state, messageKey)) {
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'delivery-uncertain',
          escalationReason: 'delivery-uncertain',
        });
        continue;
      }
      if (messageAt === null || ageHours(messageAt, nowMs) < 0) {
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'age-unknown',
          escalationReason: 'timestamp-unavailable',
        });
        continue;
      }
      if (ageHours(messageAt, nowMs) > DM_RESPONSE_WINDOW_HOURS) {
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'outside-window',
          escalationReason: 'outside-window',
        });
        continue;
      }
      if (classification.classification === 'needs-human') {
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'needs-human',
          escalationReason: classification.escalationReason,
        });
        continue;
      }
      if (result.directMessagesSent >= MAX_DM_REPLIES_PER_RUN) {
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'reply-limit-reached',
          escalationReason: 'reply-limit-reached',
        });
        continue;
      }
      recordCommunityInteraction(state, statePath, {
        platformId: latest.id,
        source: 'graph',
        surface: 'directMessages',
        receivedAt,
        observedAt: nowMs,
        classification: classification.classification,
        status: 'needs-human',
        escalationReason: null,
      });
      const reply = await graphJsonPost(`${encodeId(accountId)}/messages`, {
        recipient: { id: senderId },
        message: { text: buildDirectMessageReply({ message: body }) },
      }, messageAccessToken, { fetchImpl });
      if (reply.ok) {
        persist(messageKey, 'direct-message');
        result.directMessagesSent += 1;
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'responded',
          responseAt: nowMs,
        });
      } else if (reply.uncertain === true) {
        persist(messageKey, 'direct-message', 'uncertain');
        addError(result, reply.error);
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'delivery-uncertain',
          escalationReason: 'delivery-uncertain',
        });
      } else {
        addError(result, reply.error);
        recordCommunityInteraction(state, statePath, {
          platformId: latest.id,
          source: 'graph',
          surface: 'directMessages',
          receivedAt,
          observedAt: nowMs,
          classification: classification.classification,
          status: 'delivery-failed',
          escalationReason: 'delivery-failed',
        });
      }
    }
  } catch (error) {
    addError(result, error);
    safeLog(log, 'warn', `⚠️ Instagram community DM sync: ${error.message || error}`);
  }

  for (const { group, media: mediaItem } of joined.matches) {
    if (!String(group.followUpFormat || '').startsWith('story-')) continue;
    const publishedAt = group.publishedAtMs;
    const age = ageHours(publishedAt, nowMs);
    if (age === null || age < STORY_MIN_AGE_HOURS || age > STORY_MAX_AGE_HOURS) continue;
    const storyKey = hashAction('story-follow-up', group.identity, group.followUpFormat);
    if (hasAction(state, storyKey) || result.storiesAttempted >= MAX_STORIES_PER_RUN) continue;
    const imageUrl = firstText(group.storyImageUrl, mediaItem.media_url, mediaItem.thumbnail_url);
    if (!isHttpUrl(imageUrl)) {
      result.storiesSkipped += 1;
      continue;
    }
    const publishAt = new Date(nowMs);
    const reservationKey = socialPublishReservationKey('instagram', 'story', storyKey);
    let reservations;
    try {
      reservations = await socialPublishReservations.reserveBatch({
        platform: 'instagram',
        capGroup: 'story',
        accountId,
        repoRoot: reservationRepoRoot,
        reservations: [{ key: reservationKey, publishAt }],
        now: publishAt,
      });
    } catch (error) {
      addError(result, error);
      safeLog(log, 'warn', `⚠️ Instagram Story shared publication gate failed: ${error.message || error}`);
      continue;
    }
    if (!reservations?.[0]?.allowed) {
      result.storiesSkipped += 1;
      safeLog(log, 'warn', `🛑 Instagram Story held by shared daily cap (${reservations?.[0]?.reason || 'reservation-denied'})`);
      continue;
    }
    result.storiesAttempted += 1;
    let story;
    try {
      story = await publishStory({
        igUserId: accountId,
        accessToken: graphAccessToken,
        imageUrl,
        fetchImpl,
        sleepImpl,
      });
    } catch (error) {
      // A transport failure at media_publish is ambiguous, so the reservation
      // stays active until the next pass can reconcile the native account.
      addError(result, error);
      continue;
    }
    if (story.ok) {
      persist(storyKey, 'story-follow-up');
      result.storiesPublished += 1;
      try {
        await socialPublishReservations.markPublished({
          platform: 'instagram', capGroup: 'story', accountId, key: reservationKey, publishAt, publishedAt: new Date().toISOString(),
        });
      } catch (error) {
        safeLog(log, 'warn', `⚠️ Instagram Story reservation remains held after accepted post: ${error.message}`);
      }
    } else {
      addError(result, story.reason);
      if (story.uncertain === true) continue;
      try {
        await socialPublishReservations.release({
          platform: 'instagram', capGroup: 'story', accountId, key: reservationKey, publishAt,
        });
      } catch (error) {
        addError(result, error);
      }
    }
  }

  result.status = result.errors.length > 0
    ? result.commentsReplied + result.privateRepliesSent + result.directMessagesSent + result.storiesPublished > 0 ? 'partial' : 'api-error'
    : 'completed';
  state.updatedAt = new Date(nowMs).toISOString();
  saveCommunityState(statePath, state);
  result.outcomes = buildInstagramCommunityOutcomeSnapshot({
    interactions: state.interactions,
    asOf: new Date(nowMs),
    source: 'graph',
    runStatus: result.status,
    coverage: 'graph-bounded-pages-and-recent-media',
    trackingStartedAt: state.trackingStartedAt,
    truncated: state.interactionsTruncated,
  });
  safeLog(log, 'log', `🤖 Instagram community automation: ${result.status} · commenti ${result.commentsReplied}/${result.commentsSeen} · DM ${result.directMessagesSent} · Stories ${result.storiesPublished}`);
  return result;
}
