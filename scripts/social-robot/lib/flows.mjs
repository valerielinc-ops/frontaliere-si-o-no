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

const ANY_OF = (...words) => new RegExp(`^\\s*(?:${words.join('|')})\\s*$`, 'i');

export const RX = Object.freeze({
  igCreate: ANY_OF('New post', 'Create', 'Crea', 'Nuovo post', 'Neuer Beitrag', 'Erstellen', 'Créer', 'Nouvelle publication'),
  igPostMenu: ANY_OF('Post', 'Beitrag', 'Publication'),
  igNext: ANY_OF('Next', 'Avanti', 'Weiter', 'Suivant'),
  igShare: ANY_OF('Share', 'Condividi', 'Teilen', 'Partager'),
  igCaption: /caption|didascalia|bildunterschrift|légende/i,
  igConfirm: /your post has been shared|post shared|il tuo post è stato condiviso|post condiviso|dein beitrag wurde geteilt|beitrag geteilt|votre publication a été partagée|publication partagée/i,
  notNow: ANY_OF('Not now', 'Not Now', 'Non ora', 'Jetzt nicht', 'Plus tard'),
  ttPost: ANY_OF('Post', 'Pubblica', 'Posten', 'Veröffentlichen', 'Publier'),
  ttPostNow: ANY_OF('Post now', 'Pubblica ora', 'Jetzt posten', 'Publier maintenant'),
  // Success wording only, matched ONLY inside TT_SUCCESS_TOAST: TikTok Studio
  // keeps "Manage your posts" in its navigation on every page, so neither that
  // phrase nor a page-wide text search can prove a press was published.
  ttConfirm: /your (?:video|post|photos?) (?:has|have) been (?:uploaded|posted|published)|(?:video|post) published|il tuo (?:video|post) è stato pubblicato|dein beitrag wurde veröffentlicht|votre publication a été publiée/i,
  ttConfirmUrl: /\/tiktokstudio\/content|\/creator-center\/content/,
  igChallengeText: /confirm it'?s you|help us confirm|suspicious login|conferma che sei tu|conferma la tua identità|attività sospetta|bestätige, dass du es bist|confirmez qu'il s'agit bien de vous/i,
  ttChallengeText: /verify to continue|drag the slider|trascina il cursore|verifica per continuare|schieberegler|faites glisser/i,
  ttLoginText: /log in to tiktok|accedi a tiktok|bei tiktok anmelden|se connecter à tiktok/i,
});

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
   *   'confirmation-missing'|'download'|'browser'|'unexpected'} errorClass
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

/** Steps at or after the press of the publish button: the post may be online. */
export const PRESSED_STEPS = Object.freeze(['publish', 'confirmation']);

/**
 * Run `afterPress` — the press itself and the wait for the confirmation — and
 * mark ANY error it throws as `pressed`, keeping its class: a challenge or a
 * login wall that appears after the press still pauses the platform, but the
 * post is then also `unconfirmed` and never pressed again on its own.
 */
async function pressed(afterPress) {
  try {
    return await afterPress();
  } catch (err) {
    const e = classifyError(err);
    e.pressed = true;
    throw e;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Type the caption like a person: focus, optionally clear what the page put
 * there (TikTok pre-fills the file name), then line by line with a per-key
 * delay. Checks the editor holds the first line afterwards.
 */
export async function typeCaption(page, editor, caption, { human, clear = false, hashtagSuggestions = false } = {}) {
  await editor.click();
  if (clear) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
  }
  const lines = String(caption).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      if (hashtagSuggestions) await typeTikTokLine(page, lines[i], human);
      else await page.keyboard.type(lines[i], { delay: human.typeDelay() });
    }
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }
  const firstLine = normalize(lines.find((l) => l.trim()) || '');
  const written = normalize(await editor.innerText().catch(() => ''));
  if (firstLine && !written.includes(firstLine.slice(0, 40))) {
    throw new RobotError('selector-missing', 'the caption editor does not hold the caption after typing');
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
    writeFileSync(file, `${JSON.stringify({ url, ...meta }, null, 2)}\n`, 'utf8');
    saved.push(file);
  } catch {
    // disk full
  }
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

