#!/usr/bin/env node
/**
 * PI-ASP (P&I Personal-Office) `bewerber-web` detail renderer — shared by the
 * Gesundheitswelt-Zollikerberg crawlers (spital-zollikerberg,
 * diakoniewerk-neumuenster), both of which deep-link into the same
 * `stiftdia.pi-asp.de/bewerber-web` ATS.
 *
 * WHY A BROWSER: the pi-asp applicant portal is a GWT SPA — the detail page
 * is served as an empty shell (`BewerberWeb.nocache.js` bootstrap) and the
 * job-ad content only exists after the app boots and calls its GWT-RPC
 * backend (`publicRPC/WebPositionGwtService#getWebPositionDetailData`).
 * Replaying that RPC over plain HTTP was evaluated and rejected: the wire
 * format needs the per-deployment serialization-policy strong name (a hash
 * that changes on every ATS redeploy, discoverable only inside the ~4 MB
 * obfuscated permutation JS), an `Rpc-Xsrf` session token, and the exact
 * field serialization of the `WebPositionDetailDataParams` DTO — all
 * unstable, undocumented internals. Rendering with the repo's shared
 * Playwright runtime (same pattern as salina-reha / hofweissbad / Ostendis)
 * is the maintainable route.
 *
 * DOM anchors (extracted from the deployed GWT bundle, 2026-07 — the class
 * names are app constants, not per-deploy obfuscated symbols):
 *   - `.BW-webPositionDeteilScreen` — detail screen wrapper (sic: "Deteil")
 *   - `.BW-WebPositionPage`         — the rendered job-ad page itself
 *   - `.BW-WebPositionActionButtons`     — apply/back buttons (noise)
 *   - `.BW-WebPositionSocialMediaSection` — share widget (noise)
 *
 * Politeness: one page per position, rate-limited by the shared runtime
 * (default 5 s between navigations), capped at `DEFAULT_MAX_DETAIL_RENDERS`
 * detail renders per run (logged when the cap trims the queue).
 */
import { htmlToText } from './hospital-custom-html-helpers.mjs';
import {
  createBrowser,
  createPoliteContext,
  fetchWithRateLimit,
  closeAll,
  AntiBotBlockError,
  NavigationTimeout,
} from './ats-clients/playwright-runtime.mjs';

/**
 * Containers that hold the rendered job ad, in preference order. The
 * `[class*=…]` variants keep matching if P&I prefixes/suffixes the class
 * (they fixed the "Deteil" typo once before in another module).
 */
export const PI_ASP_DETAIL_CONTAINER_SELECTOR = [
  '.BW-WebPositionPage',
  '.BW-webPositionDeteilScreen',
  '[class*="webPositionDeteil"]',
  '[class*="WebPositionDetail"]',
  '.BW-UserJobOfferDetailScreen-mainPanel',
].join(', ');

/** Chrome inside the detail container that must not leak into descriptions. */
export const PI_ASP_DETAIL_NOISE_SELECTOR = [
  '.BW-WebPositionActionButtons',
  '.BW-WebPositionSocialMediaSection',
  '.BW-Header',
  '.BW-HeaderImage',
  'script',
  'style',
  'iframe',
  'noscript',
].join(', ');

/** Hard cap on detail-page renders per run (both crawlers list ~6-12 jobs). */
export const DEFAULT_MAX_DETAIL_RENDERS = 24;

/** GWT boot + RPC round-trip budget after `domcontentloaded`. */
const DETAIL_RENDER_TIMEOUT_MS = 30_000;

/**
 * Minimum plain-text length for a rendered detail to count as a real job ad.
 * Below this it's a skeleton/error screen and the caller must fall back to
 * its synthetic listing-derived description. Matches the audit's thin
 * threshold (100 chars) with headroom for boilerplate-only screens.
 */
export const MIN_DETAIL_TEXT_CHARS = 200;

const REALISTIC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Convert a rendered detail-container's inner HTML into the plain-text
 * description used for the job. Pure — fixture-testable without a browser.
 *
 * `htmlToText` keeps the ad's structure: `<li>` → `• ` bullet lines (which
 * the parser-quality audit's `hasStructuredContent` check requires) and
 * block-level close tags → newlines.
 *
 * @param {string} containerHtml — innerHTML of the detail container, ideally
 *   already stripped of noise nodes (see PI_ASP_DETAIL_NOISE_SELECTOR).
 * @returns {string} structured plain text, or '' when the content is too
 *   thin to be a real job ad (caller falls back to its synthetic stub).
 */
