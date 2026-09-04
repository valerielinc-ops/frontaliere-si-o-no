import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * `scripts/ci/run-related-tests.mjs` è il selettore che il gate CI usa al posto
 * della suite intera, ed è la stessa ricetta che AGENTS.md prescrive prima di
 * aprire una PR. Ma un agente lavora in un worktree SPARSE, e lì costruire il
 * grafo di import inciampa su `services/blogArticleIds.ts`: è un symlink verso
 * `packages/articles/content/`, che il profilo sparse esclude, quindi il link
 * risolve nel vuoto — `ls` lo mostra e `readFileSync` lancia ENOENT.
 *
 * Prima della tolleranza il runner moriva con uno stack trace, il che lasciava
 * come unica opzione pre-PR la suite intera: in un worktree sparse sono 156
 * rossi ereditati e nessun verdetto. Questi casi difendono la tolleranza E il
 * suo limite: un errore che non sia ENOENT deve continuare a propagare, e lo
 * scarto non deve mai essere silenzioso.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/ci/run-related-tests.mjs'), 'utf-8');

describe('run-related-tests — il selettore sopravvive a un worktree sparse', () => {
  it('tollera solo ENOENT, e rilancia qualunque altro errore di lettura', () => {
    // La riga che conta: senza di essa un permesso negato o un EISDIR
    // verrebbero inghiottiti come «file assente» e il grafo sarebbe monco
    // senza che nessuno lo sappia.
    expect(SRC).toMatch(/if \(err\.code !== 'ENOENT'\) throw err;/);
  });

  it('non legge più il sorgente senza guardia', () => {
    // `readFileSync(file, 'utf8')` nudo dentro importsOf() è la regressione
    // esatta da impedire: è com'era, ed è quello che faceva morire il runner.
    const start = SRC.indexOf('function importsOf');
    expect(start).toBeGreaterThan(-1);
    const importsOf = SRC.slice(start, SRC.indexOf('\nfunction ', start + 1));
    expect(importsOf).toContain('try {');
    expect(importsOf).toMatch(/unreadable\.push\(file\)/);
  });

  it('lo scarto è rumoroso — un grafo monco non passa per un grafo completo', () => {
    // Una selezione più corta del dovuto è l'unico danno che questa tolleranza
    // può fare, quindi va detta a voce, sopra l'elenco dei test scelti.
    expect(SRC).toMatch(/unreadable\.length > 0/);
    expect(SRC).toContain('the selection may be incomplete');
  });

  it('su un checkout completo il comportamento è invariato', () => {
    // `unreadable` parte vuoto e si riempie solo dal ramo ENOENT: in CI, dove
    // l'albero è intero, nessun file è illeggibile e il runner seleziona
    // esattamente quello che selezionava prima.
    expect(SRC).toMatch(/const unreadable = \[\];/);
  });
});
