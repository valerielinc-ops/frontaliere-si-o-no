import { describe, expect, it } from 'vitest';
import { verifySumUpRemoteConfig, verifySumUpRemoteConfigTemplate } from '../scripts/ci/verify-sumup-remote-config.mjs';

const API_KEY = 'sup_sk_live_secret_value';
const MERCHANT_CODE = 'MC_LIVE';
const WEBHOOK_URL = 'https://europe-west6.example.test/sumupAssistedApplicationWebhook';

type Template = {
  version: { versionNumber: string };
  parameters: Record<string, unknown>;
  parameterGroups?: Record<string, { parameters?: Record<string, unknown> }>;
};

function template(overrides: Record<string, unknown> = {}): Template {
  return {
    version: { versionNumber: '42' },
    parameters: {
      ASSISTED_APPLICATION_PAYMENT_PROVIDER: { defaultValue: { value: 'sumup' } },
      SUMUP_API_KEY: { defaultValue: { value: API_KEY } },
      SUMUP_MERCHANT_CODE: { defaultValue: { value: MERCHANT_CODE } },
      SUMUP_ASSISTED_APPLICATION_WEBHOOK_URL: { defaultValue: { value: WEBHOOK_URL } },
      ...overrides,
    },
  };
}

describe('verify-sumup-remote-config', () => {
  it('accepts the complete top-level SumUp contract', async () => {
    const logs: string[] = [];
    const result = await verifySumUpRemoteConfig({
      readTemplate: async () => template(),
      log: (line: string) => logs.push(line),
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(logs.join('\n')).not.toContain(API_KEY);
    expect(logs.join('\n')).not.toContain(MERCHANT_CODE);
  });

  it('rejects a parameter hidden in a group without printing its value', () => {
    const grouped = template();
    delete grouped.parameters.SUMUP_MERCHANT_CODE;
    grouped.parameterGroups = {
      payments: {
        parameters: {
          SUMUP_MERCHANT_CODE: { defaultValue: { value: MERCHANT_CODE } },
        },
      },
    };

    const result = verifySumUpRemoteConfigTemplate(grouped);
    const merchantCheck = result.checks.find((check) => check.name === 'merchantCode');
    expect(result.ok).toBe(false);
    expect(merchantCheck).toMatchObject({
      key: 'SUMUP_MERCHANT_CODE',
      ok: false,
      reason: expect.stringContaining('top-level'),
    });
    expect(JSON.stringify(result)).not.toContain(MERCHANT_CODE);
  });

  it.each([
    ['provider', { ASSISTED_APPLICATION_PAYMENT_PROVIDER: { defaultValue: { value: 'stripe' } } }],
    ['webhook', { SUMUP_ASSISTED_APPLICATION_WEBHOOK_URL: { defaultValue: { value: 'http://example.test/callback' } } }],
  ])('rejects an invalid %s value', (_label, overrides) => {
    const result = verifySumUpRemoteConfigTemplate(template(overrides));
    expect(result.ok).toBe(false);
  });
});
