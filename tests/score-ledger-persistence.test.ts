/**
 * Il ledger dei punteggi perdeva i successi — gate sul gemello del sito.
 *
 * Il documento condiviso `ai_model_scores/_all` (Firestore, progetto
 * `frontaliere-ticino`) e' la memoria che `sortChainByScore()` usa per decidere
 * quale modello viene provato per primo, e lo scrivono i workflow di ENTRAMBI i
 * repo. Il 2026-08-18 diceva `claude-cli/haiku: score -3, successes 0,
 * failures 1` mentre la run 32134269129 gli aveva applicato 4 successi e 4
 * fallimenti. Due meccanismi indipendenti:
 *
 *  1. i contatori erano scritti come valori ASSOLUTI, quindi due processi che
 *     scrivevano lo stesso modello si cancellavano a vicenda (`{merge: true}`
 *     fonde campi diversi, non scrittori concorrenti sullo stesso campo);
 *  2. nessun percorso di uscita riuscito faceva il flush: `create-article.mjs`
 *     importava `flushScores` e non lo chiamava MAI, e i suoi `process.exit()`
 *     saltano `beforeExit`.
 *
 * La riproduzione in processo e le asserzioni funzionali stanno sul corpus
 * (`generator/tests/score-ledger-persistence.test.mjs`), dove `node --test`
 * puo' importare il modulo due volte senza il costo di vitest. Qui restano i
 * due gate di forma, che sono quelli che possono regredire in silenzio da
 * questo lato: sono scansioni di sorgente, quindi non toccano `data/` e
 * girano anche in un worktree sparse.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = join(process.cwd(), 'scripts');
const AI_MODELS = join(SCRIPTS_DIR, 'lib', 'ai-models.mjs');

describe('ledger dei punteggi: i due modi silenziosi di riaprire il buco', () => {
  it('chi importa il flush lo chiama', () => {
    // Il difetto originale in una riga: `scripts/create-article.mjs` importava
    // `flushScores` e non lo invocava mai. Un import inerte non fa fallire
    // niente — serve un guard esplicito.
    const offenders: string[] = [];
    const candidates = [
      ...readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f),
      // `scripts/lib/` va incluso: shared-jobs-crawler.mjs importa il flush da
      // li' dentro, ed e' proprio il punto cieco di una scansione che guarda
      // solo il livello superiore.
      ...readdirSync(join(SCRIPTS_DIR, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join('lib', f)),
    ];
    for (const name of candidates) {
      const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
      const imported = /import\s*\{[^}]*\bflush(Scores|ScoresBeforeExit)\b[^}]*\}\s*from\s*['"][^'"]*ai-models\.mjs['"]/.test(src);
      if (!imported) continue;
      const body = src.replace(/import\s*\{[^}]*\}\s*from[^\n]*\n/g, '');
      if (!/\bflushScores(BeforeExit)?\s*\(/.test(body)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('i contatori restano increment atomici, non totali assoluti', () => {
    const src = readFileSync(AI_MODELS, 'utf8');
    const persist = src.slice(src.indexOf('async function _persistScoresToFirestore'));
    const head = persist.slice(0, persist.indexOf('\n}\n'));
    expect(head).toMatch(/_firestoreFieldValue\.increment\(counterDelta\.successes\)/);
    expect(head).toMatch(/_firestoreFieldValue\.increment\(counterDelta\.failures\)/);
  });

  it('la riga `last-resort:` non cambia forma', () => {
    // Altri test cercano `<tier> N served/M failed` per sottostringa. La riga
    // nuova (`models:`) le sta SOTTO invece di alterarla.
    const src = readFileSync(AI_MODELS, 'utf8');
    const tierFn = src.slice(src.indexOf('function _formatLastResortTier'), src.indexOf('function _formatLastResortTier') + 600);
    expect(tierFn).toMatch(/\$\{t\.served\} served`, `\$\{t\.failed\} failed/);
    expect(src).toMatch(/lines\.push\(_formatRunOutcomesLine\(s\)\);/);
  });
});
