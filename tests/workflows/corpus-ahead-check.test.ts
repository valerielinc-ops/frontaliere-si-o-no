import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
// @ts-expect-error — .mjs senza tipi, come gli altri script di scripts/ci.
import {
  classify,
  localHash,
  needsDecisionHere,
  renderIssueBody,
  SITE_ACTIONABLE_STATES,
} from '../../scripts/ci/corpus-ahead-check.mjs';

/**
 * Il ciclo gira in DUE direzioni, e questo repo aveva un ricevitore solo.
 *
 * CLAUDE.md: "il codice scende dal sito al corpus, i dati risalgono dal corpus
 * al sito". Dopo il cutover del 2026-08-02 e' nanako a GENERARE il corpus, e da
 * allora anche il codice risale: le guardie nuove nascono in `generator/` la',
 * non qui. Nessuno dei due mirror copre `generator/` — `mirror-articles-engine.yml`
 * porta `engine/`, `mirror-articles-corpus.yml` portava `content/` ed e'
 * dispatch-only in via di cancellazione.
 *
 * Il corpus SA gia' quando succede (`scripts/ci/loop-drift-check.mjs`, cron
 * 07:31 UTC, classe `corpus-ahead`), ma apre la issue SUL CORPUS, dove nessun
 * agente puo' aprire una PR su questo repo. Costo misurato due volte: #81 → #82
 * sul corpus (il cap sulla meta description non e' sceso e il difetto e' tornato
 * il giorno dopo, `tests` rosso su OGNI branch di qui), e il 2026-08-09 nella
 * direzione opposta, con #120/#121/#122 mergiate dentro `generator/` e nessun
 * segnale da questa parte.
 *
 * Queste asserzioni sono sulla FORMA del rimedio, non sulla sua prosa. Ognuna
 * cade se la proprieta' corrispondente viene tolta.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const RECEIVER = 'corpus-ahead-check.yml';
const CHECKER = 'scripts/ci/corpus-ahead-check.mjs';

const wfPath = path.join(WF_DIR, RECEIVER);

/** Un `path` del corpus + il suo `sitePath` di qua: la forma reale del manifest. */
const twin = (over: Record<string, unknown> = {}) => ({
  path: 'generator/scripts/create-article.mjs',
  sitePath: 'scripts/create-article.mjs',
  mode: 'adapted',
  reason: 'Fork del generatore principale del sito.',
  ...over,
});

const BASE = { site: 'aaaaaaaaaaaaaaaa', corpus: 'bbbbbbbbbbbbbbbb' };

describe('il verdetto `corpus-ahead` arriva a questo repo, non solo al corpus', () => {
  it('il workflow ricevitore esiste', () => {
    expect(
      fs.existsSync(wfPath),
      `${RECEIVER} manca. Senza un ricevitore, ogni verdetto "il corpus si e' ` +
        'mosso, il sito no" resta in una issue sul corpus, che e\' il repo che ' +
        'non puo\' aprire una PR qui. E\' esattamente cio\' che ha lasciato #120, ' +
        '#121 e #122 senza risalita.',
    ).toBe(true);
  });

  it('lo script che produce il verdetto esiste', () => {
    expect(fs.existsSync(path.join(ROOT, CHECKER)), `${CHECKER} manca`).toBe(true);
  });
});

