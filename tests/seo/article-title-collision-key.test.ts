import { describe, expect, it } from 'vitest';
import {
  buildArticleTitleCollisionKey,
  countArticlesByTitleKey,
} from '@/packages/articles/engine/ogPagesPlugin';
import {
  buildTitleWithBrand,
  TITLE_BRAND_SUFFIX,
  TITLE_MAX_CHARS,
  truncateHeadlineToMeasuredBudget,
} from '@/build-plugins/shared/titleSuffix';

const TITLE_COLLISION_OPTIONS = {
  buildTitleWithBrand,
  truncateHeadlineToMeasuredBudget,
  titleBrandSuffix: TITLE_BRAND_SUFFIX,
  titleMaxChars: TITLE_MAX_CHARS,
};

describe('article title collision keys', () => {
  it('uses the same bounded output for distinct overlong headlines', () => {
    const sharedPrefix =
      'Guida completa per lavoratori frontalieri tra Italia e Svizzera con informazioni fiscali dettagliate';
    const first = `${sharedPrefix} per Lugano`;
    const second = `${sharedPrefix} per Como`;

    const firstKey = buildArticleTitleCollisionKey(first, TITLE_COLLISION_OPTIONS);
    const secondKey = buildArticleTitleCollisionKey(second, TITLE_COLLISION_OPTIONS);

    expect(firstKey).toBe(secondKey);
    expect(firstKey.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('makes the renderer count bounded title collisions', () => {
    const sharedPrefix =
      'Guida completa per lavoratori frontalieri tra Italia e Svizzera con informazioni fiscali dettagliate';
    const entries = [
      { articleId: 'lugano', title: `${sharedPrefix} per Lugano` },
      { articleId: 'como', title: `${sharedPrefix} per Como` },
    ];

    const collisions = countArticlesByTitleKey(
      entries,
      (entry) => buildArticleTitleCollisionKey(entry.title, TITLE_COLLISION_OPTIONS),
    );
    const key = buildArticleTitleCollisionKey(entries[0].title, TITLE_COLLISION_OPTIONS);

    expect(collisions.get(key)).toBe(2);
  });
});
