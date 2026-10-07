import { describe, expect, it } from 'vitest';

import { chooseCorpusOverlayCommit } from '../scripts/lib/article-corpus-overlay.mjs';

const commit = 'a'.repeat(40);

describe('article corpus overlay revision gate', () => {
  it('accepts a readable manifest commit proven on corpus main and equal to the site copy', () => {
    expect(chooseCorpusOverlayCommit({
      manifest: { commit },
      corpusMainCommit: commit,
      manifestIsAncestorOfMain: true,
      contentMatchesSiteCopy: true,
    })).toEqual({ ok: true, commit });
  });

  it('refuses an unreadable manifest instead of falling back to corpus main', () => {
    const verdict = chooseCorpusOverlayCommit({
      manifest: null,
      corpusMainCommit: commit,
      manifestIsAncestorOfMain: true,
      contentMatchesSiteCopy: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/manifest\.json/);
  });

  it('refuses a manifest commit that is not proven on the current corpus main', () => {
    const verdict = chooseCorpusOverlayCommit({
      manifest: { commit },
      corpusMainCommit: 'b'.repeat(40),
      manifestIsAncestorOfMain: false,
      contentMatchesSiteCopy: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/antenato o uguale/);
  });

  it('refuses a manifest that cannot be proven at least as new as the site copy', () => {
    const verdict = chooseCorpusOverlayCommit({
      manifest: { commit },
      corpusMainCommit: commit,
      manifestIsAncestorOfMain: true,
      contentMatchesSiteCopy: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/copia del sito/);
  });
});
