import { afterEach, describe, expect, it, vi } from 'vitest';

const MODULE = '@/functions/src/lib/emailExperimentPostHog.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('emailExperimentPostHog — disabled by default', () => {
  it('exposes the two canonical event names', async () => {
    const { EMAIL_EXPERIMENT_EVENTS } = await import(MODULE);
    expect(EMAIL_EXPERIMENT_EVENTS.SENT).toBe('email_sent');
    expect(EMAIL_EXPERIMENT_EVENTS.OPENED).toBe('email_opened');
  });

  it('is a no-op (no network) when POSTHOG_EMAIL_EXPERIMENT is unset', async () => {
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { captureEmailEvent, isEmailExperimentEnabled } = await import(MODULE);
    expect(await isEmailExperimentEnabled()).toBe(false);
    const ok = await captureEmailEvent('email_sent', { email: 'a@b.com', variant: 'curioso', provider: 'mailjet' });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('emailExperimentPostHog — enabled', () => {
  it('POSTs the event to PostHog with the expected payload', async () => {
    vi.resetModules();
    vi.stubEnv('POSTHOG_EMAIL_EXPERIMENT', '1');
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'phc_test_key');
    vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);

    const { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS } = await import(MODULE);
    const ok = await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.OPENED, {
      email: 'Mario@Example.com',
      variant: 'concreto',
      provider: 'mailgun',
      campaignId: 'weekly_2026-06-15',
      locale: 'it',
    });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://ph.example.com/capture/');
    const body = JSON.parse(opts!.body);
    expect(body.api_key).toBe('phc_test_key');
    expect(body.event).toBe('email_opened');
    expect(body.distinct_id).toBe('mario@example.com'); // lowercased
    expect(body.properties.subject_variant).toBe('concreto');
    expect(body.properties.email_provider).toBe('mailgun');
    expect(body.properties.campaign_id).toBe('weekly_2026-06-15');
  });

  it('no-ops for an excluded provider (e.g. mailtrap sandbox) even when enabled', async () => {
    vi.resetModules();
    vi.stubEnv('POSTHOG_EMAIL_EXPERIMENT', '1');
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'phc_test_key');
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const { captureEmailEvent, EMAIL_EXPERIMENT_EVENTS, EXPERIMENT_EXCLUDED_PROVIDERS } = await import(MODULE);
    expect(EXPERIMENT_EXCLUDED_PROVIDERS.has('mailtrap')).toBe(true);
    const ok = await captureEmailEvent(EMAIL_EXPERIMENT_EVENTS.SENT, {
      email: 'a@b.com', variant: 'concreto', provider: 'mailtrap', campaignId: 'weekly_2026-06-15',
    });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still no-ops when email (distinct_id) is missing', async () => {
    vi.resetModules();
    vi.stubEnv('POSTHOG_EMAIL_EXPERIMENT', 'true');
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'phc_test_key');
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const { captureEmailEvent } = await import(MODULE);
    expect(await captureEmailEvent('email_sent', { variant: 'curioso' })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops when the key is missing even if the flag is on', async () => {
    vi.resetModules();
    vi.stubEnv('POSTHOG_EMAIL_EXPERIMENT', '1'); // no POSTHOG_PROJECT_KEY
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const { captureEmailEvent, isEmailExperimentEnabled } = await import(MODULE);
    expect(await isEmailExperimentEnabled()).toBe(false);
    expect(await captureEmailEvent('email_opened', { email: 'x@y.com' })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws when fetch rejects', async () => {
    vi.resetModules();
    vi.stubEnv('POSTHOG_EMAIL_EXPERIMENT', '1');
    vi.stubEnv('POSTHOG_PROJECT_KEY', 'phc_test_key');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { captureEmailEvent } = await import(MODULE);
    await expect(captureEmailEvent('email_opened', { email: 'x@y.com' })).resolves.toBe(false);
  });
});
