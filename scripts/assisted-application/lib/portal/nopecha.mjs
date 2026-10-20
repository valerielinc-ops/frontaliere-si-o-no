/** The free NopeCHA extension solves visible challenges; v3 keeps the native flow. */
import { getChromium } from '../../../lib/ensure-chromium.mjs';
import { extractFields } from './fields.mjs';

export const CAPTCHA_TIMEOUT_MS = 120_000;

/** Extension builds require Chromium's persistent context, including in headless mode. */
export async function launchNopechaContext(extensionPath, options) {
  const chromium = await getChromium();
  const context = await chromium.launchPersistentContext('', {
    ...options,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const ready = await worker.evaluate(() => {
      const manifest = chrome.runtime.getManifest();
      return manifest.name === 'NopeCHA: CAPTCHA Solver' && manifest.nopecha?.enabled
        && !manifest.nopecha.key && !manifest.nopecha.keys?.length;
    });
    if (!ready) throw new Error('nopecha_extension_not_ready');
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Bounded wait while the installed extension solves the challenge in the same page. */
export async function awaitCaptcha(page, snapshot, { enabled, timeoutMs = CAPTCHA_TIMEOUT_MS } = {}) {
  if (!enabled || !snapshot.captcha) return snapshot;
  const deadline = Date.now() + timeoutMs;
  let current = snapshot;
  while (current.captcha && Date.now() < deadline) {
    await page.waitForTimeout(1000);
    current = await extractFields(page, { listboxOptions: false });
  }
  return current;
}
