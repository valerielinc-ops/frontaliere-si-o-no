import { test, expect, type Page } from 'playwright/test';

/**
 * Live guard: the body a reader sees belongs to the article they opened.
 *
 * WHAT BROKE, 2026-08-09. A reader on
 * /articoli-frontaliere/psicologo-frontaliere-ticino-lavoro/ got the right
 * title and excerpt with the DAILY BRIEF underneath — "Buongiorno, è domenica 9
 * agosto 2026. Questo è il bollettino quotidiano…". The cause was one stash and
 * no identity: `staticArticleFallback` holds a single clone of the LANDING
 * page's `article.ft-blog-article`, it survives client-side navigation, and
 * `adoptRuntimeArticle` published it under whatever id the next URL resolved
 * to. Because `mergeArticleMetaOverlay` never overwrites, the wrong body then
 * stuck for the rest of the session.
 *
 * WHY THIS RUNS LIVE. The unit tests in `runtime-article-resolution.test.ts`
 * pin the attribution rule directly, which is the real guard. What they cannot
 * assemble is the condition that makes the path reachable at all: an article
 * that EXISTS but is absent from the deployed bundle. That is not a fixture —
 * it is the normal state of everything the corpus published since the last
 * deploy, and it exists only in production, only until the next deploy.
 *
 * THE JOURNEY IS THE TEST. A direct landing cannot show the bug: the stash and
 * the URL agree. The failure needs a SECOND article in the same document, which
 * is why this navigates rather than calling `page.goto` twice.
 *
 * SKIPS RATHER THAN FAILS when the shape it needs is not there — no edition
 * today, or no article newer than the bundle. A skip says "not observable now";
 * turning that into a red would train the team to ignore this file.
 */

const BASE = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/$/, '');
const HUB = `${BASE}/articoli-frontaliere/`;

/** Text only today's edition has. The brief opens on this greeting in every locale's it-source. */
const BRIEF_MARKERS = [/bollettino quotidiano/i, /Buongiorno,\s*è\s+(luned|marted|mercoled|gioved|venerd|sabato|domenica)/i];

const isBrief = (text: string) => BRIEF_MARKERS.some((re) => re.test(text));

/** Consent overlays intercept clicks; they are not what is under test. */
async function dismissConsent(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.fc-consent-root, .fc-dialog-overlay').forEach((el) => el.remove());
  }).catch(() => {});
}

async function articleText(page: Page): Promise<string> {
  const article = page.locator('article').first();
  return (await article.innerText().catch(() => '')).replace(/\s+/g, ' ');
}

test('un articolo aperto dopo il bollettino non ne eredita il corpo', async ({ page }) => {
  // 1. The edition is the landing page — the one whose body leaked.
  const today = new Date().toISOString().slice(0, 10);
  const briefUrl = `${BASE}/articoli-frontaliere/bollettino-frontaliere-${today}/`;
  const landing = await page.goto(briefUrl, { waitUntil: 'domcontentloaded' });
  test.skip(!landing || landing.status() === 404, `nessuna edizione per ${today} — niente da osservare`);

  await page.waitForTimeout(4000);
  await dismissConsent(page);
  const briefText = await articleText(page);
  test.skip(!isBrief(briefText), 'la pagina di atterraggio non è il bollettino — precondizione assente');

  // 2. Reach a DIFFERENT article without a full page load, so the document —
  //    and its single stash — is the brief's throughout.
  await page.evaluate(() => {
    const hub = [...document.querySelectorAll('a')]
      .find((a) => /\/articoli-frontaliere\/?$/.test(a.getAttribute('href') || ''));
    hub?.click();
  });
  await page.waitForTimeout(3000);
  await dismissConsent(page);

  const target = await page.evaluate(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/articoli-frontaliere/"]')]
      .find((a) => {
        const href = a.getAttribute('href') || '';
        return !/\/articoli-frontaliere\/?$/.test(href) && !href.includes('bollettino-frontaliere');
      });
    if (!link) return null;
    const href = link.getAttribute('href');
    link.click();
    return href;
  });
  test.skip(!target, 'nessun altro articolo raggiungibile dall’hub');

  await page.waitForTimeout(6000);
  await dismissConsent(page);

  // 3. The reader is on another article's URL. Whatever body is rendered there,
  //    it may not be the edition's.
  expect(page.url()).not.toContain('bollettino-frontaliere');
  const text = await articleText(page);
  expect(text.length, `nessun corpo renderizzato su ${page.url()}`).toBeGreaterThan(200);
  expect(isBrief(text), `il corpo del bollettino è finito su ${page.url()}`).toBe(false);
});

test('nessuno degli articoli aperti nella stessa visita eredita il bollettino', async ({ page }) => {
  // The reported symptom was "tutti gli articoli", not one: the stash is
  // published once per id and the document keeps it, so EVERY article opened
  // after the edition took it. One target proves the leak; several prove it is
  // not a single unlucky slug.
  const today = new Date().toISOString().slice(0, 10);
  const landing = await page.goto(`${BASE}/articoli-frontaliere/bollettino-frontaliere-${today}/`, {
    waitUntil: 'domcontentloaded',
  });
  test.skip(!landing || landing.status() === 404, `nessuna edizione per ${today} — niente da osservare`);
  await page.waitForTimeout(4000);
  await dismissConsent(page);
  test.skip(!isBrief(await articleText(page)), 'la pagina di atterraggio non è il bollettino');

  const gotoHub = async () => {
    await page.evaluate(() => {
      const hub = [...document.querySelectorAll('a')]
        .find((a) => /\/articoli-frontaliere\/?$/.test(a.getAttribute('href') || ''));
      hub?.click();
    });
    await page.waitForTimeout(3000);
    await dismissConsent(page);
  };

  await gotoHub();
  const targets = await page.evaluate(() => {
    const hrefs = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/articoli-frontaliere/"]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => !/\/articoli-frontaliere\/?$/.test(h) && !h.includes('bollettino-frontaliere'));
    return [...new Set(hrefs)].slice(0, 3);
  });
  test.skip(targets.length === 0, 'nessun articolo raggiungibile dall’hub');

  for (const href of targets) {
    // Client-side each time: a full load would re-stash and hide the bug.
    const moved = await page.evaluate((target) => {
      const link = [...document.querySelectorAll<HTMLAnchorElement>('a')]
        .find((a) => a.getAttribute('href') === target);
      if (!link) return false;
      link.click();
      return true;
    }, href);
    if (!moved) continue;
    await page.waitForTimeout(5000);
    await dismissConsent(page);

    const text = await articleText(page);
    expect(isBrief(text), `il corpo del bollettino è finito su ${href}`).toBe(false);
    await gotoHub();
  }
});
