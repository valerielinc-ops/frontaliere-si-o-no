import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LinkedIn member OAuth scope', () => {
  it('requests only w_member_social by default', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/linkedin-member-auth.mjs'), '--url-only'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          LINKEDIN_MEMBER_CLIENT_ID: 'test-client-id',
          LINKEDIN_MEMBER_CLIENT_SECRET: '',
          LINKEDIN_MEMBER_SCOPE: '',
        },
      },
    );

    expect(result.status).toBe(0);
    const authUrl = result.stdout.match(/https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?[^\s]+/u)?.[0];
    expect(authUrl).toBeDefined();
    expect(new URL(authUrl!).searchParams.get('scope')).toBe('w_member_social');
  });
});
