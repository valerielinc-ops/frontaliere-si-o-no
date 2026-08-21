/**
 * pr-collision-detector: l'elenco file di una PR, e SOPRATTUTTO se e' completo.
 *
 * `gh pr view --json files` interroga la connection GraphQL `files(first: 100)`
 * e non pagina. Le modalita' sono TRE, non due, e la #6190 ne copriva una sola
 * perche' keyava il fallback sulla lista VUOTA:
 *
 *   <= 100     completa
 *   101..N     troncata a 100, in ordine alfabetico, exit 0, NON vuota
 *   oversize   `.files: null`
 *
 * Misurato il 2026-08-20 su questo repo: #6121 (changedFiles=183) → GraphQL
 * 100, REST `--paginate` 183/183; #6175 (oversize) → GraphQL null, REST 100.
 * Nella banda di mezzo la REST e' completa, quindi il campione non era un male
 * necessario ma una chiamata non fatta.
 *
 * Il fetch viveva inline in `main()`, e per questo il cap a 100 e' passato
 * senza copertura: qui e' una funzione pura con `gh` iniettato.
 */
import { describe, it, expect } from 'vitest';
import { fetchPrFiles, GRAPHQL_FILES_CAP, decideCollisionLabel } from '../scripts/ci/pr-collision-detector.mjs';

const REST_PAGE = 30; // quanti file rende l'endpoint REST senza `--paginate`

/**
 * `gh` finto FEDELE alla firma vera (`gh(args, {json, allowFail})`).
 *
 * La prima versione registrava solo `args[0]` e ignorava `opts`, quindi era
 * cieca a tutto cio' che rende corretta la chiamata: misurato, quattro
 * mutazioni distinte del sorgente restavano 10/10 verdi — fra cui togliere
 * `--paginate` e togliere `json: false`, che sono ESATTAMENTE il difetto
 * della #6190 che rientra dalla finestra. Un doppio che non guarda gli
 * argomenti non e' un test del comando, e' un test di se stesso.
 *
 * Qui il finto si comporta come `gh` davvero:
 *  - senza `--paginate` rende solo la prima pagina (30), come l'endpoint vero;
 *  - con `json !== false` fa `JSON.parse` dell'output, che su un elenco
 *    newline-delimited lancia — come lancia il `gh()` reale;
 *  - un endpoint sbagliato non risponde.
 */
function fakeGh({ graphql, rest }: { graphql?: unknown; rest?: string | Error }) {
  const calls: string[][] = [];
  const fn = (args: string[], opts: { json?: boolean; allowFail?: boolean } = {}) => {
    calls.push(args);
    if (args[0] === 'pr') {
      if (graphql instanceof Error) throw graphql;
      return graphql ?? [];
    }
    if (!/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(args[1] ?? '')) {
      throw new Error(`endpoint REST inatteso: ${args[1]}`);
    }
    if (rest instanceof Error) throw rest;
    let out = rest ?? '';
    if (!args.includes('--paginate')) {
      out = out.split('\n').filter(Boolean).slice(0, REST_PAGE).join('\n');
    }
    // Il `gh()` vero parsa come JSON salvo `json: false` — su righe nude lancia.
    if (opts.json !== false) return JSON.parse(out);
    return out;
  };
  return { fn, calls };
}

/** I nomi dei comandi, per le asserzioni sull'ordine delle chiamate. */
const verbs = (calls: string[][]) => calls.map((a) => a[0]);

