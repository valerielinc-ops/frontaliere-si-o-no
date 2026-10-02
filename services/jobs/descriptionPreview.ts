import { decodeHtmlText } from '../../packages/articles/engine/shared/htmlEntities';
import { stripHtmlTags } from '../../packages/articles/engine/shared/htmlMarkup.mjs';
import { stripMarkdownMarkers } from './plainTextMarkdown';

/** One preview budget across active, archived and pre-hydration job pages. */
export const JOB_DESCRIPTION_PREVIEW_LENGTH = 220;

export function jobDescriptionPlainText(description: string): string {
  const text = stripHtmlTags(stripMarkdownMarkers(String(description ?? '')), '\n');
  return stripMarkdownMarkers(decodeHtmlText(text))
    .replace(/\s+/g, ' ')
    .trim();
}

export function jobDescriptionPreview(description: string): string {
  const text = jobDescriptionPlainText(description);
  return text.length > JOB_DESCRIPTION_PREVIEW_LENGTH
    ? `${text.slice(0, JOB_DESCRIPTION_PREVIEW_LENGTH).trimEnd()}…`
    : text;
}
