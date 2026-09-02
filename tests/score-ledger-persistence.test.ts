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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as aiModels from '../scripts/lib/ai-models.mjs';

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

  it('anche il percorso di FALLIMENTO flusha, non solo quello riuscito', () => {
    // Il gate «chi importa il flush lo chiama» qui sopra passa in modo VACUO
    // per un file che flusha in fondo a main() e poi esce da un catch con
    // `process.exit(1)`: la chiamata c'e', ma sul ramo sbagliato. E' esattamente
    // la forma in cui il difetto e' sopravvissuto in
    // `scripts/lib/shared-jobs-crawler.mjs` e `scripts/generate-company-parser.mjs`
    // mentre veniva rimosso da `create-article.mjs`.
    //
    // `process.exit()` salta `beforeExit`, quindi un handler di uscita che
    // chiama `process.exit` senza aver prima atteso un flush perde ogni delta
    // non ancora persistito — e sul ramo di errore quei delta sono per lo piu'
    // fallimenti, cioe' proprio il segnale che al ledger serve.
    const offenders: string[] = [];
    for (const name of ledgerScripts()) {
      const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
      for (const handler of catchHandlers(src).map(stripComments)) {
        if (!/\bprocess\.exit\s*\(/.test(handler)) continue;
        if (/\bflushScores(BeforeExit)?\s*\(/.test(handler)) continue;
        offenders.push(name);
        break;
      }
    }
    expect(offenders).toEqual([]);
  });

  it('chi chiama callLLM e poi process.exit nomina un flush da qualche parte', () => {
    // Il gate qui sopra guarda dentro i `.catch(`, ed e' li' che vive la forma
    // piu' comune del difetto. Ma non tutte le uscite sono in un catch:
    // `analytics-report.mjs` chiamava `callLLM` e chiudeva `main()` con un
    // `process.exit(0)` in fondo al percorso RIUSCITO, senza flush da nessuna
    // parte del file. `exit(0)` salta `beforeExit` esattamente come `exit(1)`,
    // quindi quello script non ha mai persistito un solo esito.
    //
    // Il guard e' volutamente grossolano — «il file nomina un flush» — perche'
    // decidere staticamente se OGNI cammino di uscita flusha vorrebbe un
    // control-flow graph. Un file che chiama callLLM, esce con process.exit e
    // non nomina mai il flush pero' e' perdita certa, senza analisi.
    const offenders: string[] = [];
    for (const name of ledgerScripts()) {
      const src = stripComments(readFileSync(join(SCRIPTS_DIR, name), 'utf8'));
      if (!/\bcallLLM\b|\bcallSingleModel\b/.test(src)) continue;
      if (!/\bprocess\.exit\s*\(/.test(src)) continue;
      if (/\bflushScores(BeforeExit)?\s*\(/.test(src)) continue;
      offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it('lastUsed avanza solo su un vero successo, non su ogni run che fallisce', () => {
    // #6065 item 2: se `lastUsed` (l'ancora del decadimento in `_decayScore`)
    // viene ristampato a "now" su OGNI persist — successo o fallimento — allora
    // un modello permanentemente rotto ma ancora tentato ogni run vede sempre
    // un `ageH` piccolo (la cadenza fra i run), non il tempo reale trascorso da
    // quando ha funzionato l'ultima volta. Il punto fisso che ne risulta,
    // `s = 0.75*s - 3 -> s ~ -12`, puo' scavalcare un modello che funziona al
    // 70%. La entry deve costruire `lastUsed` SOLO quando questo ciclo contiene
    // almeno un successo (`counterDelta?.successes`), cosi' un fallimento non
    // resetta l'ancora e il decadimento riflette il vero tempo trascorso.
    const src = readFileSync(AI_MODELS, 'utf8');
    const start = src.indexOf('async function _persistScoresToFirestore');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('modelsDelta[_encodeModelId(modelId)] = entry;', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    // La entry iniziale non deve piu' contenere `lastUsed: now` incondizionato.
    const entryLiteral = body.slice(body.indexOf('const entry = {'), body.indexOf('const entry = {') + 300);
    expect(entryLiteral).not.toMatch(/lastUsed:\s*now/);
    // Deve invece essere assegnato condizionalmente, gated sui successi del delta.
    expect(body).toMatch(/if\s*\(\s*counterDelta\?\.successes\s*\)\s*entry\.lastUsed\s*=\s*now;/);
  });

  it('lo snapshot del ledger e il suo clear sono un blocco sincrono', () => {
    // Perche' due invocazioni concorrenti di `_persistScoresToFirestore()` — il
    // debounce di `_schedulePersist` e il flush di `flushScoresBeforeExit`
    // lanciato da `beforeExit`/SIGINT/SIGTERM — non possano contare due volte
    // lo stesso delta.
    //
    // La garanzia non e' un lock: e' che fra la guardia `_dirtyModels.size === 0`
    // e lo svuotamento di `_dirtyModels` + `_pendingCounterDeltas` non c'e'
    // nessun punto di sospensione. JS esegue quel tratto run-to-completion,
    // quindi la seconda invocazione o vede l'insieme gia' vuoto e ritorna
    // subito, o raccoglie soltanto i delta arrivati DOPO — disgiunti dai primi.
    // Un `await` infilato li' dentro aprirebbe la finestra e renderebbe
    // possibile il doppio `FieldValue.increment`, cioe' punteggi gonfiati: il
    // difetto opposto a quello che questa PR chiude. Il guard e' su quel tratto,
    // non sul comportamento, perche' e' l'unica cosa che puo' regredire.
    const src = readFileSync(AI_MODELS, 'utf8');
    const start = src.indexOf('async function _persistScoresToFirestore');
    expect(start).toBeGreaterThan(-1);
    const criticalEnd = src.indexOf('const modelsDelta', start);
    expect(criticalEnd).toBeGreaterThan(start);
    const critical = src.slice(start, criticalEnd);
    // Il tratto critico deve davvero contenere sia il clear sia lo svuotamento
    // dei delta, altrimenti il guard misurerebbe una regione sbagliata.
    expect(critical).toMatch(/_dirtyModels\.clear\(\)/);
    expect(critical).toMatch(/_pendingCounterDeltas\.delete\(modelId\)/);
    expect(stripComments(critical)).not.toMatch(/\bawait\b/);
  });

});

describe('flush finale del ledger: esito e visibilita runtime', () => {
  const MODEL = 'test/flush-model';

  beforeEach(() => {
    aiModels.resetState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
  });

  afterEach(() => {
    aiModels.resetState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function installSet(set: ReturnType<typeof vi.fn>) {
    aiModels.__installScoreStoreForTests({
      collection: () => ({ doc: () => ({ set }) }),
    });
  }

  it('ritorna true e misura la latenza quando il write riesce', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    installSet(set);
    aiModels.recordModelSuccess(MODEL);

    await expect(aiModels.flushScoresBeforeExit(500)).resolves.toBe(true);

    expect(set).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join(' ')).toContain('Final flush completed in 0ms (timeout=500ms, 1 model(s))');
  });

  it('ritorna false, annota il failure e conserva il delta per il retry', async () => {
    const set = vi.fn()
      .mockRejectedValueOnce(new Error('write rejected'))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installSet(set);
    aiModels.recordModelSuccess(MODEL);

    await expect(aiModels.flushScoresBeforeExit(500)).resolves.toBe(false);
    expect(warn.mock.calls.flat().join(' ')).toContain('::warning::');
    expect(warn.mock.calls.flat().join(' ')).toContain('Final flush failed after 0ms');

    await expect(aiModels.flushScoresBeforeExit(500)).resolves.toBe(true);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('ritorna false e annota timeout configurato ed elapsed', async () => {
    const set = vi.fn(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installSet(set);
    aiModels.recordModelSuccess(MODEL);

    const flush = aiModels.flushScoresBeforeExit(125);
    await vi.advanceTimersByTimeAsync(125);

    await expect(flush).resolves.toBe(false);
    const output = warn.mock.calls.flat().join(' ');
    expect(output).toContain('::warning::');
    expect(output).toContain('Final flush timed out after 125ms (elapsed 125ms)');
  });
});

/**
 * I file sotto `scripts/` che scrivono davvero nel ledger.
 *
 * NON e' «chi importa flushScores»: `callLLM()` fa da solo `initScoreStore()`
 * alla prima chiamata (`if (!_storeInitialized) await initScoreStore()`), quindi
 * uno script che chiama `callLLM` persiste su Firestore anche se non nomina mai
 * il flush — e sono proprio quelli che perdevano tutto, perche' non avendo mai
 * scritto `flushScores` non comparivano nemmeno nel gate qui sopra.
 *
 * L'import puo' essere statico o dinamico (`await import('./lib/ai-models.mjs')`):
 * `send-newsletter.mjs` e `backfill-ai-search-optimization.mjs` usano il secondo,
 * ed e' l'altra meta' del punto cieco.
 */
function ledgerScripts(): string[] {
  return walkMjs(SCRIPTS_DIR).filter((name) => {
    const src = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    if (!/ai-models\.mjs['"]/.test(src)) return false;
    return /\bcallLLM\b|\bcallSingleModel\b|\bflush(Scores|ScoresBeforeExit)\b/.test(src);
  });
}

/**
 * Via i commenti prima di cercare la chiamata al flush.
 *
 * Non e' cosmesi: il primo giro di questo gate passava perche' il commento che
 * SPIEGA la fix nomina `flushScores()` con le parentesi, e la regex lo contava
 * come chiamata. Un guard che si accontenta di leggere il proprio commento non
 * e' un guard — l'ha mostrato la prova per mutazione, che restava verde.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Tutti i `.mjs` sotto `scripts/`, ricorsivo, path relativi a SCRIPTS_DIR. */
function walkMjs(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const next = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walkMjs(root, next));
    else if (entry.name.endsWith('.mjs')) out.push(next);
  }
  return out;
}

/**
 * I corpi di ogni `.catch(` del sorgente, estratti bilanciando le parentesi.
 * Una regex non basta: il corpo di questi handler contiene a sua volta
 * parentesi e `try/catch` annidati.
 */
function catchHandlers(src: string): string[] {
  const bodies: string[] = [];
  const marker = '.catch(';
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = at + marker.length - 1; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    bodies.push(src.slice(at, end + 1));
    from = end + 1;
  }
  return bodies;
}
