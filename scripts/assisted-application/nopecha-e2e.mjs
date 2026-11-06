#!/usr/bin/env node
/** Actual extension + local portal; --probe-free additionally checks the public Token API. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { awaitCaptcha, launchNopechaContext } from './lib/portal/nopecha.mjs';
import { extractFields } from './lib/portal/fields.mjs';
import { probeAnonymousRecaptchaV3 } from './lib/nopecha-probe.mjs';

const extension = process.env.NOPECHA_EXTENSION_PATH;
assert.ok(extension, 'NOPECHA_EXTENSION_PATH is required');
const received = [];
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/submit') {
    let token = '';
    for await (const chunk of req) token += chunk;
    received.push(token);
    res.end('received');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  // A local widget fixture: the extension loads, but this test does not spend quota.
  if (req.url.startsWith('/recaptcha/')) { res.end('<html></html>'); return; }
  res.end(`<!doctype html><html><body><button id="send">Submit</button><p id="result"></p>
    <iframe src="/recaptcha/api2/anchor?size=normal" width="300" height="100"></iframe>
    <textarea name="g-recaptcha-response" hidden></textarea>
    <script>
      window.grecaptcha = {execute: async () => 'native-token'};
      document.getElementById('send').onclick = async () => {
        const token = await grecaptcha.execute('public_test_sitekey', {action: 'apply'});
        await fetch('/submit', {method: 'POST', body: token});
        document.getElementById('result').textContent = 'confirmed';
      };
    </script></body></html>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let context;
try {
  context = await launchNopechaContext(extension, {
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  });
  const page = await context.newPage();
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url);
  const pending = await extractFields(page, { listboxOptions: false });
  assert.equal(pending.captcha, true);
  // Simulate the response field the extension fills after recognizing a challenge.
  await page.evaluate(() => { setTimeout(() => { document.querySelector('textarea').value = 'widget-token'; }, 50); });
  const solved = await awaitCaptcha(page, pending, { enabled: true, timeoutMs: 3000 });
  assert.equal(solved.captcha, false);
  await page.locator('#send').click();
  await page.locator('#result').filter({ hasText: 'confirmed' }).waitFor();
  assert.deepEqual(received, ['native-token']);
  // Neither v3 nor numeric v2 execute calls are replaced by an unsupported free API.
  assert.equal(await page.evaluate(() => grecaptcha.execute(0)), 'native-token');
  await page.evaluate(() => { document.querySelector('textarea').value = ''; });
  const unresolved = await awaitCaptcha(page, pending, { enabled: true, timeoutMs: 50 });
  assert.equal(unresolved.captcha, true);
  assert.equal(received.length, 1);
  console.log('NopeCHA: extension loaded; solved widget recognized; unresolved challenge preserved; one submission; native v3 unchanged.');

  if (process.argv.includes('--probe-free')) {
    // Public vendor demo, no candidate account, CV or employer submission.
    const demo = 'https://nopecha.com/captcha/recaptcha';
    const html = await (await fetch(demo, { signal: AbortSignal.timeout(15_000) })).text();
    const sitekey = /recaptcha\/api\.js\?render=([\w-]+)/.exec(html)?.[1];
    assert.ok(sitekey, 'NopeCHA demo no longer exposes its v3 site key');
    const token = await probeAnonymousRecaptchaV3({ sitekey, url: demo, action: 'homepage' });
    assert.ok(token.length > 20, 'NopeCHA returned an invalid demo token');
    console.log('NopeCHA free Token API: token received on this runner (demo, not employer acceptance).');
  }
} finally {
  await context?.close();
  server.close();
}
