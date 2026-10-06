#!/usr/bin/env node
/**
 * End-to-end check of the social robot's web flows on LOCAL look-alike pages
 * of Instagram and TikTok: no network, no account, no secret. Run by
 * social-robot-e2e.yml when the robot changes, and by hand:
 *
 *   node scripts/social-robot/robot-e2e.mjs
 *   (PLAYWRIGHT_CHROMIUM_PATH=<binary> to use a local Chromium build)
 *
 * vitest cannot cover it: tests.yml has no browser. The pages copy the
 * structure the selectors of lib/flows.mjs rely on (roles, labels, the hidden
 * file input, TikTok's Draft.js editor and its late-enabled Post button), in
 * Italian for Instagram and English for TikTok, so both language branches of
 * the selectors run. Scenarios:
 *   - dry run on both: reaches the publish button, screenshot, NOTHING sent;
 *   - publish on both: pressed once, confirmation seen, caption and slides
 *     received by the fake platform;
 *   - a press with no confirmation: `confirmation-missing`, pressed = true —
 *     on TikTok also with the persistent "Manage your posts" navigation on the
 *     page, which is not a confirmation; the success toast is;
 *   - a challenge (Instagram) or a captcha (TikTok) right after the press:
 *     keeps its class, pressed = true — the post may be online;
 *   - login wall, challenge, and a video-only upload field with processing;
 *   - an Instagram SVG-only create fallback whose hit target is its button;
 *     a non-actionable TikTok cookie config beside an unrelated banner; a
 *     cookie banner whose custom element is defined late, one that appears on
 *     the Post hover, one with a zero-size host and fixed shadow content, one
 *     that blocks the optional Post now click, or one with a closed shadow root;
 *   - one whole runRobot() publish through the persistent profile: the confirm
 *     dispatch happens after the confirmation, never in a dry run.
 */
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildQueueEntry, parseLedger } from '../lib/social-publish-queue.mjs';
import { openProfile } from './lib/browser.mjs';
import { emptyJournal } from './lib/cadence.mjs';
import { FLOWS, RobotError, captureDiagnostics, stepTracker } from './lib/flows.mjs';
import { runRobot } from './lib/robot.mjs';

const CAPTION = '📰 I 5 articoli più letti di ieri su frontaliereticino.ch\n\n1. Uno — 10 visualizzazioni\n2. Due — 8 visualizzazioni\n\n#frontalieri #ticino';
const normalized = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const page = (title, body, script = '') => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

function instagramPage({ confirm = true, afterShare = '', createMenu = true, fallbackCreate = false } = {}) {
  const createMenuMarkup = createMenu ? `
<div id="menu" hidden>
  <a href="#" id="post-item" role="link"><span>Post</span><svg aria-label="Post" role="img"><title>Post</title></svg></a>
  <a href="#"><span>Video in diretta</span><svg aria-label="Video in diretta" role="img"><title>Video in diretta</title></svg></a>
  <a href="#"><span>Inserzione</span><svg aria-label="Inserzione" role="img"><title>Inserzione</title></svg></a>
</div>` : '';
  const createMarkup = fallbackCreate
    ? '<button type="button" id="create" aria-label="Open composer"><svg aria-label="New post" role="img" width="24" height="24"></svg></button>'
    : '<a href="#" id="create" role="link">Crea</a>';
  const dialogContent = `
  <h2>Crea nuovo post</h2>
  <div id="pick"><form enctype="multipart/form-data"><input id="file" type="file" accept="image/jpeg,image/png,image/heic" multiple style="display:none"></form><button type="button">Seleziona dal computer</button></div>
  <div id="crop" hidden><p>Ritaglia</p><div role="button" tabindex="0" class="next">Avanti</div></div>
  <div id="edit" hidden><p>Modifica</p><div role="button" tabindex="0" class="next">Avanti</div></div>
  <div id="share-step" hidden><div id="caption" contenteditable="true" role="textbox" aria-label="Scrivi una didascalia..."></div><div role="button" tabindex="0" id="share">Condividi</div></div>
  <div id="done" hidden><img alt="" src="data:,"><span>Il tuo post è stato condiviso.</span></div>`;
  const dialogMarkup = createMenu
    ? '<div id="dialog" role="dialog" hidden></div>'
    : `<div id="dialog" role="dialog" hidden>${dialogContent}</div>`;
  const openDialog = `$('dialog').innerHTML = ${JSON.stringify(dialogContent)}; $('dialog').hidden = false; bindDialog();`;
  const createAction = createMenu ? "$('menu').hidden = false;" : openDialog;
  const postAction = createMenu ? `$('post-item').onclick = (e) => { e.preventDefault(); $('menu').hidden = true; ${openDialog} };` : '';
  return page('Instagram', `
<nav>${createMarkup}<a href="/">Home</a></nav>
${createMenuMarkup}
${dialogMarkup}`, `
const $ = (id) => document.getElementById(id);
let count = 0;
$('create').onclick = (e) => { e.preventDefault(); ${createAction} };
${postAction}
function bindDialog() {
  $('file').onchange = () => { count = $('file').files.length; $('pick').hidden = true; $('crop').hidden = false; };
  const steps = ['crop', 'edit', 'share-step'];
  document.querySelectorAll('.next').forEach((b) => b.onclick = () => { const i = steps.findIndex((s) => !$(s).hidden); $(steps[i]).hidden = true; $(steps[i + 1]).hidden = false; });
  $('share').onclick = async () => {
    await fetch('/api/ig/share', { method: 'POST', body: JSON.stringify({ caption: $('caption').innerText, files: count }) });
    $('share-step').hidden = true;
    ${afterShare ? `location.href = '${afterShare}';` : confirm ? "$('done').hidden = false;" : ''}
  };
}
${createMenu ? '' : 'bindDialog();'}`);
}

