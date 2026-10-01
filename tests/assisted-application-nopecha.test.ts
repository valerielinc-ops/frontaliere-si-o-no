import { describe, expect, it, vi } from 'vitest';
import { solveRecaptchaV3 } from '../scripts/assisted-application/lib/portal/nopecha.mjs';

const challenge = { sitekey: 'public_test_sitekey', url: 'https://jobs.example/apply?email=private#secret', action: 'apply' };
const response = (body: object, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('NopeCHA anonymous token integration', () => {
  it('waits for the accepted job and returns its token without sending candidate values or credentials', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: 'job-1' }))
      .mockResolvedValueOnce(response({ code: 14, message: 'Incomplete job' }, 409))
      .mockResolvedValueOnce(response({ data: 'solved-token' }));
    const wait = vi.fn(async () => {});
    expect(await solveRecaptchaV3(challenge, { fetchImpl, wait })).toBe('solved-token');
    const request = fetchImpl.mock.calls[0][1];
    expect(JSON.parse(request.body)).toEqual({ sitekey: challenge.sitekey, url: 'https://jobs.example/apply', data: { action: 'apply' }, enterprise: false });
    expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.nopecha.com/v1/token/recaptcha3?id=job-1');
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it.each([12, 16, 18, 11])('reports provider code %i without retrying a refused job or exposing its message', async (code) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: code, message: 'private echoed request' }, 403));
    await expect(solveRecaptchaV3(challenge, { fetchImpl })).rejects.toThrow(`nopecha_error_${code}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds waiting for a token that never becomes ready', async () => {
    let now = 0;
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ data: 'job-1' }))
      .mockResolvedValue(response({ error: 14 }, 409));
    await expect(solveRecaptchaV3(challenge, { fetchImpl, timeoutMs: 5000, now: () => now, wait: async (ms: number) => { now += ms; } })).rejects.toThrow('nopecha_timeout');
    expect(now).toBe(5000);
  });

  it('rejects malformed requests before contacting NopeCHA', async () => {
    const fetchImpl = vi.fn();
    await expect(solveRecaptchaV3({ ...challenge, url: 'file:///private' }, { fetchImpl })).rejects.toThrow('nopecha_invalid_challenge');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
