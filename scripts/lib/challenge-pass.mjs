/**
 * challenge-pass.mjs — get a page past the anti-bot challenges that a real
 * user's browser passes without solving anything (owner decision 2026-11-09).
 *
 *   Cloudflare interstitial («Just a moment…»): its script decides by itself
 *     within seconds; we wait for the page to move on.
 *   Cloudflare Turnstile: a non-interactive widget fills its token alone; a
 *     managed one wants one click on its checkbox.
 *   reCAPTCHA v3 / invisible: nothing to solve, only the browser's score
 *     (CloakBrowser's job, not this file's).
 *   reCAPTCHA v2 and hCaptcha: reported, not solved here.
 *
 * Only useful with the stealth browser: a vanilla Chromium is the reason the
 * challenge is there, and waiting would only delay the same stop.
 */

const INTERSTITIAL_TITLE_RE = /just a moment|un momento|einen moment|un instant|attention required|checking your browser|verifica.*browser/i;
const TURNSTILE_FRAME_RE = /^https:\/\/challenges\.cloudflare\.com\//;

/** What challenge the page shows now (in-page check, every frame's URL). */
export async function challengeState(page) {
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const frameUrls = frames.map((frame) => {
    try {
      return frame.url();
    } catch {
      return '';
    }
  });
  const inPage = await page.evaluate(() => {
    const token = document.querySelector('input[name="cf-turnstile-response"]');
    return {
      title: document.title || '',
      // Not the /cdn-cgi/challenge-platform/ script alone: Cloudflare's bot
      // management injects it into ordinary pages too.
      cfInterstitial: Boolean(document.querySelector('#challenge-form, #challenge-stage, #challenge-running') || window._cf_chl_opt),
      turnstileToken: Boolean(token && token.value),
      turnstileWidget: Boolean(token || document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"]')),
    };
  }).catch(() => ({ title: '', cfInterstitial: false, turnstileToken: false, turnstileWidget: false }));
  const turnstileFrame = frameUrls.some((url) => TURNSTILE_FRAME_RE.test(url));
  return {
    interstitial: inPage.cfInterstitial || INTERSTITIAL_TITLE_RE.test(inPage.title),
    turnstile: (turnstileFrame || inPage.turnstileWidget) && !inPage.turnstileToken,
    recaptcha: frameUrls.some((url) => /\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)/.test(url) && !/size=invisible/.test(url)),
    hcaptcha: frameUrls.some((url) => /hcaptcha\.com\/captcha/.test(url)),
  };
}

const blocking = (state) => state.interstitial || state.turnstile;

/** One click on the Turnstile checkbox: left side of the widget's frame. */
async function clickTurnstile(page) {
  const frame = page.frames().find((candidate) => TURNSTILE_FRAME_RE.test(candidate.url()));
  if (!frame) return false;
  const element = await frame.frameElement().catch(() => null);
  const box = element ? await element.boundingBox().catch(() => null) : null;
  if (!box || box.width < 10 || box.height < 10) return false;
  await page.mouse.move(box.x + 12 + Math.random() * 10, box.y + box.height / 2 + (Math.random() * 6 - 3), { steps: 8 });
  await page.mouse.click(box.x + 28 + Math.random() * 4, box.y + box.height / 2 + (Math.random() * 4 - 2));
  return true;
}

/**
 * Wait out an interstitial and click a managed Turnstile once.
 * Resolves `{ passed, initial, state, clicked }`; `passed` is true when no
 * Cloudflare challenge is left on the page (reCAPTCHA v2 / hCaptcha stay in
 * `state`); `initial` is what the page showed before waiting.
 */
export async function passChallenge(page, { timeoutMs = 30_000, pollMs = 1_000, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  const initial = await challengeState(page);
  let state = initial;
  let clicked = false;
  // A non-interactive Turnstile needs a few seconds before it asks for a click.
  const clickAfter = Date.now() + Math.min(6_000, timeoutMs / 3);
  while (blocking(state) && Date.now() < deadline) {
    if (state.turnstile && !clicked && Date.now() >= clickAfter) {
      clicked = await clickTurnstile(page).catch(() => false);
      if (clicked) log('[challenge-pass] Turnstile checkbox clicked');
    }
    await page.waitForTimeout(pollMs);
    state = await challengeState(page);
  }
  const passed = !blocking(state);
  log(`[challenge-pass] ${passed ? 'passed' : 'still challenged'} (${Object.keys(state).filter((key) => state[key]).join(', ') || 'none'})`);
  return { passed, initial, state, clicked };
}
