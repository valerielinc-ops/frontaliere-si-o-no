import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchPublicConfigResponse, getPublicConfigEndpoint } from '../services/publicConfigEndpoint';

describe('public Remote Config endpoint', () => {
  it('uses the cacheable Worker route on the production apex', () => {
    const hostname = 'frontaliereticino.ch';
    expect(getPublicConfigEndpoint(hostname)).toBe('/api/public-config/');
  });

  it.each([
    'www.frontaliereticino.ch',
    'frontaliere-ticino.web.app',
    'frontaliere-ticino.firebaseapp.com',
    'frontaliere-ticino--pr-123.web.app',
    'localhost',
    'example.test',
  ])('uses the direct function endpoint outside the production apex: %s', (hostname) => {
    expect(getPublicConfigEndpoint(hostname)).toBe(
      'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPublicConfig',
    );
  });

  it('falls back to the Cloud Function if the production Worker route is unavailable', async () => {
    const calls: Array<{ endpoint: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input);
      calls.push({ endpoint, init });
      return new Response(endpoint === '/api/public-config/' ? 'not deployed' : '{}', {
        status: endpoint === '/api/public-config/' ? 404 : 200,
      });
    };

    const response = await fetchPublicConfigResponse('/api/public-config/', fetchImpl);

    expect(response.status).toBe(200);
    expect(calls.map(({ endpoint }) => endpoint)).toEqual([
      '/api/public-config/',
      'https://europe-west6-frontaliere-ticino.cloudfunctions.net/getPublicConfig',
    ]);
    expect(calls.every(({ init }) => init?.cache === 'default' && init.credentials === 'omit')).toBe(true);
  });

  it('routes the scheduled house-creative probe through the production Worker', () => {
    const workflow = readFileSync(new URL('../.github/workflows/house-creative-readout.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('https://frontaliereticino.ch/api/public-config/');
    expect(workflow).not.toContain('cloudfunctions.net/getPublicConfig');
  });
});
