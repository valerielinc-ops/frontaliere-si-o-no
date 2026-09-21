// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRewardedApplicationPageUrl,
  clearRewardedApplicationHandoff,
  createRewardedApplicationHandoff,
  isRewardedApplicationPagePath,
  readRewardedApplicationHandoff,
} from '@/services/rewardedApplicationHandoff';

describe('rewarded application external-page handoff', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/');
  });

  it('registers the standalone page as an entrypoint route', () => {
    expect(isRewardedApplicationPagePath('/rewarded-application/')).toBe(true);
    expect(isRewardedApplicationPagePath('/rewarded-application')).toBe(false);
    expect(isRewardedApplicationPagePath('/cerca-lavoro-ticino/')).toBe(false);
  });

  it('stores a short-lived employer destination behind an opaque token', () => {
    const token = createRewardedApplicationHandoff({
      destination: 'https://employer.example/jobs/42',
      jobId: 'job-42',
      companyId: 'acme',
      companyName: 'Acme',
      jobTitle: 'Responsabile operativo',
    });

    expect(token).toBeTruthy();
    expect(token).not.toContain('employer.example');
    expect(readRewardedApplicationHandoff(token)).toMatchObject({
      destination: 'https://employer.example/jobs/42',
      jobId: 'job-42',
      companyId: 'acme',
      companyName: 'Acme',
    });
    expect(buildRewardedApplicationPageUrl(token!)).toContain('/rewarded-application/?handoff=');
  });

  it('rejects non-http destinations and clears a completed handoff', () => {
    expect(createRewardedApplicationHandoff({
      destination: 'javascript:alert(1)',
      jobId: 'job-42',
      companyId: 'acme',
    })).toBeNull();

    const token = createRewardedApplicationHandoff({
      destination: 'https://employer.example/jobs/42',
      jobId: 'job-42',
      companyId: 'acme',
    });
    expect(token).toBeTruthy();
    clearRewardedApplicationHandoff(token);
    expect(readRewardedApplicationHandoff(token)).toBeNull();
  });

  it('rejects malformed or expired handoffs instead of inventing a lifetime', () => {
    const token = 'malformed';
    window.localStorage.setItem(
      `frontaliere_rewarded_application_handoff_v1:${token}`,
      JSON.stringify({
        token,
        destination: 'https://employer.example/jobs/42',
        jobId: 'job-42',
        companyId: 'acme',
        createdAt: 'not-a-timestamp',
        expiresAt: Date.now() + 60_000,
      }),
    );

    expect(readRewardedApplicationHandoff(token)).toBeNull();
    expect(window.localStorage.getItem(`frontaliere_rewarded_application_handoff_v1:${token}`)).toBeNull();
  });
});
