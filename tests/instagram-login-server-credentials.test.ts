import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteConfigTemplate, RC_TO_ENV } from '../scripts/load-rc-env.mjs';
import {
  collectInstagramLoginPublishEnv,
  INSTAGRAM_LOGIN_PUBLISH_ENV,
  INSTAGRAM_PUBLISHER_READY_ENV,
} from '../scripts/load-instagram-login-env.mjs';
import {
  getInstagramPublisherCredentials,
  getInstagramPublisherCredentialsFromTemplates,
} from '../scripts/lib/instagram-publisher-credentials.mjs';
import { INSTAGRAM_LOGIN_GRAPH_API } from '../scripts/lib/instagram-graph-constants.mjs';
import {
  remoteConfigTemplateUrl,
  updateRcTemplateWithEtag as updateRcTemplateWithAdmin,
} from '../scripts/lib/remote-config-admin.mjs';
import { updateRcTemplateWithEtag as updateRcTemplateWithRest } from '../scripts/lib/remote-config-rest.mjs';
import {
  buildAuthorizationUrl,
  callbackConfig,
  normalizeInstagramLoginTokenExchangeResponse,
  verifyGrantedPublishScopes,
} from '../scripts/instagram-login-auth.mjs';
import { probeInstagramLoginPublisher } from '../scripts/lib/instagram-login-readiness-probe.mjs';
import { setInstagramLoginGithubSecret } from '../scripts/lib/instagram-login-github-secrets.mjs';
import { isInstagramLoginTokenRefreshDue } from '../scripts/refresh-instagram-login-token.mjs';
import {
  commitInstagramLoginCredentialUpdate,
  INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY,
  isInstagramLoginCredentialWriteLocked,
  isInstagramLoginCredentialWritePending,
  stageInstagramLoginValues,
} from '../scripts/lib/instagram-login-remote-config.mjs';

const futureExpiry = () => new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const grantedPublishScopes = 'instagram_business_basic,instagram_business_content_publish';
const remoteConfigWriters = [
  ['admin', updateRcTemplateWithAdmin],
  ['REST', updateRcTemplateWithRest],
] as const;

