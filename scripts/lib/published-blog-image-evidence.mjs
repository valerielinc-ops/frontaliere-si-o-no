/**
 * Validation policy for the generated map in the corpus' reader-facing blog
 * image-credit aggregate.
 *
 * The aggregate is broader than the site's article-hero registry: the corpus
 * publisher intentionally includes the site-owned static outage fallback
 * `/images/places/lugano-view.webp` with schema scope `place`. The shared
 * generated-image validator proves the scope/path pair; every other scope is
 * still rejected by this consumer policy.
 */
import { validateGeneratedImageRecord } from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';

export const PUBLISHED_BLOG_IMAGE_EVIDENCE_SCOPES = Object.freeze(['article-hero', 'place']);
export const DETERMINISTIC_CARD_SOURCE = 'deterministic-card';
export const DETERMINISTIC_CARD_PROVIDER = 'site-owned';
export const DETERMINISTIC_CARD_LICENSE = 'private-grant';
export const DETERMINISTIC_CARD_PRODUCER = 'generator/scripts/lib/daily-brief-image.mjs';
export const DETERMINISTIC_CARD_TEMPLATE_VERSION = 'frontaliereticino.daily-brief-card.v1';

/**
 * The corpus' daily brief cards are site-owned bytes, not provider-generated
 * credits. Keep the predicate strict: a generic private-grant record must not
 * silently acquire deterministic-card semantics at the site boundary.
 */
export function isPublishedDeterministicCardRecord(record) {
  return record?.source === DETERMINISTIC_CARD_SOURCE
    && record?.provider === DETERMINISTIC_CARD_PROVIDER
    && record?.license === DETERMINISTIC_CARD_LICENSE
    && record?.producer === DETERMINISTIC_CARD_PRODUCER
    && record?.templateVersion === DETERMINISTIC_CARD_TEMPLATE_VERSION;
}

export function validatePublishedBlogImageEvidence(imageUrl, record) {
  const validation = validateGeneratedImageRecord(record);
  const errors = [...validation.errors];
  if (!PUBLISHED_BLOG_IMAGE_EVIDENCE_SCOPES.includes(record?.scope)) {
    errors.push(`scope is not ${PUBLISHED_BLOG_IMAGE_EVIDENCE_SCOPES.join(' or ')}`);
  }
  if (record?.imageUrl !== imageUrl) errors.push('imageUrl does not match the record key');
  return { valid: errors.length === 0, errors };
}
