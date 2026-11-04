import { describe, expect, it } from 'vitest';

import {
  assertInstagramPublishReady,
  buildInstagramCapabilityMonitorOutputs,
  checkInstagramPublishReadiness,
} from '../scripts/lib/instagram-publish-readiness.mjs';

function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

const readyEnv = {
  FB_PAGE_ID: 'page-123',
  FB_USER_ACCESS_TOKEN: 'user-token',
  INSTAGRAM_BUSINESS_ACCOUNT_ID: 'instagram-456',
  INSTAGRAM_ACCESS_TOKEN: 'page-token',
};

function readyFetch({
  permissions = ['instagram_basic', 'instagram_content_publish'],
  tasks = ['CREATE_CONTENT'],
}: { permissions?: string[]; tasks?: string[] } = {}) {
  return async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/me/permissions')) {
      return response({ data: permissions.map((permission) => ({ permission, status: 'granted' })) });
    }
    if (url.pathname.endsWith('/page-123')) {
      return response({
        id: 'page-123',
        access_token: 'page-token',
        tasks,
        instagram_business_account: { id: 'instagram-456' },
      });
    }
    if (url.pathname.endsWith('/instagram-456')) return response({ id: 'instagram-456' });
    throw new Error(`unexpected readiness probe: ${url.pathname}`);
  };
}

describe('Instagram publishing boundary readiness', () => {
  it('accepts publishing only after the exact Page, account, token source, task, and grant match', async () => {
    const fetchImpl = readyFetch();
    const { verdict } = await checkInstagramPublishReadiness({ env: readyEnv, fetchImpl });

    expect(verdict.state).toBe('ready');
    await expect(assertInstagramPublishReady({ env: readyEnv, fetchImpl })).resolves.toMatchObject({ state: 'ready' });
  });

  it('reports capability-specific permission and Page-task readiness', async () => {
    const fetchImpl = readyFetch({
      permissions: [
        'instagram_basic',
        'instagram_content_publish',
        'instagram_manage_insights',
        'instagram_manage_comments',
        'instagram_manage_messages',
        'pages_manage_metadata',
      ],
      tasks: ['CREATE_CONTENT', 'ANALYZE', 'MODERATE', 'MESSAGING'],
    });
    const { capabilities } = await checkInstagramPublishReadiness({ env: readyEnv, fetchImpl });

    expect(capabilities).toMatchObject({
      feedAndReels: { state: 'ready' },
      insights: { state: 'ready' },
      comments: { state: 'ready' },
      directMessages: { state: 'ready' },
      stories: { state: 'ready', eligibilityNote: expect.stringMatching(/Business accounts/) },
    });
  });

  it('keeps publishing ready while reporting Insights, comments, and messaging scopes separately', async () => {
    const { verdict, capabilities } = await checkInstagramPublishReadiness({
      env: readyEnv,
      fetchImpl: readyFetch(),
    });

    expect(verdict.state).toBe('ready');
    expect(capabilities.feedAndReels.state).toBe('ready');
    expect(capabilities.insights.state).toBe('action-required');
    expect(capabilities.comments.state).toBe('action-required');
    expect(capabilities.directMessages.state).toBe('action-required');
  });

  it('alerts only on optional capability gaps after shared Instagram identity is verified', async () => {
    const { probe, capabilities } = await checkInstagramPublishReadiness({
      env: readyEnv,
      fetchImpl: readyFetch(),
    });

    expect(buildInstagramCapabilityMonitorOutputs(capabilities, probe)).toMatchObject({
      actionRequired: ['insights', 'comments', 'direct_messages'],
      ready: [],
      reasons: {
        insights: expect.stringContaining('instagram_manage_insights'),
        comments: expect.stringContaining('instagram_manage_comments'),
        direct_messages: expect.stringContaining('instagram_manage_messages'),
      },
    });
  });

  it('keeps optional capabilities quiet until shared Page, token, and basic permission checks pass', () => {
    const capabilities = {
      insights: { state: 'action-required', reason: 'missing optional permission' },
      comments: { state: 'action-required', reason: 'missing optional permission' },
      directMessages: { state: 'action-required', reason: 'missing optional permission' },
    };

    expect(buildInstagramCapabilityMonitorOutputs(capabilities, {
      pageLinkStatus: 'matched',
      publisherTokenStatus: 'matched',
      publisherTokenSourceStatus: 'matched',
      permissionStatuses: { instagram_basic: 'missing' },
    })).toMatchObject({ actionRequired: [], ready: [] });
    expect(buildInstagramCapabilityMonitorOutputs(capabilities, {
      pageLinkStatus: 'unavailable',
      publisherTokenStatus: 'matched',
      publisherTokenSourceStatus: 'matched',
      permissionStatuses: { instagram_basic: 'granted' },
    })).toMatchObject({ actionRequired: [], ready: [] });
  });

  it('reports each optional capability as ready so the monitor can close its matching issue', async () => {
    const { probe, capabilities } = await checkInstagramPublishReadiness({
      env: readyEnv,
      fetchImpl: readyFetch({
        permissions: [
          'instagram_basic',
          'instagram_content_publish',
          'instagram_manage_insights',
          'instagram_manage_comments',
          'instagram_manage_messages',
          'pages_manage_metadata',
        ],
        tasks: ['CREATE_CONTENT', 'ANALYZE', 'MODERATE', 'MESSAGING'],
      }),
    });

    expect(buildInstagramCapabilityMonitorOutputs(capabilities, probe)).toMatchObject({
      actionRequired: [],
      ready: ['insights', 'comments', 'direct_messages'],
    });
  });

  it('fails closed when configured credentials do not have verifiable publishing readiness', async () => {
    const fetchImpl = async () => response({ error: { code: 10 } });

    await expect(assertInstagramPublishReady({ env: readyEnv, fetchImpl })).rejects.toMatchObject({
      code: 'SOCIAL_PUBLISH_READINESS_REQUIRED',
      readiness: { state: 'action-required' },
    });
  });

  it('does not expose configured token values in a blocked readiness error', async () => {
    const fetchImpl = async () => response({ error: { code: 10, message: 'private graph detail' } });
    let error: Error | undefined;
    try {
      await assertInstagramPublishReady({ env: readyEnv, fetchImpl });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).not.toContain('user-token');
    expect(error?.message).not.toContain('page-token');
    expect(error?.message).not.toContain('private graph detail');
  });
});
