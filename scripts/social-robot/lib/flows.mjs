/**
 * flows.mjs — the Instagram and TikTok web flows of the social robot.
 *
 * Each flow drives an already-logged-in page (the owner's persistent profile)
 * from the platform's home to the publish button. With `dryRun` it stops
 * there, after a screenshot; otherwise it presses the button and returns
 * `published` ONLY once the platform's own confirmation is on the page. A
 * press without a visible confirmation throws `confirmation-missing` with
 * `pressed: true`, and so does any other error after the press (a challenge,
 * a login wall, a closed page — each keeps its class): the caller must treat
 * the post as possibly online and never press it again on its own.
 *
 * Selectors are role/text based with a few structural fallbacks, in the four
 * UI languages the accounts may use (it/en/de/fr). They were written against
 * the public web apps as documented and are exercised end to end on local
 * look-alike pages by scripts/social-robot/robot-e2e.mjs; the first dry run on
 * the real sites (after the owner's login) is what validates them there. When
 * one is missing the robot saves a screenshot and the HTML of the page and
 * stops: it never guesses another button.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const INSTAGRAM_HOME = 'https://www.instagram.com/';
export const TIKTOK_UPLOAD = 'https://www.tiktok.com/tiktokstudio/upload';

export const DEFAULT_TIMEOUTS = Object.freeze({
  ui: 20_000, // a control of the page
  upload: 180_000, // TikTok processes the video before the post button enables
  confirm: 180_000, // the platform's confirmation after the press
  optional: 3_000, // a dialog that may or may not be there
});

/** Bound the wait for TikTok to upgrade its cookie banner and attach its action. */
export const TIKTOK_COOKIE_BANNER_ACTION_TIMEOUT_MS = 1_000;

const ANY_OF = (...words) => new RegExp(`^\\s*(?:${words.join('|')})\\s*$`, 'i');
const ACCESSIBLE_LABEL_WITH_ICON = (...words) => new RegExp(`^\\s*(${words.join('|')})(?:\\s*\\1)?\\s*$`, 'i');
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
const EXACT_TEXT_ONE_OF = (...words) => new RegExp(`^\\s*(?:${words.map(escapeRegExp).join('|')})\\s*$`, 'i');

export const RX = Object.freeze({
  igCreate: ANY_OF('New post', 'Create', 'Crea', 'Nuovo post', 'Neuer Beitrag', 'Erstellen', 'Créer', 'Nouvelle publication'),
  // Instagram repeats the item label in the accessible name when its icon has
  // the same aria-label as the visible text (for example: "PostPost").
  igPostMenu: ACCESSIBLE_LABEL_WITH_ICON('Post', 'Beitrag', 'Publication'),
  igNext: ANY_OF('Next', 'Avanti', 'Weiter', 'Suivant'),
  igShare: ANY_OF('Share', 'Condividi', 'Teilen', 'Partager'),
  igCaption: /caption|didascalia|bildunterschrift|légende/i,
  igConfirm: /your post has been shared|post shared|il tuo post è stato condiviso|post condiviso|dein beitrag wurde geteilt|beitrag geteilt|votre publication a été partagée|publication partagée/i,
  notNow: ANY_OF('Not now', 'Not Now', 'Non ora', 'Jetzt nicht', 'Plus tard'),
  ttPost: ANY_OF('Post', 'Pubblica', 'Posten', 'Veröffentlichen', 'Publier'),
  ttPostNow: ANY_OF('Post now', 'Pubblica ora', 'Jetzt posten', 'Publier maintenant'),
  ttContentChecksTitle: /Attivare i controlli automatici dei contenuti\?|Turn on automatic content checks\?|Automatische Inhaltsprüfungen aktivieren\?|Automatische Inhaltskontrollen aktivieren\?|Activer les contrôles automatiques du contenu\s*\?/i,
  ttContentChecksCancel: EXACT_TEXT_ONE_OF('Annulla', 'Cancel', 'Abbrechen', 'Annuler'),
  ttCookieTitle: /Consentire i cookie da TikTok su questo browser\?|Allow cookies from TikTok on this browser\?|Cookies von TikTok in diesem Browser zulassen\?|Autoriser les cookies de TikTok sur ce navigateur\s*\?/i,
  ttCookieDecline: EXACT_TEXT_ONE_OF('Rifiuta i cookie opzionali', 'Reject optional cookies', 'Optionale Cookies ablehnen', 'Refuser les cookies facultatifs'),
  ttTourAction: EXACT_TEXT_ONE_OF('Ok', 'Last', 'Salta', 'Skip', 'Fine', 'Chiudi', 'Next', 'Avanti', 'Continua', 'Continue', 'Suivant', 'Weiter'),
  // Success wording only, matched ONLY inside TT_SUCCESS_TOAST: TikTok Studio
  // keeps "Manage your posts" in its navigation on every page, so neither that
  // phrase nor a page-wide text search can prove a press was published.
  ttConfirm: /your (?:video|post|photos?) (?:has|have) been (?:uploaded|posted|published)|(?:video|post) published|il tuo (?:video|post) è stato pubblicato|dein beitrag wurde veröffentlicht|votre publication a été publiée/i,
  ttConfirmUrl: /\/tiktokstudio\/content|\/creator-center\/content/,
  igChallengeText: /confirm it'?s you|help us confirm|suspicious login|conferma che sei tu|conferma la tua identità|attività sospetta|bestätige, dass du es bist|confirmez qu'il s'agit bien de vous/i,
  ttChallengeText: /verify to continue|drag the slider|trascina il cursore|verifica per continuare|schieberegler|faites glisser/i,
  ttLoginText: /log in to tiktok|accedi a tiktok|bei tiktok anmelden|se connecter à tiktok/i,
});

