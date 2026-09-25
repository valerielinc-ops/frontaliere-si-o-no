import { describe, expect, it } from 'vitest';
import {
  KEY_ID,
  provisionPagespeedKey,
  restrictionsMatch,
} from '../scripts/ci/provision-pagespeed-key.mjs';

const CREDENTIALS = { client_email: 'sa@example.iam.gserviceaccount.com', private_key: 'PRIVATE', project_id: 'demo-project' };
const KEY_STRING = 'AIza-test-key-value';
const KEY_NAME = `projects/demo-project/locations/global/keys/${KEY_ID}`;

type Call = { method: string; url: string; body?: unknown };

/** A fake Google: Service Usage, API Keys v2, PSI and CrUX, recording every call. */
function fakeGoogle({
  enabled = [] as string[],
  existingKey = null as null | { name: string; restrictions?: unknown },
  probeStatuses = [[200, 200]] as Array<[number, number]>,
  forbidden = false,
} = {}) {
  const calls: Call[] = [];
  let probe = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (forbidden) return json(403, { error: { message: 'Permission denied', details: [{ reason: 'IAM_PERMISSION_DENIED' }] } });
    if (url.includes('serviceusage.googleapis.com') && url.includes('/services?')) {
      return json(200, { services: enabled.map((name) => ({ config: { name } })) });
    }
    if (url.endsWith('services:batchEnable')) return json(200, { name: 'operations/enable-1', done: true, response: {} });
    if (url.includes('apikeys.googleapis.com') && url.endsWith('/locations/global/keys') && method === 'GET') {
      return json(200, { keys: existingKey ? [existingKey] : [] });
    }
    if (url.includes(`keys?keyId=${KEY_ID}`)) return json(200, { name: 'operations/create-1', done: true, response: { name: KEY_NAME } });
    if (url.includes('updateMask=restrictions')) return json(200, { name: 'operations/patch-1', done: true, response: {} });
    if (url.endsWith('/keyString')) return json(200, { keyString: KEY_STRING });
    if (url.includes('pagespeedonline')) return new Response('{}', { status: (probeStatuses[probe] || probeStatuses.at(-1))![0] });
    if (url.includes('chromeuxreport')) {
      const status = (probeStatuses[probe] || probeStatuses.at(-1))![1];
      probe += 1;
      return new Response('{}', { status });
    }
    return json(404, { error: { message: `unexpected ${method} ${url}` } });
  };
  return { calls, fetchImpl };
}

function run(google: ReturnType<typeof fakeGoogle>, overrides: Record<string, unknown> = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const masked: string[] = [];
  const promise = provisionPagespeedKey({
    credentials: CREDENTIALS,
    fetchImpl: google.fetchImpl as never,
    getAccessToken: async () => 'cloud-token',
    writeRemoteConfig: async (options: Record<string, unknown>) => { writes.push(options); return { ok: true, changed: true, attempt: 1 }; },
    sleep: async () => {},
    log: () => {},
    mask: (value: string) => { masked.push(value); },
    probeAttempts: 3,
    probeDelayMs: 0,
    ...overrides,
  });
  return { promise, writes, masked };
}

describe('provision-pagespeed-key', () => {
  it('accepts only a key restricted to exactly PSI + CrUX with no client restriction', () => {
    expect(restrictionsMatch({ apiTargets: [{ service: 'chromeuxreport.googleapis.com' }, { service: 'pagespeedonline.googleapis.com' }] })).toBe(true);
    expect(restrictionsMatch({ apiTargets: [{ service: 'pagespeedonline.googleapis.com' }] })).toBe(false);
    expect(restrictionsMatch({
      apiTargets: [{ service: 'pagespeedonline.googleapis.com' }, { service: 'chromeuxreport.googleapis.com' }],
      browserKeyRestrictions: { allowedReferrers: ['https://frontaliereticino.ch/*'] },
    })).toBe(false);
    expect(restrictionsMatch(undefined)).toBe(false);
  });

  it('dry run only reads: no enable, no key, no Remote Config', async () => {
    const google = fakeGoogle();
    const { promise, writes } = run(google, { dryRun: true });
    await expect(promise).resolves.toMatchObject({ dryRun: true, created: true });
    expect(google.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(writes).toEqual([]);
  });

  it('enables the APIs, creates the restricted key, verifies it, then writes Remote Config', async () => {
    const google = fakeGoogle({ enabled: ['pagespeedonline.googleapis.com'] });
    const { promise, writes, masked } = run(google);
    await expect(promise).resolves.toMatchObject({ created: true, remoteConfig: 'written' });
    const enable = google.calls.find((call) => call.url.endsWith('services:batchEnable'));
    expect(enable?.body).toEqual({ serviceIds: ['chromeuxreport.googleapis.com', 'apikeys.googleapis.com'] });
    const create = google.calls.find((call) => call.url.includes(`keyId=${KEY_ID}`));
    expect(create?.body).toMatchObject({ restrictions: { apiTargets: [{ service: 'pagespeedonline.googleapis.com' }, { service: 'chromeuxreport.googleapis.com' }] } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: 'PAGESPEED_API_KEY', value: KEY_STRING });
    // The key and the token are masked before anything else happens with them.
    expect(masked).toEqual(expect.arrayContaining(['cloud-token', KEY_STRING]));
  });

  it('realigns the restrictions of an existing key instead of creating a second one', async () => {
    const google = fakeGoogle({
      enabled: ['pagespeedonline.googleapis.com', 'chromeuxreport.googleapis.com', 'apikeys.googleapis.com'],
      existingKey: { name: KEY_NAME, restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] } },
    });
    const { promise } = run(google);
    await expect(promise).resolves.toMatchObject({ created: false });
    expect(google.calls.some((call) => call.url.includes(`keyId=${KEY_ID}`))).toBe(false);
    expect(google.calls.find((call) => call.method === 'PATCH')?.url).toContain(`${KEY_NAME}?updateMask=restrictions`);
  });

  it('waits for a new key to propagate and treats CrUX 404 (no data) as authorized', async () => {
    const google = fakeGoogle({ probeStatuses: [[403, 403], [200, 404]] });
    const { promise, writes } = run(google);
    await expect(promise).resolves.toMatchObject({ remoteConfig: 'written' });
    expect(writes).toHaveLength(1);
  });

  it('never writes Remote Config when the key does not authorize both APIs', async () => {
    const google = fakeGoogle({ probeStatuses: [[200, 403]] });
    const { promise, writes } = run(google);
    await expect(promise).rejects.toThrow(/Remote Config left unchanged/);
    expect(writes).toEqual([]);
  });

  it('names the missing IAM roles on a 403', async () => {
    const google = fakeGoogle({ forbidden: true });
    const { promise, writes } = run(google);
    await expect(promise).rejects.toThrow(/roles\/serviceusage\.apiKeysAdmin.*roles\/serviceusage\.serviceUsageAdmin/);
    expect(writes).toEqual([]);
  });
});
