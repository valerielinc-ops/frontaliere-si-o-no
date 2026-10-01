/** Bounded browser diagnostics, stored only inside the order's encrypted evidence. */
const LIMIT = 40;
const TEXT_LIMIT = 800;
const BODY_LIMIT = 64 * 1024;

export function diagnosticLocation(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? { host: url.hostname, path: url.pathname.slice(0, 300) } : null;
  } catch { return null; }
}

/** No URL queries, bearer credentials, JWTs or named secrets in diagnostic text. */
export function diagnosticText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      const location = diagnosticLocation(raw);
      return location ? `${location.host}${location.path}` : '[url]';
    })
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/((?:password|passwd|authorization|cookie|[\w-]*token|api[_-]?key)\s*["']?\s*[:=]\s*)["']?[^\s,;"'}]+/gi, '$1[redacted]')
    .slice(0, TEXT_LIMIT);
}

/** Keep error fields, never the complete JSON response (which may contain an account). */
export function responseErrors(body, failedHttp = false) {
  const errors = [];
  const visit = (value, field = '', depth = 0) => {
    if (errors.length >= 8 || depth > 3 || value == null) return;
    if (typeof value === 'string') {
      errors.push({ message: diagnosticText(value), ...(field ? { field: diagnosticText(field) } : {}) });
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) visit(item, field, depth + 1);
    } else if (typeof value === 'object') {
      const detail = {};
      for (const key of ['code', 'errorCode', 'message', 'field', 'path']) {
        if (['string', 'number'].includes(typeof value[key])) detail[key] = diagnosticText(value[key]);
      }
      if (Object.keys(detail).length) errors.push({ ...(field ? { field: diagnosticText(field) } : {}), ...detail });
      for (const [key, item] of Object.entries(value).slice(0, 30)) {
        if (/^(error|errors|validationErrors)$/i.test(key)) visit(item, field, depth + 1);
      }
      // Validation dictionaries: { errors: { linkedin: ["Invalid URL"] } }.
      if (!Object.keys(detail).length && depth > 0) {
        for (const [key, item] of Object.entries(value).slice(0, 8)) {
          if (!/password|token|secret|cookie|authorization|api.?key/i.test(key)
            && !/^(error|errors|validationErrors)$/i.test(key)) visit(item, key, depth + 1);
        }
      }
    }
  };
  // A successful payload may itself be a token, OTP or an account's `code`.
  // Only error envelopes (or an explicit failure) are diagnostic material.
  if (failedHttp || body?.success === false || body?.ok === false || body?.errorCode != null) visit(body);
  else if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of ['error', 'errors', 'validationErrors']) {
      if (body[key] != null) visit(body[key], '', 1);
    }
  }
  return errors.slice(0, 8);
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
  let bodyReads = 0;
  const push = (list, entry) => { if (!stopped && list.length < LIMIT) list.push({ phase, ...entry }); };
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
  listen(context, 'request', (request) => { if (tracked(request)) push(data.requests, metadata(request)); });
  listen(context, 'requestfailed', (request) => push(data.requestFailures, { ...metadata(request), error: diagnosticText(request.failure()?.errorText) }));
  listen(context, 'response', (response) => {
    const request = response.request();
    if (!tracked(request) || data.responses.length >= LIMIT || stopped) return;
    const entry = { phase, ...metadata(request), status: response.status() };
    data.responses.push(entry);
    if (phase === 'submit' && response.status() >= 400 && /^(POST|PUT|PATCH)$/.test(request.method()) && httpFailures.length < 10) {
      httpFailures.push({ ...diagnosticLocation(response.url()), method: request.method(), status: response.status() });
    }
    if (bodyReads >= 12) return;
    bodyReads += 1;
    const task = (async () => {
      const type = await response.headerValue('content-type');
      if (!/json/i.test(type || '')) return;
      const rawSize = await response.headerValue('content-length');
      const size = Number(rawSize);
      // Playwright exposes a buffered body, not a bounded stream. Unknown or
      // chunked sizes stay metadata-only instead of buffering an arbitrary payload.
      if (!/^[1-9]\d*$/.test(rawSize || '') || !Number.isSafeInteger(size) || size > BODY_LIMIT) {
        if (!stopped) entry.bodySkipped = 'size_not_bounded';
        return;
      }
      const bytes = await response.body();
      if (stopped || bytes.length > BODY_LIMIT) return;
      const errors = responseErrors(JSON.parse(bytes.toString('utf8')), response.status() >= 400);
      if (errors.length) entry.errors = errors;
    })().catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  return {
    data,
    async beforeSubmit(page) {
      phase = 'submit';
      // Reserve the bounded network/error budget for the decisive click.
      bodyReads = 0;
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
      let timer;
      await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      stopped = true;
    },
  };
}