export const MAX_GUIDED_TOUR_STEPS = 12;

/**
 * The containers TikTok shows its post-publish success message in (a top
 * toast / live region). The confirmation text counts only inside one of
 * these, never anywhere on the page.
 */
export const TT_SUCCESS_TOAST = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], [class*="toast" i], [data-e2e*="toast"]';
export const TT_PROCESSING = '[role="progressbar"], [data-e2e="upload-progress"], [data-e2e*="progress" i]';

export class RobotError extends Error {
  /**
   * @param {'login-required'|'challenge'|'selector-missing'|'upload-unsupported'|
   *   'confirmation-missing'|'download'|'browser'|'interstitial-unknown'|
   *   'cookie-banner-unreachable'|'unexpected'} errorClass
   * @param {string} message
   * @param {{ step?: string, pressed?: boolean }} [extra]
   */
  constructor(errorClass, message, { step = '', pressed = false } = {}) {
    super(message);
    this.name = 'RobotError';
    this.errorClass = errorClass;
    this.step = step;
    this.pressed = pressed;
  }
}

export function classifyError(err) {
  if (err instanceof RobotError) return err;
  const wrapped = new RobotError('unexpected', String(err?.message || err));
  wrapped.stack = err?.stack;
  return wrapped;
}

/** Give larger/longer videos more processing time, with a bounded ceiling. */
export function timeoutForTikTokVideo(video, fallback = DEFAULT_TIMEOUTS.upload) {
  const bytes = Number(video?.bytes);
  const durationMs = Number(video?.durationMs);
  if (!Number.isFinite(bytes) || !Number.isFinite(durationMs) || bytes <= 0 || durationMs <= 0) return fallback;
  const transferMs = Math.ceil(bytes / (256 * 1024)) * 1_000;
  return Math.min(10 * 60_000, Math.max(60_000, 30_000 + transferMs + durationMs));
}

/** The confirmation step is entered only after the publish click was sent. */
export const PRESSED_STEPS = Object.freeze(['confirmation']);

/**
 * Run the publish click and wait for confirmation. The flow calls the marker
 * immediately after Playwright accepts the publish click; an intercepted or
 * blocked click therefore remains retryable instead of becoming unconfirmed.
 */
