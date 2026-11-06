import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Cloudflare Worker is plain JavaScript.
import worker, { socialRedirectResponse } from '../infra/cloudflare-worker/locale-router.js';
import { facebookUrl } from '../scripts/lib/facebook-links.mjs';
import { socialRedirectKey } from '../scripts/lib/social-redirect-links.mjs';

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe('locale-router social redirect', () => {
  it('redirects a valid stable key to the same-origin destination with post attribution', async () => {
    const link = facebookUrl(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/job-one/',
      'facebook_job',
      'job-one--arm-a',
    );
    const fetch = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(new Request(link), {}, ctx);

    expect(response.status).toBe(302);
    expect(fetch).not.toHaveBeenCalled();
    const destination = new URL(response.headers.get('Location') || '');
    expect(destination.origin).toBe('https://frontaliereticino.ch');
    expect(destination.pathname).toBe('/cerca-lavoro-ticino/job-one/');
    expect(destination.searchParams.get('utm_source')).toBe('facebook');
    expect(destination.searchParams.get('utm_medium')).toBe('social');
    expect(destination.searchParams.get('utm_campaign')).toBe('facebook_job');
    expect(destination.searchParams.get('utm_content')).toBe('job-one--arm-a');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects external targets, malformed keys, and duplicated attribution fields', async () => {
    const target = 'https://evil.example/';
    const identity = {
      target,
      source: 'facebook',
      medium: 'social',
      campaign: 'facebook_job',
      content: 'post-one',
    };
    const key = socialRedirectKey(identity);
    const external = await socialRedirectResponse(new Request(
      `https://frontaliereticino.ch/social/r/${key}/?to=${encodeURIComponent(target)}&utm_source=facebook&utm_medium=social&utm_campaign=facebook_job&utm_content=post-one`,
    ));
    const invalidKey = await socialRedirectResponse(new Request(
      'https://frontaliereticino.ch/social/r/00000000000000000000/?to=%2Farticolo%2F&utm_source=facebook&utm_medium=social&utm_campaign=facebook_job&utm_content=post-one',
    ));
    const duplicate = await socialRedirectResponse(new Request(
      `https://frontaliereticino.ch/social/r/${key}/?to=${encodeURIComponent(target)}&utm_source=facebook&utm_source=linkedin&utm_medium=social&utm_campaign=facebook_job&utm_content=post-one`,
    ));

    expect(external?.status).toBe(404);
    expect(invalidKey?.status).toBe(404);
    expect(duplicate?.status).toBe(404);
  });

  it('does not serve non-GET requests from a redirect key', async () => {
    const response = await socialRedirectResponse(new Request(
      'https://frontaliereticino.ch/social/r/00000000000000000000/',
      { method: 'POST' },
    ));
    expect(response?.status).toBe(405);
  });
});