const instagramLogin = () => page('Login • Instagram', '<form><input name="username" aria-label="Username"><input name="password" type="password" aria-label="Password"><button>Accedi</button></form>');

function tiktokPage({
  accept = 'video/*',
  captcha = false,
  captchaAfterPost = false,
  afterPost = 'redirect',
  cookieBanner = false,
  lateCookieBanner = false,
  zeroSizeCookieBanner = false,
  closedCookieBanner = false,
  delayedCookieBanner = false,
  optionalPostCookieBanner = false,
  cookieConfig = false,
  unrelatedBanner = false,
  contentChecks = false,
  guidedTour = false,
  unknownOverlay = false,
  lateUnknownOverlay = false,
  prefilledCaption = 'video',
} = {}) {
  const cookieShadowMarkup = `
    <style>
      :host { display: block; position: fixed; inset: auto 0 0; z-index: 2000; height: 260px; background: #0aa; color: white; font: 16px sans-serif; }
      section { box-sizing: border-box; height: 100%; padding: 24px 64px; }
      .actions { display: flex; gap: 16px; justify-content: flex-end; }
      button { background: white; border: 0; border-radius: 4px; color: #111; font: 600 16px sans-serif; padding: 14px 20px; }
      ${zeroSizeCookieBanner ? 'section { position: fixed; inset: 0; z-index: 2000; width: 100vw; height: 100vh; background: #0aa; }' : ''}
    </style>
    <section aria-label="Consentire i cookie da TikTok su questo browser?">
      <h2>Consentire i cookie da TikTok su questo browser?</h2>
      <p>TikTok utilizza cookie e tecnologie simili per fornire, migliorare, proteggere e analizzare i nostri servizi.</p>
      <div class="actions">
        <button id="cookie-decline">Rifiuta i cookie opzionali</button>
        <button id="cookie-accept">Consenti tutti</button>
      </div>
    </section>`;
  const hasCookieBanner = cookieBanner || lateCookieBanner || zeroSizeCookieBanner || closedCookieBanner || delayedCookieBanner || optionalPostCookieBanner;
  const cookieVisibleOnLoad = cookieBanner || delayedCookieBanner;
  const cookieMode = closedCookieBanner || optionalPostCookieBanner ? 'closed' : 'open';
  const cookieAttributes = zeroSizeCookieBanner
    ? ' style="display:block;position:fixed;inset:auto 0 0;width:0;height:0"'
    : optionalPostCookieBanner
    ? ' hidden style="display:none"'
    : cookieVisibleOnLoad
    ? (delayedCookieBanner ? ' style="display:block;position:fixed;inset:auto 0 0;height:260px;z-index:2000"' : '')
    : ' hidden';
  const after = {
    redirect: "location.href = '/tiktokstudio/content';",
    // The POST answers 200 and the page stays where it is: no toast, no redirect.
    stay: '',
    toast: "document.body.insertAdjacentHTML('beforeend', '<div class=\"TUXTopToast\" role=\"alert\"><span>Your post has been published</span></div>');",
  }[afterPost];
  return page('TikTok Studio', `
<nav><a href="/tiktokstudio/content">Manage your posts</a><a href="/tiktokstudio/upload">Upload</a></nav>
<main>
  ${captcha ? '<div id="captcha-verify-container"><p>Drag the slider to fit the puzzle</p></div>' : ''}
  <div id="upload"><input id="file" type="file" accept="${accept}"><p>Select a video to upload</p></div>
  <div id="processing" data-e2e="upload-progress" role="progressbar" hidden>Processing video…</div>
  <div id="editor" hidden>
    <div data-e2e="caption_container"><div class="public-DraftEditor-content" contenteditable="true" role="combobox" id="caption"></div><div id="hashtag-suggestions" role="listbox" hidden><div role="option">different-suggestion</div></div></div>
    <button data-e2e="post_video_button" id="post" disabled>Post</button>
  </div>
  ${(hasCookieBanner || cookieConfig) ? '<script id="tiktok-cookie-banner-config" type="application/json">{"i18n":{"cookieBannerTitle":"Consentire i cookie da TikTok su questo browser?","cookieBannerBtnDecline":"Rifiuta i cookie opzionali"}}</script>' : ''}
  ${hasCookieBanner ? `<tiktok-cookie-banner id="cookie-banner"${cookieAttributes}></tiktok-cookie-banner>` : ''}
  ${optionalPostCookieBanner ? '<button id="post-now" hidden style="position:fixed;left:30px;bottom:30px;z-index:100">Post now</button>' : ''}
  ${unrelatedBanner ? '<div id="unrelated-banner" role="banner">Account navigation</div>' : ''}
  ${contentChecks ? '<div id="content-checks" role="dialog" hidden style="position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.4);padding:25% 20%"><h2>Attivare i controlli automatici dei contenuti?</h2><p>Esamineremo automaticamente il tuo video per escludere problemi con il copyright e altre possibili violazioni.</p><label><input type="checkbox" checked>Controllo a campione dei contenuti</label><button id="content-cancel">Annulla</button><button id="content-activate">Attiva</button><button id="content-close" aria-label="Close">×</button></div>' : ''}
  ${guidedTour ? '<div id="react-joyride-portal" hidden><div class="react-joyride__overlay" data-test-id="overlay" role="presentation" style="position:fixed;inset:0;z-index:1001;pointer-events:auto;background:rgba(0,0,0,.5)"></div><div class="react-joyride__tooltip" role="alertdialog" aria-modal="true" style="position:fixed;left:50%;bottom:125px;z-index:1002;width:280px;transform:translateX(-50%);background:white;color:#111;padding:20px"><h2>Nuove funzionalità di editing aggiunte</h2><p>Ora è più facile che mai creare video professionali e coinvolgenti.</p><button id="tour-action">Ok</button></div></div>' : ''}
  ${unknownOverlay || lateUnknownOverlay ? '<div id="unknown-overlay" hidden style="position:fixed;inset:0;z-index:1100;pointer-events:auto;background:rgba(120,0,0,.25)"><h2>Conferma il tuo account creator</h2><button id="unknown-continue">Continua</button></div>' : ''}
</main>`, `
const $ = (id) => document.getElementById(id);
let count = 0;
let popupEscapes = 0;
let contentAction = 'none';
let cookieAction = 'none';
let cookieAcceptClicks = 0;
let cookieShownByHover = false;
${hasCookieBanner ? `
const cookie = $('cookie-banner');
const installCookie = (host, mode) => {
  const cookieRoot = host.attachShadow({ mode });
  cookieRoot.innerHTML = ${JSON.stringify(cookieShadowMarkup)};
  cookieRoot.getElementById('cookie-decline').addEventListener('click', () => { cookieAction = 'decline'; host.hidden = true; host.style.display = 'none'; });
  cookieRoot.getElementById('cookie-accept').addEventListener('click', () => { cookieAcceptClicks += 1; cookieAction = 'accept'; host.hidden = true; host.style.display = 'none'; });
};
${delayedCookieBanner ? "setTimeout(() => customElements.define('tiktok-cookie-banner', class extends HTMLElement { connectedCallback() { installCookie(this, 'open'); } }), 150);" : `customElements.define('tiktok-cookie-banner', class extends HTMLElement {}); installCookie(cookie, ${JSON.stringify(cookieMode)});`}
${lateCookieBanner ? "$('post').addEventListener('mouseenter', () => { cookieShownByHover = true; cookie.hidden = false; cookie.style.display = ''; }, { once: true });" : ''}
${zeroSizeCookieBanner ? "cookie.shadowRoot.querySelector('section').hidden = true; $('post').addEventListener('mouseenter', () => { cookie.shadowRoot.querySelector('section').hidden = false; }, { once: true });" : ''}
` : ''}
${lateUnknownOverlay ? "$('post').addEventListener('mouseenter', () => { $('unknown-overlay').hidden = false; }, { once: true });" : ''}
$('content-cancel')?.addEventListener('click', () => { contentAction = 'cancel'; $('content-checks').hidden = true; });
$('content-activate')?.addEventListener('click', () => { contentAction = 'activate'; $('content-checks').hidden = true; });
$('content-close')?.addEventListener('click', () => { contentAction = 'close'; $('content-checks').hidden = true; });
let tourStep = 0;
$('tour-action')?.addEventListener('click', () => {
  if (tourStep === 0) {
    tourStep = 1;
    $('tour-action').textContent = 'Last';
  } else {
    $('react-joyride-portal').remove();
  }
});
$('file').onchange = () => {
  count = $('file').files.length;
  $('processing').hidden = false;
  setTimeout(() => {
    $('editor').hidden = false;
    $('caption').innerText = ${JSON.stringify(prefilledCaption)};
    if (${contentChecks}) $('content-checks').hidden = false;
    if (${guidedTour}) $('react-joyride-portal').hidden = false;
    if (${unknownOverlay}) $('unknown-overlay').hidden = false;
  }, 400);
  setTimeout(() => { $('processing').hidden = true; $('post').disabled = false; }, 1200);
};
$('caption').addEventListener('input', () => {
  const text = $('caption').innerText;
  $('hashtag-suggestions').hidden = !(text.includes('#') && !text.endsWith(' '));
});
$('caption').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { popupEscapes += 1; $('hashtag-suggestions').hidden = true; }
  if (e.key === ' ') $('hashtag-suggestions').hidden = true;
});
const sendPost = async () => {
  await fetch('/api/tt/post', { method: 'POST', body: JSON.stringify({ caption: $('caption').innerText, files: count, popupEscapes, contentAction, cookieAction, cookieAcceptClicks, cookieShownByHover }) });
  ${captchaAfterPost
    ? "document.querySelector('main').insertAdjacentHTML('afterbegin', '<div id=\"captcha-verify-container\"><p>Drag the slider to fit the puzzle</p></div>');"
    : after}
};
$('post').onclick = async () => {
  if (${optionalPostCookieBanner}) {
    $('post-now').hidden = false;
    $('cookie-banner').hidden = false;
    $('cookie-banner').style.display = '';
    return;
  }
  await sendPost();
};
$('post-now')?.addEventListener('click', sendPost);
`);
}

