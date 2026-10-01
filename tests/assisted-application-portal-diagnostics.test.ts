import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { diagnosticLocation, diagnosticText, responseErrors, startPortalDiagnostics } from '../scripts/assisted-application/lib/portal/diagnostics.mjs';

function fixture() {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://jobs.example/apply?token=private',
    evaluate: vi.fn(async () => ({ messages: ['Profile URL required'], invalid: [{ label: 'LinkedIn', message: 'Invalid URL', required: true, filled: false }] })),
  });
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const request = { url: () => 'https://jobs.example/api/apply?email=private', method: () => 'POST', resourceType: () => 'fetch', failure: () => ({ errorText: 'net::ERR_FAILED' }) };
  const response = (body: object, status = 200) => ({ request: () => request, url: request.url, status: () => status, headerValue: async (key: string) => key === 'content-type' ? 'application/json' : String(Buffer.byteLength(JSON.stringify(body))), body: async () => Buffer.from(JSON.stringify(body)) });
  return { page, context, request, response };
}

describe('encrypted portal diagnostics', () => {
  it('strips queries, fragments, credentials and named secrets from diagnostic text', () => {
    expect(diagnosticLocation('https://user:pass@jobs.example/apply?token=private#secret')).toEqual({ host: 'jobs.example', path: '/apply' });
    expect(diagnosticLocation('data:text/plain,private')).toBeNull();
    const text = diagnosticText('https://jobs.example/api?token=private Bearer abc password="secret" recaptcha-token=hidden');
    expect(text).not.toMatch(/private|abc|secret|hidden/);
    expect(diagnosticText('a'.repeat(2000))).toHaveLength(800);
  });

  it('extracts validation errors, including successful HTTP responses, without copying account data', () => {
    expect(responseErrors({ data: { email: 'private', password: 'secret' }, errors: [{ code: 'INVALID_PROFILE', message: 'Profile URL required', field: 'linkedin' }] }))
      .toEqual([{ code: 'INVALID_PROFILE', message: 'Profile URL required', field: 'linkedin' }]);
    expect(responseErrors({ errors: { linkedin: ['Invalid URL'], password: 'secret' } })).toEqual([{ message: 'Invalid URL', field: 'linkedin' }]);
    expect(responseErrors({ data: { user: 'private' }, token: 'secret' })).toEqual([]);
    expect(responseErrors('opaque-credential')).toEqual([]);
    expect(responseErrors({ code: 'opaque-credential', message: 'Welcome' })).toEqual([]);
    expect(responseErrors({ message: 'Invalid URL' }, true)).toEqual([{ message: 'Invalid URL' }]);
    expect(responseErrors({ success: false, code: 'INVALID_URL', message: 'Invalid URL' })).toEqual([{ code: 'INVALID_URL', message: 'Invalid URL' }]);
  });

  it('records console, page errors, failed requests and HTTP 200 validation errors around the final click', async () => {
    const { context, page, request, response } = fixture();
    const failures: object[] = [];
    const diagnostics = startPortalDiagnostics(context, failures);
    await diagnostics.beforeSubmit(page);
    page.emit('console', { type: () => 'error', text: () => 'Profile URL required token=private', location: () => ({ url: 'https://jobs.example/app.js?token=private' }) });
    page.emit('pageerror', new Error('client_validation_failed'));
    context.emit('request', request);
    context.emit('requestfailed', request);
    context.emit('response', response({ errors: [{ field: 'linkedin', message: 'Required' }], data: { password: 'private' } }));
    context.emit('response', response({ error: { code: 'INVALID_PROFILE' } }, 422));
    await diagnostics.afterSubmit(page, 'refused');
    await diagnostics.finish();
    expect(diagnostics.data.console[0]).toMatchObject({ phase: 'submit', text: 'Profile URL required token=[redacted]' });
    expect(diagnostics.data.pageErrors[0].message).toBe('client_validation_failed');
    expect(diagnostics.data.requestFailures[0].error).toBe('net::ERR_FAILED');
    expect(diagnostics.data.responses[0]).toMatchObject({ status: 200, errors: [{ field: 'linkedin', message: 'Required' }] });
    expect(failures).toEqual([{ host: 'jobs.example', path: '/api/apply', method: 'POST', status: 422 }]);
    expect(diagnostics.data.validation[1]).toMatchObject({ phase: 'after_submit', outcome: 'refused', frames: [{ invalid: [{ label: 'LinkedIn', filled: false }] }] });
    expect(JSON.stringify(diagnostics.data)).not.toContain('private');
    expect(context.listenerCount('response')).toBe(0);
    expect(page.listenerCount('console')).toBe(0);
  });

  it('attaches popup pages, caps early noise and reserves room for the submit', async () => {
    const { context, page, request } = fixture();
    const popup = fixture().page;
    const diagnostics = startPortalDiagnostics(context);
    context.emit('page', popup);
    for (let i = 0; i < 100; i += 1) context.emit('request', request);
    expect(diagnostics.data.requests).toHaveLength(40);
    await diagnostics.beforeSubmit(page);
    expect(diagnostics.data.requests).toHaveLength(10);
    context.emit('request', request);
    popup.emit('pageerror', new Error('popup_error'));
    expect(diagnostics.data.requests.at(-1).phase).toBe('submit');
    expect(diagnostics.data.pageErrors.at(-1).message).toBe('popup_error');
    await diagnostics.finish();
    expect(popup.listenerCount('pageerror')).toBe(0);
  });

  it.each([null, '', 'NaN', 'Infinity', '-1', '65537', '1.5'])('does not buffer a JSON response with unbounded size %s', async (size) => {
    const { context, response } = fixture();
    const diagnostics = startPortalDiagnostics(context);
    const large = response({ error: 'x'.repeat(70_000) });
    large.headerValue = async (key: string) => key === 'content-type' ? 'application/json' : size;
    large.body = vi.fn(large.body);
    context.emit('response', large);
    await diagnostics.finish();
    expect(large.body).not.toHaveBeenCalled();
    expect(diagnostics.data.responses[0].bodySkipped).toBe('size_not_bounded');
  });
});
