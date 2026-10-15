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
 * `changedFiles` e `files` vengono fetchati in UNA SOLA `gh pr view --json
 * changedFiles,files` (#6206 item 3): prima erano due chiamate `gh pr view`
 * separate — una per `changedFiles` (l'oracolo), una per `files` — non
 * atomiche. Un push sulla PR fra le due lasciava leggere un `expected` vecchio
 * contro un `files` nuovo (o viceversa), producendo un falso `complete=true`:
 * la stessa classe di race gia' chiusa in
 * pr-review-loop.yml/pr-redflag-fixer.yml. Qui i due valori vengono dalla
 * stessa risposta GraphQL.
 *
 * Il fetch viveva inline in `main()`, e per questo il cap a 100 e' passato
 * senza copertura: qui e' una funzione pura con `gh` iniettato.
 */
import { describe, it, expect } from 'vitest';
import { fetchPrFiles, GRAPHQL_FILES_CAP, REST_FILES_HARD_CAP, decideCollisionLabel } from '../scripts/ci/pr-collision-detector.mjs';

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
 *  - un endpoint sbagliato non risponde;
 *  - con `allowFail` un fallimento NON lancia: rende `''` (o `null` in modo
 *    JSON), esattamente come il `gh()` reale. Senza questo ramo la mutazione
 *    «rimetti `allowFail: true` sulla REST» restava verde 20/20, cioe' il
 *    doppio era ancora cieco a meta' della firma che dichiara di replicare.
 *
 * `view` sostituisce il vecchio `graphql`: e' l'oggetto GIA' PARSATO
 * `{changedFiles, files}` che l'unica `gh pr view --json changedFiles,files`
 * rende (o l'errore che lancerebbe/inghiotte, stesso trattamento del vecchio
 * `graphql`).
 */
function fakeGh({ view, rest }: { view?: unknown; rest?: string | Error }) {
  const calls: string[][] = [];
  const fn = (args: string[], opts: { json?: boolean; allowFail?: boolean } = {}) => {
    calls.push(args);
    if (args[0] === 'pr') {
      if (view instanceof Error) {
        // Simmetrico al ramo REST sotto, e per lo stesso motivo: `fetchPrFiles`
        // chiama QUESTA `gh` con `allowFail: true`, quindi il fallimento vero
        // non lancia — rende `null`. Un finto che lancia soltanto non puo'
        // riprodurre il modo in cui la chiamata fallisce davvero, ed era
        // esattamente il caso in cui `complete` usciva TRUE (#6206).
        if (opts.allowFail) return opts.json === false ? '' : null;
        throw view;
      }
      return view ?? {};
    }
    if (!/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(args[1] ?? '')) {
      throw new Error(`endpoint REST inatteso: ${args[1]}`);
    }
    if (rest instanceof Error) {
      // Il `gh()` reale con `allowFail` INGHIOTTE: rende `''`/`null` invece di
      // lanciare. E' proprio il segnale che sparisce, quindi il finto deve
      // riprodurlo o il test non puo' vederlo mancare.
      if (opts.allowFail) return opts.json === false ? '' : null;
      throw rest;
    }
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

describe('fetchPrFiles — le tre modalita di gh pr view --json changedFiles,files', () => {
  it('<=100 file: usa la vista combinata e NON chiama la REST', () => {
    const { fn, calls } = fakeGh({ view: { changedFiles: 12, files: listOf(12) }, rest: 'non-deve-servire\n' });
    const { files, complete } = fetchPrFiles(1, fn as never, 'o/r');
    expect(files).toHaveLength(12);
    expect(complete).toBe(true);
    expect(verbs(calls)).toEqual(['pr']);
  });

  it('TRONCATA a 100 con 183 attesi: il fallback parte e la REST vince (era il buco della #6190)', () => {
    const { fn, calls } = fakeGh({
      view: { changedFiles: 183, files: listOf(GRAPHQL_FILES_CAP) },
      rest: `${listOf(183).join('\n')}\n`,
    });
    const { files, complete } = fetchPrFiles(6121, fn as never, 'o/r');
    expect(files).toHaveLength(183);
    expect(complete).toBe(true);
    expect(verbs(calls)).toEqual(['pr', 'api']);
  });

  it('lista NON vuota ma piu corta degli attesi: fallback anche sotto il cap', () => {
    const { fn } = fakeGh({ view: { changedFiles: 57, files: listOf(40) }, rest: `${listOf(57).join('\n')}\n` });
    const { files, complete } = fetchPrFiles(2, fn as never, 'o/r');
    expect(files).toHaveLength(57);
    expect(complete).toBe(true);
  });

  it('oversize (`.files: null` → []) con REST troncata: campione, e complete=false', () => {
    const { fn, calls } = fakeGh({ view: { changedFiles: 0, files: [] }, rest: `${listOf(100).join('\n')}\n` });
    // changedFiles=0 e' cio' che GitHub riporta sul diff oversize: 0 dichiarati
    // ma file veri. Non e' una PR vuota.
    const { files, complete } = fetchPrFiles(6175, fn as never, 'o/r');
    expect(files).toHaveLength(100);
    expect(complete).toBe(false);
    expect(verbs(calls)).toEqual(['pr', 'api']);
  });

  it('PR rebase-only: 0 attesi e 0 trovati → completa, non «sconosciuta»', () => {
    const { fn } = fakeGh({ view: { changedFiles: 0, files: [] }, rest: '' });
    const { files, complete } = fetchPrFiles(3, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(true);
  });

  it('REST che esplode: tiene la lista della vista combinata e la dichiara incompleta', () => {
    const { fn } = fakeGh({
      view: { changedFiles: 183, files: listOf(GRAPHQL_FILES_CAP) },
      rest: new Error('rate limit'),
    });
    const { files, complete } = fetchPrFiles(4, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('entrambe le sorgenti a vuoto con file attesi: complete=false, non un vuoto credibile', () => {
    const { fn } = fakeGh({ view: { changedFiles: 9, files: [] }, rest: '' });
    const { files, complete } = fetchPrFiles(5, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(false);
  });

  it('changedFiles assente dalla risposta (fetch fallito/degradato) con file trovati: complete=false', () => {
    const { fn } = fakeGh({ view: { files: listOf(3) }, rest: '' });
    const { complete } = fetchPrFiles(6, fn as never, 'o/r');
    expect(complete).toBe(false);
  });

  it('la REST non vince mai se restituisce MENO file della vista combinata', () => {
    const { fn } = fakeGh({
      view: { changedFiles: 183, files: listOf(GRAPHQL_FILES_CAP) },
      rest: 'solo/uno.ts\n',
    });
    const { files } = fetchPrFiles(8, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
  });

  it('righe vuote e spazi nella REST non diventano path', () => {
    const { fn } = fakeGh({ view: { changedFiles: 2, files: [] }, rest: '  a.ts  \n\n b.ts\n   \n' });
    const { files } = fetchPrFiles(9, fn as never, 'o/r');
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
      view: { changedFiles: 0, files: listOf(GRAPHQL_FILES_CAP) },
      rest: listOf(250).join('\n'),
    });
    const { files, complete } = fetchPrFiles(7, fn as never, 'o/r');
    expect(verbs(calls)).toEqual(['pr', 'api']);
    expect(files).toHaveLength(250);
    expect(complete).toBe(false); // oracolo assente + file presenti = non lo so
  });

  it('la chiamata REST passa --paginate e l endpoint giusto', () => {
    const { fn, calls } = fakeGh({ view: { changedFiles: 250, files: listOf(GRAPHQL_FILES_CAP) }, rest: listOf(250).join('\n') });
    fetchPrFiles(42, fn as never, 'o/r');
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
      view: { changedFiles: 50, files: listOf(GRAPHQL_FILES_CAP) },
      rest: new Error('REST giu'),
    });
    const { files, complete } = fetchPrFiles(9, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('al cap con REST che CONFERMA 100: completo, perche il dubbio e sciolto', () => {
    const { fn } = fakeGh({
      view: { changedFiles: GRAPHQL_FILES_CAP, files: listOf(GRAPHQL_FILES_CAP) },
      rest: listOf(GRAPHQL_FILES_CAP).join('\n'),
    });
    const { files, complete } = fetchPrFiles(10, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(true);
  });

  it('al cap con REST che risponde con MENO file: non e una conferma', () => {
    // Il buco vero: `restConfirmed = true` messo PRIMA di guardare quanto la
    // REST avesse consegnato. Una REST che esce 0 rendendo 60 file su una
    // GraphQL tagliata a 100 non scioglie nulla — la lista puo' essere ancora
    // quella troncata — ma contava come conferma, e con `expected` piu' basso
    // del cap `100 >= 50` dichiarava completa una lista tagliata.
    const { fn } = fakeGh({
      view: { changedFiles: 50, files: listOf(GRAPHQL_FILES_CAP) },
      rest: listOf(60).join('\n'),
    });
    const { files, complete } = fetchPrFiles(11, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('al cap con REST che risponde 200 A MANI VUOTE: non e una conferma', () => {
    // Stesso difetto per l'altra via: `''` non lancia, quindi passava per
    // «ha risposto». Zero file consegnati non confermano un elenco da 100.
    const { fn } = fakeGh({ view: { changedFiles: 50, files: listOf(GRAPHQL_FILES_CAP) }, rest: '' });
    const { files, complete } = fetchPrFiles(12, fn as never, 'o/r');
    expect(files).toHaveLength(GRAPHQL_FILES_CAP);
    expect(complete).toBe(false);
  });

  it('il finto ONORA allowFail: una REST giu rende una stringa vuota, non lancia', () => {
    // Test del doppio, non del sorgente: senza questo ramo il finto lanciava
    // comunque, quindi la mutazione «rimetti `allowFail: true`» restava verde
    // e il punto non era coperto da niente.
    const { fn } = fakeGh({ view: { changedFiles: 1, files: listOf(1) }, rest: new Error('REST giu') });
    expect(() => fn(['api', 'repos/o/r/pulls/1/files'], { json: false })).toThrow();
    expect(fn(['api', 'repos/o/r/pulls/1/files'], { json: false, allowFail: true })).toBe('');
  });

  it('l invariante del cap NON dipende da allowFail: tiene anche se qualcuno lo rimette', () => {
    // Con `allowFail` il fallimento arriva come `''` invece che come throw.
    // Poiche' `restConfirmed` misura la CONSEGNA e non l'assenza di eccezione,
    // le due strade danno lo stesso verdetto conservativo.
    const gh = (args: string[], opts: { json?: boolean; allowFail?: boolean } = {}) => {
      if (args[0] === 'pr') return { changedFiles: 50, files: listOf(GRAPHQL_FILES_CAP) };
      if (opts.allowFail) return opts.json === false ? '' : null;
      throw new Error('REST giu');
    };
    const { complete } = fetchPrFiles(13, gh as never, 'o/r');
    expect(complete).toBe(false);
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

describe('fetchPrFiles — «non ha risposto» non e «e vuoto» (follow-up #6206)', () => {
  // Il buco che chiude: entrambe le `gh` mute davano `expected` assente e
  // `files=[]`, quindi `complete` cadeva sul ramo `files.length === 0` e
  // usciva TRUE. A valle, `pr-review-loop` legge esattamente quella coppia
  // («elenco vuoto E completo») come «PR rebase-only», sceglie il tier
  // `normal` e SALTA il guard sull'incompletezza — cioe' il falso negativo
  // che questo modulo esiste per impedire, prodotto dal modulo stesso.
  it('gh muta con oracolo sconosciuto: NON e completa', () => {
    const { fn } = fakeGh({ view: new Error('gh: network unreachable'), rest: new Error('idem') });
    const { files, complete, reason } = fetchPrFiles(1, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(false);
    expect(reason).toBe('list-fetch-failed');
  });

  it('la COPPIA che pr-review-loop legge non e mai «vuoto E completo» per errore', () => {
    // Il consumatore a valle non guarda `complete` da solo: fa
    // `if [ -z "$files" ] && [ "$files_complete" = "1" ]` e da li' conclude
    // «PR rebase-only», sceglie il tier `normal` ed esce PRIMA del guard
    // sull'incompletezza. E' la congiunzione a dover essere impossibile
    // quando l'elenco non e' mai arrivato, non uno dei due campi.
    const { fn } = fakeGh({ view: new Error('gh: 502'), rest: new Error('gh: 502') });
    const { files, complete } = fetchPrFiles(1, fn as never, 'o/r');
    expect(files.length === 0 && complete).toBe(false);
  });

  it('PR rebase-only VERA resta completa: [] consegnato non e [] mancante', () => {
    // Il verso opposto, che non deve regredire: qui la vista combinata ha
    // risposto, e ha risposto «nessun file». Distinguere le due e' tutto il
    // punto. `rest: ''` perche' con lista vuota il fallback REST parte
    // comunque, e una PR rebase-only non ha file da nessuna delle due parti.
    const { fn } = fakeGh({ view: { changedFiles: 0, files: [] }, rest: '' });
    const { files, complete, reason } = fetchPrFiles(1, fn as never, 'o/r');
    expect(files).toEqual([]);
    expect(complete).toBe(true);
    expect(reason).toBe('complete');
  });
});

describe('fetchPrFiles — la CAUSA dell incompletezza, non solo il fatto (follow-up #6206)', () => {
  it('etichetta il tetto rigido della REST come tale, non come un errore ordinario', () => {
    // Sopra i 3000 file `--paginate` non ha una pagina successiva: nessun
    // retry lo risolve, e a valle va detto — prima ogni `complete:false`
    // stampava la stessa riga.
    const huge = listOf(REST_FILES_HARD_CAP);
    const { fn } = fakeGh({ view: { changedFiles: 4200, files: listOf(100) }, rest: `${huge.join('\n')}\n` });
    const { complete, reason } = fetchPrFiles(1, fn as never, 'o/r');
    expect(complete).toBe(false);
    expect(reason).toBe('rest-hard-limit');
  });

  it('distingue il cap GraphQL non confermato da una lista corta', () => {
    const { fn } = fakeGh({ view: { changedFiles: 0, files: listOf(100) }, rest: new Error('REST giu') });
    expect(fetchPrFiles(1, fn as never, 'o/r').reason).toBe('graphql-cap');

    const { fn: fn2 } = fakeGh({ view: { changedFiles: 40, files: listOf(12) }, rest: `${listOf(12).join('\n')}\n` });
    expect(fetchPrFiles(1, fn2 as never, 'o/r').reason).toBe('short-of-oracle');
  });

  it('una lista completa porta reason "complete"', () => {
    const { fn } = fakeGh({ view: { changedFiles: 12, files: listOf(12) }, rest: 'non-deve-servire\n' });
    expect(fetchPrFiles(1, fn as never, 'o/r').reason).toBe('complete');
  });
});