export function piAspDetailHtmlToDescription(containerHtml = '') {
  // htmlToText's generic tag-strip does not understand comment nodes — a
  // `<!-- … -->` block containing markup would leak its text. Drop comments
  // outright before converting.
  const withoutComments = String(containerHtml || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const text = htmlToText(withoutComments)
    // htmlToText collapses runs of spaces but keeps every newline it emits;
    // squeeze leftover per-line whitespace and 3+ blank lines.
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < MIN_DETAIL_TEXT_CHARS) return '';
  return text;
}

/**
 * Render up to `maxRenders` pi-asp detail pages and return a Map
 * `url → structured description text`. URLs whose render or extraction fails
 * are simply absent from the map — callers keep their synthetic fallback
 * description, so a broken detail render degrades to today's behaviour
 * instead of dropping jobs.
 *
 * A single browser/context is shared across all URLs; the shared runtime
 * enforces the inter-navigation delay.
 *
 * @param {string[]} urls — pi-asp `bewerber-web…#position,id=…` deep links.
 * @param {object} [options]
 * @param {string} [options.label] — crawler key for log lines.
 * @param {number} [options.maxRenders=DEFAULT_MAX_DETAIL_RENDERS]
 * @param {number} [options.minDelayMs] — passed to fetchWithRateLimit.
 * @returns {Promise<Map<string, string>>}
 */
export async function renderPiAspDetailDescriptions(urls, options = {}) {
  const label = options.label || 'pi-asp';
  const maxRenders =
    Number.isFinite(options.maxRenders) && options.maxRenders > 0
      ? options.maxRenders
      : DEFAULT_MAX_DETAIL_RENDERS;

  const byUrl = new Map();
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return byUrl;

  const queue = unique.slice(0, maxRenders);
  if (unique.length > queue.length) {
    console.log(
      `  ⚠️ [${label}] detail-render cap: rendering ${queue.length}/${unique.length} ` +
        `detail pages this run (cap=${maxRenders}); the rest keep listing-derived descriptions.`,
    );
  }

  let browser;
  try {
    browser = await createBrowser({ userAgent: REALISTIC_UA });
    const context = await createPoliteContext(browser, { userAgent: REALISTIC_UA });

    for (const url of queue) {
      let page;
      try {
        page = await fetchWithRateLimit(context, url, {
          minDelayMs: options.minDelayMs,
        });

        // The shell arrives instantly; the job ad appears only after the GWT
        // app boots and its detail RPC resolves. Wait for a detail container
        // that actually carries text, not just for the node to exist.
        await page.waitForFunction(
          (sel) => {
            const el = document.querySelector(sel);
            return Boolean(el && el.innerText && el.innerText.trim().length >= 100);
          },
          PI_ASP_DETAIL_CONTAINER_SELECTOR,
          { timeout: DETAIL_RENDER_TIMEOUT_MS },
        );

        const containerHtml = await page.evaluate(
          ({ sel, noiseSel }) => {
            const el = document.querySelector(sel);
            if (!el) return '';
            const clone = el.cloneNode(true);
            for (const noise of clone.querySelectorAll(noiseSel)) noise.remove();
            return clone.innerHTML;
          },
          {
            sel: PI_ASP_DETAIL_CONTAINER_SELECTOR,
            noiseSel: PI_ASP_DETAIL_NOISE_SELECTOR,
          },
        );

        const description = piAspDetailHtmlToDescription(containerHtml);
        if (description) {
          byUrl.set(url, description);
        } else {
          console.warn(
            `  ⚠️ [${label}] detail rendered but too thin (<${MIN_DETAIL_TEXT_CHARS} chars) — ` +
              `falling back to listing description: ${url}`,
          );
        }
      } catch (err) {
        if (err instanceof AntiBotBlockError) {
          // Persistent block — stop hammering the ATS with the remaining URLs.
          console.warn(`  ⚠️ [${label}] anti-bot block on detail render, aborting details: ${err.message}`);
          break;
        }
        const kind = err instanceof NavigationTimeout ? 'navigation timeout' : 'detail render failed';
        console.warn(`  ⚠️ [${label}] ${kind} for ${url}: ${err?.message || err}`);
      } finally {
        if (page) {
          try {
            await page.close();
          } catch {
            /* no-op */
          }
        }
      }
    }

    console.log(
      `  ✓ [${label}] detail descriptions rendered: ${byUrl.size}/${queue.length}`,
    );
    return byUrl;
  } catch (err) {
    // Browser launch failure (OOM / missing binary even after self-heal):
    // degrade to listing-derived descriptions rather than failing the crawl.
    console.warn(
      `  ⚠️ [${label}] Playwright unavailable — keeping listing-derived descriptions: ${err?.message || err}`,
    );
    return byUrl;
  } finally {
    await closeAll(browser);
  }
}
