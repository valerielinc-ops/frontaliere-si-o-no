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
export const PRIVATE_GRANT_LICENSE = 'private-grant';
export const PRIVATE_GRANT_PROVIDER = 'site-owned';
export const GENERATED_IMAGE_CREDIT = 'frontaliereticino.ch';
export const GENERATED_IMAGE_PROMPT_VERSION = 'frontaliereticino.generated-image-policy.v1';
export const GENERATED_IMAGE_MAX_BYTES = 220 * 1024;
export const GENERATED_IMAGE_KIND = 'generated';
export const LICENSED_PHOTO_KIND = 'photo';

export const GENERATED_IMAGE_SCOPES = Object.freeze([
  'event-library',
  'editorial-profile',
  'article-hero',
  'place',
  'og',
]);

export const GENERATED_IMAGE_PROVIDERS = Object.freeze([
  'openai-codex',
  'gemini',
  'fal',
  'together',
  'pollinations',
]);
export const LICENSED_PHOTO_PROVIDERS = Object.freeze([
  'wikimedia',
  'pexels',
  'pixabay',
]);
export const IMAGE_PROVIDERS = Object.freeze([
  ...GENERATED_IMAGE_PROVIDERS,
  ...LICENSED_PHOTO_PROVIDERS,
]);
export const GENERATED_IMAGE_LICENSE_URLS = Object.freeze({
  'openai-codex': 'https://openai.com/policies/terms-of-use/',
  gemini: 'https://ai.google.dev/gemini-api/terms',
  fal: 'https://fal.ai/terms',
  together: 'https://www.together.ai/terms-of-service',
  pollinations: 'https://pollinations.ai/terms',
});
export const LICENSED_PHOTO_LICENSE_URLS = Object.freeze({
  wikimedia: 'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia',
  pexels: 'https://www.pexels.com/license/',
  pixabay: 'https://pixabay.com/service/license-summary/',
});
export const LICENSED_PHOTO_LICENSES = Object.freeze({
  wikimedia: Object.freeze(['CC0', 'Public domain', 'CC BY', 'CC BY-SA']),
  pexels: Object.freeze(['Pexels License']),
  pixabay: Object.freeze(['Pixabay Content License']),
});
export const LICENSED_PHOTO_RESTRICTIONS = Object.freeze([
  'licensed-source',
  'no-recognizable-foreground-person',
  'no-logo-brand-or-trademark',
]);

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