describe('il ricevitore gira da solo e parla', () => {
  const src = fs.existsSync(wfPath) ? fs.readFileSync(wfPath, 'utf-8') : '';
  const doc = (src ? YAML.parse(src) : {}) as Record<string, any>;
  /** `on:` sopravvive alla coercizione booleana di YAML 1.1 come `true`. */
  const on = (doc.on ?? doc[true as unknown as string]) as Record<string, any>;

  /**
   * I commenti spiegano apposta le forme RIFIUTATE (`rm -rf`, il push verso il
   * corpus): vanno ignorati, o il test cade sulla propria motivazione. Stessa
   * soluzione di tests/workflows/articles-engine-mirror.test.ts.
   */
  const live = src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('ha uno schedule — un ricevitore che nessuno lancia non e\' un ricevitore', () => {
    // La lezione gia' scritta da mirror-articles-engine.yml: dispatch-only e'
    // cio' che ha lasciato l'engine fermo per tre giorni dopo il cutover.
    // `mirror-articles-corpus.yml` e `transport-generator-to-nanako.yml` sono
    // entrambi dispatch-only, ed entrambi non girano da agosto.
    expect(on, 'nessun blocco `on:`').toBeTruthy();
    expect(on.schedule, `${RECEIVER} deve avere uno schedule, non solo workflow_dispatch`).toBeTruthy();
    expect(Array.isArray(on.schedule) && on.schedule.length > 0).toBe(true);
  });

  it('apre la issue sullo schedule, e sa aprirla su richiesta', () => {
    // Il verdetto che resta nel log del run e' il verdetto che nessuno legge.
    expect(/--issue/.test(src), 'il ricevitore deve poter aprire la issue (`--issue`)').toBe(true);
    expect(/schedule/.test(src) && /flags='--issue'/.test(src)).toBe(true);
  });

  it('ha i permessi per aprire la issue', () => {
    expect(doc.permissions?.issues, '`issues: write` serve, o la issue non parte').toBe('write');
  });

  it('non copia niente: nessun rm -rf, nessun push verso il corpus', () => {
    // Il rimedio scelto e' un OSSERVATORE. Un mirror di `generator/` sarebbe
    // distruttivo in due modi indipendenti: spingerebbe sito → corpus,
    // sovrascrivendo con la copia piu' vecchia proprio le guardie da ricevere;
    // e ricostruendo la cartella da zero cancellerebbe i file `corpus-only`,
    // fra cui `generator/scripts/lib/topic-coverage-guard.mjs`, che E' la
    // guardia di #120.
    expect(/rm\s+-rf/.test(live), 'il ricevitore non deve cancellare niente').toBe(false);
    expect(/git\s+push/.test(live), 'il ricevitore non deve scrivere sul corpus').toBe(false);
  });
});

