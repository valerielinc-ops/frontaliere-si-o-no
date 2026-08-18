import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  listCorpusWideTests,
  listNonCorpusWideTests,
  corpusWideRegistry,
  corpusWideSeconds,
  blockingTestsFor,
  skippableTestsFor,
  parseCorpusSkipList,
} from '../scripts/ci/corpus-wide-tests.mjs';

/**
 * L'OSSERVATORE dello split corpus-wide.
 *
 * Il meccanismo che questo test sorveglia toglie 7 file di test dal job
 * bloccante `vitest (unit + integration)` e li fa girare altrove. Fatto bene è
 * una ricollocazione; fatto male è una cancellazione con un nome gentile. La
 * differenza sta tutta in invarianti che nessuno può verificare a occhio, e
 * ognuna di esse, se salta, salta IN SILENZIO — un gate che non gira non
 * diventa rosso, sparisce.
 *
 * Le quattro forme di guasto che questo file rende impossibili:
 *
 *   1. REGISTRO CHE NOMINA UN FANTASMA. Un test rinominato o cancellato lascia
 *      nel registro un path che non esiste. L'esclusione non esclude niente,
 *      il gruppo `only` non lo raccoglie, e il gate non gira NÉ sulla PR NÉ su
 *      main. È il caso peggiore: sembra coperto due volte, non lo è nessuna.
 *
 *   2. PARTIZIONE BUCATA. `only` gira il complemento del registro. Se registro
 *      e complemento non coprono esattamente la suite, un file cade fra i due
 *      e smette di girare ovunque.
 *
 *   3. `watch` MORTO. Una radice dati rinominata (`services/locales/blog-body`
 *      che diventa altro) lascia un prefisso che non matcha più niente: il
 *      trigger «resta bloccante se il diff tocca il corpus» non scatta mai
 *      più, e i gate diventano solo-post-merge senza che nessuno l'abbia
 *      deciso. È la forma di #5470: un contratto che non ha forma di import,
 *      quindi invisibile ai guard che seguono gli import.
 *
 *   4. LA ENV COME GRIMALDELLO. `VITEST_CORPUS_SKIP` arriva da un `env:` di
 *      workflow. Se accettasse path arbitrari sarebbe una leva per spegnere
 *      qualunque test senza toccare un file di test — Non-Negotiable #1 aggirato
 *      da una riga di YAML.
 */

const ROOT = path.resolve(__dirname, '..');

/**
 * Esiste, dal punto di vista del REPO e non del checkout corrente.
 *
 * I worktree degli agent sono sparse (`public/`, `data/` e
 * `packages/articles/content/` non materializzati, vedi
 * docs/LOCAL-DEV.md#sparse-worktrees): un controllo di sola `fs.existsSync`
 * sarebbe rosso in locale e verde in CI, cioè un test che mente a chi lavora.
 * Il fallback su `git ls-files` legge l'INDEX, che in sparse-checkout contiene
 * comunque tutti i path tracciati.
 *
 * `lstatSync` e non `existsSync`, e la differenza NON è cosmetica:
 * `services/locales/blog-body` e `blog-body-ch` sono SYMLINK dentro
 * `packages/articles/content` (i due corpora sono uno solo sul disco).
 * `existsSync` segue il link, e in un worktree sparse il bersaglio non è
 * materializzato → risponderebbe «non esiste» per due radici dati che
 * esistono benissimo. Per la stessa ragione lo slash finale va tolto anche dal
 * pathspec di git: git traccia il symlink come un FILE, e `ls-files -- <dir>/`
 * non lo troverebbe.
 */