function fakePlatforms() {
  const state = { igShares: [], ttPosts: [] };
  const server = http.createServer((req, res) => {
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const data = JSON.parse(body || '{}');
        if (req.url === '/api/ig/share') state.igShares.push(data);
        if (req.url === '/api/tt/post') state.ttPosts.push(data);
        send(200, '{}', 'application/json');
      });
      return;
    }
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/ig/': return send(200, instagramPage());
      case '/ig-direct/': return send(200, instagramPage({ createMenu: false }));
      case '/ig-svg-fallback/': return send(200, instagramPage({ createMenu: false, fallbackCreate: true }));
      case '/ig-silent/': return send(200, instagramPage({ confirm: false }));
      case '/ig-challenge-after-share/': return send(200, instagramPage({ afterShare: '/challenge/' }));
      case '/challenge/': return send(200, page('Instagram', '<h1>Help us confirm it\'s you</h1>'));
      case '/ig-logged-out/': return send(302, '', 'text/plain', { location: '/accounts/login/' });
      case '/accounts/login/': return send(200, instagramLogin());
      case '/tiktokstudio/upload': return send(200, tiktokPage());
      case '/tt-captcha/tiktokstudio/upload': return send(200, tiktokPage({ captcha: true }));
      case '/tt-video-only/tiktokstudio/upload': return send(200, tiktokPage({ accept: 'video/*' }));
      case '/tt-captcha-after-post/tiktokstudio/upload': return send(200, tiktokPage({ captchaAfterPost: true }));
      case '/tt-silent/tiktokstudio/upload': return send(200, tiktokPage({ afterPost: 'stay' }));
      case '/tt-toast/tiktokstudio/upload': return send(200, tiktokPage({ afterPost: 'toast' }));
      case '/tt-cookie-config-no-action/tiktokstudio/upload': return send(200, tiktokPage({ cookieConfig: true, unrelatedBanner: true }));
      case '/tt-late-cookie/tiktokstudio/upload': return send(200, tiktokPage({ lateCookieBanner: true }));
      case '/tt-zero-size-cookie/tiktokstudio/upload': return send(200, tiktokPage({ zeroSizeCookieBanner: true }));
      case '/tt-delayed-cookie/tiktokstudio/upload': return send(200, tiktokPage({ delayedCookieBanner: true }));
      case '/tt-closed-cookie/tiktokstudio/upload': return send(200, tiktokPage({ closedCookieBanner: true }));
      case '/tt-optional-cookie-intercept/tiktokstudio/upload': return send(200, tiktokPage({ optionalPostCookieBanner: true }));
      case '/tt-unknown-publish/tiktokstudio/upload': return send(200, tiktokPage({ lateUnknownOverlay: true }));
      case '/tt-interstitials/tiktokstudio/upload': return send(200, tiktokPage({ cookieBanner: true, contentChecks: true, guidedTour: true }));
      case '/tt-unknown/tiktokstudio/upload': return send(200, tiktokPage({ unknownOverlay: true }));
      case '/tiktokstudio/content': return send(200, page('Manage posts', '<h1>Manage your posts</h1>'));
      default: return send(404, 'not found', 'text/plain');
    }
  });
  return { server, state };
}

