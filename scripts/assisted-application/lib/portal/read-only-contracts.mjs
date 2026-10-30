/** Read a public guest form without candidate data or any mutating browser request. */
import { launchChromium } from '../../../lib/ensure-chromium.mjs';
import { extractFields } from './fields.mjs';
import { hasApplicationSurface, postingMatch } from './portal.mjs';
import { publicContractGet } from './public-contract-get.mjs';

const contractKey = fields => JSON.stringify(fields.map(field => ({ id: field.id, frame: field.frame, label: field.label,
  form: field.form, context: field.context, section: field.section, autocomplete: field.autocomplete,
  kind: field.kind, inputType: field.inputType, required: field.required, invalid: field.invalid, options: field.options })));

export async function readOnlyPortalContracts({ applyUrl, job, channelType = '', get = publicContractGet,
  launch = () => launchChromium({ headless: true }), now = Date.now, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  let browser;
  let context;
  let page;
  let blocked = false;
  let resourceFailed = false;
  let requestCount = 0;
  let totalBytes = 0;
  const deniedRequests = [];
  const unknown = reason => ({ complete: false, readOnly: true, observedAt: now(), reason, deniedRequests });
  const recordDenied = request => {
    blocked = true;
    if (deniedRequests.length >= 3) return;
    const url = new URL(request.url());
    const endpoint = ['https:', 'http:'].includes(url.protocol) ? (url.origin + url.pathname).slice(0, 300) : 'unsupported_protocol';
    // Neither request bodies nor query strings belong in the diagnostic.
    deniedRequests.push({ method: request.method().slice(0, 12), endpoint });
  };
  const read = async (url, maxBytes = 1_500_000) => {
    let counted = 0;
    let requested = 0;
    const attempt = () => {
      requested++;
      if (++requestCount > 40) {
        controller.abort(new Error('contract_request_budget'));
        throw new Error('contract_request_budget');
      }
    };
    const consume = bytes => {
      counted += bytes;
      totalBytes += bytes;
      if (totalBytes > 5_000_000) {
        controller.abort(new Error('contract_byte_budget'));
        throw new Error('contract_byte_budget');
      }
    };
    const response = await get(url, { signal, maxBytes, onBytes: consume, onRequest: attempt });
    if (!requested) attempt();
    if (!counted) consume(response.body.length);
    return response;
  };
  try {
    const html = await read(applyUrl);
    if (html.status !== 200 || !String(html.headers['content-type'] || '').includes('text/html')) {
      return unknown(html.status >= 500 || html.status === 429 ? 'transient_http' : 'public_form_unavailable');
    }
    if (html.url !== applyUrl) return unknown('redirected_form_unknown');
    browser = await launch();
    context = await browser.newContext({ javaScriptEnabled: true, offline: true, serviceWorkers: 'block', acceptDownloads: false });
    await context.routeWebSocket('**/*', async socket => { blocked = true; await socket.close().catch(() => {}); });
    await context.exposeBinding('__portalContractProbeDenied', () => { blocked = true; });
    await context.addInitScript(() => {
      const denied = window.__portalContractProbeDenied;
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker', 'EventSource']) {
        if (!(name in window)) continue;
        Object.defineProperty(window, name, { value: function () {
          denied().catch(() => {});
          throw new Error('read_only_contract_probe');
        } });
      }
    });
    let rootDelivered = false;
    await context.route('**/*', async route => {
      const request = route.request();
      const mainDocument = request.isNavigationRequest() && page && request.frame() === page.mainFrame();
      if (request.method() !== 'GET' || (request.isNavigationRequest() && (!mainDocument || rootDelivered || request.url() !== applyUrl))) {
        recordDenied(request);
        await route.abort().catch(() => {});
        return;
      }
      if (['image', 'font', 'media'].includes(request.resourceType())) {
        await route.abort().catch(() => {});
        return;
      }
      const pathname = new URL(request.url()).pathname;
      if (!mainDocument && !(request.resourceType() === 'stylesheet' && /\.css$/i.test(pathname))
        && !(request.resourceType() === 'script' && /\.m?js$/i.test(pathname))) {
        recordDenied(request);
        await route.abort().catch(() => {});
        return;
      }
      if (requestCount > 40 || totalBytes > 5_000_000 || signal.aborted) {
        resourceFailed = true;
        await route.abort().catch(() => {});
        return;
      }
      try {
        const response = mainDocument ? html : await read(request.url(), 1_000_000);
        if (mainDocument) rootDelivered = true;
        if (response.status < 200 || response.status >= 300 || totalBytes > 5_000_000) throw new Error('resource_unavailable');
        const headers = {};
        for (const name of ['content-type', 'content-security-policy', 'access-control-allow-origin',
          'cross-origin-resource-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']) {
          if (typeof response.headers[name] === 'string') headers[name] = response.headers[name];
        }
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch {
        resourceFailed = true;
        await route.abort().catch(() => {});
      }
    });
    page = await context.newPage();
    await page.goto(applyUrl, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) });
    if (blocked || resourceFailed || signal.aborted || page.url() !== applyUrl) return unknown('incomplete_public_form');
    const first = await extractFields(page, { listboxOptions: false, channelType });
    const optionalMarkers = () => page.evaluate(() => [...document.querySelectorAll('[data-aa-id]')]
      .filter(element => typeof element.required === 'boolean')
      .map(element => ({ id: element.getAttribute('data-aa-id'), nativeRequired: element.required,
        explicitlyOptional: element.getAttribute('aria-required') === 'false' })));
    const firstMarkers = await optionalMarkers();
    await page.waitForTimeout(150);
    const snapshot = await extractFields(page, { listboxOptions: false, channelType });
    const finalMarkers = await optionalMarkers();
    if (blocked || resourceFailed || signal.aborted || first.captcha || snapshot.captcha) return unknown('challenge_or_incomplete_form');
    if (first.passwordVisible || snapshot.passwordVisible) return unknown('account_form_unknown');
    if (!hasApplicationSurface(snapshot) || !snapshot.fields.some(field => field.kind === 'file')) return unknown('application_form_unknown');
    const pageText = await page.locator('body').innerText({ timeout: 2_000 });
    if (postingMatch(pageText, job, applyUrl) !== 'match') return unknown('posting_mismatch');
    if (contractKey(first.fields) !== contractKey(snapshot.fields) || JSON.stringify(firstMarkers) !== JSON.stringify(finalMarkers)) return unknown('native_contract_unstable');
    return { complete: true, readOnly: true, stable: true, sourceUrl: applyUrl, url: page.url(), observedAt: now(),
      fields: snapshot.fields.map(({ value: _value, checked: _checked, ...field }) => ({ ...field,
        explicitlyOptional: field.frame === 0 && finalMarkers.filter(marker => marker.id === field.id
          && marker.explicitlyOptional && marker.nativeRequired === false).length === 1 })) };
  } catch (error) {
    return unknown(/^contract_(?:url|dns|redirect|encoding|response_too_large)/.test(String(error?.code || ''))
      ? 'public_contract_unsupported' : 'transient_probe_failure');
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