function trackedPathExists(rel: string): boolean {
  const stripped = rel.replace(/\/$/, '');
  try {
    fs.lstatSync(path.join(ROOT, stripped));
    return true;
  } catch {
    /* non materializzato: chiedi all'index */
  }
  for (const spec of [rel, stripped]) {
    try {
      const out = execFileSync('git', ['ls-files', '-z', '--', spec], {
        cwd: ROOT,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (out.length > 0) return true;
    } catch {
      /* prossimo pathspec */
    }
  }
  return false;
}

describe('registro dei gate corpus-wide (split del cammino bloccante)', () => {
  const corpus = listCorpusWideTests();
  const rest = listNonCorpusWideTests();

  it('ogni file del registro esiste davvero', () => {
    // Guasto 1. Un path fantasma non esclude niente e non viene raccolto da
    // nessun gruppo: il gate smette di girare ovunque, in silenzio.
    const missing = corpus.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(missing).toEqual([]);
  });

  it('è disgiunto dal complemento e insieme coprono tutta la suite', () => {
    // Guasto 2. `VITEST_CORPUS_GROUP=only` esclude `rest`: se `corpus ∪ rest`
    // non fosse la suite intera, i file mancanti non girerebbero né nel job
    // della PR né nella run post-merge.
    const inCorpus = new Set(corpus);
    expect(rest.filter((f) => inCorpus.has(f))).toEqual([]);
    expect(new Set([...corpus, ...rest]).size).toBe(corpus.length + rest.length);
    expect(corpus.length).toBeGreaterThan(0);
    // Un registro che ingrassasse fino a contenere mezza suite renderebbe la
    // run post-merge lunga quanto quella che ha sostituito, e il job bloccante
    // cieco su metà del repo. Il registro è per i gate O(corpus), non è un
    // parcheggio per i test scomodi.
    expect(corpus.length).toBeLessThan(25);
    expect(rest.length).toBeGreaterThan(corpus.length * 50);
  });

  it('ogni radice dati sorvegliata corrisponde a path tracciati', () => {
    // Guasto 3. Un `watch` che non matcha più niente disarma il trigger che
    // tiene questi gate bloccanti sulle PR che toccano davvero il corpus.
    const dead: string[] = [];
    for (const entry of corpusWideRegistry()) {
      expect(entry.watch.length).toBeGreaterThan(0);
      for (const w of entry.watch) {
        if (!trackedPathExists(w)) dead.push(`${entry.file} → ${w}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('nessuna radice sorvegliata passa da un symlink', () => {
    // LA REGRESSIONE CHE HA TROVATO LA REVIEW su questa stessa PR.
    //
    // `services/locales/blog-body` e `blog-body-ch` sono symlink dentro
    // `packages/articles/content/` — git li traccia come UN file, mode 120000.
    // Un `watch` che li nomina non matcha MAI un diff vero, perché sia
    // `git diff --name-only` sia l'API della PR riportano il path reale
    // (`packages/articles/content/blog-body…`), mai l'alias. La prima stesura
    // del registro sorvegliava l'alias per `blog-body-typescript-syntax`: il
    // gate nato per l'apostrofo non escapato del 2026-07-29 non poteva restare
    // bloccante sulla PR che porta quell'apostrofo.
    //
    // Il controllo di esistenza qui sopra NON bastava — l'alias esiste
    // eccome. Serve questo, che guarda il MODO e non la presenza.
    const viaSymlink: string[] = [];
    for (const entry of corpusWideRegistry()) {
      for (const w of entry.watch) {
        const stripped = w.replace(/\/$/, '');
        let out = '';
        try {
          out = execFileSync('git', ['ls-files', '-s', '--', stripped], {
            cwd: ROOT,
            encoding: 'utf-8',
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch {
          continue;
        }
        // `ls-files -s -- <dir>` elenca OGNI file sotto la directory, quindi
        // guardare la prima riga direbbe «symlink» per `services/locales/` solo
        // perché il primo figlio in ordine è `blog-body`. Symlink è il path
        // sorvegliato, non un suo discendente: cerco la riga il cui NOME è
        // esattamente `stripped`.
        const self = out
          .split('\n')
          .find((line) => line.endsWith(`\t${stripped}`));
        if (self && self.startsWith('120000')) viaSymlink.push(`${entry.file} → ${w}`);
      }
    }
    expect(viaSymlink).toEqual([]);
  });

  it('la misura dichiarata è presente e plausibile per ogni voce', () => {
    // Il registro giustifica la propria esistenza con una cifra misurata. Una
    // voce senza misura è una voce che nessuno può contestare, e fra un anno
    // nessuno saprà se vale ancora il meccanismo.
    for (const entry of corpusWideRegistry()) {
      expect(entry.seconds, entry.file).toBeGreaterThan(5);
    }
    expect(corpusWideSeconds()).toBeGreaterThan(150);
  });

  describe('decisione per-test sul diff della PR', () => {
    it('un diff che non tocca il corpus non tiene bloccante nessuno', () => {
      expect(blockingTestsFor(['components/Header.tsx', 'README.md'])).toEqual([]);
      expect(skippableTestsFor(['components/Header.tsx'])).toEqual(corpus);
    });

    it('un diff sul corpus articoli li tiene bloccanti', () => {
      // Questo è il punto 3 del mandato: quando il diff tocca il corpus, questi
      // gate sono ESATTAMENTE quelli che devono bloccare, e lo fanno.
      const blocking = blockingTestsFor(['packages/articles/content/it/qualunque.ts']);
      expect(blocking).toContain('tests/generated-content-parses.test.ts');
      expect(blocking).toContain('tests/article-hero-image-integrity.test.ts');
      expect(blocking).toContain('tests/render-article-pages-single-vs-full.test.ts');
    });

    it('un diff su un BODY del corpus tiene bloccante il gate di sintassi', () => {
      // Il path e' quello REALE con cui un body arriva in un diff. La prima
      // stesura sorvegliava l'alias symlink `services/locales/blog-body/` e
      // questa asserzione sarebbe fallita: e' il caso d'uso primario del gate
      // (l'apostrofo non escapato del 2026-07-29 e' atterrato esattamente come
      // `packages/articles/content/blog-body-ch/fr/<slug>.ts`).
      const blocking = blockingTestsFor([
        'packages/articles/content/blog-body-ch/fr/frontaliere-insegnante-scuola-ticino.ts',
      ]);
      expect(blocking).toContain('tests/blog-body-typescript-syntax.test.ts');
      expect(blockingTestsFor(['packages/articles/content/blog-body/it/x.ts'])).toContain(
        'tests/blog-body-typescript-syntax.test.ts',
      );
    });

    it('un diff sul renderer li tiene bloccanti via chiusura degli import', () => {
      // Non è una lista scritta a mano: `build-plugins/ogPagesPlugin.ts` non
      // compare in nessun `watch`. Ci arriva perché i due test lo importano —
      // così un import nuovo si porta dietro il trigger da solo.
      const blocking = blockingTestsFor(['build-plugins/ogPagesPlugin.ts']);
      expect(blocking).toContain('tests/article-hero-image-integrity.test.ts');
      expect(blocking).toContain('tests/render-article-pages-single-vs-full.test.ts');
    });

    it('la decisione è mirata: un diff sui job non risveglia i gate articoli', () => {
      // Il caso più frequente del repo — i crawler committano slice decine di
      // volte al giorno. Un flag unico «tocca il corpus» rimetterebbe in gioco
      // 201s per un gate che ne vale 16,7.
      expect(blockingTestsFor(['data/jobs/by-crawler/coop.json'])).toEqual([
        'tests/job-locale-consistency.test.ts',
      ]);
    });

    it('modificare un gate lo rende bloccante sulla sua stessa PR', () => {
      // Chi cambia un gate deve vederlo girare PRIMA del merge. Senza questo,
      // una modifica a uno di questi sette file verrebbe validata solo dopo.
      const self = 'tests/blog-body-typescript-syntax.test.ts';
      expect(blockingTestsFor([self])).toContain(self);
    });

    it('blocking e skippable sono sempre complementari sul registro', () => {
      for (const diff of [
        [],
        ['components/Header.tsx'],
        ['packages/articles/content/it/x.ts'],
        ['data/jobs/by-crawler/coop.json'],
        ['build-plugins/seoHubsPlugin.ts', 'README.md'],
      ]) {
        const union = [...blockingTestsFor(diff), ...skippableTestsFor(diff)].sort();
        expect(union, `diff: ${JSON.stringify(diff)}`).toEqual(corpus);
      }
    });
  });

  it('VITEST_CORPUS_SKIP non può spegnere un test fuori dal registro', () => {
    // Guasto 4. La env arriva da un `env:` di workflow: se accettasse path
    // arbitrari sarebbe una leva per disattivare qualunque gate senza toccare
    // un file di test.
    expect(parseCorpusSkipList('tests/seo-completeness.test.ts')).toEqual([]);
    expect(parseCorpusSkipList('tests/** tests/*.test.ts .')).toEqual([]);
    expect(parseCorpusSkipList('tests/blog-body-typescript-syntax.test.ts')).toEqual([
      'tests/blog-body-typescript-syntax.test.ts',
    ]);
    // Valore assente/vuoto = nessuna esclusione: il default è la suite intera.
    expect(parseCorpusSkipList(undefined)).toEqual([]);
    expect(parseCorpusSkipList('')).toEqual([]);
  });

  it('il workflow post-merge esiste e gira il gruppo corpus', () => {
    // L'altra metà della ricollocazione. Se questo file sparisse, lo split
    // diventerebbe una rimozione: i sette gate uscirebbero dal job bloccante e
    // non entrerebbero da nessuna parte. Il test lega le due metà, che
    // altrimenti sono legate solo da un commento.
    const wf = path.join(ROOT, '.github', 'workflows', 'corpus-wide-gates.yml');
    expect(fs.existsSync(wf)).toBe(true);
    const src = fs.readFileSync(wf, 'utf-8');
    expect(src).toContain('VITEST_CORPUS_GROUP: only');
    // E la metà che rende lo spostamento osservabile: senza reporter, un gate
    // post-merge rosso non lo guarda nessuno.
    expect(src).toContain('report-failure');
  });
});
