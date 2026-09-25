import { describe, expect, it } from 'vitest';
import {
  KEY_ID,
  newKeyId,
  provisionPagespeedKey,
  restrictionsMatch,
} from '../scripts/ci/provision-pagespeed-key.mjs';

const CREDENTIALS = { client_email: 'sa@example.iam.gserviceaccount.com', private_key: 'PRIVATE', project_id: 'demo-project' };
const KEY_STRING = 'AIza-test-key-value';
const NOW = new Date('2026-09-25T06:07:08Z');
const NEW_KEY_ID = `${KEY_ID}-202609250607`;
const NEW_KEY_NAME = `projects/demo-project/locations/global/keys/${NEW_KEY_ID}`;
const OLD_KEY_NAME = `projects/demo-project/locations/global/keys/${KEY_ID}`;
const BOTH_APIS = { apiTargets: [{ service: 'pagespeedonline.googleapis.com' }, { service: 'chromeuxreport.googleapis.com' }] };

type Call = { method: string; url: string; body?: unknown };

/** A fake Google: Service Usage, API Keys v2, PSI and CrUX, recording every call. Probe tuples: [PSI, queryRecord, queryHistoryRecord]. */
function fakeGoogle({
  enabled = [] as string[],
  existingKeys = [] as Array<{ name: string; restrictions?: unknown; createTime?: string; deleteTime?: string }>,
  probeStatuses = [[200, 200, 200]] as Array<[number, number, number]>,
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
      return json(200, { keys: existingKeys });
    }
    if (url.includes(`keys?keyId=${KEY_ID}-`) && method === 'POST') {
      const keyId = new URL(url).searchParams.get('keyId');
      return json(200, { name: 'operations/create-1', done: true, response: { name: `projects/demo-project/locations/global/keys/${keyId}` } });
    }
    if (url.endsWith('/keyString')) return json(200, { keyString: KEY_STRING });
    const statuses = probeStatuses[probe] || probeStatuses.at(-1)!;
    if (url.includes('pagespeedonline')) return new Response('{}', { status: statuses[0] });
    if (url.includes('records:queryRecord')) return new Response('{}', { status: statuses[1] });
    if (url.includes('records:queryHistoryRecord')) {
      probe += 1;
      return new Response('{}', { status: statuses[2] });
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
    now: NOW,
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

  it('rejects a key whose API targets are limited to some methods only', () => {
    expect(restrictionsMatch({
      apiTargets: [
        { service: 'pagespeedonline.googleapis.com' },
        { service: 'chromeuxreport.googleapis.com', methods: ['google.chrome.uxreport.v1.RecordService.QueryRecord'] },
      ],
    })).toBe(false);
  });

  it('names a new key with the prefix and a UTC minute suffix', () => {
    expect(newKeyId(NOW)).toBe(NEW_KEY_ID);
    expect(NEW_KEY_ID).toMatch(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/);
  });

  it('dry run only reads: no enable, no key, no Remote Config', async () => {
    const google = fakeGoogle({ enabled: ['apikeys.googleapis.com'] });
    const { promise, writes } = run(google, { dryRun: true });
    await expect(promise).resolves.toMatchObject({ dryRun: true, created: true });
    expect(google.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(google.calls.some((call) => call.url.endsWith('/locations/global/keys'))).toBe(true);
    expect(writes).toEqual([]);
  });

  it('dry run with the API Keys API disabled stops before listing keys', async () => {
    const google = fakeGoogle();
    const { promise, writes } = run(google, { dryRun: true });
    await expect(promise).resolves.toMatchObject({ dryRun: true, servicesEnabled: expect.arrayContaining(['apikeys.googleapis.com']) });
    expect(google.calls.some((call) => call.url.includes('apikeys.googleapis.com'))).toBe(false);
    expect(writes).toEqual([]);
  });

  it('enables the APIs, creates the restricted key, verifies it, then writes Remote Config', async () => {
    const google = fakeGoogle({ enabled: ['pagespeedonline.googleapis.com'] });
    const { promise, writes, masked } = run(google);
    await expect(promise).resolves.toMatchObject({ created: true, keyId: NEW_KEY_ID, remoteConfig: 'written' });
    const enable = google.calls.find((call) => call.url.endsWith('services:batchEnable'));
    expect(enable?.body).toEqual({ serviceIds: ['chromeuxreport.googleapis.com', 'apikeys.googleapis.com'] });
    const create = google.calls.find((call) => call.method === 'POST' && call.url.includes('keyId='));
    expect(create?.url).toContain(`keyId=${NEW_KEY_ID}`);
    expect(create?.body).toMatchObject({ restrictions: BOTH_APIS });
    expect(google.calls.some((call) => call.url.includes(`${NEW_KEY_NAME}/keyString`))).toBe(true);
    // Every consumer endpoint is probed before the write.
    expect(google.calls.some((call) => call.url.includes('records:queryHistoryRecord'))).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: 'PAGESPEED_API_KEY', value: KEY_STRING });
    // The key and the token are masked before anything else happens with them.
    expect(masked).toEqual(expect.arrayContaining(['cloud-token', KEY_STRING]));
  });

  it('never mutates an existing non-conforming key: it creates a new one next to it', async () => {
    const google = fakeGoogle({
      enabled: ['pagespeedonline.googleapis.com', 'chromeuxreport.googleapis.com', 'apikeys.googleapis.com'],
      existingKeys: [{ name: OLD_KEY_NAME, restrictions: { apiTargets: [{ service: 'generativelanguage.googleapis.com' }] } }],
    });
    const { promise } = run(google);
    await expect(promise).resolves.toMatchObject({ created: true, keyId: NEW_KEY_ID });
    expect(google.calls.some((call) => call.method === 'PATCH' || call.method === 'DELETE')).toBe(false);
    expect(google.calls.some((call) => call.url.includes(`${OLD_KEY_NAME}/keyString`))).toBe(false);
  });

  it('a failed probe on a new key leaves every existing key and Remote Config untouched', async () => {
    const google = fakeGoogle({
      enabled: ['pagespeedonline.googleapis.com', 'chromeuxreport.googleapis.com', 'apikeys.googleapis.com'],
      existingKeys: [{ name: OLD_KEY_NAME, restrictions: { apiTargets: [{ service: 'pagespeedonline.googleapis.com' }] } }],
      probeStatuses: [[403, 403, 403]],
    });
    const { promise, writes } = run(google);
    await expect(promise).rejects.toThrow(/Remote Config left unchanged/);
    // The only write against Google is the creation of the new key; the probes are reads with the key.
    const googleWrites = google.calls.filter((call) => call.method !== 'GET' && !call.url.includes('chromeuxreport.googleapis.com/v1/records:'));
    expect(googleWrites.map((call) => call.url)).toEqual([expect.stringContaining(`keyId=${NEW_KEY_ID}`)]);
    expect(google.calls.filter((call) => call.url.includes('records:queryHistoryRecord'))).toHaveLength(3);
    expect(writes).toEqual([]);
  });

  it('reuses the newest conforming key and skips deleted ones', async () => {
    const google = fakeGoogle({
      enabled: ['pagespeedonline.googleapis.com', 'chromeuxreport.googleapis.com', 'apikeys.googleapis.com'],
      existingKeys: [
        { name: `${OLD_KEY_NAME}-202609200000`, restrictions: BOTH_APIS, createTime: '2026-09-20T00:00:00Z' },
        { name: `${OLD_KEY_NAME}-202609240000`, restrictions: BOTH_APIS, createTime: '2026-09-24T00:00:00Z', deleteTime: '2026-09-24T01:00:00Z' },
        { name: `${OLD_KEY_NAME}-202609220000`, restrictions: BOTH_APIS, createTime: '2026-09-22T00:00:00Z' },
      ],
    });
    const { promise } = run(google);
    await expect(promise).resolves.toMatchObject({ created: false, keyId: `${KEY_ID}-202609220000` });
    expect(google.calls.some((call) => call.method === 'POST' && call.url.includes('keyId='))).toBe(false);
  });

  it('waits for a new key to propagate and treats CrUX 404 (no data) as authorized', async () => {
    const google = fakeGoogle({ probeStatuses: [[403, 403, 403], [200, 404, 404]] });
    const { promise, writes } = run(google);
    await expect(promise).resolves.toMatchObject({ remoteConfig: 'written' });
    expect(writes).toHaveLength(1);
  });

  it.each([
    ['CrUX queryRecord', [200, 403, 200]],
    ['CrUX queryHistoryRecord', [200, 200, 403]],
    ['PSI runPagespeed', [403, 200, 200]],
  ] as Array<[string, [number, number, number]]>)('never writes Remote Config when %s is not authorized', async (_endpoint, statuses) => {
    const google = fakeGoogle({ probeStatuses: [statuses] });
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
