import {
  GENERATED_IMAGE_KIND,
  LICENSED_PHOTO_KIND,
} from './generatedImageRegistry.mjs';

/**
 * Pure vision contract shared by image generation and article-cover reuse.
 * Keep this module free of image processing and provider dependencies.
 */
export const VISION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    ok: Object.freeze({ type: 'boolean' }),
    contains_text: Object.freeze({ type: 'boolean' }),
    contains_logo: Object.freeze({ type: 'boolean' }),
    contains_recognizable_face: Object.freeze({ type: 'boolean' }),
    contains_recognizable_foreground_person: Object.freeze({ type: 'boolean' }),
    looks_like_specific_real_event: Object.freeze({ type: 'boolean' }),
    is_photograph: Object.freeze({ type: 'boolean' }),
    is_topic_relevant: Object.freeze({ type: 'boolean' }),
    notes: Object.freeze({ type: 'string' }),
  }),
  required: Object.freeze([
    'ok',
    'contains_text',
    'contains_logo',
    'contains_recognizable_face',
    'contains_recognizable_foreground_person',
    'looks_like_specific_real_event',
    'is_photograph',
    'is_topic_relevant',
    'notes',
  ]),
});

/** Validate the complete verifier schema at the publication boundary. */
export function isCompleteArticleHeroVisionVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return false;
  return VISION_SCHEMA.required.every((field) => (
    Object.hasOwn(verdict, field)
      && typeof verdict[field] === VISION_SCHEMA.properties[field].type
  ));
}

/** The publication verdict applies topic relevance to synthetic heroes too. */
export function imageVisionRejected(verdict, { kind = GENERATED_IMAGE_KIND, scope } = {}) {
  const articleHero = scope === 'article-hero';
  // The JSON schema is enforced by the primary verifier, but the Gemini
  // fallback is parsed from free-form text. Require the same complete verdict
  // at this shared policy boundary before any article hero can be published.
  if (articleHero && !isCompleteArticleHeroVisionVerdict(verdict)) return true;
  if (verdict?.ok !== true) return true;
  if (articleHero && verdict.is_topic_relevant !== true) return true;
  if (kind === LICENSED_PHOTO_KIND) {
    return !verdict.ok || verdict.is_photograph !== true || verdict.contains_logo || verdict.contains_recognizable_face
      || (articleHero && verdict.contains_recognizable_foreground_person !== false)
      || (articleHero && verdict.contains_text);
  }
  return verdict.contains_text !== false || verdict.contains_logo !== false || verdict.contains_recognizable_face !== false || verdict.looks_like_specific_real_event !== false;
}

const VISION_FAILURE_FLAG_NAMES = Object.freeze([
  'contains_text',
  'contains_logo',
  'contains_recognizable_face',
  'contains_recognizable_foreground_person',
  'looks_like_specific_real_event',
  'is_photograph',
  'is_topic_relevant',
]);

export function structuredVisionFailure(verdict) {
  return Object.fromEntries(VISION_FAILURE_FLAG_NAMES
    .filter((name) => typeof verdict?.[name] === 'boolean')
    .map((name) => [name, verdict[name]]));
}

/** Build the typed rejection consumed by the provider failure ledger. */
export function imageVisionRejectionError(verdict) {
  const error = new Error(`vision gate rejected image: ${String(verdict?.notes || 'forbidden content')}`);
  error.code = 'IMAGE_VISION_REJECTED';
  error.vision = structuredVisionFailure(verdict);
  return error;
}