function check(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), 'social-robot-e2e-'));
  const { server, state } = fakePlatforms();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = [1, 2, 3].map((i) => {
    const f = path.join(work, `slide-${i}.jpg`);
    writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return f;
  });
  const video = path.join(work, 'article-2026-10-03.mp4');
  writeFileSync(video, Buffer.from('fake-mp4'));
  const videoFiles = [video];
  const human = { pause: () => new Promise((r) => setTimeout(r, 30)), typeDelay: () => 0 };
  const timeouts = { ui: 5_000, upload: 10_000, confirm: 3_000, optional: 800 };
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const stateDir = path.join(work, 'state');
  const context = await openProfile({ stateDir, headless: true, launch: executablePath ? { executablePath, kind: 'explicit' } : { kind: 'playwright-default' } });
  const tab = context.pages()[0] || (await context.newPage());
  tab.setDefaultTimeout(1_500);

  const run = async (channel, startUrl, { dryRun, label }) => {
    const dir = path.join(work, 'diagnostics', label);
    const step = stepTracker();
    const snap = (name) => captureDiagnostics(tab, dir, name, { channel, step: step.get() });
    try {
      return { result: await FLOWS[channel]({ page: tab, files: channel === 'tiktok' ? videoFiles : files, caption: CAPTION, dryRun, human, snap, startUrl, timeouts, video: channel === 'tiktok' ? { bytes: 8, durationMs: 7_750 } : undefined, step }), dir };
    } catch (err) {
      return { error: err, dir };
    }
  };

  try {
    console.log('Instagram (it)');
    let r = await run('instagram', `${base}/ig/`, { dryRun: true, label: 'ig-dry' });
    check(r.result?.status === 'dry-run', `dry run stops at the Share button (${r.error?.message || 'ok'})`);
    check(existsSync(path.join(r.dir, 'create-menu.png')), 'submenu leaves a screenshot before Post is selected');
    check(existsSync(path.join(r.dir, 'ready-to-publish.png')), 'dry run leaves a screenshot of the ready post');
    check(state.igShares.length === 0, 'dry run shares nothing');

    r = await run('instagram', `${base}/ig-direct/`, { dryRun: true, label: 'ig-direct-dry' });
    check(r.result?.status === 'dry-run', `legacy direct dialog remains supported (${r.error?.message || 'ok'})`);

    r = await run('instagram', `${base}/ig-svg-fallback/`, { dryRun: true, label: 'ig-svg-fallback' });
    check(r.result?.status === 'dry-run', `an SVG-only create fallback clicks through its button parent (${r.error?.message || 'ok'})`);

    r = await run('instagram', `${base}/ig/`, { dryRun: false, label: 'ig-publish' });
    check(r.result?.status === 'published' && /condiviso/i.test(r.result.evidence), `publish returns only with the confirmation (${r.result?.evidence || r.error?.message})`);
    check(state.igShares.length === 1 && state.igShares[0].files === files.length, 'one share with every slide');
    check(state.igShares[0].caption.includes('I 5 articoli più letti') && state.igShares[0].caption.includes('#frontalieri'), 'the caption reached the platform');

    r = await run('instagram', `${base}/ig-silent/`, { dryRun: false, label: 'ig-silent' });
    check(r.error instanceof RobotError && r.error.errorClass === 'confirmation-missing' && r.error.pressed === true, 'a press without confirmation is confirmation-missing, pressed');

    const sharesBeforeChallenge = state.igShares.length;
    r = await run('instagram', `${base}/ig-challenge-after-share/`, { dryRun: false, label: 'ig-challenge-after' });
    check(state.igShares.length === sharesBeforeChallenge + 1, 'the share reached the platform before the challenge');
    check(r.error?.errorClass === 'challenge' && r.error.pressed === true, `a challenge after the press stays a challenge, pressed (${r.error?.errorClass}, pressed=${r.error?.pressed})`);

    const before = state.igShares.length;
    r = await run('instagram', `${base}/ig-logged-out/`, { dryRun: false, label: 'ig-login' });
    check(r.error?.errorClass === 'login-required', 'a login wall is login-required');
    check(state.igShares.length === before, 'nothing shared from a login wall');

    console.log('TikTok (en)');
    r = await run('tiktok', `${base}/tiktokstudio/upload`, { dryRun: true, label: 'tt-dry' });
    check(r.result?.status === 'dry-run', `dry run waits for the Post button to enable and stops (${r.error?.message || 'ok'})`);
    check(existsSync(path.join(r.dir, 'ready-to-publish.png')), 'dry run leaves a screenshot of the ready post');
    check(state.ttPosts.length === 0, 'dry run posts nothing');

    r = await run('tiktok', `${base}/tt-cookie-config-no-action/tiktokstudio/upload`, { dryRun: true, label: 'tt-cookie-config-no-action' });
    check(r.result?.status === 'dry-run', `a non-actionable cookie config does not block upload (${r.error?.message || 'ok'})`);

    r = await run('tiktok', `${base}/tiktokstudio/upload`, { dryRun: false, label: 'tt-publish' });
    check(r.result?.status === 'published', `publish returns with the redirect to the content page (${r.result?.evidence || r.error?.message})`);
    check(state.ttPosts.length === 1 && !state.ttPosts[0].caption.includes('slide-1.jpg'), 'the pre-filled file name was replaced by the caption');
    check(state.ttPosts[0].caption.includes('#ticino') && state.ttPosts[0].files === videoFiles.length && state.ttPosts[0].popupEscapes > 0, 'caption, hashtag popup handling and video reached the platform');

    r = await run('tiktok', `${base}/tt-captcha/tiktokstudio/upload`, { dryRun: false, label: 'tt-captcha' });
    check(r.error?.errorClass === 'challenge', 'a captcha is a challenge');
    r = await run('tiktok', `${base}/tt-video-only/tiktokstudio/upload`, { dryRun: false, label: 'tt-video' });
    check(r.result?.status === 'published', 'the video-only upload field accepts the MP4');
    check(state.ttPosts.length === 2, 'only the captcha was skipped');
    r = await run('tiktok', `${base}/tt-captcha-after-post/tiktokstudio/upload`, { dryRun: false, label: 'tt-captcha-after' });
    check(state.ttPosts.length === 3, 'the post reached the platform before the captcha');
    check(r.error?.errorClass === 'challenge' && r.error.pressed === true, `a captcha after the press stays a challenge, pressed (${r.error?.errorClass}, pressed=${r.error?.pressed})`);
    r = await run('tiktok', `${base}/tt-silent/tiktokstudio/upload`, { dryRun: false, label: 'tt-silent' });
    check(state.ttPosts.length === 4, 'the silent page sent the post (200, no redirect)');
    check(r.result?.status !== 'published' && r.error?.errorClass === 'confirmation-missing' && r.error.pressed === true,
      `the persistent "Manage your posts" navigation is no confirmation: confirmation-missing, pressed (${r.result?.status || r.error?.errorClass}, pressed=${r.error?.pressed})`);
    r = await run('tiktok', `${base}/tt-toast/tiktokstudio/upload`, { dryRun: false, label: 'tt-toast' });
    check(r.result?.status === 'published' && /has been published/i.test(r.result.evidence), `the success toast confirms without a redirect (${r.result?.evidence || r.error?.message})`);

    r = await run('tiktok', `${base}/tt-late-cookie/tiktokstudio/upload`, { dryRun: false, label: 'tt-late-cookie' });
    check(r.result?.status === 'published', `a cookie banner shown at publish is dismissed and the retry publishes (${r.result?.evidence || r.error?.message})`);
    check(state.ttPosts.at(-1).cookieShownByHover === true && state.ttPosts.at(-1).cookieAction === 'decline' && state.ttPosts.at(-1).cookieAcceptClicks === 0, 'the late banner used only the optional-cookie rejection, never the accept-all action');

    r = await run('tiktok', `${base}/tt-zero-size-cookie/tiktokstudio/upload`, { dryRun: false, label: 'tt-zero-size-cookie' });
    check(r.result?.status === 'published', `a zero-size cookie host with visible fixed shadow content is dismissed and the retry publishes (${r.result?.evidence || r.error?.message})`);
    check(state.ttPosts.at(-1).cookieAction === 'decline' && state.ttPosts.at(-1).cookieAcceptClicks === 0, 'the zero-size cookie host uses only the exact optional-cookie rejection, never the accept-all action');

    r = await run('tiktok', `${base}/tt-delayed-cookie/tiktokstudio/upload`, { dryRun: false, label: 'tt-delayed-cookie' });
    check(r.result?.status === 'published', `a not-yet-defined cookie host is waited for and dismissed (${r.result?.evidence || r.error?.message})`);
    check(state.ttPosts.at(-1).cookieAction === 'decline' && state.ttPosts.at(-1).cookieAcceptClicks === 0, 'the delayed cookie host uses only the optional-cookie rejection');

    const beforeClosedCookie = state.ttPosts.length;
    r = await run('tiktok', `${base}/tt-closed-cookie/tiktokstudio/upload`, { dryRun: false, label: 'tt-closed-cookie' });
    check(r.error?.errorClass === 'cookie-banner-unreachable' && /shadow root closed/i.test(r.error.message) && /VNC/i.test(r.error.message), 'a closed cookie shadow root fails closed with the VNC manual action');
    check(r.error?.pressed === false, 'an intercepted publish click records pressed=false');
    check(state.ttPosts.length === beforeClosedCookie, 'the closed cookie banner never posted');
    const closedCookieDiagnostic = JSON.parse(readFileSync(path.join(r.dir, 'cookie-banner-unreachable.json'), 'utf8'));
    check(closedCookieDiagnostic.shadowRootMode === 'closed-or-not-ready' && closedCookieDiagnostic.cookieBannerState === 'defined-closed', 'the closed cookie diagnostic records the observed defined-closed state');

    const beforeOptionalCookie = state.ttPosts.length;
    r = await run('tiktok', `${base}/tt-optional-cookie-intercept/tiktokstudio/upload`, { dryRun: false, label: 'tt-optional-cookie-intercept' });
    check(r.error?.errorClass === 'cookie-banner-unreachable' && r.error?.step === 'publish', 'an unreachable cookie banner intercepted Post now and propagated its fail-closed error');
    check(state.ttPosts.length === beforeOptionalCookie, 'the intercepted optional Post now click never entered confirmation');

    const beforeUnknownAtPublish = state.ttPosts.length;
    r = await run('tiktok', `${base}/tt-unknown-publish/tiktokstudio/upload`, { dryRun: false, label: 'tt-unknown-publish' });
    check(r.error?.errorClass === 'interstitial-unknown' && r.error?.step === 'publish', 'an unknown overlay at the publish click remains interstitial-unknown');
    check(state.ttPosts.length === beforeUnknownAtPublish && existsSync(path.join(r.dir, 'interstitial-unknown.png')), 'the unknown publish overlay never posted and left a diagnostic');

    const beforeInterstitials = state.ttPosts.length;
    r = await run('tiktok', `${base}/tt-interstitials/tiktokstudio/upload`, { dryRun: false, label: 'tt-interstitials' });
    check(r.result?.status === 'published', `known interstitials are dismissed before caption and publish (${r.result?.evidence || r.error?.message})`);
    check(state.ttPosts.length === beforeInterstitials + 1, 'the known-interstitial post reached the fake platform');
    check(normalized(state.ttPosts.at(-1).caption) === normalized(CAPTION), 'the pre-filled TikTok caption was replaced exactly, hashtags included');
    check(state.ttPosts.at(-1).contentAction === 'cancel' && state.ttPosts.at(-1).cookieAction === 'decline', 'known interstitials used only safe actions');

    const unknownStarted = Date.now();
    r = await run('tiktok', `${base}/tt-unknown/tiktokstudio/upload`, { dryRun: false, label: 'tt-unknown' });
    const unknownElapsed = Date.now() - unknownStarted;
    check(r.error?.errorClass === 'interstitial-unknown' && r.error?.step === 'caption', `an unknown overlay stops before the caption click (${r.error?.errorClass || r.error?.message})`);
    check(unknownElapsed < 10_000, `the unknown overlay fails closed without the long click timeout (${unknownElapsed}ms)`);
    check(state.ttPosts.length === beforeInterstitials + 1, 'the unknown-overlay scenario never posted');
    check(existsSync(path.join(r.dir, 'interstitial-unknown.png')), 'the unknown overlay leaves a dedicated screenshot');

    console.log('runRobot, persistent profile');
    const entry = buildQueueEntry({
      channel: 'instagram', kind: 'article', day: '2026-10-03', caption: CAPTION,
      imageUrls: ['https://cdn.frontaliereticino.ch/images/social/instagram/article-2026-10-03-0.jpg'],
      ledgerEntries: [{ id: 'uno', kind: 'article', url: 'https://frontaliereticino.ch/x/', day: '2026-10-03', views: 10 }],
    });
    let journal = emptyJournal();
    const dispatched = [];
    const robot = (cliMode, rcMode, startUrl) => runRobot({
      cliMode, rcMode, platforms: ['instagram'], sleep: async () => {},
      reader: { readQueue: () => ({ pending: [entry] }), readLedger: () => parseLedger('') },
      journalStore: { load: () => journal, save: (j) => { journal = j; } },
      fetchImages: async () => files,
      diagnosticsFor: () => path.join(work, 'diagnostics', `robot-${cliMode}-${rcMode}`),
      publishWith: (channel, e, f, { dryRun, human: h, diagnosticsDir }) => FLOWS[channel]({ page: tab, files: f, caption: e.caption, dryRun, human: h, timeouts, startUrl, snap: (n) => captureDiagnostics(tab, diagnosticsDir, n) }),
      dispatchConfirm: async (args) => { dispatched.push({ ...args, sharesAtDispatch: state.igShares.length }); return { ok: true }; },
      reportIssue: async () => { throw new Error('no issue expected'); },
      log: { log: () => {}, warn: () => {}, error: console.error },
    });
    const shares = state.igShares.length;
    let out = await robot('publish', 'dry', `${base}/ig/`);
    check(out.dryRun && out.results[0].outcome === 'dry-run' && dispatched.length === 0 && state.igShares.length === shares, '--publish with Remote Config "dry" stays a dry run');
    out = await robot('publish', 'live', `${base}/ig/`);
    check(out.results[0].outcome === 'published' && dispatched.length === 1, 'live publish dispatches one confirmation');
    check(dispatched[0].sharesAtDispatch === shares + 1 && dispatched[0].queueId === entry.id, 'the dispatch follows the confirmed share of that entry');
    out = await robot('publish', 'live', `${base}/ig/`);
    check(out.results[0].outcome === 'empty' && state.igShares.length === shares + 1, 'the same entry is never pressed twice');

    console.log('\n✅ social robot e2e: all scenarios passed');
  } finally {
    await context.close().catch(() => {});
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`❌ ${err.stack || err.message}`);
  process.exit(1);
});
