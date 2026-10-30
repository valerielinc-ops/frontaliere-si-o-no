import { describe, expect, it } from 'vitest';
import { nextRemoteBatch } from '../scripts/assisted-application/remote-executor.mjs';
import { executionArtifacts } from '../scripts/assisted-application/lib/execution-artifacts.mjs';
import { privateBrowserEnvironment } from '../scripts/assisted-application/lib/darwin-isolation.mjs';

describe('remote executor transport boundaries', () => {
  it('visits pending orders beyond the first full batch and then starts a fresh fair sweep', async () => {
    const orders = Array.from({ length: 61 }, (_, index) => ({ id: String(index).padStart(3, '0') }));
    const db = { collection(name) {
      expect(name).toBe('assisted_applications'); let after = ''; let limit = 0;
      const query = {
        where(field, operator, value) { expect([field, operator, value]).toEqual(['automationState', '==', 'submitting']); return query; },
        orderBy(field) { expect(field).toBe('__name__'); return query; },
        limit(value) { limit = value; return query; },
        startAfter(cursor) { after = cursor.id; return query; },
        async get() { return { docs: orders.filter(doc => doc.id > after).slice(0, limit) }; },
      }; return query;
    } };
    let cursor = null; const seen = [];
    do { const page = await nextRemoteBatch({ db, cursor }); seen.push(...page.docs.map(doc => doc.id)); cursor = page.cursor; } while (cursor);
    expect(seen).toEqual(orders.map(doc => doc.id));
    expect((await nextRemoteBatch({ db, cursor })).docs[0].id).toBe('000');
  });
  it('never passes manager credentials or the owner home into the browser environment', () => {
    expect(privateBrowserEnvironment({ home: '/private/browser-home', temporary: '/private/browser-tmp',
      env: { HOME: '/owner', GOOGLE_APPLICATION_CREDENTIALS: '/owner/service-account', CODEX_AUTH_JSON: 'secret', PATH: '/owner/bin', LANG: 'it' } }))
      .toEqual({ PATH: '/usr/bin:/bin', HOME: '/private/browser-home', TMPDIR: '/private/browser-tmp', LANG: 'it' });
  });
  it('bridges only bounded already-redacted issue fields, with no arbitrary artifact payload', () => {
    const stop = { host: 'jobs.example.test', path: '/[posting]/apply', reason: 'captcha', channel: 'lever', step: 2,
      buttons: ['Continue'], fields: [], errors: ['contact fixture@example.test'], agent: [], privateDump: 'excluded' };
    const result = executionArtifacts({ stop, arbitraryDump: 'excluded' });
    expect(result.stop.privateDump).toBeUndefined(); expect(result.arbitraryDump).toBeUndefined();
    expect(result.stop.errors).toEqual(['contact [email]']);
    expect(executionArtifacts({ stop: { ...stop, path: '/apply?candidate=private' } })).toEqual({});
    expect(executionArtifacts({ stop: { ...stop, buttons: ['x'.repeat(40_000)] } })).toEqual({});
    expect(executionArtifacts({ pass: { host: 'jobs.example.test', channel: 'lever', mode: 'submit', stage: 'unknown' } })).toEqual({});
  });
});
