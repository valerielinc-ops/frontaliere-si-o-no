/**
 * Regression test for the sibling qualityReject-tagging in
 * scripts/create-article.mjs (fix/issue-3598, PR #3611 review round 2).
 *
 * PR #3611 tagged callLLM's two body2-validation throws with
 * `qualityReject = true`, but the reviewer flagged the same content-quality
 * class (malformed/incomplete AI response) left untagged elsewhere in the
 * identical catch chain (callGemini -> generateAndValidateArticle ->
 * proven-pool / evergreen / manual-URL): validateItalianPayload's
 * missing-field throw, callGemini's parse-retry-exhausted and
 * content.it-missing throws, every throw in validate() (data/content/title/id
 * /slug/field checks), and translateArticle's JSON-parse-exhausted throw.
 * None of these messages match isQualityRejectError()'s recognition regex, so
 * untagged they crash the whole run instead of skipping to the next headline
 * — the exact bug PR #3611 fixed for callLLM. This test locks all of them to
 * the tagged form so none can silently regress.
 *
 * Deliberately NOT tagged (left as a hard-fail by design, confirmed by intent
 * comments in the source): translateArticle's "assente anche nella sorgente
 * IT" throw (guards a real upstream defect, not a per-headline AI-quality
 * issue) and the DUPLICATO/assumed-invariant assertions elsewhere in the
 * file — different semantic class, out of scope here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '..', '..', 'scripts/create-article.mjs'),
  'utf8',
);

function expectTagged(messageFragment: string) {
  const escaped = messageFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}[\\s\\S]{0,20}\`?\\);[\\s\\S]{0,120}err\\.qualityReject = true;\\s*throw err;`);
  expect(SRC, `expected "${messageFragment}" throw site to tag err.qualityReject = true`).toMatch(pattern);
}

describe('create-article.mjs content-quality throw sites tag qualityReject', () => {
  it('validateItalianPayload: missing-field throw', () => {
    expectTagged('Campo ${field} mancante per ${locale}');
  });

  it('callGemini: parse-retry-exhausted throw', () => {
    expectTagged('JSON non valido dalla generazione IT: ${parseErr.message}');
  });

  it('callGemini: content.it-missing throw', () => {
    expectTagged("Risposta IT non contiene content.it e non può essere normalizzata");
  });

  it('translateArticle: translation JSON-parse-exhausted throw', () => {
    expectTagged('JSON non valido dalla traduzione ${label}: ${retry2Err.message}');
  });

  it('validate(): all data/content/title/id/slug/field throws', () => {
    expectTagged('Campo mancante nella risposta AI: data (non è un oggetto)');
    expectTagged('Campo mancante nella risposta AI: content`');
    expectTagged('Campo mancante nella risposta AI: content.it.title');
    expectTagged('Campo mancante nella risposta AI: id (impossibile sintetizzare dal titolo "${itContent.title}")');
    expectTagged('Contenuto mancante per ${locale}');
    expectTagged('Slug mancante per ${locale} e titolo non utilizzabile per fallback');
  });

  it('validate(): both duplicate "Slug mancante per ${locale}" sites (it-loop + en/de/fr-loop) tag qualityReject', () => {
    const matches = [
      ...SRC.matchAll(/Slug mancante per \$\{locale\}`\);[\s\S]{0,80}err\.qualityReject = true;\s*throw err;/g),
    ];
    expect(matches.length).toBe(2);
  });

  it('validate(): the localized-field-missing throw (inside the it-locale loop) tags qualityReject', () => {
    expect(SRC).toMatch(
      /Campo \$\{field\} mancante per \$\{locale\}`\);\s*\n\s*err\.qualityReject = true;\s*throw err;\s*\n\s*\}\s*\n\s*\}\s*\n\s*\}/,
    );
  });

  it('deliberately leaves the translation-source-defect throw untagged (different semantic class)', () => {
    expect(SRC).toMatch(
      /throw new Error\(`Campo \$\{field\} mancante nella traduzione \$\{locale\} \(e assente anche nella sorgente IT\)`\);/,
    );
  });
});
