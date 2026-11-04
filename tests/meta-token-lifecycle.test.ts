import { describe, expect, it } from 'vitest';

import { classifyMetaTokenLifecycle } from '../scripts/lib/meta-token-lifecycle.mjs';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

describe('Meta token lifecycle', () => {
  it('does not create a second setup alert when no token is configured', () => {
    expect(classifyMetaTokenLifecycle({ env: {}, now: NOW })).toMatchObject({
      state: 'not-configured',
      actionRequired: false,
    });
  });

  it('flags configured tokens with missing or malformed expiry metadata', () => {
    expect(classifyMetaTokenLifecycle({
      env: { FB_PAGE_ACCESS_TOKEN: 'page-token-fixture' },
      now: NOW,
    })).toMatchObject({ state: 'expiry-unverified', actionRequired: true });
    expect(classifyMetaTokenLifecycle({
      env: {
        FB_USER_ACCESS_TOKEN: 'user-token-fixture',
        FB_USER_ACCESS_TOKEN_EXPIRES_AT: 'not-a-date',
      },
      now: NOW,
    })).toMatchObject({ state: 'expiry-unverified', actionRequired: true });
  });

  it('alerts before expiry and reports expired credentials without exposing them', () => {
    const expiring = classifyMetaTokenLifecycle({
      env: {
        FB_USER_ACCESS_TOKEN: 'user-token-fixture',
        FB_USER_ACCESS_TOKEN_EXPIRES_AT: '2026-11-10T00:00:00.000Z',
        FB_PAGE_ACCESS_TOKEN: 'page-token-fixture',
        FB_PAGE_ACCESS_TOKEN_EXPIRES_AT: '0',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-page-token-fixture',
        INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT: '0',
      },
      now: NOW,
    });
    expect(expiring).toMatchObject({ state: 'expiring-soon', actionRequired: true });
    expect(JSON.stringify(expiring)).not.toContain('user-token-fixture');
    expect(JSON.stringify(expiring)).not.toContain('page-token-fixture');
    expect(JSON.stringify(expiring)).not.toContain('instagram-page-token-fixture');

    expect(classifyMetaTokenLifecycle({
      env: {
        FB_USER_ACCESS_TOKEN: 'user-token-fixture',
        FB_USER_ACCESS_TOKEN_EXPIRES_AT: '2026-11-03T00:00:00.000Z',
      },
      now: NOW,
    })).toMatchObject({ state: 'expired', actionRequired: true });
  });

  it('reports healthy only when every configured token has a verified safe lifetime', () => {
    expect(classifyMetaTokenLifecycle({
      env: {
        FB_USER_ACCESS_TOKEN: 'user-token-fixture',
        FB_USER_ACCESS_TOKEN_EXPIRES_AT: '2027-01-03T00:00:00.000Z',
        FB_PAGE_ACCESS_TOKEN: 'page-token-fixture',
        FB_PAGE_ACCESS_TOKEN_EXPIRES_AT: '0',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-page-token-fixture',
        INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT: '0',
      },
      now: NOW,
    })).toMatchObject({ state: 'healthy', actionRequired: false });
  });
});
