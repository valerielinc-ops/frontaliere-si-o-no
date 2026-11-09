import { getRemoteConfig } from 'firebase-admin/remote-config';

export const HOUSE_AD_EXPERIMENT_ID = 'house_creatives_v2';
export const READER_SUBSCRIPTION_EXPERIMENT_ID = 'reader_subscription_house_v1';
// Keep in sync with services/houseAdCreative.ts. Unknown Remote Config arms
// fail closed to the fixed control creative.
const HOUSE_AD_VARIANTS = new Set([
  'control', 'time_saved', 'profile_match', 'in_control', 'swiss_work', 'next_chapter',
]);
export const HOUSE_AD_CREATIVE_DEFAULTS = Object.freeze({
  HOUSE_AD_CREATIVE_EXPERIMENT_ENABLED: 'false',
  HOUSE_AD_CREATIVE_VARIANT: 'control',
  HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED: 'false',
  HOUSE_AD_READER_SUBSCRIPTION_VARIANT: 'control',
});

const TEMPLATE_REFRESH_MS = 5 * 60 * 1000;
const TEMPLATE_MAX_STALE_MS = 60 * 60 * 1000;
const TEMPLATE_LOAD_TIMEOUT_MS = 2500;
const TEMPLATE_RETRY_DELAY_MS = 30 * 1000;
const DEFAULT_ASSIGNMENT = Object.freeze({
  variant: 'control',
  enrolled: false,
  experimentId: HOUSE_AD_EXPERIMENT_ID,
  assignmentSource: 'local_default',
  readerSubscriptionVariant: 'control',
  readerSubscriptionEnrolled: false,
  readerSubscriptionExperimentId: READER_SUBSCRIPTION_EXPERIMENT_ID,
  readerSubscriptionAssignmentSource: 'local_default',
});

let cachedTemplate = null;
let cachedAt = 0;
let templateLoad = null;
let retryAfter = 0;

async function loadServerTemplate() {
  const now = Date.now();
  if (cachedTemplate && now - cachedAt < TEMPLATE_REFRESH_MS) return cachedTemplate;

  if (!templateLoad && Date.now() < retryAfter) {
    return cachedTemplate && Date.now() - cachedAt <= TEMPLATE_MAX_STALE_MS ? cachedTemplate : null;
  }

  if (!templateLoad) {
    let candidate;
    try {
      candidate = getRemoteConfig().initServerTemplate({ defaultConfig: HOUSE_AD_CREATIVE_DEFAULTS });
    } catch {
      retryAfter = Date.now() + TEMPLATE_RETRY_DELAY_MS;
      return cachedTemplate && Date.now() - cachedAt <= TEMPLATE_MAX_STALE_MS ? cachedTemplate : null;
    }
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), TEMPLATE_LOAD_TIMEOUT_MS);
    });
    const load = Promise.resolve().then(() => candidate.load()).then(() => candidate);
    const attempt = Promise.race([load, timeout])
      .then((loaded) => {
        if (!loaded) {
          retryAfter = Date.now() + TEMPLATE_RETRY_DELAY_MS;
          return null;
        }
        cachedTemplate = candidate;
        cachedAt = Date.now();
        retryAfter = 0;
        return candidate;
      })
      .catch(() => {
        retryAfter = Date.now() + TEMPLATE_RETRY_DELAY_MS;
        return null;
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (templateLoad === attempt) templateLoad = null;
      });
    templateLoad = attempt;
  }

  const refreshed = await templateLoad;
  if (refreshed) return refreshed;
  return cachedTemplate && Date.now() - cachedAt <= TEMPLATE_MAX_STALE_MS ? cachedTemplate : null;
}

/**
 * Resolve a stable, anonymous browser ID through Firebase's server Remote
 * Config conditions. Percentage conditions and their seed live in Firebase;
 * the browser never chooses a variant itself and no client template is exposed.
 */
export async function resolveHouseAdCreativeAssignment(randomizationId) {
  if (typeof randomizationId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(randomizationId)) {
    return DEFAULT_ASSIGNMENT;
  }

  try {
    const template = await loadServerTemplate();
    if (!template) return DEFAULT_ASSIGNMENT;

    const config = template.evaluate({ randomizationId });
    const enabledValue = config.getValue('HOUSE_AD_CREATIVE_EXPERIMENT_ENABLED');
    const variantValue = config.getValue('HOUSE_AD_CREATIVE_VARIANT');
    const readerSubscriptionEnabledValue = config.getValue('HOUSE_AD_READER_SUBSCRIPTION_EXPERIMENT_ENABLED');
    const readerSubscriptionVariantValue = config.getValue('HOUSE_AD_READER_SUBSCRIPTION_VARIANT');
    const variant = variantValue.asString();
    const source = enabledValue.getSource() === 'remote' || variantValue.getSource() === 'remote'
      ? 'firebase_remote_config'
      : 'local_default';
    const readerSubscriptionVariant = readerSubscriptionVariantValue.asString();
    const readerSubscriptionSource = readerSubscriptionEnabledValue.getSource() === 'remote'
      || readerSubscriptionVariantValue.getSource() === 'remote'
      ? 'firebase_remote_config'
      : 'local_default';
    const readerSubscriptionEnrolled = readerSubscriptionEnabledValue.asBoolean()
      && ['control', 'subscription'].includes(readerSubscriptionVariant)
      && readerSubscriptionSource === 'firebase_remote_config';

    if (!enabledValue.asBoolean() || !HOUSE_AD_VARIANTS.has(variant)) {
      return {
        ...DEFAULT_ASSIGNMENT,
        assignmentSource: source,
        readerSubscriptionVariant: readerSubscriptionEnrolled ? readerSubscriptionVariant : 'control',
        readerSubscriptionEnrolled,
        readerSubscriptionAssignmentSource: readerSubscriptionSource,
      };
    }

    return {
      variant,
      enrolled: true,
      experimentId: HOUSE_AD_EXPERIMENT_ID,
      assignmentSource: 'firebase_remote_config',
      readerSubscriptionVariant: readerSubscriptionEnrolled ? readerSubscriptionVariant : 'control',
      readerSubscriptionEnrolled,
      readerSubscriptionExperimentId: READER_SUBSCRIPTION_EXPERIMENT_ID,
      readerSubscriptionAssignmentSource: readerSubscriptionSource,
    };
  } catch {
    // A stale/missing experiment config must never prevent a fallback creative.
    return DEFAULT_ASSIGNMENT;
  }
}