const listOf = (n: number, prefix = 'a/f') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}.ts`);

describe('fetchPrFiles — le tre modalita di gh pr view --json files', () => {
  it('<=100 file: usa GraphQL e NON chiama la REST', () => {
    const { fn, calls } = fakeGh({ graphql: listOf(12), rest: 'non-deve-servire\n' });
    const { files, complete } = fetchPrFiles(1, 12, fn as never, 'o/r');
    expect(files).toHaveLength(12);
    expect(complete).toBe(true);
    expect(verbs(calls)).toEqual(['pr']);
  });

  it('TRONCATA a 100 con 183 attesi: il fallback parte e la REST vince (era il buco della #6190)', () => {
    const { fn, calls } = fakeGh({
      graphql: listOf(GRAPHQL_FILES_CAP),
      rest: `${listOf(183).join('\n')}\n`,
    });
    const { files, complete } = fetchPrFiles(6121, 183, fn as never, 'o/r');
    expect(files).toHaveLength(183);
    expect(complete).toBe(true);
    expect(verbs(calls)).toEqual(['pr', 'api']);
  });

  it('lista NON vuota ma piu corta degli attesi: fallback anche sotto il cap', () => {
    const { fn } = fakeGh({ graphql: listOf(40), rest: `${listOf(57).join('\n')}\n` });
    const { files, complete } = fetchPrFiles(2, 57, fn as never, 'o/r');
    expect(files).toHaveLength(57);
    expect(complete).toBe(true);
  });

  it('oversize (`.files: null` → []) con REST troncata: campione, e complete=false', () => {
    const { fn, calls } = fakeGh({ graphql: [], rest: `${listOf(100).join('\n')}\n` });
    // changedFiles=0 e' cio' che GitHub riporta sul diff oversize: 0 dichiarati
    // ma file veri. Non e' una PR vuota.
    const { files, complete } = fetchPrFiles(6175, 0, fn as never, 'o/r');
    expect(files).toHaveLength(100);
    expect(complete).toBe(false);
    expect(verbs(calls)).toEqual(['pr', 'api']);
  });

  it('PR rebase-only: 0 attesi e 0 trovati → completa, non «sconosciuta»', () => {
    const { fn } = fakeGh({ graphql: [], rest: '' });
    const { files, complete } = fetchPrFiles(3, 0, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(true);
  });

  it('REST che esplode: tiene la lista GraphQL e la dichiara incompleta', () => {
    const { fn } = fakeGh({ graphql: listOf(GRAPHQL_FILES_CAP), rest: new Error('rate limit') });
    const { files, complete } = fetchPrFiles(4, 183, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('entrambe le sorgenti a vuoto con file attesi: complete=false, non un vuoto credibile', () => {
    const { fn } = fakeGh({ graphql: [], rest: '' });
    const { files, complete } = fetchPrFiles(5, 9, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(false);
  });

  it('changedFiles assente (campo non chiesto) con file trovati: complete=false', () => {
    const { fn } = fakeGh({ graphql: listOf(3), rest: '' });
    const { complete } = fetchPrFiles(6, undefined as never, fn as never, 'o/r');
    expect(complete).toBe(false);
  });

  it('la REST non vince mai se restituisce MENO file di GraphQL', () => {
    const { fn } = fakeGh({ graphql: listOf(GRAPHQL_FILES_CAP), rest: 'solo/uno.ts\n' });
    const { files } = fetchPrFiles(8, 183, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
  });

  it('righe vuote e spazi nella REST non diventano path', () => {
    const { fn } = fakeGh({ graphql: [], rest: '  a.ts  \n\n b.ts\n   \n' });
    const { files } = fetchPrFiles(9, 2, fn as never, 'o/r');
    expect(files).toEqual(['a.ts', 'b.ts']);
  });
});

describe('fetchPrFiles — la clausola del cap, isolata', () => {
  it('ESATTAMENTE al cap con oracolo assente: chiama la REST e la lista cresce', () => {
    // L'unico caso in cui `changedFiles` non aiuta. Senza la clausola
    // `files.length >= GRAPHQL_FILES_CAP` il fallback non partirebbe e la
    // lista resterebbe tagliata: gli altri test lo mascheravano perche'
    // passavano tutti da `known && files.length < expected`.
    const { fn, calls } = fakeGh({
      graphql: listOf(GRAPHQL_FILES_CAP),
      rest: listOf(250).join('\n'),
    });
    const { files, complete } = fetchPrFiles(7, 0, fn as never, 'o/r');
    expect(verbs(calls)).toEqual(['pr', 'api']);
    expect(files).toHaveLength(250);
    expect(complete).toBe(false); // oracolo assente + file presenti = non lo so
  });

  it('la chiamata REST passa --paginate e l endpoint giusto', () => {
    const { fn, calls } = fakeGh({ graphql: listOf(GRAPHQL_FILES_CAP), rest: listOf(250).join('\n') });
    fetchPrFiles(42, 250, fn as never, 'o/r');
    const restCall = calls.find((a) => a[0] === 'api');
    expect(restCall).toBeDefined();
    expect(restCall).toContain('--paginate');
    expect(restCall?.[1]).toBe('repos/o/r/pulls/42/files');
  });

  it('al cap con REST MUTA: non dichiara completo un elenco che potrebbe essere tagliato', () => {
    // La congiunzione stretta: `changedFiles` letto quando la PR aveva 50
    // file, la PR cresce a 250 subito dopo, GraphQL tronca a 100 e la REST
    // non risponde. `100 >= 50` direbbe «completo» su una lista tagliata.
    const { fn } = fakeGh({
      graphql: listOf(GRAPHQL_FILES_CAP),
      rest: new Error('REST giu'),
    });
    const { files, complete } = fetchPrFiles(9, 50, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('al cap con REST che CONFERMA 100: completo, perche il dubbio e sciolto', () => {
    const { fn } = fakeGh({
      graphql: listOf(GRAPHQL_FILES_CAP),
      rest: listOf(GRAPHQL_FILES_CAP).join('\n'),
    });
    const { files, complete } = fetchPrFiles(10, GRAPHQL_FILES_CAP, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(true);
  });
});

describe('decideCollisionLabel — unknown non e «non collide»', () => {
  const d = (collides: boolean, hasLabel: boolean, listComplete: boolean) =>
    decideCollisionLabel({ collides, hasLabel, listComplete } as never);

  it('collide e non ha la label → la mette', () => {
    expect(d(true, false, true)).toBe('add');
  });

  it('collide e ce l ha gia → non tocca nulla', () => {
    expect(d(true, true, true)).toBe('none');
  });

  it('non collide, elenco COMPLETO → rimuove', () => {
    expect(d(false, true, true)).toBe('remove');
  });

  it('non collide MA elenco INCOMPLETO → tiene la label', () => {
    // Il verso conservativo: togliere qui sbloccherebbe l'auto-merge su una PR
    // che puo' collidere davvero, e il costo di sbagliare dall'altra parte e'
    // un rebase in piu'.
    expect(d(false, true, false)).toBe('keep');
  });

  it('non collide e non ha la label → nessuna azione, anche con elenco incompleto', () => {
    expect(d(false, false, false)).toBe('none');
    expect(d(false, false, true)).toBe('none');
  });

  it('un elenco incompleto non impedisce di AGGIUNGERE la label', () => {
    // L'incompletezza rende inaffidabile un «non collide», non un «collide»:
    // le collisioni viste sono viste davvero.
    expect(d(true, false, false)).toBe('add');
  });
});
