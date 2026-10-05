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
 *   - one whole runRobot() publish through the persistent profile: the confirm
 *     dispatch happens after the confirmation, never in a dry run.
 */
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildQueueEntry, parseLedger } from '../lib/social-publish-queue.mjs';
import { openProfile } from './lib/browser.mjs';
import { emptyJournal } from './lib/cadence.mjs';
import { FLOWS, RobotError, captureDiagnostics, stepTracker } from './lib/flows.mjs';
import { runRobot } from './lib/robot.mjs';

const CAPTION = '📰 I 5 articoli più letti di ieri su frontaliereticino.ch\n\n1. Uno — 10 visualizzazioni\n2. Due — 8 visualizzazioni\n\n#frontalieri #ticino';

const page = (title, body, script = '') => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;

function instagramPage({ confirm = true, afterShare = '' } = {}) {
  return page('Instagram', `
<nav><a href="#" id="create" role="link">Crea</a><a href="/">Home</a></nav>
<div id="menu" hidden><a href="#" id="post-item" role="link">Post</a><a href="#">Diretta</a></div>
<div id="dialog" role="dialog" hidden>
  <h2>Crea nuovo post</h2>
  <div id="pick"><form enctype="multipart/form-data"><input id="file" type="file" accept="image/jpeg,image/png,image/heic" multiple style="display:none"></form><button type="button">Seleziona dal computer</button></div>
  <div id="crop" hidden><p>Ritaglia</p><div role="button" tabindex="0" class="next">Avanti</div></div>
  <div id="edit" hidden><p>Modifica</p><div role="button" tabindex="0" class="next">Avanti</div></div>
  <div id="share-step" hidden><div id="caption" contenteditable="true" role="textbox" aria-label="Scrivi una didascalia..."></div><div role="button" tabindex="0" id="share">Condividi</div></div>
  <div id="done" hidden><img alt="" src="data:,"><span>Il tuo post è stato condiviso.</span></div>
</div>`, `
const $ = (id) => document.getElementById(id);
let count = 0;
$('create').onclick = (e) => { e.preventDefault(); $('menu').hidden = false; };
$('post-item').onclick = (e) => { e.preventDefault(); $('menu').hidden = true; $('dialog').hidden = false; };
$('file').onchange = () => { count = $('file').files.length; $('pick').hidden = true; $('crop').hidden = false; };
const steps = ['crop', 'edit', 'share-step'];
document.querySelectorAll('.next').forEach((b) => b.onclick = () => { const i = steps.findIndex((s) => !$(s).hidden); $(steps[i]).hidden = true; $(steps[i + 1]).hidden = false; });
$('share').onclick = async () => {
  await fetch('/api/ig/share', { method: 'POST', body: JSON.stringify({ caption: $('caption').innerText, files: count }) });
  $('share-step').hidden = true;
  ${afterShare ? `location.href = '${afterShare}';` : confirm ? "$('done').hidden = false;" : ''}
};`);
}

const instagramLogin = () => page('Login • Instagram', '<form><input name="username" aria-label="Username"><input name="password" type="password" aria-label="Password"><button>Accedi</button></form>');

function tiktokPage({ accept = 'video/*', captcha = false, captchaAfterPost = false, afterPost = 'redirect' } = {}) {
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
</main>`, `
const $ = (id) => document.getElementById(id);
let count = 0;
let popupEscapes = 0;
$('file').onchange = () => {
  count = $('file').files.length;
  $('processing').hidden = false;
  setTimeout(() => { $('editor').hidden = false; $('caption').innerText = 'carousel.mp4'; }, 400);
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
$('post').onclick = async () => {
  await fetch('/api/tt/post', { method: 'POST', body: JSON.stringify({ caption: $('caption').innerText, files: count, popupEscapes }) });
  ${captchaAfterPost
    ? "document.querySelector('main').insertAdjacentHTML('afterbegin', '<div id=\"captcha-verify-container\"><p>Drag the slider to fit the puzzle</p></div>');"
    : after}
};`);
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
  const video = path.join(work, 'carousel.mp4');
  writeFileSync(video, Buffer.from('fake-mp4'));
  const videoFiles = [video];
  const human = { pause: () => new Promise((r) => setTimeout(r, 30)), typeDelay: () => 0 };
  const timeouts = { ui: 5_000, upload: 10_000, confirm: 3_000, optional: 800 };
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const stateDir = path.join(work, 'state');
  const context = await openProfile({ stateDir, headless: true, launch: executablePath ? { executablePath, kind: 'explicit' } : { kind: 'playwright-default' } });
  const tab = context.pages()[0] || (await context.newPage());

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
    check(existsSync(path.join(r.dir, 'ready-to-publish.png')), 'dry run leaves a screenshot of the ready post');
    check(state.igShares.length === 0, 'dry run shares nothing');

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
