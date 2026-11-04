import { describe, expect, it } from 'vitest';

import {
  RC_SERVER_NAMESPACE,
  fetchServerRcTemplate,
  removeRcParamsWithEtag,
  setRcParamWithEtag,
} from '../scripts/lib/remote-config-admin.mjs';

const credentials = {
  client_email: 'firebase@example.test',
  private_key: 'not-a-real-key',
  project_id: 'project-fixture',
};

function fakeRemoteConfig(parameters: Record<string, unknown>) {
  let current = { parameters };
  const calls: Array<{ method: string; url: URL; ifMatch: string | null; body?: any }> = [];
  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET');
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({
      method,
      url,
      ifMatch: headers?.['If-Match'] || null,
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    if (method === 'GET') {
      return new Response(JSON.stringify(current), { status: 200, headers: { etag: 'fixture-etag' } });
    }
    current = JSON.parse(String(init.body));
    return new Response('{}', { status: 200 });
  };
  return { calls, fetchImpl, current: () => current };
}

describe('Firebase Remote Config server template namespace', () => {
  it('reads the server template through the Admin SDK method without consulting the client template', async () => {
    const rc = {
      getTemplate: async () => { throw new Error('client template must not be read'); },
      getServerTemplate: async () => ({ parameters: { SERVER_TOKEN: { defaultValue: { value: 'private' } } } }),
    };

    await expect(fetchServerRcTemplate(rc as any)).resolves.toMatchObject({
      parameters: { SERVER_TOKEN: { defaultValue: { value: 'private' } } },
    });
  });

  it('publishes private credentials only to the firebase-server REST resource with ETag protection', async () => {
    const rc = fakeRemoteConfig({ KEEP: { defaultValue: { value: 'unchanged' } } });
    const result = await setRcParamWithEtag({
      credentials,
      name: 'SERVER_FB_PAGE_ACCESS_TOKEN',
      value: 'fixture-token',
      namespace: RC_SERVER_NAMESPACE,
      fetchImpl: rc.fetchImpl,
      getAccessToken: async () => 'fixture-access-token',
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ok: true, changed: true, attempt: 1 });
    expect(rc.calls.map(({ method }) => method)).toEqual(['GET', 'PUT']);
    for (const call of rc.calls) {
      expect(call.url.searchParams.get('name')).toBe(
        'projects/project-fixture/namespaces/firebase-server/remoteConfig',
      );
    }
    expect(rc.calls[1].ifMatch).toBe('fixture-etag');
    expect(rc.current().parameters).toMatchObject({
      KEEP: { defaultValue: { value: 'unchanged' } },
      SERVER_FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-token' } },
    });
  });

  it('removes only exact client-template secret parameters and preserves the rest', async () => {
    const rc = fakeRemoteConfig({
      SERVER_FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-token' } },
      FB_PAGE_ID: { defaultValue: { value: 'public-page-id' } },
    });
    const result = await removeRcParamsWithEtag({
      credentials,
      names: ['SERVER_FB_PAGE_ACCESS_TOKEN'],
      fetchImpl: rc.fetchImpl,
      getAccessToken: async () => 'fixture-access-token',
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ok: true, changed: true, attempt: 1 });
    expect(rc.calls.every(({ url }) => !url.searchParams.has('name'))).toBe(true);
    expect(rc.current().parameters).toEqual({
      FB_PAGE_ID: { defaultValue: { value: 'public-page-id' } },
    });
  });
});
