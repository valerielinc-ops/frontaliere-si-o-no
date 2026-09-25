import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { digestDocument } from './canonical-json-digest.mjs';

export const TRANSLATION_RUNTIME_CONTRACT_V2_SCHEMA_VERSION = 2;
export const TRANSLATION_RUNTIME_PROVIDER_V2_SCHEMA_VERSION = 3;
export const TRANSLATION_RUNTIME_PROVIDER_V2_MODULE_PATH = 'scripts/lib/translation-shadow-provider-v2.mjs';
export const TRANSLATION_RUNTIME_PROVIDER_V2_EXPORT_NAME = 'translate';
export const TRANSLATION_RUNTIME_PROVIDER_V2_ENGINE_VERSION = 'shadow-engine-v2';

const CONTRACT_KEYS = ['schemaVersion', 'provider', 'capabilities'];
const PROVIDER_KEYS = ['modulePath', 'exportName', 'schemaVersion', 'engineVersion', 'costClass', 'executionClass'];
const CAPABILITY_KEYS = ['generationEnabled', 'publishEnabled'];

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => typeof key === 'string'
      && expectedKeys.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

const defaultContract = {
  schemaVersion: TRANSLATION_RUNTIME_CONTRACT_V2_SCHEMA_VERSION,
  provider: {
    modulePath: TRANSLATION_RUNTIME_PROVIDER_V2_MODULE_PATH,
    exportName: TRANSLATION_RUNTIME_PROVIDER_V2_EXPORT_NAME,
    schemaVersion: TRANSLATION_RUNTIME_PROVIDER_V2_SCHEMA_VERSION,
    engineVersion: TRANSLATION_RUNTIME_PROVIDER_V2_ENGINE_VERSION,
    costClass: 'zero',
    executionClass: 'isolated_callback',
  },
  capabilities: {
    generationEnabled: false,
    publishEnabled: false,
  },
};

export const TRANSLATION_RUNTIME_CONTRACT_V2 = deepFreeze(defaultContract);

/**
 * Validate the source-controlled provider seam before a scheduler can reserve
 * or execute a plan. Every value that crosses into the isolated executor is
 * pinned here; environment variables are deliberately not part of this API.
 */
export function validateTranslationRuntimeContractV2(input = TRANSLATION_RUNTIME_CONTRACT_V2) {
  if (!hasExactKeys(input, CONTRACT_KEYS)) {
    throw new TypeError('translation runtime contract v2 has an unsupported schema');
  }
  if (input.schemaVersion !== TRANSLATION_RUNTIME_CONTRACT_V2_SCHEMA_VERSION) {
    throw new TypeError('translation runtime contract v2 schema version is invalid');
  }
  if (!hasExactKeys(input.provider, PROVIDER_KEYS)) {
    throw new TypeError('translation runtime contract v2 provider has an unsupported schema');
  }
  if (input.provider.modulePath !== TRANSLATION_RUNTIME_PROVIDER_V2_MODULE_PATH) {
    throw new TypeError('translation runtime contract v2 provider module is not pinned');
  }
  if (input.provider.exportName !== TRANSLATION_RUNTIME_PROVIDER_V2_EXPORT_NAME) {
    throw new TypeError('translation runtime contract v2 provider export is not pinned');
  }
  if (input.provider.schemaVersion !== TRANSLATION_RUNTIME_PROVIDER_V2_SCHEMA_VERSION) {
    throw new TypeError('translation runtime contract v2 provider schema version is invalid');
  }
  if (input.provider.engineVersion !== TRANSLATION_RUNTIME_PROVIDER_V2_ENGINE_VERSION) {
    throw new TypeError('translation runtime contract v2 provider engine is not pinned');
  }
  if (input.provider.costClass !== 'zero' || input.provider.executionClass !== 'isolated_callback') {
    throw new TypeError('translation runtime contract v2 provider execution class is invalid');
  }
  if (!hasExactKeys(input.capabilities, CAPABILITY_KEYS)
      || input.capabilities.generationEnabled !== false
      || input.capabilities.publishEnabled !== false) {
    throw new TypeError('translation runtime contract v2 capabilities must keep generation and publish disabled');
  }

  return deepFreeze({
    schemaVersion: input.schemaVersion,
    provider: { ...input.provider },
    capabilities: { ...input.capabilities },
  });
}

/**
 * Resolve and probe the pinned provider export. Importing the module proves
 * the seam is present; the executor remains the only code allowed to call it.
 */
export async function resolveTranslationRuntimeContractV2({
  repository,
  contract = TRANSLATION_RUNTIME_CONTRACT_V2,
} = {}) {
  if (!nonEmptyString(repository)) {
    throw new TypeError('translation runtime contract v2 repository is required');
  }
  const normalized = validateTranslationRuntimeContractV2(contract);
  const modulePath = path.resolve(repository, normalized.provider.modulePath);
  let moduleStats;
  try {
    moduleStats = await stat(modulePath);
  } catch {
    throw new TypeError('translation runtime contract v2 provider module is missing');
  }
  if (!moduleStats.isFile()) {
    throw new TypeError('translation runtime contract v2 provider module is not a file');
  }

  const moduleUrl = pathToFileURL(modulePath).href;
  let providerModule;
  try {
    providerModule = await import(moduleUrl);
  } catch {
    throw new TypeError('translation runtime contract v2 provider module cannot be imported');
  }
  if (typeof providerModule[normalized.provider.exportName] !== 'function') {
    throw new TypeError('translation runtime contract v2 provider export is missing');
  }

  return deepFreeze({
    ...normalized,
    digest: digestDocument(normalized),
    provider: {
      ...normalized.provider,
      moduleUrl,
    },
  });
}
