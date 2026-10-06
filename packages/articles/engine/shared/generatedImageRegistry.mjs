/**
 * Shared contract for images made by the site's single image engine.
 *
 * This module deliberately has no Node imports. The browser, the site build,
 * the crawler assembler and the corpus can all validate the same records and
 * build the same prompt without bringing a provider SDK into the article
 * package.
 */

export const GENERATED_IMAGE_SCHEMA_VERSION = 1;
export const GENERATED_IMAGE_LICENSE = 'generated-provider';
export const GENERATED_IMAGE_CREDIT = 'frontaliereticino.ch';
export const GENERATED_IMAGE_PROMPT_VERSION = 'frontaliereticino.generated-image-policy.v1';
export const GENERATED_IMAGE_MAX_BYTES = 220 * 1024;

export const GENERATED_IMAGE_SCOPES = Object.freeze([
  'event-library',
  'article-hero',
  'place',
  'og',
]);

export const GENERATED_IMAGE_PROVIDERS = Object.freeze([
  'openai-codex',
  'gemini',
]);
export const GENERATED_IMAGE_LICENSE_URLS = Object.freeze({
  'openai-codex': 'https://openai.com/policies/terms-of-use/',
  gemini: 'https://ai.google.dev/gemini-api/terms',
});

export const GENERATED_IMAGE_POLICY = Object.freeze([
  'Illustrative editorial scene, never a documentary or journalistic photograph of a specific real event.',
  'No real or recognizable person in the foreground.',
  'No face of a public figure or identifiable person.',
  'No logo, brand, trademark, signage, readable text, lettering, watermark or signature.',
  'Use an original, coherent visual language across the Frontaliere Ticino library.',
  'Keep the subject generic enough to illustrate a category, place or editorial idea.',
]);

export const GENERATED_IMAGE_RESTRICTIONS = Object.freeze([
  'illustrative-only',
  'no-real-recognizable-foreground-person',
  'no-public-figure-face',
  'no-logo-brand-or-text',
  'no-specific-real-event-photojournalism',
]);

