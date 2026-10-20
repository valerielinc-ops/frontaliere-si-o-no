/**
 * Instagram comments and DM worker through the authenticated Meta Business
 * Suite Chrome session.
 *
 * This is intentionally a UI adapter. It does not inspect browser storage or
 * replay Business Suite's private requests. It only clicks the named Inbox
 * tabs, reads an accessible thread when one is visible and submits a bounded,
 * canned reply through the visible composer. If the current UI does not expose
 * a stable thread/composer, it records no action and fails closed.
 */
import {
  buildDirectMessageReply,
  buildPublicCommentReply,
  hashAction,
  loadCommunityState,
  recordCommunityAction,
} from './instagram-community-automation.mjs';

export const BUSINESS_SUITE_INBOX_BASE = 'https://business.facebook.com/latest/inbox';
export const BUSINESS_SUITE_SURFACES = Object.freeze({
  comments: `${BUSINESS_SUITE_INBOX_BASE}/instagram`,
  direct: `${BUSINESS_SUITE_INBOX_BASE}/instagram_direct`,
});
export const MAX_BROWSER_THREADS_PER_RUN = 25;
export const MAX_BROWSER_COMMENT_REPLIES_PER_RUN = 20;
export const MAX_BROWSER_DM_REPLIES_PER_RUN = 10;

function text(value) {
  const result = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return result || null;
}
function normalise(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('it-IT');
}

export function businessSuitePageState(url, bodyText) {
  const current = String(url || '');
  const body = normalise(bodyText);
  if (/login|checkpoint|challenge|recover/iu.test(current)) return 'login-required';
  if (!/business\.facebook\.com\/latest\/inbox/iu.test(current)) return 'wrong-surface';
  if (/log in|accedi|sessione scaduta|session has expired/iu.test(body) && !/inbox/iu.test(body)) return 'login-required';
  return 'ready';
}

export function parseBusinessSuiteThreadRef({ href = '', label = '', surface = '' } = {}) {
  try {
    const url = new URL(String(href), BUSINESS_SUITE_INBOX_BASE);
    const selected = url.searchParams.get('selected_item_id');
    if (!selected || !/^\d{4,}$/u.test(selected)) return null;
    return {
      id: selected,
      key: hashAction('browser-thread', surface, selected),
      surface,
      label: text(label),
      href: url.href,
    };
  } catch {
    return null;
  }
}

const NAVIGATION_LINES = new Set([
  'all messages', 'messenger', 'instagram', 'whatsapp', 'facebook comments', 'instagram comments',
  'inbox', 'content', 'home', 'search', 'unread', 'follow up', 'filters', 'send', 'invia',
]);

/** Pure conservative extractor used by the browser worker and its tests. */
export function extractLatestMessage(lines) {
  const candidates = (Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/gu))
    .map((line) => text(line))
    .filter(Boolean)
    .filter((line) => !NAVIGATION_LINES.has(normalise(line)))
    .filter((line) => line.length >= 2 && line.length <= 1000)
    .filter((line) => !/^\d{1,2}[:.]\d{2}(?:\s|$)/u.test(line))
    .filter((line) => !/^(?:reply|rispondi|comment|comments|messages?)$/iu.test(line));
  return candidates.at(-1) || null;
}

function resultTemplate(mode) {
  return {
    status: mode === 'live' ? 'starting' : mode === 'off' ? 'disabled' : 'dry-run',
    mode,
    source: 'browser',
    surfacesChecked: 0,
    threadsSeen: 0,
    commentsSeen: 0,
    commentsReplied: 0,
    privateRepliesSent: 0,
    conversationsSeen: 0,
    directMessagesSent: 0,
    skipped: 0,
    errors: [],
  };
}

function addError(result, error) {
  const message = String(error?.message || error || 'unknown error').replace(/\s+/gu, ' ').slice(0, 220);
  if (!result.errors.includes(message)) result.errors.push(message);
}

async function bodyText(page) {
  return page.locator('body').innerText({ timeout: 15_000 }).catch(() => '');
}

async function visibleThreadRefs(page, surface) {
  return page.locator('a[href*="selected_item_id"]').evaluateAll((links, route) => links.map((link, index) => {
    const rect = link.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      index,
      href: link.href,
      label: link.getAttribute('aria-label') || link.textContent || '',
      surface: route,
    };
  }).filter(Boolean), surface).catch(() => []);
}

async function accessibleThreadText(page) {
  const selectors = [
    '[role="main"] [data-testid*="message" i]',
    '[role="main"] [aria-label*="message" i]',
    'main [data-testid*="message" i]',
    'main [aria-label*="message" i]',
    '[role="article"]',
  ];
  for (const selector of selectors) {
    const values = await page.locator(selector).allInnerTexts().catch(() => []);
    if (values.length) return values;
  }
  return [];
}