async function pressed(afterPress) {
  let pressSent = false;
  const markPressed = () => { pressSent = true; };
  try {
    return await afterPress(markPressed);
  } catch (err) {
    const e = classifyError(err);
    e.pressed = pressSent;
    throw e;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const diagnosticMetadata = new WeakMap();

function addDiagnosticMetadata(page, metadata) {
  if (!page || typeof page !== 'object') return;
  diagnosticMetadata.set(page, { ...(diagnosticMetadata.get(page) || {}), ...metadata });
}

/**
 * The first candidate locator that is visible (or attached), polling until
 * `timeout`. `guard` runs at every poll and may throw — that is how a login
 * wall or a challenge interrupts a wait at once instead of after the timeout.
 */
export async function findFirst(candidates, { timeout = DEFAULT_TIMEOUTS.ui, state = 'visible', guard = null, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (guard) await guard();
    for (const candidate of candidates) {
      const loc = candidate.first();
      try {
        if (state === 'attached' ? (await loc.count()) > 0 : await loc.isVisible()) return loc;
      } catch {
        // detached while polling: try the next one
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

async function isEnabled(loc) {
  try {
    if (await loc.isDisabled()) return false;
    const aria = await loc.getAttribute('aria-disabled');
    return aria !== 'true';
  } catch {
    return false;
  }
}

async function waitEnabled(loc, { timeout, guard }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (guard) await guard();
    if (await isEnabled(loc)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function saveInterstitialDiagnostic(snap, label = 'interstitial-unknown') {
  try {
    await snap(label);
  } catch {
    // A diagnostic failure must not mask the fail-closed error.
  }
}

async function observeCookieBanner(root, blockedLocator = null) {
  let point = null;
  try {
    const box = blockedLocator ? await blockedLocator.boundingBox() : null;
    if (box && box.width > 0 && box.height > 0) point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  } catch {
    // The blocked control may detach while the banner is being upgraded.
  }
  return root.evaluate((host, coordinates) => {
    const defined = Boolean(customElements.get('tiktok-cookie-banner')) && host.matches(':defined');
    const shadowRootMode = host.shadowRoot ? 'open' : 'closed-or-not-ready';
    const visible = (node) => {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const contentVisible = Boolean(host.shadowRoot && [...host.shadowRoot.querySelectorAll('*')].some(visible));
    const hostVisible = visible(host);
    const hostBlocksControl = Boolean(coordinates && document.elementFromPoint(coordinates.x, coordinates.y) === host);
    return {
      cookieBannerState: defined ? (host.shadowRoot ? 'defined-open' : 'defined-closed') : 'not-defined',
      shadowRootMode,
      relevant: hostVisible || contentVisible || hostBlocksControl,
    };
  }, point).catch(() => ({ cookieBannerState: 'unknown', shadowRootMode: 'closed-or-not-ready', relevant: false }));
}

const isClickIntercepted = (err) => /intercepts pointer events|not receiving events|another element.*receives pointer events/i.test(String(err?.message || err));

async function checkClickable(locator, { step, label }) {
  let box;
  try {
    box = await locator.boundingBox();
  } catch {
    box = null;
  }
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new RobotError('selector-missing', `${label} has no clickable box`, { step: step?.get?.() || '' });
  }

  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  let hit;
  try {
    hit = await locator.evaluate((node, coordinates) => {
      const top = document.elementFromPoint(coordinates.x, coordinates.y);
      const root = node.getRootNode();
      const shadowHost = root && root.host ? root.host : null;
      const clickableAncestor = node.closest?.('button, a, [role="button"], [role="link"]');
      const isTarget = top === node
        || Boolean(top && node.contains(top))
        || top === shadowHost
        || top === clickableAncestor;
      if (isTarget) return { ok: true };
      if (!top) return { ok: false, obstacle: 'no element at its center' };
      const text = String(top.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const identity = [top.tagName?.toLowerCase(), top.id ? `#${top.id}` : '', top.getAttribute?.('role') ? `[role="${top.getAttribute('role')}"]` : '', top.getAttribute?.('data-test-id') ? `[data-test-id="${top.getAttribute('data-test-id')}"]` : ''].filter(Boolean).join('');
      return { ok: false, obstacle: `${identity || 'element'}${text ? ` "${text}"` : ''}` };
    }, point);
  } catch (err) {
    throw new RobotError('selector-missing', `${label} could not be checked before clicking: ${err?.message || err}`, { step: step?.get?.() || '' });
  }

  return hit;
}

async function ensureClickable(page, locator, { step, snap, label, platform, recovery = { used: false }, allowInterstitialRecovery = true }) {
  const hit = await checkClickable(locator, { step, label });
  if (hit?.ok) return;

  if (allowInterstitialRecovery && platform && !recovery.used) {
    recovery.used = true;
    await dismissKnownInterstitials({ page, platform, step, snap, timeout: DEFAULT_TIMEOUTS.optional, blockedLocator: locator });
    const retryHit = await checkClickable(locator, { step, label });
    if (retryHit?.ok) return;
    await saveInterstitialDiagnostic(snap);
    throw new RobotError(
      'interstitial-unknown',
      `${label} is blocked by an unrecognized overlay${retryHit?.obstacle ? `: ${retryHit.obstacle}` : ''}`,
      { step: step?.get?.() || '' },
    );
  }

  await saveInterstitialDiagnostic(snap);
  throw new RobotError(
    'interstitial-unknown',
    `${label} is blocked by an unrecognized overlay${hit?.obstacle ? `: ${hit.obstacle}` : ''}`,
    { step: step?.get?.() || '' },
  );
}

async function clickChecked(page, locator, { step, snap, label = 'control', platform, allowInterstitialRecovery = true }) {
  const recovery = { used: !allowInterstitialRecovery };
  await ensureClickable(page, locator, { step, snap, label, platform, recovery, allowInterstitialRecovery });
  try {
    await locator.click();
  } catch (err) {
    let retryIntercepted = false;
    if (isClickIntercepted(err) && platform && !recovery.used) {
      recovery.used = true;
      await dismissKnownInterstitials({ page, platform, step, snap, timeout: DEFAULT_TIMEOUTS.optional, blockedLocator: locator });
      await ensureClickable(page, locator, { step, snap, label, platform, recovery, allowInterstitialRecovery });
      try {
        await locator.click();
        return;
      } catch (retryErr) {
        if (!isClickIntercepted(retryErr)) throw retryErr;
        retryIntercepted = true;
      }
    }
    if (isClickIntercepted(err) || retryIntercepted) {
      await saveInterstitialDiagnostic(snap);
      throw new RobotError('interstitial-unknown', `${label} click was intercepted by an unrecognized overlay`, { step: step?.get?.() || '' });
    }
    throw err;
  }
}

/**
 * Type the caption like a person: focus, optionally clear what the page put
 * there (TikTok pre-fills the file name), then line by line with a per-key
 * delay. Checks the editor holds exactly the queued caption afterwards.
 */
export async function typeCaption(page, editor, caption, { human, clear = false, hashtagSuggestions = false, platform, step = null, snap = async () => {} } = {}) {
  await clickChecked(page, editor, { step, snap, platform, label: 'caption editor' });
  if (clear) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    let cleared;
    try {
      cleared = await editor.innerText();
    } catch {
      throw new RobotError('selector-missing', 'the caption editor could not be read after clearing', { step: 'caption' });
    }
    if (normalize(cleared)) {
      throw new RobotError('selector-missing', 'the caption editor is not empty after clearing', { step: 'caption' });
    }
  }
  const lines = String(caption).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      if (hashtagSuggestions) await typeTikTokLine(page, lines[i], human);
      else await page.keyboard.type(lines[i], { delay: human.typeDelay() });
    }
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }
  let written;
  try {
    written = normalize(await editor.innerText());
  } catch {
    throw new RobotError('selector-missing', 'the caption editor could not be read after typing', { step: 'caption' });
  }
  if (written !== normalize(caption)) {
    throw new RobotError('selector-missing', 'the caption editor does not exactly match the queued caption', { step: 'caption' });
  }
}

/**
 * Type a TikTok line while closing the hashtag suggestion popup after every
 * tag. Escape leaves the text typed so far intact and cannot choose a
 * platform suggestion; the original separating space is then entered.
 */
async function typeTikTokLine(page, line, human) {
  const hashtag = /#[\p{L}\p{N}_]+/gu;
  let cursor = 0;
  for (const match of line.matchAll(hashtag)) {
    const index = match.index ?? cursor;
    const tag = match[0];
    const before = line.slice(cursor, index);
    if (before) await page.keyboard.type(before, { delay: human.typeDelay() });
    await page.keyboard.type(tag, { delay: human.typeDelay() });
    await page.keyboard.press('Escape');
    cursor = index + tag.length;
    if (line[cursor] === ' ') {
      await page.keyboard.press('Space');
      cursor += 1;
    }
  }
  if (cursor < line.length) await page.keyboard.type(line.slice(cursor), { delay: human.typeDelay() });
}

async function waitForTikTokProcessing(page, { timeout, guard }) {
  await guard();
  const indicator = page.locator(TT_PROCESSING).first();
  if ((await indicator.count().catch(() => 0)) === 0 || !(await indicator.isVisible().catch(() => false))) return;
  const deadline = Date.now() + timeout;
  for (;;) {
    await guard();
    if (!(await indicator.isVisible().catch(() => false))) return;
    if (Date.now() >= deadline) {
      throw new RobotError('selector-missing', 'TikTok keeps processing the video past the upload timeout', { step: 'processing' });
    }
    await sleep(250);
  }
}

/** Screenshot + HTML + a small meta file. Never throws: diagnosis must not mask the error. */
export async function captureDiagnostics(page, dir, label, meta = {}) {
  const saved = [];
  const pageMetadata = page && typeof page === 'object' ? diagnosticMetadata.get(page) : null;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return saved;
  }
  try {
    const file = path.join(dir, `${label}.png`);
    await page.screenshot({ path: file, fullPage: true, timeout: 15_000 });
    saved.push(file);
  } catch {
    // page gone
  }
  try {
    const file = path.join(dir, `${label}.html`);
    writeFileSync(file, await page.content(), 'utf8');
    saved.push(file);
  } catch {
    // page gone
  }
  try {
    const file = path.join(dir, `${label}.json`);
    let url = '';
    try {
      const u = new URL(page.url());
      url = `${u.origin}${u.pathname}`;
    } catch {
      // about:blank
    }
    writeFileSync(file, `${JSON.stringify({ url, ...(pageMetadata || {}), ...meta }, null, 2)}\n`, 'utf8');
    saved.push(file);
  } catch {
    // disk full
  }
  if (pageMetadata && page && typeof page === 'object') diagnosticMetadata.delete(page);
  return saved;
}

function stepTracker() {
  const t = { current: 'start' };
  return { set: (s) => (t.current = s), get: () => t.current };
}

async function textVisible(page, rx) {
  try {
    return await page.getByText(rx).first().isVisible();
  } catch {
    return false;
  }
}

export function instagramGuard(page, step) {
  return async () => {
    const url = page.url();
    if (/\/accounts\/login|\/accounts\/emailsignup/.test(url)) {
      throw new RobotError('login-required', 'Instagram shows its login page: the profile is not logged in', { step: step.get() });
    }
    if (/\/challenge\/|\/checkpoint\//.test(url) || (await textVisible(page, RX.igChallengeText))) {
      throw new RobotError('challenge', 'Instagram asks to confirm the identity of the account', { step: step.get() });
    }
    try {
      if (await page.locator('input[name="username"]').first().isVisible() && await page.locator('input[name="password"]').first().isVisible()) {
        throw new RobotError('login-required', 'Instagram shows a login form: the profile is not logged in', { step: step.get() });
      }
    } catch (err) {
      if (err instanceof RobotError) throw err;
    }
  };
}

export function tiktokGuard(page, step) {
  return async () => {
    const url = page.url();
    if (/\/login(?:\/|\?|$)/.test(url) || (await textVisible(page, RX.ttLoginText))) {
      throw new RobotError('login-required', 'TikTok shows its login page: the profile is not logged in', { step: step.get() });
    }
    try {
      if (await page.locator('#captcha-verify-container, .captcha_verify_container, .captcha-verify-container, [id^="captcha_container"]').first().isVisible()) {
        throw new RobotError('challenge', 'TikTok shows a captcha', { step: step.get() });
      }
    } catch (err) {
      if (err instanceof RobotError) throw err;
    }
    if (await textVisible(page, RX.ttChallengeText)) {
      throw new RobotError('challenge', 'TikTok asks to verify the account', { step: step.get() });
    }
  };
}

async function visible(locator) {
  return Boolean(locator && await locator.isVisible().catch(() => false));
}

async function findVisible(candidates, { timeout = DEFAULT_TIMEOUTS.optional, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const loc = candidate.nth(i);
        if (await visible(loc)) return loc;
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Interstitials that the robot may close without changing account settings.
 * Dialogs are matched by role plus title; the title alternatives cover the
 * four account languages. TikTok's cookie banner is a custom element whose
 * visible shadow-DOM text is backed by `#tiktok-cookie-banner-config`.
 *
 * Joyride is deliberately structural: its portal and tooltip/alertdialog
 * markers identify an informational tour, while its button markers/text
 * identify only the safe advance/close actions.
 */
export const INTERSTITIAL_REGISTRY = Object.freeze({
  instagram: Object.freeze([
    Object.freeze({ id: 'instagram-not-now', surface: 'button', name: RX.notNow, safeAction: 'click' }),
  ]),
  tiktok: Object.freeze([
    // Cookie consent is always handled first: it can cover a tour action.
    Object.freeze({
      id: 'tiktok-cookie-banner',
      surface: 'banner',
      title: RX.ttCookieTitle,
      rootSelectors: Object.freeze(['tiktok-cookie-banner', '[data-e2e="cookie-banner"]', '[role="banner"]']),
      name: RX.ttCookieDecline,
      safeAction: 'decline-optional-cookies',
    }),
    Object.freeze({
      id: 'tiktok-content-checks',
      surface: 'dialog',
      role: 'dialog',
      title: RX.ttContentChecksTitle,
      safeAction: 'cancel-or-close',
    }),
    Object.freeze({
      id: 'tiktok-guided-tour',
      surface: 'guided-tour',
      rootSelectors: Object.freeze(['.react-joyride__tooltip', '#react-joyride-portal [role="alertdialog"]']),
      safeAction: 'advance-guided-tour',
    }),
  ]),
});

async function findKnownInterstitial(page, entry, timeout = DEFAULT_TIMEOUTS.optional, { blockedLocator = null } = {}) {
  if (entry.surface === 'button') {
    const button = await findVisible([page.getByRole('button', { name: entry.name })], { timeout });
    return button ? { root: button, action: button } : null;
  }

  if (entry.surface === 'dialog') {
    const dialog = await findVisible([page.getByRole(entry.role).filter({ hasText: entry.title })], { timeout });
    return dialog ? { root: dialog } : null;
  }

  if (entry.surface === 'banner') {
    const titleInConfig = page.locator('#tiktok-cookie-banner-config').filter({ hasText: entry.title });
    const configPresent = (await titleInConfig.count().catch(() => 0)) > 0;
    for (const selector of entry.rootSelectors) {
      const isCookieHost = selector === 'tiktok-cookie-banner';
      if (isCookieHost) {
        const hosts = page.locator(selector);
        const count = await hosts.count().catch(() => 0);
        for (let i = 0; i < count; i += 1) {
          const root = hosts.nth(i);
          const state = await observeCookieBanner(root, blockedLocator);
          if (!state.relevant) continue;
          const action = await findVisible([
            // Page locators pierce TikTok's open shadow root even when the host has no box.
            page.locator('tiktok-cookie-banner button').filter({ hasText: entry.name }),
            page.getByRole('button', { name: entry.name }),
          ], { timeout: Math.min(Math.max(timeout, 0), TIKTOK_COOKIE_BANNER_ACTION_TIMEOUT_MS) });
          if (!action) return { root, action: null, unreachable: state };
          return { root, action };
        }
        continue;
      }

      const root = await findVisible([page.locator(selector)], { timeout: 0 });
      if (!root) continue;
      const title = await findVisible([
        root.getByText(entry.title),
        root.locator('h1, h2, h3, [role="heading"]').filter({ hasText: entry.title }),
      ], { timeout: 0 });
      if (!title && !configPresent) continue;
      const action = await findVisible([
        root.locator('button').filter({ hasText: entry.name }),
        root.getByRole('button', { name: entry.name }),
      ], { timeout: 0 });
      if (!action) {
        continue;
      }
      return { root, action };
    }
    return null;
  }

  if (entry.surface === 'guided-tour') {
    const root = await findVisible(entry.rootSelectors.map((selector) => page.locator(selector)), { timeout });
    if (!root) return null;
    const action = await findVisible([
      root.locator('[data-test-id="button-primary"]'),
      root.locator('[data-test-id="button-close"]'),
      root.locator('[data-test-id="button-skip"]'),
      root.getByRole('button', { name: RX.ttTourAction }),
      root.locator('button').filter({ hasText: RX.ttTourAction }),
    ], { timeout: 0 });
    return { root, action };
  }

  return null;
}

async function dismissKnownInterstitial({ page, platform, target, entry, step, snap }) {
  if (entry.safeAction === 'click' || entry.safeAction === 'decline-optional-cookies') {
    if (!await visible(target.action)) {
      throw new RobotError('interstitial-unknown', `known interstitial "${entry.id}" has no safe action`, { step: step.get() });
    }
    await clickChecked(page, target.action, { step, snap, platform, allowInterstitialRecovery: false, label: `safe action for ${entry.id}` });
    return;
  }

  if (entry.safeAction === 'cancel-or-close') {
    const cancel = await findVisible([
      target.root.getByRole('button', { name: RX.ttContentChecksCancel }),
      target.root.locator('button').filter({ hasText: RX.ttContentChecksCancel }),
    ], { timeout: 0 });
    if (cancel) {
      await clickChecked(page, cancel, { step, snap, platform, allowInterstitialRecovery: false, label: `cancel action for ${entry.id}` });
      return;
    }
    const close = await findVisible([target.root.locator('.common-modal-close, [data-e2e="modal-close"]')], { timeout: 0 });
    if (close) {
      await clickChecked(page, close, { step, snap, platform, allowInterstitialRecovery: false, label: `close action for ${entry.id}` });
      return;
    }
    throw new RobotError('interstitial-unknown', `known interstitial "${entry.id}" has no safe cancel or close control`, { step: step.get() });
  }

  if (entry.safeAction === 'advance-guided-tour') {
    if (!await visible(target.action)) {
      throw new RobotError('interstitial-unknown', `guided tour "${entry.id}" has no safe advance or close control`, { step: step.get() });
    }
    await clickChecked(page, target.action, { step, snap, platform, allowInterstitialRecovery: false, label: `safe action for ${entry.id}` });
    return;
  }

  throw new RobotError('interstitial-unknown', `interstitial "${entry.id}" has no registered safe action`, { step: step.get() });
}

/** Dismiss registered interstitials and fail closed on any other visible dialog. */
export async function dismissKnownInterstitials({ page, platform, step, snap = async () => {}, timeout = DEFAULT_TIMEOUTS.optional, blockedLocator = null }) {
  const entries = INTERSTITIAL_REGISTRY[platform] || [];
  const maxPasses = entries.length + MAX_GUIDED_TOUR_STEPS + 2;
  let settled = false;
  let tourSteps = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let dismissed = false;
    const scanDeadline = Date.now() + (pass === 0 ? timeout : 0);
    for (const entry of entries) {
      const target = await findKnownInterstitial(page, entry, Math.max(0, scanDeadline - Date.now()), { blockedLocator });
      if (!target) continue;
      if (entry.safeAction === 'advance-guided-tour') {
        if (tourSteps >= MAX_GUIDED_TOUR_STEPS) {
          await saveInterstitialDiagnostic(snap);
          throw new RobotError('interstitial-unknown', `guided tour "${entry.id}" exceeded the ${MAX_GUIDED_TOUR_STEPS}-step safety limit`, { step: step.get() });
        }
        tourSteps += 1;
      }
      if (target.unreachable) {
        const { cookieBannerState, shadowRootMode } = target.unreachable;
        addDiagnosticMetadata(page, { cookieBannerState, shadowRootMode });
        await saveInterstitialDiagnostic(snap, 'cookie-banner-unreachable');
        throw new RobotError(
          'cookie-banner-unreachable',
          `TikTok cookie banner is visible but its "Rifiuta i cookie opzionali" control is unreachable after the bounded wait (state ${cookieBannerState}, shadow root ${shadowRootMode}). The owner must reject optional cookies once in the robot profile via VNC.`,
          { step: step.get() },
        );
      }
      await snap(`interstitial-${entry.id}`);
      await dismissKnownInterstitial({ page, platform, target, entry, step, snap });
      dismissed = true;
    }
    if (!dismissed) {
      settled = true;
      break;
    }
  }

  if (!settled) {
    await saveInterstitialDiagnostic(snap);
    throw new RobotError('interstitial-unknown', 'registered interstitials did not settle within the safety limit', { step: step.get() });
  }

  if (platform !== 'tiktok') return;
  const dialogs = page.locator('[role="dialog"], [role="alertdialog"]');
  for (let i = 0, count = await dialogs.count().catch(() => 0); i < count; i += 1) {
    const dialog = dialogs.nth(i);
    if (!await visible(dialog)) continue;
    await snap('interstitial-unknown');
    const role = await dialog.getAttribute('role').catch(() => 'dialog');
    const text = normalize(await dialog.innerText().catch(() => ''));
    throw new RobotError(
      'interstitial-unknown',
      `TikTok shows an unrecognized ${role}${text ? `: "${text.slice(0, 240)}"` : ''}`,
      { step: step.get() },
    );
  }
}

async function required(step, name, candidates, opts) {
  step.set(name);
  const loc = await findFirst(candidates, opts);
  if (!loc) throw new RobotError('selector-missing', `no control found for step "${name}"`, { step: name });
  return loc;
}

const FAIL_CLOSED_INTERSTITIAL_ERRORS = Object.freeze(['interstitial-unknown', 'cookie-banner-unreachable']);

async function optionalClick(candidates, { timeout = DEFAULT_TIMEOUTS.optional, guard, page, platform, step, snap, label = 'optional control' } = {}) {
  const loc = await findFirst(candidates, { timeout, guard });
  if (loc) {
    try {
      await clickChecked(page, loc, { step, snap, platform, label });
    } catch (err) {
      if (err instanceof RobotError && FAIL_CLOSED_INTERSTITIAL_ERRORS.includes(err.errorClass)) throw err;
    }
  }
  return Boolean(loc);
}

/**
 * @param {{ page: import('playwright').Page, files: string[], caption: string,
 *   dryRun: boolean, human: { pause: () => Promise<void>, typeDelay: () => number },
 *   snap: (label: string) => Promise<unknown>, startUrl?: string,
 *   timeouts?: Partial<typeof DEFAULT_TIMEOUTS>, step?: ReturnType<typeof stepTracker> }} opts
 */
export async function instagramFlow({ page, files, caption, dryRun, human, snap, startUrl = INSTAGRAM_HOME, timeouts = {}, step = stepTracker() }) {
  const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const guard = instagramGuard(page, step);
  step.set('open');
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await guard();
  await human.pause();
  await dismissKnownInterstitials({ page, platform: 'instagram', step, snap, timeout: t.optional });

  const create = await required(step, 'create', [
    page.getByRole('link', { name: RX.igCreate }),
    page.getByRole('button', { name: RX.igCreate }),
    page.locator('svg[aria-label="New post"], svg[aria-label="Nuovo post"], svg[aria-label="Neuer Beitrag"], svg[aria-label="Nouvelle publication"]'),
  ], { guard, timeout: t.ui });
  await clickChecked(page, create, { step, snap, platform: 'instagram', label: 'Instagram create control' });
  await human.pause();
  // Newer layouts open a small menu (Post / Live / Ad) before the dialog.
  step.set('create-menu');
  const postMenu = await findFirst([
    page.getByRole('link', { name: RX.igPostMenu }),
    page.getByRole('menuitem', { name: RX.igPostMenu }),
  ], { guard, timeout: t.optional });
  if (postMenu) {
    await snap('create-menu');
    await clickChecked(page, postMenu, { step, snap, platform: 'instagram', label: 'Instagram Post menu item' });
    await human.pause();
  }

  const input = await required(step, 'upload', [
    page.locator('div[role="dialog"] input[type="file"]'),
    page.locator('form[enctype="multipart/form-data"] input[type="file"]'),
    page.locator('input[type="file"][accept*="image"]'),
  ], { guard, timeout: t.ui, state: 'attached' });
  await dismissKnownInterstitials({ page, platform: 'instagram', step, snap, timeout: 0 });
  await input.setInputFiles(files);
  await human.pause();

  for (const name of ['next-crop', 'next-edit']) {
    const next = await required(step, name, [page.getByRole('button', { name: RX.igNext })], { guard, timeout: t.ui });
    await clickChecked(page, next, { step, snap, platform: 'instagram', label: `Instagram ${name} control` });
    await human.pause();
  }

  const editor = await required(step, 'caption', [
    page.getByRole('textbox', { name: RX.igCaption }),
    page.locator('div[role="dialog"] div[contenteditable="true"][aria-label]'),
  ], { guard, timeout: t.ui });
  await dismissKnownInterstitials({ page, platform: 'instagram', step, snap, timeout: 0 });
  await typeCaption(page, editor, caption, { human, platform: 'instagram', step, snap });
  await human.pause();

  const share = await required(step, 'share-button', [
    page.getByRole('button', { name: RX.igShare }),
  ], { guard, timeout: t.ui });
  if (!(await waitEnabled(share, { timeout: t.ui, guard }))) {
    throw new RobotError('selector-missing', 'the Share button stays disabled', { step: 'share-button' });
  }
  await snap('ready-to-publish');
  if (dryRun) return { status: 'dry-run', step: 'share-button' };

  step.set('publish');
  return pressed(async (markPressed) => {
    await dismissKnownInterstitials({ page, platform: 'instagram', step, snap, timeout: 0 });
    await clickChecked(page, share, { step, snap, platform: 'instagram', label: 'Instagram Share control' });
    markPressed();
    step.set('confirmation');
    const confirmation = await findFirst([page.getByText(RX.igConfirm)], { timeout: t.confirm, guard });
    if (!confirmation) {
      throw new RobotError('confirmation-missing', 'Share was pressed but Instagram showed no confirmation', { step: 'confirmation', pressed: true });
    }
    const evidence = normalize(await confirmation.innerText().catch(() => 'confirmation visible'));
    await snap('confirmed');
    return { status: 'published', evidence };
  });
}

/** Same contract as instagramFlow. */
export async function tiktokFlow({ page, files, caption, video, dryRun, human, snap, startUrl = TIKTOK_UPLOAD, timeouts = {}, step = stepTracker() }) {
  const baseTimeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const t = { ...baseTimeouts, upload: timeoutForTikTokVideo(video, baseTimeouts.upload) };
  const guard = tiktokGuard(page, step);
  step.set('open');
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await guard();
  await human.pause();

  step.set('upload');
  await dismissKnownInterstitials({ page, platform: 'tiktok', step, snap, timeout: t.optional });
  const input = await required(step, 'upload', [page.locator('input[type="file"]')], { guard, timeout: t.ui, state: 'attached' });
  const accept = String((await input.getAttribute('accept').catch(() => '')) || '');
  if (accept && !/video(?:\/|,|\s|$)/i.test(accept)) {
    throw new RobotError('upload-unsupported', `the upload field does not accept video/*: "${accept}"`, { step: 'upload' });
  }
  await input.setInputFiles(files);
  await human.pause();
  await waitForTikTokProcessing(page, { timeout: t.upload, guard });
  await dismissKnownInterstitials({ page, platform: 'tiktok', step, snap, timeout: t.optional });

  const editor = await required(step, 'caption', [
    page.locator('[data-e2e="caption_container"] [contenteditable="true"]'),
    page.locator('.public-DraftEditor-content[contenteditable="true"]'),
    page.getByRole('combobox').and(page.locator('[contenteditable="true"]')),
  ], { guard, timeout: t.upload });
  await dismissKnownInterstitials({ page, platform: 'tiktok', step, snap, timeout: 0 });
  await typeCaption(page, editor, caption, { human, clear: true, hashtagSuggestions: true, platform: 'tiktok', step, snap });
  await human.pause();

  const post = await required(step, 'post-button', [
    page.locator('button[data-e2e="post_video_button"]'),
    page.getByRole('button', { name: RX.ttPost }),
  ], { guard, timeout: t.ui });
  if (!(await waitEnabled(post, { timeout: t.upload, guard }))) {
    throw new RobotError('selector-missing', 'the Post button stays disabled (upload not processed?)', { step: 'post-button' });
  }
  await dismissKnownInterstitials({ page, platform: 'tiktok', step, snap, timeout: t.optional });
  await snap('ready-to-publish');
  if (dryRun) return { status: 'dry-run', step: 'post-button' };

  step.set('publish');
  return pressed(async (markPressed) => {
    await post.scrollIntoViewIfNeeded();
    await sleep(Math.min(250, t.optional));
    await dismissKnownInterstitials({ page, platform: 'tiktok', step, snap, timeout: t.optional });
    await clickChecked(page, post, { step, snap, platform: 'tiktok', label: 'TikTok Post control' });
    markPressed();
    // TikTok may ask once more ("content check still running — post now?").
    await optionalClick([page.getByRole('button', { name: RX.ttPostNow })], { page, platform: 'tiktok', step, snap, guard, timeout: 5_000, label: 'TikTok Post now control' });
    step.set('confirmation');
    const deadline = Date.now() + t.confirm;
    for (;;) {
      await guard();
      if (RX.ttConfirmUrl.test(page.url())) {
        await snap('confirmed');
        return { status: 'published', evidence: `redirected to ${new URL(page.url()).pathname}` };
      }
      const text = await findFirst([page.locator(TT_SUCCESS_TOAST).filter({ hasText: RX.ttConfirm })], { timeout: 1_000 });
      if (text) {
        const evidence = normalize(await text.innerText().catch(() => 'confirmation visible'));
        await snap('confirmed');
        return { status: 'published', evidence };
      }
      if (Date.now() >= deadline) break;
    }
    throw new RobotError('confirmation-missing', 'Post was pressed but TikTok showed no confirmation', { step: 'confirmation', pressed: true });
  });
}

export const FLOWS = Object.freeze({ instagram: instagramFlow, tiktok: tiktokFlow });
export { stepTracker };
