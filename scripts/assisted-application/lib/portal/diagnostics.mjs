/** Bounded browser diagnostics, stored only inside the order's encrypted evidence. */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { DIAGNOSTIC_BODY_LIMIT, DIAGNOSTIC_BODY_READ_LIMIT, diagnosticLocation, diagnosticText, hasBoundedBodyLength, responseErrors, settleDiagnostics } from './diagnostic-values.mjs';
import { FETCH_DIAGNOSTIC_BINDING, FETCH_DIAGNOSTIC_CONTROL } from './diagnostic-fetch.mjs';
export { diagnosticLocation, diagnosticText, responseErrors } from './diagnostic-values.mjs';

let browserScript;
function fetchDiagnosticScript() {
  // Bundle the same byte-limited stream reader and redaction code used in Node.
  browserScript ||= build({
    stdin: { contents: "import { installFetchDiagnostics } from './diagnostic-fetch.mjs'; installFetchDiagnostics(window);", resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022',
  }).then((result) => result.outputFiles[0].text);
  return browserScript;
}
const LIMIT = 40;

/**
 * A human challenge served to the browser: hCaptcha's `getcaptcha`, reCAPTCHA's
 * image `payload`. Lever, TSMG 2026-10-01: SUBMIT APPLICATION opened an hCaptcha
 * challenge that nobody passed and that was gone by the end of the wait.
 */
export function isChallengeRequest(url) {
  const location = diagnosticLocation(url);
  if (!location) return false;
  return (/(^|\.)hcaptcha\.com$/.test(location.host) && /^\/getcaptcha(\/|$)/.test(location.path))
    || (/(^|\.)(google\.com|recaptcha\.net)$/.test(location.host) && /^\/recaptcha\/(api2|enterprise)\/payload(\/|$)/.test(location.path));
}

/** Read validity without checkValidity/reportValidity, which would change the page. */
export async function validationDiagnostics(page) {
  const frames = typeof page.frames === 'function' ? page.frames() : [page];
  const results = [];
  for (const frame of frames.slice(0, 8)) {
    const data = await frame.evaluate(() => {
      const rendered = (node) => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
      const messages = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live], .error, .invalid-feedback, [class*="error-message" i], [class*="errorMessage"]')]
        .filter((node) => rendered(node) && !node.closest('#__next-route-announcer__, next-route-announcer, #gatsby-announcer'))
        .map((node) => (node.innerText || node.textContent || '').trim().slice(0, 800)).filter(Boolean).slice(0, 20);
      const invalid = [...document.querySelectorAll('input, select, textarea, [aria-invalid="true"]')]
        .filter((node) => node.getAttribute('aria-invalid') === 'true' || (node.willValidate && !node.validity.valid))
        .slice(0, 20).map((node) => ({
          label: node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.name || '',
          type: node.type || node.getAttribute('role') || node.tagName.toLowerCase(),
          message: node.validationMessage || '',
          required: Boolean(node.required) || node.getAttribute('aria-required') === 'true',
          filled: Boolean(String(node.value || '').trim()),
        }));
      return { messages: [...new Set(messages)], invalid };
    }).catch(() => null);
    if (data) results.push({
      location: diagnosticLocation(frame.url()),
      messages: data.messages.map(diagnosticText),
      invalid: data.invalid.map((field) => ({ ...field, label: diagnosticText(field.label), message: diagnosticText(field.message) })),
    });
  }
  return results;
}