async function required(step, name, candidates, opts) {
  step.set(name);
  const loc = await findFirst(candidates, opts);
  if (!loc) throw new RobotError('selector-missing', `no control found for step "${name}"`, { step: name });
  return loc;
}

async function optionalClick(candidates, { timeout = DEFAULT_TIMEOUTS.optional, guard } = {}) {
  const loc = await findFirst(candidates, { timeout, guard });
  if (loc) await loc.click().catch(() => {});
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
  await optionalClick([page.getByRole('button', { name: RX.notNow })], { guard });

  const create = await required(step, 'create', [
    page.getByRole('link', { name: RX.igCreate }),
    page.getByRole('button', { name: RX.igCreate }),
    page.locator('svg[aria-label="New post"], svg[aria-label="Nuovo post"], svg[aria-label="Neuer Beitrag"], svg[aria-label="Nouvelle publication"]'),
  ], { guard, timeout: t.ui });
  await create.click();
  await human.pause();
  // Newer layouts open a small menu (Post / Live / Ad) before the dialog.
  await optionalClick([
    page.getByRole('link', { name: RX.igPostMenu }),
    page.getByRole('menuitem', { name: RX.igPostMenu }),
  ], { guard });

  const input = await required(step, 'upload', [
    page.locator('div[role="dialog"] input[type="file"]'),
    page.locator('form[enctype="multipart/form-data"] input[type="file"]'),
    page.locator('input[type="file"][accept*="image"]'),
  ], { guard, timeout: t.ui, state: 'attached' });
  await input.setInputFiles(files);
  await human.pause();

  for (const name of ['next-crop', 'next-edit']) {
    const next = await required(step, name, [page.getByRole('button', { name: RX.igNext })], { guard, timeout: t.ui });
    await next.click();
    await human.pause();
  }

  const editor = await required(step, 'caption', [
    page.getByRole('textbox', { name: RX.igCaption }),
    page.locator('div[role="dialog"] div[contenteditable="true"][aria-label]'),
  ], { guard, timeout: t.ui });
  await typeCaption(page, editor, caption, { human });
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
  return pressed(async () => {
    await share.click();
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

  const input = await required(step, 'upload', [page.locator('input[type="file"]')], { guard, timeout: t.ui, state: 'attached' });
  const accept = String((await input.getAttribute('accept').catch(() => '')) || '');
  if (accept && !/video(?:\/|,|\s|$)/i.test(accept)) {
    throw new RobotError('upload-unsupported', `the upload field does not accept video/*: "${accept}"`, { step: 'upload' });
  }
  await input.setInputFiles(files);
  await human.pause();
  await waitForTikTokProcessing(page, { timeout: t.upload, guard });

  const editor = await required(step, 'caption', [
    page.locator('[data-e2e="caption_container"] [contenteditable="true"]'),
    page.locator('.public-DraftEditor-content[contenteditable="true"]'),
    page.getByRole('combobox').and(page.locator('[contenteditable="true"]')),
  ], { guard, timeout: t.upload });
  await typeCaption(page, editor, caption, { human, clear: true, hashtagSuggestions: true });
  await human.pause();

  const post = await required(step, 'post-button', [
    page.locator('button[data-e2e="post_video_button"]'),
    page.getByRole('button', { name: RX.ttPost }),
  ], { guard, timeout: t.ui });
  if (!(await waitEnabled(post, { timeout: t.upload, guard }))) {
    throw new RobotError('selector-missing', 'the Post button stays disabled (upload not processed?)', { step: 'post-button' });
  }
  await snap('ready-to-publish');
  if (dryRun) return { status: 'dry-run', step: 'post-button' };

  step.set('publish');
  return pressed(async () => {
    await post.click();
    // TikTok may ask once more ("content check still running — post now?").
    await optionalClick([page.getByRole('button', { name: RX.ttPostNow })], { guard, timeout: 5_000 });
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
