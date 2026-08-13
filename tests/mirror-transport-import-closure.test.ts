import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// `.mjs` senza tipi, come gli altri script di scripts/ci: l'import risolve,
// e nessuna direttiva serve a zittirlo (una `@ts-expect-error` inutilizzata e'
// essa stessa un errore TS2578).
import {
  relativeImportSpecifiers,
  resolveRelativeImport,
  undeclaredRelativeImports,
  parseTransportManifest,
  transportManifestPaths,
  readSiteText,
  siteFileExists,
  TRANSPORT_MANIFEST,
  CODE_EXTENSIONS,
} from '../scripts/ci/corpus-ahead-check.mjs';

/**
 * Un file che viaggia da solo non arriva.
 *
 * ## Il difetto, misurato
 *
 * `scripts/lib/meta-field-regex.mjs` e' `mode: identical` nel manifest del
 * ciclo (`scripts/ci/loop-sync-manifest.json`, sul corpus): la sorgente di
 * verita' e' questo repo, e il fixer del corpus lo copia di la' appena
 * `loop-drift-check.mjs` lo classifica `site-ahead`.
 *
 * Il 2026-08-13 la PR #5781 ha estratto `scripts/lib/unescape-ts-string.mjs` e
 * ha fatto in modo che `meta-field-regex.mjs` lo importi. Il file estratto non
 * esisteva sul corpus, non compariva nel suo manifest, e non era elencato in
 * `.github/transport/nanako-generator-manifest.txt`. Il fixer copia UN file —
 * quello nominato nel report — quindi l'import sarebbe rimasto insoddisfatto:
 * `ERR_MODULE_NOT_FOUND` in cima a `generator/scripts/create-article.mjs`
 * (riga 154, `import … from './lib/meta-field-regex.mjs'`), che e' il
 * generatore eseguito ogni 15 minuti. Con la CI verde da entrambi i lati.
 *
 * ## Perche' nessun guard esistente lo prendeva
 *
 * `tests/packages-articles-confinement.test.ts` prova via AST che
 * `packages/articles` non importa fuori da se': segue gli import di un file per
 * volta, e la domanda qui non e' «questo file importa fuori» ma «il file che
 * importa e il file importato viaggiano INSIEME». `loop-drift-check.mjs`
 * confronta i gemelli dichiarati uno per uno e dichiara il punto cieco: non
 * vede i file che un file allineato NOMINA. Questo e' la stessa classe col
 * segno invertito — un file allineato che IMPORTA un assente — ed e' per questo
 * che nessuno dei due lo vedeva.
 *
 * ## Cosa fissa questo test
 *
 * Una sola proprieta', sul manifest del transport, che e' l'elenco esplicito di
 * cio' che viene copiato sotto `generator/` sul corpus:
 *
 *   ogni import relativo di ogni file elencato risolve a un file che e' a sua
 *   volta ELENCATO, oppure dichiarato `# !rewired <path> -- <ragione>`.
 *
 * Offline e deterministico di proposito: e' l'unica forma che diventa rossa
 * nella PR che introduce il difetto, invece che nel run notturno del giorno
 * dopo o in nanako a runtime. Il gemello in rete c'e' comunque —
 * `scripts/ci/corpus-ahead-check.mjs` applica la stessa funzione al manifest
 * del corpus e riporta la classe `import-not-declared` nella issue giornaliera.
 *
 * L'header del transport manifest documenta gia' questo identico incidente
 * («those specifiers were never followed, so the first transport shipped code
 * that could not load: these are top-level `import`s, so create-article.mjs
 * threw before main() on every invocation in nanako»). La cura di allora fu
 * aggiungere i sei file mancanti. Aggiungere i file di allora chiude i file di
 * allora; questo test chiude la classe.
 */

const ROOT = path.resolve(__dirname, '..');
const manifestFile = path.join(ROOT, TRANSPORT_MANIFEST);

/**
 * Lettura sparse-immune, non `fs.existsSync`. Il manifest elenca tre file sotto
 * `data/`, che la ricetta dei worktree di CLAUDE.md non materializza: con il
 * solo filesystem questo test direbbe «tre voci stale» in locale e niente in
 * CI — il falso negativo che CLAUDE.md chiama «l'errore diagnostico piu' facile
 * da fare qui».
 */
const readSite = (rel: string): string | null => readSiteText(rel);
const existsSite = (rel: string): boolean => siteFileExists(rel);