export const GENERATED_IMAGE_DEFAULT_FORMAT = Object.freeze({
  width: 1200,
  height: 675,
  format: 'webp',
  maxBytes: GENERATED_IMAGE_MAX_BYTES,
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ASSET_ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isoDate(value) {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function aspectRatio(width, height) {
  return `${width}:${height}`;
}

/**
 * Normalize the public generation specification before it reaches a provider.
 * The returned object is also the canonical input for prompt hashing.
 */
export function normalizeGeneratedImageSpec(spec = {}) {
  const scope = normalizeText(spec.scope);
  if (!GENERATED_IMAGE_SCOPES.includes(scope)) {
    throw new Error(`Unsupported generated-image scope: ${scope || '<empty>'}`);
  }
  const subject = normalizeText(spec.subject);
  if (!subject) throw new Error('Generated-image subject is required');
  const area = normalizeText(spec.area || 'Swiss border region');
  const season = normalizeText(spec.season || 'all seasons');
  const format = isRecord(spec.format) ? spec.format : GENERATED_IMAGE_DEFAULT_FORMAT;
  const width = Number(format.width || GENERATED_IMAGE_DEFAULT_FORMAT.width);
  const height = Number(format.height || GENERATED_IMAGE_DEFAULT_FORMAT.height);
  if (!positiveInteger(width) || !positiveInteger(height)) {
    throw new Error('Generated-image format must have positive integer dimensions');
  }
  const outputFormat = normalizeText(format.format || 'webp').toLowerCase();
  if (outputFormat !== 'webp') throw new Error('Generated-image output format must be webp');
  const maxBytes = Number(format.maxBytes || GENERATED_IMAGE_MAX_BYTES);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > GENERATED_IMAGE_MAX_BYTES) {
    throw new Error(`Generated-image maxBytes must be <= ${GENERATED_IMAGE_MAX_BYTES}`);
  }
  const assetId = normalizeText(spec.assetId) || undefined;
  if (assetId && !ASSET_ID_RE.test(assetId)) throw new Error('Generated-image assetId is invalid');
  return Object.freeze({
    scope,
    subject,
    area,
    season,
    format: Object.freeze({ width, height, format: outputFormat, maxBytes }),
    category: normalizeText(spec.category) || undefined,
    variant: normalizeText(spec.variant) || undefined,
    assetId,
  });
}

/**
 * Central prompt policy. Provider adapters must pass this exact result to the
 * model; callers may add a deterministic variation only through `variation`.
 */
export function buildGeneratedImagePrompt(spec, { variation = '' } = {}) {
  const normalized = normalizeGeneratedImageSpec(spec);
  const policy = GENERATED_IMAGE_POLICY.map((rule) => `- ${rule}`).join('\n');
  const variationText = normalizeText(variation);
  return [
    'Create one original editorial illustration for frontaliereticino.ch.',
    `Purpose: ${normalized.scope}.`,
    `Subject: ${normalized.subject}.`,
    `Area or visual context: ${normalized.area}.`,
    `Seasonal atmosphere: ${normalized.season}.`,
    `Composition: landscape ${normalized.format.width}x${normalized.format.height}, clear subject separation, calm editorial composition, no cropped focal subject at the edges.`,
    'Style: warm, precise, contemporary Swiss editorial illustration with natural texture, restrained colors and a consistent art direction; not photorealistic.',
    'Mandatory safety policy:',
    policy,
    variationText ? `Deterministic variation: ${variationText}.` : '',
    'Return only the image; do not explain it and do not add a caption.',
  ].filter(Boolean).join('\n');
}

/** Return the stable fields that a Node adapter should hash before generation. */
export function generatedImagePromptInput(spec, options) {
  const normalized = normalizeGeneratedImageSpec(spec);
  return JSON.stringify({
    promptVersion: GENERATED_IMAGE_PROMPT_VERSION,
    spec: normalized,
    variation: normalizeText(options?.variation || ''),
  });
}

export function isGeneratedImagePath(value) {
  return typeof value === 'string' && /^\/images\/(?:events\/library|generated)\/[a-z0-9][a-z0-9._-]{2,127}\.webp$/.test(value);
}

export function generatedImageAssetIdFromPath(value) {
  if (!isGeneratedImagePath(value)) return null;
  return value.slice(value.lastIndexOf('/') + 1, -'.webp'.length);
}

/**
 * Validate one persisted registry record. The function is intentionally
 * strict: a record is the permission to publish the bytes, not commentary.
 */
export function validateGeneratedImageRecord(record) {
  const errors = [];
  if (!isRecord(record)) return { valid: false, errors: ['record must be an object'] };
  if (record.schema !== GENERATED_IMAGE_SCHEMA_VERSION) errors.push('schema must be 1');
  if (!ASSET_ID_RE.test(String(record.assetId || ''))) errors.push('assetId is invalid');
  if (!GENERATED_IMAGE_PROVIDERS.includes(record.provider)) errors.push('provider is not allowed');
  if (!nonEmpty(record.model)) errors.push('model is required');
  if (record.promptVersion !== GENERATED_IMAGE_PROMPT_VERSION) errors.push('promptVersion is not current');
  if (!SHA256_RE.test(String(record.promptHash || ''))) errors.push('promptHash must be sha256');
  if (record.license !== GENERATED_IMAGE_LICENSE) errors.push('license must be generated-provider');
  if (!/^https:\/\//i.test(String(record.licenseUrl || ''))) errors.push('licenseUrl must be https');
  if (GENERATED_IMAGE_LICENSE_URLS[record.provider] && record.licenseUrl !== GENERATED_IMAGE_LICENSE_URLS[record.provider]) {
    errors.push('licenseUrl does not match the provider terms');
  }
  if (record.credit !== GENERATED_IMAGE_CREDIT) errors.push('credit must be frontaliereticino.ch');
  if (!positiveInteger(record.width) || !positiveInteger(record.height)) errors.push('width/height must be positive integers');
  if (record.format !== 'webp') errors.push('format must be webp');
  if (!positiveInteger(record.bytes) || record.bytes > GENERATED_IMAGE_MAX_BYTES) errors.push('bytes exceed the WebP limit');
  if (!SHA256_RE.test(String(record.sha256 || ''))) errors.push('sha256 must be present');
  if (!isoDate(record.generatedAt)) errors.push('generatedAt must be an ISO UTC timestamp');
  if (!isoDate(record.verifiedAt)) errors.push('verifiedAt must be an ISO UTC timestamp');
  if (!GENERATED_IMAGE_SCOPES.includes(record.scope)) errors.push('scope is not allowed');
  if (record.scope === 'event-library') {
    for (const field of ['category', 'area', 'season', 'variant']) {
      if (!nonEmpty(record[field])) errors.push(`event-library ${field} is required`);
    }
  }
  if (!Array.isArray(record.restrictions) || !GENERATED_IMAGE_RESTRICTIONS.every((item) => record.restrictions.includes(item))) {
    errors.push('restrictions do not contain the mandatory policy');
  }
  if (!isRecord(record.vision)
    || record.vision.ok !== true
    || record.vision.contains_text !== false
    || record.vision.contains_logo !== false
    || record.vision.contains_recognizable_face !== false
    || record.vision.looks_like_specific_real_event !== false
    || !nonEmpty(record.vision.notes)) {
    errors.push('vision gate verdict is missing or rejected');
  }
  if (!isGeneratedImagePath(record.imageUrl)) errors.push('imageUrl must be a generated WebP path');
  const expectedPrefix = record.scope === 'event-library' ? '/images/events/library/' : '/images/generated/';
  if (record.imageUrl && !record.imageUrl.startsWith(expectedPrefix)) errors.push('imageUrl does not match scope');
  if (record.imageUrl && generatedImageAssetIdFromPath(record.imageUrl) !== record.assetId) errors.push('imageUrl assetId mismatch');
  if (record.width / record.height < 1.6 || record.width / record.height > 1.9) errors.push('image aspect ratio is outside the editorial range');
  return { valid: errors.length === 0, errors };
}

export function validateGeneratedImageRegistry(registry, { scope } = {}) {
  const errors = [];
  const assets = Array.isArray(registry) ? registry : registry?.assets;
  if (!isRecord(registry) && !Array.isArray(registry)) return { valid: false, errors: ['registry must be an object or asset array'] };
  if (!Array.isArray(assets)) return { valid: false, errors: ['registry.assets must be an array'] };
  if (!Array.isArray(registry) && registry.schema !== GENERATED_IMAGE_SCHEMA_VERSION) errors.push('registry schema must be 1');
  if (!Array.isArray(registry) && registry.assetCount !== undefined && registry.assetCount !== assets.length) {
    errors.push('registry assetCount does not match assets');
  }
  if (scope !== undefined && !GENERATED_IMAGE_SCOPES.includes(scope)) errors.push('registry scope is not allowed');
  if (scope === 'event-library' && !Array.isArray(registry)) {
    if (registry.cdnPrefix !== '/images/events/library/') errors.push('event registry cdnPrefix is invalid');
    if (!nonEmpty(registry.libraryVersion)) errors.push('event registry libraryVersion is required');
  }
  const assetIds = new Set();
  const imageUrls = new Set();
  for (const record of assets) {
    const validation = validateGeneratedImageRecord(record);
    if (!validation.valid) errors.push(`${record?.assetId || '<unknown>'}: ${validation.errors.join(', ')}`);
    if (assetIds.has(record?.assetId)) errors.push(`${record?.assetId || '<unknown>'}: duplicate assetId`);
    if (imageUrls.has(record?.imageUrl)) errors.push(`${record?.assetId || '<unknown>'}: duplicate imageUrl`);
    assetIds.add(record?.assetId);
    imageUrls.add(record?.imageUrl);
    if (scope !== undefined && record?.scope !== scope) {
      errors.push(`${record?.assetId || '<unknown>'}: registry record does not match the requested scope`);
    }
    if (scope === 'event-library' && !String(record?.imageUrl || '').startsWith('/images/events/library/')) {
      errors.push(`${record?.assetId || '<unknown>'}: event registry record must use the library prefix`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Gate an assembled event set. OpenAgenda remains the only source-image
 * exception and must carry its own per-image licence fields; every library
 * image must point to one valid generated record.
 */
export function verifyPublishedEventImages(events, records) {
  const assets = Array.isArray(records) ? records : Array.isArray(records?.assets) ? records.assets : [];
  const byUrl = new Map(assets.map((record) => [record?.imageUrl, record]));
  const errors = [];
  const generatedPrefixes = [
    '/images/events/myswitzerland-',
    '/images/events/guidle-',
    '/images/events/tio-agenda-',
    '/images/events/ge-agenda-',
    '/images/events/fr-agenda-',
    '/images/events/nw-agenda-',
    '/images/events/ow-agenda-',
  ];
  for (const event of Array.isArray(events) ? events : []) {
    const imageUrl = event?.imageUrl;
    if (!imageUrl) continue;
    const removed = generatedPrefixes.find((prefix) => imageUrl.startsWith(prefix));
    if (removed) {
      errors.push(`${event.id || '<event>'}: removed source image URL ${imageUrl}`);
      continue;
    }
    if (isGeneratedImagePath(imageUrl)) {
      const record = byUrl.get(imageUrl);
      const validation = validateGeneratedImageRecord(record);
      const eventScopeError = record && (record.scope !== 'event-library' || !imageUrl.startsWith('/images/events/library/'))
        ? ['event image must use event-library scope and prefix']
        : [];
      const propagationErrors = record
        ? [
          event.imageAssetId !== record.assetId ? 'imageAssetId does not match registry' : '',
          event.imageLicense !== record.license ? 'imageLicense does not match registry' : '',
          event.imageLicenseUrl !== record.licenseUrl ? 'imageLicenseUrl does not match registry' : '',
          event.imageCredit !== record.credit ? 'imageCredit does not match registry' : '',
          event.imageProvider !== record.provider ? 'imageProvider does not match registry' : '',
        ].filter(Boolean)
        : [];
      if (!record || eventScopeError.length || !validation.valid || propagationErrors.length) {
        errors.push(`${event.id || '<event>'}: generated image has no valid record (${[...(validation.errors || ['missing']), ...eventScopeError, ...propagationErrors].join(', ')})`);
      }
      continue;
    }
    const openAgenda = event.sourceKey === 'openagenda'
      && imageUrl.startsWith('/images/events/openagenda-')
      && nonEmpty(event.imageCredit)
      && /^https:\/\//i.test(String(event.imageLicenseUrl || ''))
      && nonEmpty(event.imageLicense);
    const catalog = imageUrl.startsWith('/images/events/catalog/');
    if (!openAgenda && !catalog) {
      errors.push(`${event.id || '<event>'}: image URL is outside the allowed source set`);
    }
  }
  return { valid: errors.length === 0, errors };
}
