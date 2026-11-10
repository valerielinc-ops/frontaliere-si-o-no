import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock('firebase-admin/remote-config', () => ({
  getRemoteConfig: () => ({
    initServerTemplate: ({ defaultConfig }: { defaultConfig: Record<string, string> }) => ({
      load: async () => {},
      evaluate: () => ({
        getValue: (key: string) => {
          const remote = Object.prototype.hasOwnProperty.call(mockConfig.values, key);
          const value = remote ? mockConfig.values[key] : defaultConfig[key];
          return {
            asString: () => String(value),
            asBoolean: () => value === true || String(value).toLowerCase() === 'true',
            getSource: () => remote ? 'remote' : 'default',
          };
        },
      }),
    }),
  }),
}));

const VALID_RANDOMIZATION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('reader subscription Remote Config assignment', () => {
  beforeEach(() => {
    mockConfig.values = {};
    vi.resetModules();
  });

  it('fails closed to local control when assignment input is invalid', async () => {
    const { resolveHouseAdCreativeAssignment } = await import('../functions/src/houseAdCreativeAssignment.js');
    await expect(resolveHouseAdCreativeAssignment('not-an-id')).resolves.toMatchObject({
      variant: 'control', enrolled: false,
      readerSubscriptionVariant: 'control', readerSubscriptionEnrolled: false,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1',
      readerSubscriptionAssignmentSource: 'local_default',
    });
  });

  it('returns the Firebase control/treatment arm separately from the job creative test', async () => {
    mockConfig.values = {
      HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED: 'true',
      HOUSE_AD_READER_SUBSCRIPTION_VARIANT: 'subscription',
    };
    const { resolveHouseAdCreativeAssignment } = await import('../functions/src/houseAdCreativeAssignment.js');
    await expect(resolveHouseAdCreativeAssignment(VALID_RANDOMIZATION_ID)).resolves.toMatchObject({
      variant: 'control', enrolled: false, experimentId: 'house_creatives_v2',
      readerSubscriptionVariant: 'subscription', readerSubscriptionEnrolled: true,
      readerSubscriptionExperimentId: 'reader_subscription_house_v1',
      readerSubscriptionAssignmentSource: 'firebase_remote_config',
    });
  });

  it('rejects unknown Remote Config variants and never enrolls them', async () => {
    mockConfig.values = {
      HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED: 'true',
      HOUSE_AD_READER_SUBSCRIPTION_VARIANT: 'unexpected',
    };
    const { resolveHouseAdCreativeAssignment } = await import('../functions/src/houseAdCreativeAssignment.js');
    await expect(resolveHouseAdCreativeAssignment(VALID_RANDOMIZATION_ID)).resolves.toMatchObject({
      readerSubscriptionVariant: 'control', readerSubscriptionEnrolled: false,
      readerSubscriptionAssignmentSource: 'firebase_remote_config',
    });
  });
});
