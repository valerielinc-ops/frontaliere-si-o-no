import { parseStaticArticleTranslationEntries } from '../../packages/articles/engine/shared/articleStaticSource.mjs';
import { repairLegacyDoubleEscapedBreaks } from '../../scripts/lib/unescape-ts-string.mjs';

export type StaticArticleBodyPreview = Partial<Record<'body1' | 'body2' | 'body3', string>>;

/**
 * Read the body fields that feed the static article preview and placeholder
 * robots decision. The source must be one complete static locale module; a
 * malformed present file fails the build instead of silently disappearing
 * from the indexability check.
 */
export function parseStaticArticleBodyPreviews(
  source: string,
  sourcePath: string,
): Record<string, StaticArticleBodyPreview> {
  const previews = Object.create(null) as Record<string, StaticArticleBodyPreview>;

  for (const { articleId, field, value } of parseStaticArticleTranslationEntries(source, sourcePath)) {
    if (field !== 'body1' && field !== 'body2' && field !== 'body3') continue;

    // TypeScript has already decoded the literal once. Keep this caller's
    // historical single-line preview contract: CR is dropped, LF and tabs
    // become spaces, and residual legacy `\\n` text is repaired to a space.
    const preview = repairLegacyDoubleEscapedBreaks(
      value.replace(/\r/gu, '').replace(/[\n\t]/gu, ' '),
      ' ',
    );
    (previews[articleId] ??= Object.create(null))[field] = preview;
  }

  return previews;
}
