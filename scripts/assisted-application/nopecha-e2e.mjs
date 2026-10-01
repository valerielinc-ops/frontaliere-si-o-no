#!/usr/bin/env node
/** Actual extension + local portal; --probe-free additionally checks the public Token API. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { armRecaptchaV3, launchNopechaContext, solveRecaptchaV3 } from './lib/portal/nopecha.mjs';

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
  res.end(`<!doctype html><html><body><button id="send">Submit</button><p id="result"></p>
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
  const evidence = {};
  const solve = async ({ action }) => {
    assert.equal(action, 'apply');
    return 'solved-token';
  };
  await armRecaptchaV3(page, evidence, { solve });
  // Re-arming for a validation retry cannot install a duplicate binding or wrapper.
  await armRecaptchaV3(page, evidence, { solve });
  await page.locator('#send').click();
  await page.locator('#result').filter({ hasText: 'confirmed' }).waitFor();
  assert.deepEqual(received, ['solved-token']);
  assert.equal(evidence.captcha[0].solved, 1);
  assert.equal(evidence.captcha[0].requested, 1);
  // v2 widget ids retain the original function and do not create a Token API job.
  assert.equal(await page.evaluate(() => grecaptcha.execute(0)), 'native-token');
  assert.equal(evidence.captcha[0].requested, 1);

  // Provider failure keeps the native path usable, with a bounded, sanitized diagnostic.
  const refusedPage = await context.newPage();
  await refusedPage.goto(url);
  const refusedEvidence = {};
  await armRecaptchaV3(refusedPage, refusedEvidence, { solve: async () => { throw new Error('nopecha_error_12'); } });
  await refusedPage.locator('#send').click();
  await refusedPage.locator('#result').filter({ hasText: 'confirmed' }).waitFor();
  assert.deepEqual(received, ['solved-token', 'native-token']);
  assert.equal(refusedEvidence.captcha[0].error, 'nopecha_error_12');
  console.log('NopeCHA: extension loaded; v3 token delivered; one submission; v2 preserved; free-tier refusal preserved the native path.');

  if (process.argv.includes('--probe-free')) {
    // Public vendor demo, no candidate account, CV or employer submission.
    const demo = 'https://nopecha.com/captcha/recaptcha';
    const html = await (await fetch(demo, { signal: AbortSignal.timeout(15_000) })).text();
    const sitekey = /recaptcha\/api\.js\?render=([\w-]+)/.exec(html)?.[1];
    assert.ok(sitekey, 'NopeCHA demo no longer exposes its v3 site key');
    const token = await solveRecaptchaV3({ sitekey, url: demo, action: 'homepage' });
    assert.ok(token.length > 20, 'NopeCHA returned an invalid demo token');
    console.log('NopeCHA free Token API: token received on this runner (demo, not employer acceptance).');
  }
} finally {
  await context?.close();
  server.close();
}
