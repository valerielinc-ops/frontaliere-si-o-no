import { randomBytes } from 'node:crypto';
import {
  fetchRcTemplate,
  getRemoteConfig,
  stageRcParamValue,
  updateRcTemplateWithEtag,
} from './remote-config-admin.mjs';

/**
 * The rewrite artifact crosses two independent workflow runs. Its key must
 * therefore have a longer lifetime than the rotating Codex login used by the
 * rewrite broker.
 */
export const EVENT_DESCRIPTION_ARTIFACT_KEY_NAME = 'EVENT_DESCRIPTION_ARTIFACT_KEY';
export const EVENT_DESCRIPTION_ARTIFACT_KEY_BYTES = 32;
export const EVENT_DESCRIPTION_ARTIFACT_FORMAT = 'event-description-artifact-v2';
export const EVENT_DESCRIPTION_ARTIFACT_KEY_DESCRIPTION =
  'Stable private key for short-lived event-description rewrite artifacts; managed by the event workflows.';

const MIN_ARTIFACT_KEY_LENGTH = 32;

export function isValidEventDescriptionArtifactKey(value) {
  return typeof value === 'string'
    && value.length >= MIN_ARTIFACT_KEY_LENGTH
    && !/[\r\n]/u.test(value);
}

export function generateEventDescriptionArtifactKey() {
  return randomBytes(EVENT_DESCRIPTION_ARTIFACT_KEY_BYTES).toString('base64url');
}

/**
 * Keep an existing key stable. The candidate is generated once per caller so
 * an ETag retry cannot replace a key that another workflow just provisioned.
 */
export function stageEventDescriptionArtifactKey(template, candidate = generateEventDescriptionArtifactKey()) {
  const existing = template?.parameters?.[EVENT_DESCRIPTION_ARTIFACT_KEY_NAME]?.defaultValue?.value;
  if (isValidEventDescriptionArtifactKey(existing)) {
    return { changed: false, template, value: existing };
  }
  const staged = stageRcParamValue(
    template,
    EVENT_DESCRIPTION_ARTIFACT_KEY_NAME,
    candidate,
    EVENT_DESCRIPTION_ARTIFACT_KEY_DESCRIPTION,
  );
  return { ...staged, value: candidate };
}

/**
 * Provision the key once, or read the already-provisioned value, using the
 * same ETag/retry contract as the other Remote Config writers.
 */
export async function ensureEventDescriptionArtifactKey({ credentials }) {
  const candidate = generateEventDescriptionArtifactKey();
  let resolvedKey = '';
  const result = await updateRcTemplateWithEtag({
    credentials,
    versionDescription: 'ensure event-description artifact key',
    stage: (template) => {
      const staged = stageEventDescriptionArtifactKey(template, candidate);
      resolvedKey = staged.value;
      return staged;
    },
  });
  if (!result.ok || !isValidEventDescriptionArtifactKey(resolvedKey)) {
    throw new Error(`unable to provision ${EVENT_DESCRIPTION_ARTIFACT_KEY_NAME}: ${result.detail || 'Remote Config update failed'}`);
  }
  return resolvedKey;
}

/** Read the existing key without creating or changing Remote Config state. */
export async function readEventDescriptionArtifactKey() {
  const template = await fetchRcTemplate(await getRemoteConfig());
  const key = template.parameters?.[EVENT_DESCRIPTION_ARTIFACT_KEY_NAME]?.defaultValue?.value;
  if (!isValidEventDescriptionArtifactKey(key)) {
    throw new Error(`${EVENT_DESCRIPTION_ARTIFACT_KEY_NAME} is not provisioned`);
  }
  return key;
}