async function visibleComposer(page) {
  const candidates = page.locator('[contenteditable="true"], textarea, [role="textbox"]');
  const count = await candidates.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = candidates.nth(index);
    if (await item.isVisible().catch(() => false)) {
      const label = normalise(await item.getAttribute('aria-label').catch(() => '') || '');
      const placeholder = normalise(await item.getAttribute('placeholder').catch(() => '') || '');
      if (label === 'search' || placeholder === 'search') continue;
      return item;
    }
  }
  return null;
}

async function sendButton(page) {
  const buttons = page.locator('button, [role="button"]');
  const count = await buttons.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const item = buttons.nth(index);
    if (!await item.isVisible().catch(() => false)) continue;
    const label = `${await item.getAttribute('aria-label').catch(() => '')} ${await item.innerText().catch(() => '')}`;
    if (/^(?:\s*)(?:send|invia)(?:\s*)$/iu.test(label.replace(/\s+/gu, ' ').trim())) return item;
  }
  return null;
}

async function fillComposer(composer, message) {
  await composer.fill(message);
  const value = await composer.inputValue().catch(async () => composer.innerText().catch(() => ''));
  return String(value || '').trim() === message;
}

async function processSurface({ page, surface, state, statePath, result, mode, nowMs, log }) {
  const route = BUSINESS_SUITE_SURFACES[surface];
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(900);
  result.surfacesChecked += 1;
  const body = await bodyText(page);
  const pageState = businessSuitePageState(page.url(), body);
  if (pageState !== 'ready') {
    result.skipped += 1;
    if (pageState === 'login-required') result.status = 'login-required';
    return;
  }

  const refs = await visibleThreadRefs(page, surface);
  result.threadsSeen += refs.length;
  if (surface === 'comments') result.commentsSeen += refs.length;
  else result.conversationsSeen += refs.length;

  const actionLimit = surface === 'comments'
    ? MAX_BROWSER_COMMENT_REPLIES_PER_RUN
    : MAX_BROWSER_DM_REPLIES_PER_RUN;
  for (const ref of refs.slice(0, Math.min(MAX_BROWSER_THREADS_PER_RUN, actionLimit))) {
    const parsed = parseBusinessSuiteThreadRef(ref);
    if (!parsed) {
      result.skipped += 1;
      continue;
    }
    try {
      await page.locator('a[href*="selected_item_id"]').nth(ref.index).click({ timeout: 15_000 });
      await page.waitForTimeout(700);
      const composer = await visibleComposer(page);
      const messages = await accessibleThreadText(page);
      const latest = extractLatestMessage(messages);
      if (!composer || !latest) {
        result.skipped += 1;
        continue;
      }
      // A thread is a long-lived container. Idempotency therefore belongs to
      // the latest visible inbound message, not to the thread itself: a later
      // message in the same thread must be eligible for one new reply.
      const actionKey = hashAction('browser-thread-message', surface, parsed.id, latest);
      if (state.actions.some((action) => action.key === actionKey && action.status === 'sent')) continue;
      const reply = surface === 'comments'
        ? buildPublicCommentReply({ commentText: latest })
        : buildDirectMessageReply({ message: latest });
      if (mode !== 'live') continue;
      if (!await fillComposer(composer, reply)) {
        result.skipped += 1;
        continue;
      }
      const send = await sendButton(page);
      if (!send) {
        result.skipped += 1;
        continue;
      }
      await send.click({ timeout: 15_000 });
      recordCommunityAction(state, statePath, {
        key: actionKey,
        kind: surface === 'comments' ? 'browser-comment-reply' : 'browser-direct-message',
        at: nowMs,
      });
      if (surface === 'comments') result.commentsReplied += 1;
      else result.directMessagesSent += 1;
    } catch (error) {
      addError(result, error);
      log.warn?.(`⚠️ Instagram Business Suite ${surface} thread skipped: ${String(error.message || error).slice(0, 160)}`);
    }
  }
}

/** Execute one bounded, visible Business Suite Inbox pass. */
export async function runInstagramCommunityBrowserAutomation({
  context,
  statePath = null,
  mode = 'dry',
  now = new Date(),
  log = console,
} = {}) {
  const result = resultTemplate(mode);
  if (mode !== 'live') return result;
  if (!context || typeof context.newPage !== 'function') {
    result.status = 'browser-unavailable';
    return result;
  }
  const state = loadCommunityState(statePath);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const page = await context.newPage();
  try {
    for (const surface of ['comments', 'direct']) {
      await processSurface({ page, surface, state, statePath, result, mode, nowMs, log });
    }
  } catch (error) {
    addError(result, error);
  } finally {
    await page.close().catch(() => {});
  }
  if (result.status !== 'login-required') {
    result.status = result.errors.length ? 'partial' : 'completed';
  }
  log.log?.(`🤖 Instagram Business Suite browser automation: ${result.status} · commenti ${result.commentsReplied}/${result.commentsSeen} · DM ${result.directMessagesSent}/${result.conversationsSeen}`);
  return result;
}
