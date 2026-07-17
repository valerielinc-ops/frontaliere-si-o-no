/**
 * Live incident (2026-07-16): journalist Samuele Valente reported his
 * published articles showed "Marco Ferrari" as the author instead of him.
 * Root cause: processDoc() in scripts/publish-journalist-article.mjs called
 * pickAuthorForTopic() unconditionally — the same topic-keyword scorer used
 * for AI-generated content, which has no real author. For a journalist
 * submission the doc already carries a real, authenticated identity
 * (doc.authorUid/authorName, captured at draft time by
 * JournalistDashboardPage.tsx -> journalistArticleService.ts) but that
 * identity was discarded in favor of a keyword-match guess, silently handing
 * the byline to whichever registry author's expertise happened to overlap
 * the article's topic.
 *
 * This mirrors a prior, narrower fix (2026-06-30, samuele-valente missing
 * from the create-article.mjs AUTHORS mirror — see
 * tests/create-article-author-registry.test.ts) that only made the guest
 * author *selectable* by the topic scorer; it did not stop the scorer from
 * being used for real human submissions at all, so the same class of bug
 * recurred. resolveJournalistAuthor() removes the topic scorer from the
 * journalist-publish path entirely except as a last resort for docs with no
 * identity at all.
 */
import { describe, expect, it } from 'vitest';
import { resolveJournalistAuthor } from '../scripts/publish-journalist-article.mjs';

const SAMUELE_UID = 'rAaDN0AvhkUjvRxN2TJijgYodm22';

describe('resolveJournalistAuthor — trusts the submitting journalist identity over topic guessing', () => {
  it('resolves a registered guest author by uid, regardless of article topic', () => {
    const doc = {
      authorUid: SAMUELE_UID,
      authorName: 'Samuele Valente',
      authorEmail: 'samuelevalente96@gmail.com',
    };
    const resolved = resolveJournalistAuthor(doc);
    expect(resolved).not.toBeNull();
    expect(resolved.slug).toBe('samuele-valente');
    expect(resolved.name).toBe('Samuele Valente');
  });

  it('never falls through to a different registry author when the uid matches', () => {
    // Even a doc whose title/category would keyword-match a different
    // registry author entirely (pensions is laura-bianchi's specialty) must
    // still resolve to the actual submitting journalist.
    const doc = { authorUid: SAMUELE_UID, authorName: 'Samuele Valente' };
    const resolved = resolveJournalistAuthor(doc);
    expect(resolved.slug).toBe('samuele-valente');
  });

  it('trusts doc.authorName for an authenticated journalist not yet in the author registry', () => {
    const doc = { authorUid: 'some-future-journalist-uid-not-registered', authorName: 'Nuova Firma' };
    const resolved = resolveJournalistAuthor(doc);
    expect(resolved).toEqual({ slug: 'redazione', name: 'Nuova Firma', linkedinUrl: null });
  });

  it('returns null (caller falls back to pickAuthorForTopic) when the doc has no identity at all', () => {
    const doc = { category: 'novita' };
    expect(resolveJournalistAuthor(doc)).toBeNull();
  });

  it('returns null for an undefined doc without throwing', () => {
    expect(resolveJournalistAuthor(undefined)).toBeNull();
  });
});