export function startPortalDiagnostics(context, httpFailures = []) {
  const data = { console: [], pageErrors: [], requests: [], responses: [], requestFailures: [], validation: [] };
  const listeners = [];
  const pending = new Set();
  let phase = 'navigation';
  let stopped = false;
  // Outside the capped lists: a challenge's own image fetches can fill them.
  // Armed by finalClick() at each attempt's own click, never earlier (review of #10810).
  let clickArmed = false;
  let challengeAfterClick = false;
  let bodyReads = 0;
  let fetchInstalled = false;
  const push = (list, entry) => { if (!stopped && list.length < LIMIT) list.push({ phase, ...entry }); };
  const controlFetch = async (method) => {
    if (!fetchInstalled) return;
    const frames = context.pages().flatMap((page) => page.frames());
    await settleDiagnostics(frames.map((frame) => frame.evaluate(({ key, method }) => window[key]?.[method](), { key: FETCH_DIAGNOSTIC_CONTROL, method })));
  };
  const listen = (target, event, handler) => { target.on(event, handler); listeners.push(() => target.off(event, handler)); };
  const tracked = (request) => ['xhr', 'fetch'].includes(request.resourceType()) || /^(POST|PUT|PATCH)$/.test(request.method());
  const metadata = (request) => ({ ...diagnosticLocation(request.url()), method: request.method(), resourceType: request.resourceType() });
  const pages = new WeakSet();
  const attach = (page) => {
    if (pages.has(page)) return;
    pages.add(page);
    listen(page, 'console', (message) => {
      if (['error', 'warning'].includes(message.type())) push(data.console, { type: message.type(), text: diagnosticText(message.text()), location: diagnosticLocation(message.location().url) });
    });
    listen(page, 'pageerror', (error) => push(data.pageErrors, { name: diagnosticText(error.name), message: diagnosticText(error.message), stack: diagnosticText(error.stack) }));
  };
  listen(context, 'page', attach);
  for (const page of context.pages()) attach(page);
  listen(context, 'request', (request) => {
    if (clickArmed && !stopped && isChallengeRequest(request.url())) challengeAfterClick = true;
    if (tracked(request)) push(data.requests, metadata(request));
  });
  listen(context, 'requestfailed', (request) => push(data.requestFailures, { ...metadata(request), error: diagnosticText(request.failure()?.errorText) }));
  listen(context, 'response', (response) => {
    const request = response.request();
    if (!tracked(request) || data.responses.length >= LIMIT || stopped) return;
    const entry = { phase, ...metadata(request), status: response.status() };
    data.responses.push(entry);
    if (phase === 'submit' && response.status() >= 400 && /^(POST|PUT|PATCH)$/.test(request.method()) && httpFailures.length < 10) {
      httpFailures.push({ ...diagnosticLocation(response.url()), method: request.method(), status: response.status() });
    }
    if (bodyReads >= DIAGNOSTIC_BODY_READ_LIMIT) return;
    bodyReads += 1;
    const task = (async () => {
      const type = await response.headerValue('content-type');
      if (!/json/i.test(type || '')) return;
      const rawSize = await response.headerValue('content-length');
      // Playwright exposes a buffered body, not a bounded stream. Unknown or
      // chunked sizes stay metadata-only instead of buffering an arbitrary payload.
      if (!hasBoundedBodyLength(rawSize)) {
        if (!stopped) entry.bodySkipped = 'size_not_bounded';
        return;
      }
      const bytes = await response.body();
      if (stopped || bytes.length > DIAGNOSTIC_BODY_LIMIT) return;
      const errors = responseErrors(JSON.parse(bytes.toString('utf8')), response.status() >= 400);
      if (errors.length) entry.errors = errors;
    })().catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  return {
    data,
    /** Right before the final click of this attempt: only what follows it counts. */
    finalClick() {
      clickArmed = true;
      challengeAfterClick = false;
    },
    /** The portal served a human challenge after this attempt's final click. */
    challengeAfterClick: () => challengeAfterClick,
    async installFetchObserver() {
      await context.exposeBinding(FETCH_DIAGNOSTIC_BINDING, (_source, entry) => {
        if (stopped || !entry || !Array.isArray(entry.errors)) return;
        const location = diagnosticLocation(`https://${String(entry.location?.host || '').slice(0, 253)}${String(entry.location?.path || '').slice(0, 300)}`);
        if (!location) return;
        const errors = responseErrors({ errors: entry.errors });
        if (!errors.length) return;
        push(data.responses, {
          ...location, method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(entry.method) ? entry.method : 'OTHER',
          resourceType: 'fetch', source: 'browser_stream',
          status: Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599 ? entry.status : 0,
          errors,
        });
      });
      await context.addInitScript({ content: await fetchDiagnosticScript() });
      fetchInstalled = true;
    },
    async beforeSubmit(page) {
      phase = 'submit';
      // Reserve the bounded network/error budget for the decisive click.
      bodyReads = 0;
      await controlFetch('reset');
      for (const list of [data.console, data.pageErrors, data.requests, data.responses, data.requestFailures]) {
        if (list.length > 10) list.splice(0, list.length - 10);
      }
      data.validation.push({ phase: 'before_submit', frames: await validationDiagnostics(page) });
    },
    async afterSubmit(page, outcome) {
      data.validation.push({ phase: 'after_submit', outcome, frames: await validationDiagnostics(page) });
    },
    async finish() {
      listeners.forEach((stop) => stop());
      await controlFetch('finish');
      await settleDiagnostics(pending);
      stopped = true;
    },
  };
}