describe('Instagram Login server-side credential boundary', () => {
  it('requests and verifies only the basic and content-publishing grants', () => {
    const authorize = new URL(buildAuthorizationUrl({
      appId: '1234567890',
      redirectUri: 'http://localhost:8765/instagram/callback',
      state: 'random-state',
    }));
    expect(authorize.searchParams.get('scope')).toBe(grantedPublishScopes);
    expect(callbackConfig('http://localhost:8765/instagram/callback').port).toBe(8765);
    expect(() => callbackConfig('https://example.com/instagram/callback')).toThrow(/loopback http URL/);
    expect(verifyGrantedPublishScopes({ permissions: grantedPublishScopes })).toBe(grantedPublishScopes);
    expect(verifyGrantedPublishScopes({ permissions: ['instagram_business_basic', 'instagram_business_content_publish'] }))
      .toBe(grantedPublishScopes);
    expect(() => verifyGrantedPublishScopes({ permissions: 'instagram_business_basic' }))
      .toThrow(/did not grant the required publishing scopes/);
  });

  it('normalizes both documented token-exchange response envelopes and rejects ambiguous data', () => {
    const flat = normalizeInstagramLoginTokenExchangeResponse({
      access_token: 'short-token',
      user_id: '17841400000000000',
      permissions: grantedPublishScopes,
    });
    expect(flat.access_token).toBe('short-token');

    const wrapped = normalizeInstagramLoginTokenExchangeResponse({
      data: [{
        access_token: 'short-token',
        user_id: '17841400000000000',
        permissions: [
          { permission: 'instagram_business_basic', status: 'granted' },
          { permission: 'instagram_business_content_publish', status: 'granted' },
        ],
      }],
    });
    expect(verifyGrantedPublishScopes(wrapped)).toBe(grantedPublishScopes);
    expect(() => normalizeInstagramLoginTokenExchangeResponse({ data: [] })).toThrow(/invalid data envelope/);
    expect(() => normalizeInstagramLoginTokenExchangeResponse({
      access_token: 'one-token',
      data: [{ access_token: 'another-token' }],
    })).toThrow(/ambiguous token response/);
  });

  it('treats malformed credential locks as active and holds publishers during token rotation', () => {
    const now = Date.now();
    const activeLock = JSON.stringify({ id: 'rotation-1', expiresAt: new Date(now + 60_000).toISOString() });
    const expiredLock = JSON.stringify({ id: 'rotation-old', expiresAt: new Date(now - 60_000).toISOString() });
    const pendingLock = JSON.stringify({ id: 'pending-1', state: 'pending', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' });
    expect(isInstagramLoginCredentialWriteLocked(activeLock, now)).toBe(true);
    expect(isInstagramLoginCredentialWriteLocked(expiredLock, now)).toBe(false);
    expect(isInstagramLoginCredentialWriteLocked(pendingLock, now)).toBe(true);
    expect(isInstagramLoginCredentialWritePending(pendingLock, 'INSTAGRAM_LOGIN_ACCESS_TOKEN')).toBe(true);
    expect(isInstagramLoginCredentialWritePending(pendingLock, 'INSTAGRAM_LOGIN_APP_SECRET')).toBe(false);
    expect(isInstagramLoginCredentialWriteLocked('unparseable-lock', now)).toBe(true);
    expect(isInstagramLoginCredentialWriteLocked('idle', now)).toBe(false);
    expect(() => collectInstagramLoginPublishEnv({
      INSTAGRAM_PUBLISHING_AUTH_MODE: 'facebook_login',
      [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: activeLock,
    }, { now })).toThrow(/publishing is held/);
  });

  it('retries a pending refresh outside the ordinary 30-day window', () => {
    const now = Date.now();
    const expiry = now + 55 * 24 * 60 * 60 * 1000;
    expect(isInstagramLoginTokenRefreshDue(expiry, now)).toBe(false);
    expect(isInstagramLoginTokenRefreshDue(expiry, now, { recoverPending: true })).toBe(true);
    expect(isInstagramLoginTokenRefreshDue(now - 1, now, { recoverPending: true })).toBe(false);
  });

  it('uses the Remote Config ETag stage as a lock and snapshot compare-and-set', () => {
    const now = Date.now();
    const template = { parameters: {
      INSTAGRAM_LOGIN_USERNAME: { defaultValue: { value: 'previous' }, valueType: 'STRING' },
      [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: { defaultValue: { value: 'idle' }, valueType: 'STRING' },
    } };
    const lockValue = JSON.stringify({ id: 'rotation-1', state: 'pending', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' });
    const acquired = stageInstagramLoginValues(template, {
      [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: lockValue,
    }, {
      allowLockValue: true,
      expectedValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
      now,
    });
    expect(acquired).toMatchObject({ changed: true });

    expect(stageInstagramLoginValues(acquired.template, {
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry(),
    }, { lockId: 'stale-owner', now }).error).toMatch(/no longer owned/);
    expect(stageInstagramLoginValues(template, {
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry(),
    }, { expectedValues: { INSTAGRAM_LOGIN_USERNAME: 'newer' }, now }).error).toMatch(/metadata changed/);
    expect(stageInstagramLoginValues(acquired.template, {
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry(),
    }, { lockId: 'rotation-1', now })).toMatchObject({ changed: true });

    const pendingTemplate = { parameters: {
      [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: {
        defaultValue: { value: JSON.stringify({ id: 'pending-1', state: 'pending', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' }) },
        valueType: 'STRING',
      },
    } };
    expect(stageInstagramLoginValues(pendingTemplate, {
      [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: lockValue,
    }, {
      allowLockValue: true,
      recoverySecretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN',
      expectedValues: {
        [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: pendingTemplate.parameters[INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY].defaultValue.value,
      },
      now,
    })).toMatchObject({ changed: true });
    expect(stageInstagramLoginValues(pendingTemplate, {
      [INSTAGRAM_LOGIN_CREDENTIAL_WRITE_LOCK_KEY]: lockValue,
    }, {
      allowLockValue: true,
      recoverySecretName: 'INSTAGRAM_LOGIN_APP_SECRET',
      now,
    }).error).toMatch(/being updated/);
  });

  it('writes metadata before rotating the secret and restores metadata if the secret write fails', async () => {
    const events: string[] = [];
    const writeCredentials = vi.fn(async (values: Record<string, string | null>, options: { lockId: string }) => {
      events.push(`metadata:${values.INSTAGRAM_LOGIN_USERNAME ?? 'removed'}:${options.lockId}`);
      return { changed: true, attempt: 1 };
    });
    const acquireLock = vi.fn(async () => ({ id: 'rotation-1', expiresAt: '2030-01-01T00:00:00.000Z' }));
    const releaseLock = vi.fn(async () => { events.push('release'); return { changed: true, attempt: 1 }; });
    const setSecret = vi.fn(() => {
      events.push('secret');
      throw new Error('secret update timed out after the request may have committed');
    });

    await expect(commitInstagramLoginCredentialUpdate({
      accessToken: 'new-token',
      values: { INSTAGRAM_LOGIN_USERNAME: 'frontaliere' },
      previousValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
      expectedValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
      acquireLock,
      releaseLock,
      writeCredentials,
      setSecret,
    })).rejects.toThrow(/secret update timed out/);

    expect(events).toEqual([
      'metadata:frontaliere:rotation-1',
      'secret',
      'metadata:previous:rotation-1',
      'release',
    ]);
    expect(acquireLock).toHaveBeenCalledWith(expect.objectContaining({
      expectedValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
    }));
  });

  it('keeps an uncertain GitHub secret write locked until the matching secret is explicitly reconciled', async () => {
    const events: string[] = [];
    const ambiguousError = Object.assign(new Error('gh timed out after request'), { instagramSecretWriteAmbiguous: true });
    const writeCredentials = vi.fn(async (values: Record<string, string | null>, options: { lockId: string }) => {
      events.push(`metadata:${values.INSTAGRAM_LOGIN_USERNAME}:${options.lockId}`);
      return { changed: true, attempt: 1 };
    });
    const acquireLock = vi.fn(async () => {
      events.push('lock:pending');
      return { id: 'rotation-2', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' };
    });
    const releaseLock = vi.fn(async () => { events.push('release'); return { changed: true, attempt: 1 }; });

    await expect(commitInstagramLoginCredentialUpdate({
      accessToken: 'new-token',
      values: { INSTAGRAM_LOGIN_USERNAME: 'frontaliere' },
      previousValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
      expectedValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
      acquireLock,
      releaseLock,
      writeCredentials,
      setSecret: () => {
        events.push('secret');
        throw ambiguousError;
      },
    })).rejects.toThrow(/rerun the OAuth or token refresh flow/);

    expect(events).toEqual([
      'lock:pending',
      'metadata:frontaliere:rotation-2',
      'secret',
    ]);
    expect(writeCredentials).toHaveBeenCalledTimes(1);
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('keeps the publisher lock when a Remote Config PUT outcome is ambiguous', async () => {
    const releaseLock = vi.fn();
    const setSecret = vi.fn();
    const ambiguousError = Object.assign(new Error('Remote Config result is uncertain'), {
      instagramRemoteConfigWriteAmbiguous: true,
    });

    await expect(commitInstagramLoginCredentialUpdate({
      accessToken: 'new-token',
      values: { INSTAGRAM_LOGIN_USERNAME: 'frontaliere' },
      previousValues: { INSTAGRAM_LOGIN_USERNAME: 'previous' },
      acquireLock: async () => ({ id: 'rotation-ambiguous', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' }),
      releaseLock,
      writeCredentials: async () => { throw ambiguousError; },
      setSecret,
    })).rejects.toThrow(/Remote Config result is uncertain/);

    expect(setSecret).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('keeps a pending lock when a recovery attempt fails', async () => {
    const events: string[] = [];
    const writeCredentials = vi.fn(async (values: Record<string, string | null>) => {
      events.push(`metadata:${values.INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT}`);
      return { changed: true, attempt: 1 };
    });
    const releaseLock = vi.fn(async () => { events.push('release'); return { changed: true, attempt: 1 }; });
    const pendingLock = JSON.stringify({ id: 'pending-1', state: 'pending', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' });

    await expect(commitInstagramLoginCredentialUpdate({
      accessToken: 'recovered-token',
      values: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry() },
      previousValues: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00.000Z' },
      expectedValues: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00.000Z' },
      expectedLockValue: pendingLock,
      recoverPending: true,
      acquireLock: async (options: { recoverySecretName?: string; expectedLockValue?: string }) => {
        expect(options).toMatchObject({
          recoverySecretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN',
          expectedLockValue: pendingLock,
        });
        return { id: 'pending-2', secretName: 'INSTAGRAM_LOGIN_ACCESS_TOKEN' };
      },
      releaseLock,
      writeCredentials,
      setSecret: () => { throw new Error('GitHub denied the recovery write'); },
    })).rejects.toThrow(/GitHub denied/);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(/^metadata:\d{4}-/u);
    expect(events[1]).toBe('metadata:2030-01-01T00:00:00.000Z');
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('does not rotate a token when the Remote Config snapshot changed before lock acquisition', async () => {
    const writeCredentials = vi.fn();
    const setSecret = vi.fn();
    await expect(commitInstagramLoginCredentialUpdate({
      accessToken: 'stale-token',
      values: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry() },
      previousValues: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry() },
      expectedValues: { INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: 'old-expiry' },
      acquireLock: async () => { throw new Error('metadata changed'); },
      writeCredentials,
      setSecret,
    })).rejects.toThrow(/metadata changed/);
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('keeps direct Instagram Login credentials out of the general Remote Config loader', () => {
    expect(RC_TO_ENV).not.toHaveProperty('SERVER_INSTAGRAM_LOGIN_ACCESS_TOKEN');
    expect(RC_TO_ENV).not.toHaveProperty('SERVER_INSTAGRAM_LOGIN_APP_SECRET');
    expect(RC_TO_ENV).not.toHaveProperty('INSTAGRAM_PUBLISHING_AUTH_MODE');
    expect(INSTAGRAM_LOGIN_PUBLISH_ENV).not.toHaveProperty('INSTAGRAM_LOGIN_ACCESS_TOKEN');
  });

  it('loads only public publisher metadata and checks the access token from the secret environment', () => {
    const result = collectInstagramLoginPublishEnv({
      INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
      INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
      INSTAGRAM_LOGIN_USERNAME: 'frontaliereticino',
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry(),
      INSTAGRAM_LOGIN_GRANTED_SCOPES: grantedPublishScopes,
    }, { currentEnv: { INSTAGRAM_LOGIN_ACCESS_TOKEN: 'long-lived-token' } });

    expect(result).toEqual({
      selected: true,
      values: {
        INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
        INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
        INSTAGRAM_LOGIN_USERNAME: 'frontaliereticino',
        INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: expect.any(String),
        INSTAGRAM_LOGIN_GRANTED_SCOPES: grantedPublishScopes,
        [INSTAGRAM_PUBLISHER_READY_ENV]: 'true',
      },
    });
  });

  it('does not select the direct route when the stored mode is absent or Facebook Login', () => {
    expect(collectInstagramLoginPublishEnv({}, { currentEnv: {} })).toEqual({
      selected: false,
      values: { [INSTAGRAM_PUBLISHER_READY_ENV]: 'false' },
    });
    expect(collectInstagramLoginPublishEnv({ INSTAGRAM_PUBLISHING_AUTH_MODE: 'facebook_login' }, { currentEnv: {} }))
      .toEqual({ selected: false, values: { [INSTAGRAM_PUBLISHER_READY_ENV]: 'false' } });
  });

  it('fails closed for an incomplete publisher identity but permits readiness to report it', () => {
    const partial = {
      INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
      INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
    };
    expect(() => collectInstagramLoginPublishEnv(partial, { currentEnv: {} })).toThrow(/GitHub token secret/);
    expect(collectInstagramLoginPublishEnv(partial, { currentEnv: {}, allowIncomplete: true })).toEqual({
      selected: true,
      values: {
        INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
        INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
        [INSTAGRAM_PUBLISHER_READY_ENV]: 'false',
      },
    });
  });

  it('preserves explicit environment overrides', () => {
    const result = collectInstagramLoginPublishEnv({
      INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
      INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
      INSTAGRAM_LOGIN_USERNAME: 'frontaliereticino',
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry(),
    }, {
      currentEnv: {
        INSTAGRAM_PUBLISHING_AUTH_MODE: 'facebook_login',
      },
    });
    expect(result).toEqual({
      selected: false,
      values: { [INSTAGRAM_PUBLISHER_READY_ENV]: 'false' },
    });
  });

  it('uses the Instagram Login Graph host and rejects an expired direct token', () => {
    const credentials = getInstagramPublisherCredentials({
      INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
      INSTAGRAM_LOGIN_ACCESS_TOKEN: 'token',
      INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: futureExpiry(),
      INSTAGRAM_LOGIN_GRANTED_SCOPES: grantedPublishScopes,
    });
    expect(credentials).toMatchObject({ mode: 'instagram_login', accessToken: 'token', apiBase: INSTAGRAM_LOGIN_GRAPH_API });
    expect(getInstagramPublisherCredentials({
      INSTAGRAM_PUBLISHING_AUTH_MODE: 'instagram_login',
      INSTAGRAM_LOGIN_ACCESS_TOKEN: 'token',
      INSTAGRAM_LOGIN_USER_ID: '17841400000000000',
      INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: '2020-01-01T00:00:00.000Z',
      INSTAGRAM_LOGIN_GRANTED_SCOPES: grantedPublishScopes,
    }).accessToken).toBeNull();
  });

  it('selects Instagram Login reconciliation credentials from public metadata and the secret environment', () => {
    const publisher = getInstagramPublisherCredentialsFromTemplates({
      clientTemplate: { parameters: {
        INSTAGRAM_ACCESS_TOKEN: { defaultValue: { value: 'facebook-page-token' } },
        INSTAGRAM_BUSINESS_ACCOUNT_ID: { defaultValue: { value: '17841400000000001' } },
      } },
      serverTemplate: { parameters: {
        INSTAGRAM_PUBLISHING_AUTH_MODE: { defaultValue: { value: 'instagram_login' } },
        INSTAGRAM_LOGIN_USER_ID: { defaultValue: { value: '17841400000000000' } },
        INSTAGRAM_LOGIN_ACCESS_TOKEN_EXPIRES_AT: { defaultValue: { value: futureExpiry() } },
        INSTAGRAM_LOGIN_GRANTED_SCOPES: { defaultValue: { value: grantedPublishScopes } },
      } },
      env: { INSTAGRAM_LOGIN_ACCESS_TOKEN: 'direct-login-token' },
    });

    expect(publisher).toMatchObject({
      mode: 'instagram_login',
      accessToken: 'direct-login-token',
      igUserId: '17841400000000000',
      apiBase: INSTAGRAM_LOGIN_GRAPH_API,
    });
  });

  it('does not call Instagram Login ready without a verified publishing scope grant', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user_id: '17841400000000000', username: 'frontaliere', account_type: 'BUSINESS' }),
    }));
    await expect(probeInstagramLoginPublisher({
      instagramUserId: '17841400000000000',
      expectedUsername: 'frontaliere',
      accessToken: 'token',
      tokenExpiresAt: futureExpiry(),
      grantedScopes: 'instagram_business_basic',
      fetchImpl,
    })).resolves.toMatchObject({ loginPublisherStatus: 'missing-publish-scope' });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(probeInstagramLoginPublisher({
      instagramUserId: '17841400000000000',
      expectedUsername: 'frontaliere',
      accessToken: 'token',
      tokenExpiresAt: futureExpiry(),
      grantedScopes: grantedPublishScopes,
      fetchImpl,
    })).resolves.toMatchObject({ loginPublisherStatus: 'matched' });
  });

  it('addresses the dedicated server template namespace', () => {
    expect(remoteConfigTemplateUrl('test-project', 'firebase-server'))
      .toBe('https://firebaseremoteconfig.googleapis.com/v1/projects/test-project/namespaces/firebase-server/remoteConfig');
    expect(() => remoteConfigTemplateUrl('test-project', '../firebase')).toThrow(/namespace is invalid/);
  });

  it('shares the namespaced Remote Config URL in the dependency-free REST writer', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'etag-1' },
        json: async () => ({ parameters: {} }),
      })
      .mockResolvedValueOnce({ ok: true });
    const result = await updateRcTemplateWithRest({
      credentials: { project_id: 'test-project' },
      namespace: 'firebase-server',
      versionDescription: 'server template test',
      stage: (template) => ({ changed: true, template: { ...template, parameters: { TEST: { defaultValue: { value: 'ok' } } } } }),
      fetchImpl,
      getAccessToken: async () => 'service-account-token',
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://firebaseremoteconfig.googleapis.com/v1/projects/test-project/namespaces/firebase-server/remoteConfig',
      'https://firebaseremoteconfig.googleapis.com/v1/projects/test-project/namespaces/firebase-server/remoteConfig',
    ]);
  });

  it.each(remoteConfigWriters)('%s writer preserves an ambiguous PUT after a later GET failure', async (_name, update) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ parameters: {} }), {
        status: 200,
        headers: { etag: 'etag-1' },
      }))
      .mockRejectedValueOnce(new Error('PUT timed out after dispatch'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const result = await update({
      credentials: { project_id: 'test-project' },
      stage: (template) => ({ changed: true, template }),
      fetchImpl,
      getAccessToken: async () => 'service-account-token',
      sleep: async () => {},
      attempts: 2,
    });

    expect(result).toMatchObject({ ok: false, ambiguous: true, detail: 'GET remoteConfig → HTTP 503' });
  });

  it.each(remoteConfigWriters)('%s writer marks a definitive PUT rejection as non-ambiguous', async (_name, update) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ parameters: {} }), {
        status: 200,
        headers: { etag: 'etag-1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'refused' } }), {
        status: 400,
      }));
    const result = await update({
      credentials: { project_id: 'test-project' },
      stage: (template) => ({ changed: true, template }),
      fetchImpl,
      getAccessToken: async () => 'service-account-token',
      attempts: 2,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ambiguous).toBeUndefined();
    expect(result.detail).toContain('PUT remoteConfig → HTTP 400');
  });

  it('fetches the server template through its separate REST resource', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      parameters: { INSTAGRAM_PUBLISHING_AUTH_MODE: { defaultValue: { value: 'instagram_login' } } },
    }), { status: 200 }));
    const template = await fetchRemoteConfigTemplate({
      projectId: 'test-project',
      accessToken: 'service-account-token',
      namespace: 'firebase-server',
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://firebaseremoteconfig.googleapis.com/v1/projects/test-project/namespaces/firebase-server/remoteConfig',
    );
    expect(template.parameters.INSTAGRAM_PUBLISHING_AUTH_MODE.defaultValue.value).toBe('instagram_login');
  });

  it('writes approved Instagram secrets through gh stdin and never adds values to argv', () => {
    const spawn = vi.fn((_command: string, _args: string[], _options: { input?: string; env?: Record<string, string> }) => ({ status: 0, error: null }));
    setInstagramLoginGithubSecret('INSTAGRAM_LOGIN_ACCESS_TOKEN', 'long-lived-token', {
      env: {
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_PAT: 'invented-github-token',
        INSTAGRAM_LOGIN_ACCESS_TOKEN: 'old-token',
        INSTAGRAM_LOGIN_APP_SECRET: 'app-secret',
      },
      spawn,
    });
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('gh');
    expect(args).toEqual(['secret', 'set', 'INSTAGRAM_LOGIN_ACCESS_TOKEN', '--repo', 'owner/repo']);
    expect(args.join(' ')).not.toContain('long-lived-token');
    expect(options.input).toBe('long-lived-token');
    expect(options.env.GH_TOKEN).toBe('invented-github-token');
    expect(options.env).not.toHaveProperty('INSTAGRAM_LOGIN_ACCESS_TOKEN');
    expect(options.env).not.toHaveProperty('INSTAGRAM_LOGIN_APP_SECRET');
    expect(() => setInstagramLoginGithubSecret('UNRELATED_SECRET', 'value', { spawn }))
      .toThrow(/unsupported Instagram Login secret/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent GitHub secret write after an ambiguous CLI failure', () => {
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 1, error: null })
      .mockReturnValueOnce({ status: 0, error: null });
    setInstagramLoginGithubSecret('INSTAGRAM_LOGIN_ACCESS_TOKEN', 'long-lived-token', {
      env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_PAT: 'invented-github-token' },
      spawn,
    });

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(spawn.mock.calls[0][1]);
    expect(spawn.mock.calls[1][2].input).toBe('long-lived-token');
  });

  it('treats an explicit GitHub 403 secret rejection as definite', () => {
    const spawn = vi.fn(() => ({
      status: 1,
      error: null,
      stdout: '',
      stderr: 'gh: HTTP 403: Resource not accessible by integration',
    }));
    let writeError: (Error & { instagramSecretWriteAmbiguous?: boolean }) | undefined;

    try {
      setInstagramLoginGithubSecret('INSTAGRAM_LOGIN_ACCESS_TOKEN', 'long-lived-token', {
        env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_PAT: 'invented-github-token' },
        spawn,
      });
    } catch (error) {
      if (error instanceof Error) writeError = error as Error & { instagramSecretWriteAmbiguous?: boolean };
    }

    expect(writeError).toBeInstanceOf(Error);
    expect(writeError?.instagramSecretWriteAmbiguous).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