describe('il manifest del transport e\' chiuso per import', () => {
  const text = fs.readFileSync(manifestFile, 'utf8');
  const { rewired } = parseTransportManifest(text);
  const delivered: string[] = transportManifestPaths(ROOT);

  it('ogni riga elencata esiste davvero', () => {
    // Stessa pretesa dello step "Resolve manifest" del workflow, ma qui e' rossa
    // in PR invece che a dispatch: una voce stale e' un restringimento silenzioso.
    const missing = delivered.filter((rel) => !existsSite(rel));
    expect(missing, `voci del manifest che non esistono:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('ogni import relativo di un file trasportato e\' elencato o `!rewired`', () => {
    const declared = new Set(delivered);
    const hazards = undeclaredRelativeImports({
      entries: delivered.map((rel) => ({ path: rel })),
      read: readSite,
      exists: existsSite,
      isDeclared: (rel: string) => declared.has(rel) || rewired.has(rel),
    });

    expect(
      hazards,
      `${hazards.length} import relativi di file trasportati puntano a file che il transport ` +
        'NON consegna e che nessuna riga `!rewired` dichiara. Sono `import` di primo livello: ' +
        'sul corpus diventano ERR_MODULE_NOT_FOUND prima di main(), con la CI verde di qua.\n' +
        'Aggiungi il file al manifest, oppure dichiaralo\n' +
        '  # !rewired <path> -- <perche\' nanako non ne ha bisogno>\n' +
        hazards.map((h: any) => `  ${h.from}  ->  ${h.spec}  (${h.target})`).join('\n'),
    ).toEqual([]);
  });

  it('il file che ha aperto questo buco viaggia — e il test cade se lo si toglie', () => {
    // L'asserzione che rende NON vacuo il test sopra. Toglierla lascerebbe la
    // chiusura verde per costruzione il giorno in cui qualcuno «semplifica» il
    // manifest togliendo la riga: la chiusura tornerebbe rossa, ma solo se
    // qualcuno la legge. Qui il nome del file e' scritto, e la ragione con lui.
    expect(
      delivered,
      'scripts/lib/unescape-ts-string.mjs e\' importato da quattro file gia\' nel manifest ' +
        '(meta-field-regex.mjs, create-article.mjs, batch-add-faq-to-articles.mjs, ' +
        'article-topic-selector.mjs). Toglierlo rimette il generatore del corpus in ' +
        'ERR_MODULE_NOT_FOUND.',
    ).toContain('scripts/lib/unescape-ts-string.mjs');
  });

  it('ogni `!rewired` porta una ragione, e riguarda un file che esiste', () => {
    // Una direttiva senza ragione e' la prosa di prima con una sintassi in piu';
    // una che nomina un file inesistente e' una scusa scaduta che nessuno nota.
    for (const [target, reason] of rewired) {
      expect(existsSite(target), `\`!rewired ${target}\` nomina un file che non esiste`).toBe(true);
      expect(reason.length, `\`!rewired ${target}\` senza ragione scritta`).toBeGreaterThan(40);
    }
    expect(rewired.size).toBeGreaterThan(0);
  });

  it('nessun `!rewired` copre un file che il manifest consegna gia\'', () => {
    // Le due liste devono restare disgiunte: un path in entrambe rende
    // indecidibile quale delle due vince, e la chiusura passerebbe comunque.
    const both = [...rewired.keys()].filter((rel) => delivered.includes(rel));
    expect(both, `dichiarati !rewired ma anche elencati: ${both.join(', ')}`).toEqual([]);
  });
});

describe('le primitive della chiusura, per costruzione', () => {
  it('riconosce le quattro forme di import relativo, e ignora i bare specifier', () => {
    const src = [
      "import a from './a.mjs';",
      "import './side-effect.mjs';",
      "export { b } from '../b.mjs';",
      "const c = await import('./c.mjs');",
      "const d = require('../d.cjs');",
      "import fs from 'node:fs';",
      "import x from 'vitest';",
    ].join('\n');
    expect(relativeImportSpecifiers(src)).toEqual([
      './a.mjs',
      './side-effect.mjs',
      '../b.mjs',
      './c.mjs',
      '../d.cjs',
    ]);
  });

  it('risolve contro la cartella di chi importa, e null se il file non esiste', () => {
    const exists = (rel: string) => rel === 'scripts/lib/unescape-ts-string.mjs';
    expect(resolveRelativeImport('scripts/lib/meta-field-regex.mjs', './unescape-ts-string.mjs', exists))
      .toBe('scripts/lib/unescape-ts-string.mjs');
    expect(resolveRelativeImport('scripts/create-article.mjs', './lib/unescape-ts-string.mjs', exists))
      .toBe('scripts/lib/unescape-ts-string.mjs');
    // Un import che non risolve nemmeno qui e' un difetto DIVERSO: non va
    // attribuito alla chiusura, o il report smette di essere leggibile.
    expect(resolveRelativeImport('scripts/lib/x.mjs', './mai-esistito.mjs', exists)).toBeNull();
  });

  it('il caso #5781 in miniatura: dichiarato l\'importatore, non l\'importato', () => {
    const files: Record<string, string> = {
      'scripts/lib/meta-field-regex.mjs': "import { u } from './unescape-ts-string.mjs';",
      'scripts/lib/unescape-ts-string.mjs': 'export const u = 1;',
    };
    const read = (rel: string) => files[rel] ?? null;
    const entries = [{ path: 'scripts/lib/meta-field-regex.mjs', mode: 'identical' }];

    const withoutTarget = undeclaredRelativeImports({
      entries,
      read,
      isDeclared: (rel: string) => rel === 'scripts/lib/meta-field-regex.mjs',
    });
    expect(withoutTarget).toHaveLength(1);
    expect(withoutTarget[0]).toMatchObject({
      from: 'scripts/lib/meta-field-regex.mjs',
      spec: './unescape-ts-string.mjs',
      target: 'scripts/lib/unescape-ts-string.mjs',
      mode: 'identical',
    });

    // …e sparisce appena l'importato e' dichiarato anche lui. E' questa meta' a
    // provare che il guard misura la DICHIARAZIONE e non l'esistenza del file.
    expect(undeclaredRelativeImports({ entries, read, isDeclared: () => true })).toEqual([]);
  });

  it('non scandisce i non-sorgenti (JSON, asset) e sopravvive a un file assente', () => {
    expect(CODE_EXTENSIONS.has('.json')).toBe(false);
    const read = (rel: string) => (rel === 'x.mjs' ? "import './y.mjs';" : null);
    // `data/borderCrossings.ts` importa un .json: il target non e' un sorgente
    // ma la voce SI', quindi resta scandita — cio' che non deve succedere e'
    // che una voce assente faccia esplodere il guard.
    expect(undeclaredRelativeImports({ entries: [{ path: 'assente.mjs' }], read, isDeclared: () => false })).toEqual([]);
    expect(undeclaredRelativeImports({ entries: [{ path: 'dati.json' }], read, isDeclared: () => false })).toEqual([]);
  });
});