export function isLicensedPhotoRecord(record) {
  return isRecord(record)
    && record.kind === LICENSED_PHOTO_KIND
    && LICENSED_PHOTO_PROVIDERS.includes(record.provider);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ASSET_ID_RE = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const PHOTO_AUTHOR_IMAGE_PATH_RE = /\.(?:jpe?g|png|webp|gif|avif|svg)$/i;
const PHOTO_AUTHOR_HOSTS = Object.freeze({
  pexels: Object.freeze(['pexels.com', 'www.pexels.com']),
  pixabay: Object.freeze(['pixabay.com', 'www.pixabay.com']),
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedPhotoLicenseFamily(record) {
  const family = normalizeText(record?.licenseFamily).toLowerCase();
  if (['cc0', 'pd', 'cc-by', 'cc-by-sa', 'pexels', 'pixabay'].includes(family)) return family;
  const license = normalizeText(record?.license).toLowerCase();
  if (/^cc0(?:\s|$)|creative commons zero/.test(license)) return 'cc0';
  if (/public\s*domain|publicdomain/.test(license)) return 'pd';
  if (/^cc\s*by-sa(?:\s|$)/.test(license)) return 'cc-by-sa';
  if (/^cc\s*by(?:\s|$)/.test(license)) return 'cc-by';
  return family;
}

function allowedPhotoLicense(record) {
  if (!isLicensedPhotoRecord(record)) return false;
  if (!nonEmpty(record.license)) return false;
  if (record.provider === 'pexels') return record.license === 'Pexels License';
  if (record.provider === 'pixabay') return record.license === 'Pixabay Content License';
  const family = normalizedPhotoLicenseFamily(record);
  const license = normalizeText(record.license).toLowerCase();
  if (family === 'cc0') return /^cc0(?:\s|$)|creative commons zero/.test(license);
  if (family === 'pd') return /public\s*domain|publicdomain/.test(license);
  if (family === 'cc-by') return /^cc\s*by(?:\s|$)/.test(license) && !/^cc\s*by-sa/.test(license);
  if (family === 'cc-by-sa') return /^cc\s*by-sa(?:\s|$)/.test(license);
  return false;
}

function allowedPhotoLicenseUrl(record) {
  if (!/^https:\/\//i.test(String(record?.licenseUrl || ''))) return false;
  if (record.provider === 'pexels') return record.licenseUrl === LICENSED_PHOTO_LICENSE_URLS.pexels;
  if (record.provider === 'pixabay') return record.licenseUrl === LICENSED_PHOTO_LICENSE_URLS.pixabay;
  const family = normalizedPhotoLicenseFamily(record);
  const url = String(record.licenseUrl);
  if (url === LICENSED_PHOTO_LICENSE_URLS.wikimedia) return true;
  if (!/^https:\/\/creativecommons\.org\//i.test(url)) return false;
  if (family === 'cc0') return /\/publicdomain\/zero\//i.test(url);
  if (family === 'pd') return /\/publicdomain\/mark\//i.test(url);
  if (family === 'cc-by') return /\/licenses\/by(?:\/|$)/i.test(url);
  if (family === 'cc-by-sa') return /\/licenses\/by-sa(?:\/|$)/i.test(url);
  return false;
}

function photoAuthorUrlErrors(record) {
  const authorUrl = record.author?.url;
  if (authorUrl === undefined || authorUrl === null) return [];
  if (typeof authorUrl !== 'string' || !authorUrl.trim()) {
    return ['photo author.url must be a non-empty https URL'];
  }

  let parsed;
  try {
    parsed = new URL(authorUrl);
  } catch {
    return ['photo author.url must be a valid https URL'];
  }
  if (parsed.protocol !== 'https:') return ['photo author.url must be https'];

  const errors = [];
  if (PHOTO_AUTHOR_IMAGE_PATH_RE.test(parsed.pathname)) {
    errors.push('photo author.url must not point to an image file');
  }
  const allowedHosts = PHOTO_AUTHOR_HOSTS[record.provider];
  if (allowedHosts && !allowedHosts.includes(parsed.hostname.toLowerCase())) {
    errors.push(`${record.provider} author.url must use the ${record.provider} domain`);
  }
  return errors;
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

export function generatedImagePrefixForScope(scope) {
  if (scope === 'event-library') return '/images/events/library/';
  if (scope === 'editorial-profile') return '/images/authors/';
  if (scope === 'article-hero') return '/images/blog/';
  if (scope === 'place') return '/images/places/';
  return '/images/generated/';
}

export function generatedImagePathForScope(scope, assetId) {
  return `${generatedImagePrefixForScope(scope)}${assetId}.webp`;
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
  const kind = normalizeText(spec.kind || GENERATED_IMAGE_KIND).toLowerCase();
  if (![GENERATED_IMAGE_KIND, LICENSED_PHOTO_KIND].includes(kind)) {
    throw new Error(`Unsupported image kind: ${kind || '<empty>'}`);
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
    kind,
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
  const ratio = normalized.format.width / normalized.format.height;
  const composition = ratio > 1.3
    ? 'landscape'
    : ratio < 0.8
      ? 'portrait'
      : 'square';
  return [
    'Create one original editorial illustration for frontaliereticino.ch.',
    `Purpose: ${normalized.scope}.`,
    `Subject: ${normalized.subject}.`,
    `Area or visual context: ${normalized.area}.`,
    `Seasonal atmosphere: ${normalized.season}.`,
    `Composition: ${composition} ${normalized.format.width}x${normalized.format.height}, clear subject separation, calm editorial composition, no cropped focal subject at the edges.`,
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
  return typeof value === 'string' && /^\/images\/(?:events\/library|generated|blog|authors|places(?:\/thumbnails)?)\/[a-z0-9][a-z0-9._-]{2,127}\.webp$/.test(value);
}

export function isPrivateGrantImageRecord(record) {
  return isRecord(record) && record.license === PRIVATE_GRANT_LICENSE && record.provider === PRIVATE_GRANT_PROVIDER;
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
  const isPrivateGrant = record.license === PRIVATE_GRANT_LICENSE;
  const isPhoto = isLicensedPhotoRecord(record);
  if (record.kind !== undefined && ![GENERATED_IMAGE_KIND, LICENSED_PHOTO_KIND].includes(record.kind)) {
    errors.push('kind is not allowed');
  }
  if (isPrivateGrant) {
    if (record.provider !== PRIVATE_GRANT_PROVIDER) errors.push('private-grant provider must be site-owned');
    if (!nonEmpty(record.note)) errors.push('private-grant note is required');
    if (!nonEmpty(record.credit)) errors.push('private-grant credit is required');
    for (const field of ['model', 'executorModel', 'promptVersion', 'promptHash', 'licenseUrl', 'generatedAt', 'verifiedAt', 'restrictions', 'vision']) {
      if (record[field] !== undefined) errors.push(`private-grant must not declare generated field ${field}`);
    }
  } else if (isPhoto) {
    if (record.kind !== LICENSED_PHOTO_KIND) errors.push('licensed photo kind must be photo');
    if (!allowedPhotoLicense(record)) {
      errors.push('photo license is not allowed for the provider');
    }
    if (!allowedPhotoLicenseUrl(record)) errors.push('photo licenseUrl is not an allowed provider licence URL');
    if (record.provider === 'wikimedia' && !nonEmpty(record.licenseFamily)) {
      errors.push('wikimedia licenseFamily is required');
    }
    const pageUrl = record.sourcePageUrl || record.pageUrl;
    if (!/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(String(pageUrl || ''))
      && record.provider === 'wikimedia') {
      errors.push('wikimedia sourcePageUrl must be a Commons file page');
    }
    if (record.provider === 'pexels' && !/^https:\/\/www\.pexels\.com\/photo\//i.test(String(pageUrl || ''))) {
      errors.push('pexels sourcePageUrl must be a Pexels photo page');
    }
    if (record.provider === 'pixabay' && !/^https:\/\/pixabay\.com\/(?:photos|users)\//i.test(String(pageUrl || ''))) {
      errors.push('pixabay sourcePageUrl must be a Pixabay page');
    }
    if (!/^https:\/\//i.test(String(pageUrl || ''))) errors.push('photo sourcePageUrl must be https');
    if (!isRecord(record.author) || !nonEmpty(record.author.name)) errors.push('photo author.name is required');
    errors.push(...photoAuthorUrlErrors(record));
    if (!nonEmpty(record.credit)) errors.push('photo credit is required');
    if (!nonEmpty(record.copyrightNotice)) errors.push('photo copyrightNotice is required');
    if (!/^https:\/\//i.test(String(record.acquireLicensePage || ''))) errors.push('photo acquireLicensePage must be https');
    if (record.sourceImageUrl !== undefined && !/^https:\/\//i.test(String(record.sourceImageUrl))) {
      errors.push('photo sourceImageUrl must be https');
    }
  } else {
    if (record.kind !== undefined && record.kind !== GENERATED_IMAGE_KIND) errors.push('generated record kind must be generated');
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
  }
  if (!positiveInteger(record.width) || !positiveInteger(record.height)) errors.push('width/height must be positive integers');
  if (record.format !== 'webp') errors.push('format must be webp');
  if (!positiveInteger(record.bytes) || record.bytes > GENERATED_IMAGE_MAX_BYTES) errors.push('bytes exceed the WebP limit');
  if (!SHA256_RE.test(String(record.sha256 || ''))) errors.push('sha256 must be present');
  if (!isPrivateGrant && !isoDate(record.generatedAt)) errors.push('generatedAt must be an ISO UTC timestamp');
  if (!isPrivateGrant && !isoDate(record.verifiedAt)) errors.push('verifiedAt must be an ISO UTC timestamp');
  if (!GENERATED_IMAGE_SCOPES.includes(record.scope)) errors.push('scope is not allowed');
  if (record.scope === 'event-library') {
    for (const field of ['category', 'area', 'season', 'variant']) {
      if (!nonEmpty(record[field])) errors.push(`event-library ${field} is required`);
    }
  }
  if (!isPrivateGrant && !isPhoto && (!Array.isArray(record.restrictions) || !GENERATED_IMAGE_RESTRICTIONS.every((item) => record.restrictions.includes(item)))) {
    errors.push('restrictions do not contain the mandatory generated-image policy');
  }
  if (!isPrivateGrant && isPhoto && (!Array.isArray(record.restrictions) || !LICENSED_PHOTO_RESTRICTIONS.every((item) => record.restrictions.includes(item)))) {
    errors.push('restrictions do not contain the mandatory licensed-photo policy');
  }
  if (!isPrivateGrant && (!isRecord(record.vision)
    || record.vision.ok !== true
    || record.vision.contains_logo !== false
    || record.vision.contains_recognizable_face !== false
    || (isPhoto ? typeof record.vision.contains_text !== 'boolean' : record.vision.contains_text !== false)
    || (isPhoto ? typeof record.vision.looks_like_specific_real_event !== 'boolean' : record.vision.looks_like_specific_real_event !== false)
    || !nonEmpty(record.vision.notes))) {
    errors.push(isPhoto ? 'licensed-photo vision gate verdict is missing or rejected' : 'vision gate verdict is missing or rejected');
  }
  if (!isGeneratedImagePath(record.imageUrl)) errors.push('imageUrl must be a registered WebP path');
  const expectedPrefix = generatedImagePrefixForScope(record.scope);
  if (record.imageUrl && !record.imageUrl.startsWith(expectedPrefix)) errors.push('imageUrl does not match scope');
  if (record.imageUrl && generatedImageAssetIdFromPath(record.imageUrl) !== record.assetId) errors.push('imageUrl assetId mismatch');
  const ratio = record.width / record.height;
  const ratioValid = record.scope === 'editorial-profile'
    ? ratio >= 0.8 && ratio <= 1.25
    : ratio >= 1.6 && ratio <= 1.9;
  if (!ratioValid) errors.push('image aspect ratio is outside the editorial range');
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
 * image must point to one valid generated or licensed-photo record.
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
      const eventKindError = record
        && record.license !== GENERATED_IMAGE_LICENSE
        && !isLicensedPhotoRecord(record)
        ? ['event image must be generated or a licensed photo']
        : [];
      const photoPropagationErrors = record && isLicensedPhotoRecord(record)
        ? [
          event.imageAuthor?.name !== record.author?.name ? 'imageAuthor does not match registry' : '',
          event.imageSourcePageUrl !== (record.sourcePageUrl || record.pageUrl) ? 'imageSourcePageUrl does not match registry' : '',
          event.imageCopyrightNotice !== record.copyrightNotice ? 'imageCopyrightNotice does not match registry' : '',
          event.imageAcquireLicensePage !== record.acquireLicensePage ? 'imageAcquireLicensePage does not match registry' : '',
        ].filter(Boolean)
        : [];
      const propagationErrors = record
        ? [
          event.imageAssetId !== record.assetId ? 'imageAssetId does not match registry' : '',
          event.imageLicense !== record.license ? 'imageLicense does not match registry' : '',
          event.imageLicenseUrl !== record.licenseUrl ? 'imageLicenseUrl does not match registry' : '',
          event.imageCredit !== record.credit ? 'imageCredit does not match registry' : '',
          event.imageProvider !== record.provider ? 'imageProvider does not match registry' : '',
          ...photoPropagationErrors,
        ].filter(Boolean)
        : [];
      if (!record || eventScopeError.length || eventKindError.length || !validation.valid || propagationErrors.length) {
        errors.push(`${event.id || '<event>'}: generated image has no valid record (${[...(validation.errors || ['missing']), ...eventScopeError, ...eventKindError, ...propagationErrors].join(', ')})`);
      }
      continue;
    }
    const openAgenda = event.sourceKey === 'openagenda'
      && imageUrl.startsWith('/images/events/openagenda-')
      && nonEmpty(event.imageCredit)
      && /^https:\/\//i.test(String(event.imageLicenseUrl || ''))
      && nonEmpty(event.imageLicense);
    if (!openAgenda) {
      errors.push(`${event.id || '<event>'}: image URL is outside the allowed source set`);
    }
  }
  return { valid: errors.length === 0, errors };
}
