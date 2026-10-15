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

export function validatePublishedBlogImageEvidence(imageUrl, record) {
  const validation = validateGeneratedImageRecord(record);
  const errors = [...validation.errors];
  if (!PUBLISHED_BLOG_IMAGE_EVIDENCE_SCOPES.includes(record?.scope)) {
    errors.push(`scope is not ${PUBLISHED_BLOG_IMAGE_EVIDENCE_SCOPES.join(' or ')}`);
  }
  if (record?.imageUrl !== imageUrl) errors.push('imageUrl does not match the record key');
  return { valid: errors.length === 0, errors };
}