describe('il confronto a tre vie riporta solo la meta\' su cui questo repo puo\' agire', () => {
  it('il corpus si e\' mosso e noi no → `corpus-ahead`, azionabile', () => {
    // Il caso di #120/#121/#122: le guardie nascono la' e restano la'.
    const v = classify(twin(), { site: BASE.site, corpus: 'cccccccccccccccc' }, BASE);
    expect(v.state).toBe('corpus-ahead');
    expect(v.actionable).toBe(true);
  });

  it('copre `generator/` — non filtra per prefisso di path', () => {
    // La cosa che il rimedio esiste per fare. Un checker che salta `generator/`
    // e' il buco di partenza con un file in piu'.
    const v = classify(
      twin({ path: 'generator/scripts/lib/article-sanitizers.mjs', sitePath: 'scripts/lib/article-sanitizers.mjs', mode: 'identical' }),
      { site: BASE.site, corpus: 'cccccccccccccccc' },
      BASE,
    );
    expect(v.state).toBe('corpus-ahead');
    expect(v.actionable).toBe(true);
    expect(v.detail).toMatch(/copiabile/);
  });

  it('noi ci siamo mossi e il corpus no → `site-ahead`, e NON e\' azionabile qui', () => {
    // Meta' del corpus: la riporta gia' la sua issue. Ripeterla qui sdoppia il
    // segnale senza aggiungere una decisione che spetti a noi.
    const v = classify(twin(), { site: 'dddddddddddddddd', corpus: BASE.corpus }, BASE);
    expect(v.state).toBe('site-ahead');
    expect(v.actionable).toBe(false);
  });

  it('`site-ahead` non compare fra le classi azionabili di questo lato', () => {
    expect(SITE_ACTIONABLE_STATES).toContain('corpus-ahead');
    expect(SITE_ACTIONABLE_STATES).toContain('both-moved');
    expect(SITE_ACTIONABLE_STATES).not.toContain('site-ahead');
  });

  it('mossi entrambi → `both-moved`, azionabile', () => {
    const v = classify(twin(), { site: 'dddddddddddddddd', corpus: 'cccccccccccccccc' }, BASE);
    expect(v.state).toBe('both-moved');
    expect(v.actionable).toBe(true);
  });

  it('mossi entrambi ma gia\' allo STESSO contenuto → `both-moved-converged`, non `both-moved`', () => {
    // Il gemello del corpus ha questa classe dalla sua issue #680; qui mancava,
    // e il bucket «riconciliazione manuale» assorbiva anche i casi gia' risolti
    // da soli — 27 righe indistinguibili (issue #7368).
    const v = classify(twin({ mode: 'identical' }), { site: 'eeeeeeeeeeeeeeee', corpus: 'eeeeeeeeeeeeeeee' }, BASE);
    expect(v.state).toBe('both-moved-converged');
    expect(v.actionable).toBe(true);
    expect(v.detail).toMatch(/--init/);
  });

  it('un convergente non e\' una DECISIONE di questo lato', () => {
    // La proprieta' che tiene pulito il bucket manuale: comparire nel report
    // non basta a chiedere una lettura umana qui.
    const converged = classify(twin({ mode: 'identical' }), { site: 'eeeeeeeeeeeeeeee', corpus: 'eeeeeeeeeeeeeeee' }, BASE);
    const moved = classify(twin(), { site: 'dddddddddddddddd', corpus: 'cccccccccccccccc' }, BASE);
    expect(needsDecisionHere(converged)).toBe(false);
    expect(needsDecisionHere(moved)).toBe(true);
    expect(SITE_ACTIONABLE_STATES).toContain('both-moved-converged');
  });

  it('il report separa i convergenti dal bucket manuale', () => {
    const rows = [
      { path: 'generator/a.mjs', sitePath: 'a.mjs', state: 'both-moved', actionable: true, headline: 'modificato su entrambi i lati' },
      { path: 'generator/b.mjs', sitePath: 'b.mjs', state: 'both-moved-converged', actionable: true, headline: 'gia\' identici' },
    ];
    const body = renderIssueBody({ alignedAt: '2026-09-01' }, rows, rows);
    // Una sola riga chiede davvero una decisione, e l'altra ha una sezione sua.
    expect(body).toMatch(/\*\*1\*\* richiedono una decisione \*\*qui\*\*/);
    expect(body).toMatch(/gia' convergenti/);
    const manualSection = body.slice(body.indexOf('🔴'), body.indexOf('🟢'));
    expect(manualSection).toContain('generator/a.mjs');
    expect(manualSection).not.toContain('generator/b.mjs');
  });

  it('fermi entrambi sulla baseline → `stable`, silenzio', () => {
    // Un report che segnala tutto smette di essere letto. I file `adapted`
    // divergono per costruzione: e' la baseline a dire chi si e' mosso.
    const v = classify(twin(), { site: BASE.site, corpus: BASE.corpus }, BASE);
    expect(v.state).toBe('stable');
    expect(v.actionable).toBe(false);
  });

  it('`corpus-only` e baseline mancante non sono azionabili', () => {
    expect(classify(twin({ mode: 'corpus-only' }), { site: null, corpus: 'x' }, BASE).actionable).toBe(false);
    // Senza baseline il confronto a tre vie e' indecidibile: due hash diversi
    // non dicono CHI si e' mosso. La baseline si registra sul corpus.
    expect(classify(twin(), { site: 'd', corpus: 'c' }, null).actionable).toBe(false);
    expect(classify(twin(), { site: 'd', corpus: 'c' }, { site: null, corpus: null }).actionable).toBe(false);
  });

  it('gemello assente di qua → non azionabile, mai un falso `corpus-ahead`', () => {
    const v = classify(twin(), { site: null, corpus: 'cccccccccccccccc' }, BASE);
    expect(v.actionable).toBe(false);
  });
});

describe('il lettore locale e\' immune allo sparse checkout', () => {
  it('legge un gemello tracciato ma non materializzato', () => {
    // Non e' teorico: questo repo si lavora in worktree SPARSE (CLAUDE.md — un
    // checkout pieno costa 3,9 GB), e il manifest del corpus dichiara due
    // gemelli sotto `data/`, che e' proprio una delle cartelle che la ricetta
    // sparse esclude. Con il solo `existsSync` quei due file leggerebbero
    // "nessun gemello qui", cioe' sparirebbero dal confronto in silenzio.
    const h = localHash('data/authors.ts');
    expect(
      h,
      'data/authors.ts e\' un gemello dichiarato nel manifest del corpus: deve ' +
        'essere leggibile anche quando `data/` non e\' materializzato (fallback ' +
        'su `git show HEAD:<path>`).',
    ).toBeTruthy();
    expect(String(h)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('un path che il repo davvero non ha resta null', () => {
    expect(localHash('scripts/ci/questo-file-non-esiste-mai.mjs')).toBeNull();
  });
});

describe('la premessa del rimedio: il gemello di questo lato e\' RAGGIUNGIBILE', () => {
  // Se questa premessa cade, il rimedio giusto cambia — un ricevitore per un
  // ramo morto e' rumore. Il test la fissa cosi' che spegnere la pipeline
  // diventi una decisione cosciente e non un'erosione silenziosa.
  //
  // Lo spegnimento e' avvenuto, ed e' stato cosciente: il 2026-08-14 lo
  // `schedule` di publish-journalist-articles.yml e' stato rimosso su decisione
  // del proprietario (#5794), perche' i due repo drenavano la STESSA coda
  // Firestore `journalist_articles` e chi perdeva la corsa non vedeva mai
  // l'articolo. Questo test ha fatto il suo lavoro: ha fermato la modifica
  // finche' qualcuno non ha guardato.
  //
  // La premessa pero' NON e' caduta, ha cambiato forma. Il workflow conserva
  // `workflow_dispatch`, quindi il percorso resta percorribile a comando e
  // `scripts/create-article.mjs` di questo lato resta eseguibile: una guardia
  // messa solo nel corpus continua a NON proteggerlo. Percio' qui si asserisce
  // che il gemello sia raggiungibile, non che giri da solo — e se un giorno
  // sparisse anche il dispatch, il test tornerebbe a fermare la modifica.
  const journalist = path.join(WF_DIR, 'publish-journalist-articles.yml');

  it('publish-journalist-articles.yml resta invocabile ed esegue il generatore', () => {
    const src = fs.readFileSync(journalist, 'utf-8');
    const doc = YAML.parse(src) as Record<string, any>;
    const on = (doc.on ?? doc[true as unknown as string]) as Record<string, any>;

    expect(
      on.schedule || 'workflow_dispatch' in on,
      'la pipeline giornalisti deve restare invocabile (schedule o workflow_dispatch)',
    ).toBeTruthy();
    expect(
      /node scripts\/publish-journalist-article\.mjs/.test(src),
      'la pipeline giornalisti deve ancora eseguire scripts/publish-journalist-article.mjs',
    ).toBe(true);
  });

  it('lo schedule resta spento finche\' qualcuno non decide il contrario', () => {
    // L'altra meta' della decisione #5794: rimetterlo ricrea la corsa sulla coda
    // condivisa, quindi deve costare una modifica a questo test e non un
    // ritocco distratto al cron.
    const doc = YAML.parse(fs.readFileSync(journalist, 'utf-8')) as Record<string, any>;
    const on = (doc.on ?? doc[true as unknown as string]) as Record<string, any>;
    expect(
      on.schedule,
      'lo schedule del publisher giornalisti del SITO deve restare spento: la coda e\' del corpus (#5794)',
    ).toBeFalsy();
  });

  it('publish-journalist-article.mjs importa ancora da create-article.mjs', () => {
    // E' l'anello che rende vivo `scripts/create-article.mjs` di qua: una
    // guardia che non risale non e' codice morto, e' codice che gira senza.
    const src = fs.readFileSync(path.join(ROOT, 'scripts/publish-journalist-article.mjs'), 'utf-8');
    expect(/from '\.\/create-article\.mjs'/.test(src)).toBe(true);
  });
});
