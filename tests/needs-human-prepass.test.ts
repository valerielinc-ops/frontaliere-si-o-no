/**
 * needs-human-prepass — la metà deterministica dello sweep `needs-human`.
 *
 * Il difetto che chiude, misurato il 2026-08-24: `needs-human-sweep.yml` drena
 * con UN run Claude alla settimana e un cap di 15 azioni, e le issue
 * `needs-human` sul sito erano **59** — quattro settimane di coda nel caso
 * migliore, mentre lo stadio VERDICT-EXIT (#6323) ne aggiunge a ogni tick del
 * drainer (15 escalation nei primi 15 minuti dal suo merge). Un'uscita che
 * riceve più di quanto emette non è un'uscita.
 *
 * E il cap era speso male: sulle 59, **26 erano instradabili senza giudizio**
 * (17 re-queue + 9 scorpori) perché il titolo lo scrive un nostro monitor. Le 7
 * decisioni vere restavano tutte in `keep`.
 */

import { describe, it, expect } from 'vitest';
import {
  prepassDecision,
  latestVerdict,
  MONITOR_TITLE_PATTERNS,
  STALE_BLOCK_VERDICTS,
} from '../scripts/ci/needs-human-prepass.mjs';

describe('prepassDecision — famiglie di monitor riconosciute positivamente', () => {
  it.each([
    ['Crawler Failure: Run grace'],
    ['CI Failure: tests'],
    ['Workflow Failure: Audit Parser Quality'],
    ['Validation Failure (dist): audit:all'],
    ['[crawler-health] berner-montage: crawler unhealthy'],
    ['[data-quality] Translation: 35 job bloccati'],
    ['App Error: error_boundary — SyntaxError'],
    ['PostHog Exception: TypeError'],
    ['CWV field regression on a tracked page'],
  ])('%s → requeue', (title) => {
    expect(prepassDecision({ title }).action).toBe('requeue');
  });

  it('un container multi-item si SCORPORA, non si ri-accoda intero', () => {
    // Ri-accodare intero un container con più target è il modo documentato di
    // rifare `max-turns`: lo scorporo produce sub-issue atomiche, dove la resa
    // del fixer è più alta.
    const d = prepassDecision({ title: 'follow-up(#6205): 3 item deferred — REST files-cap' });
    expect(d.action).toBe('decompose');
    // Anche al PLURALE: questo file teneva una copia locale della regex che
    // diceva `\s+item\s+` invece di `\s+items?\s+`, e i titoli li scrive un LLM
    // che usa entrambe le forme. Il plurale finiva nel `requeue` intero, cioè
    // nel modo documentato di rifare `max-turns`. Ora la regex è quella
    // importata da `followup-drainer.mjs`, una sola definizione.
    expect(prepassDecision({ title: 'follow-up(#6206): 2 items deferred — plurale' }).action).toBe('decompose');
  });

  it('una follow-up singola senza item deferred si ri-accoda', () => {
    expect(prepassDecision({ title: 'follow-up(#6100): rimisura la soglia' }).action).toBe('requeue');
  });
});

describe('prepassDecision — ciò che NON deve toccare', () => {
  it.each([
    ['A/B test: candidatura assistita a 0,99 € con raccolta CV'],
    ['Farmacie svizzere e farmacie di turno: ricerca per cantone'],
    ['Portale aste targhe svizzere: crawler cantonali'],
    ['Salari: le bande sono stime servite senza marcatore'],
    ['CMP certificato: unificare il consenso ads'],
    ['Repo weight: backlog delle leve sul tasso di crescita'],
  ])('decisione del proprietario → keep: %s', (title) => {
    // Sono le righe di VISION.md § «Decisioni RICHIESTE». Se una finisse in
    // `requeue`, il fixer implementerebbe una scelta che non gli spetta —
    // espansione di scope, denaro, consenso — che è precisamente ciò che la
    // lista «Sempre umano» esiste per impedire.
    expect(prepassDecision({ title }).action).toBe('keep');
  });

  it('un tracker permanente resta dov\'è', () => {
    expect(prepassDecision({
      title: 'Crawler Failure: Run grace', labels: ['agent:no-age-out'],
    }).action).toBe('keep');
  });

  it('agent:in-progress → keep, mai un doppio instradamento (claim mutex reale)', () => {
    expect(prepassDecision({ title: 'CI Failure: tests', labels: ['agent:in-progress'] }).action).toBe('keep');
  });

  it.each(['agent:fix', 'agent:fix-queued', 'agent:decompose', 'agent:decompose-queued'])(
    'regressione #6427: needs-human + %s + titolo monitor → requeue, non keep', (label) => {
      // Prima della fix, queste 4 label facevano tornare `keep` per la guardia
      // "già in lavorazione". Ma la query a monte filtra già su `needs-human`, e
      // nessuno di questi 4 stadi aggiunge `needs-human` restando `agent:fix*`/
      // `agent:decompose*` mentre è davvero in coda: è lo stato morto lasciato
      // dall'escalation VERDICT-EXIT (che prima non rimuoveva le label), non
      // un'issue in volo. La guardia va ristretta ad `agent:in-progress` — vedi
      // caso #6427 sul sito, misurato il 2026-08-25.
      expect(prepassDecision({ title: 'CI Failure: tests', labels: [label] }).action).toBe('requeue');
    });

  it('il default è keep: «non so dirlo» non è un ramo di errore', () => {
    expect(prepassDecision({}).action).toBe('keep');
    expect(prepassDecision({ title: 'qualcosa che nessuno ha previsto' }).action).toBe('keep');
  });
});

describe('prepassDecision — verdetti superati dalla decisione sui secret', () => {
  it('blocked-secrets → requeue (decisione del proprietario, 2026-08-24)', () => {
    // Il verdetto descriveva una configurazione — il fixer del sito girava senza
    // credenziali — non un limite. Da quella data `issue-fix.yml` carica Remote
    // Config, quindi la issue è lavoro normale.
    const d = prepassDecision({ title: 'Campaign goal FAILED: brand_query_ctr', verdict: 'blocked-secrets' });
    expect(d.action).toBe('requeue');
    expect(d.reason).toMatch(/secret/i);
  });

  it('gli altri verdetti di blocco NON sono superati', () => {
    for (const v of ['blocked-admin-settings', 'blocked-workflows-scope', 'no-root-cause']) {
      expect(STALE_BLOCK_VERDICTS.has(v), v).toBe(false);
      expect(prepassDecision({ title: 'una cosa qualunque', verdict: v }).action).toBe('keep');
    }
  });

  it('regressione #5608: un verdetto NON_RETRYABLE vince sul riconoscimento di famiglia', () => {
    // Prima della fix, un titolo di famiglia monitor tornava sempre `requeue`
    // a prescindere dal verdetto — anche quando la issue era arrivata in
    // `needs-human` già passata per l'uscita TERMINALE di VERDICT-EXIT
    // (followup-drainer.mjs) proprio per quel verdetto. Il loop misurato:
    // no-root-cause → escalate → questo pre-pass la re-accoda il giorno dopo,
    // prima che lo sweep settimanale la giudichi → stesso no-root-cause, da capo.
    for (const v of ['no-root-cause', 'blocked-workflows-scope', 'blocked-admin-settings', 'revenue-tracker-manual', 'already-fixed']) {
      const d = prepassDecision({ title: 'PostHog Exception: TypeError', verdict: v });
      expect(d.action, v).toBe('keep');
      expect(d.reason, v).toMatch(new RegExp(v));
    }
  });

  it('regressione #7307: `max-turns` vince sul riconoscimento di famiglia', () => {
    // Stesso loop di #5608 con un altro verdetto, misurato sulle 6 issue del
    // bucket `fix-outcome:max-turns` nella finestra 14gg. Due di quelle sei —
    // #7242 `Crawler Failure: Run zurich` e #7179 `Run volg` — erano state
    // parcheggiate `fu-parked` + `needs-human` dal drainer (path max-turns non
    // eleggibile alla decomposizione) e ri-accodate da QUESTO pre-pass alle
    // 06:49 del 2026-09-04 sul solo titolo di famiglia, senza che nulla fosse
    // cambiato dal verdetto: la run successiva rifà lo stesso cap di turni.
    // Le altre quattro le ha liberate lo sweep Claude scrivendo una scheda
    // nuova — input cambiato, porta di rientro legittima, non toccata da qui.
    //
    // L'invariante è «niente RI-ACCODO a costo zero», e vale ancora tale e
    // quale. Non è «niente azione»: dal #7280 una famiglia riconosciuta con
    // `max-turns` ed eleggibile va allo SCORPORO (vedi il test qui sotto), che
    // cambia l'input come lo cambia la scheda dello sweep.
    for (const title of ['Crawler Failure: Run zurich', 'PostHog Exception: TypeError']) {
      const d = prepassDecision({ title, verdict: 'max-turns' });
      expect(d.action, title).not.toBe('requeue');
    }
    // Ineleggibile allo scorporo → `keep` puro, con il verdetto nel motivo: è
    // il caso delle `from-decompose`, per cui la porta resta lo sweep (D5: il
    // secondo livello di scorporo è escluso su misura).
    for (const title of ['Crawler Failure: Run zurich', 'PostHog Exception: TypeError']) {
      const d = prepassDecision({ title, labels: ['from-decompose'], verdict: 'max-turns' });
      expect(d.action, title).toBe('keep');
      expect(d.reason, title).toMatch(/max-turns/);
    }
  });

  it('#7280: `max-turns` su famiglia riconosciuta è uno SCORPORO, non un keep', () => {
    // Il collo di bottiglia di `needs-human` non è l'ingresso ma l'USCITA:
    // misurato il 2026-09-04, 28 issue `needs-human` e `keep=28`, di cui 21 con
    // verdetto `max-turns`. Per 7 di esse — i `Crawler Failure: Run *` e
    // `[crawler-health] recruitingapp-2563` — il verdetto era l'UNICO motivo del
    // `keep`: famiglia riconosciuta, nessuna label che escluda lo scorporo.
    // Ci finiscono perché il gemello crawler del drainer (`crawlerFixDecision`)
    // parcheggia `max-turns` senza passare dalla DECOMPOSE-ROUTE che la path
    // queue-managed usa per lo stesso verdetto.
    for (const title of [
      'Crawler Failure: Run zurich',
      'Crawler Failure: Run volg',
      '[crawler-health] recruitingapp-2563: crawler unhealthy',
      'CWV field regression on a tracked page (#5001 watchlist)',
    ]) {
      const d = prepassDecision({ title, labels: ['fu-parked'], verdict: 'max-turns' });
      expect(d.action, title).toBe('decompose');
    }
    // Il gate di eleggibilità è quello del drainer, non una copia: le stesse
    // label che gli tolgono lo scorporo sull'aggregato lo tolgono anche qui.
    for (const l of ['decomposed:1', 'from-decompose', 'agent:decompose-queued', 'maybe-resolved']) {
      expect(prepassDecision({
        title: 'Crawler Failure: Run zurich', labels: [l], verdict: 'max-turns',
      }).action, l).toBe('keep');
    }
    // E la precedenza del #5608 non si tocca: un verdetto `NON_RETRYABLE` resta
    // `keep` anche su una issue perfettamente eleggibile allo scorporo. È fermo,
    // non troppo grande — scorporarlo riprodurrebbe lo stesso verdetto su N figlie.
    for (const v of ['no-root-cause', 'already-fixed', 'blocked-admin-settings', 'revenue-tracker-manual']) {
      expect(prepassDecision({
        title: 'Crawler Failure: Run zurich', labels: ['fu-parked'], verdict: v,
      }).action, v).toBe('keep');
    }
  });

  it('lo scorporo NON parte se il drainer ha già escluso la issue (❓ review #7318)', () => {
    // `issue-decompose.yml` non ri-controlla l'eleggibilità: va dritto al run
    // Claude. Il drainer invece esclude `decomposed:1`, `from-decompose`,
    // `agent:decompose*` e `maybe-resolved` (`isDecomposeEligible`). Senza il
    // gate, questo pre-pass mandava allo scorporo proprio le issue che il
    // drainer ne aveva appena escluse — spostando il loop dalla porta `requeue`
    // a quella `decompose` invece di chiuderlo.
    const title = 'follow-up(#6205): 3 item deferred — REST files-cap';
    expect(prepassDecision({ title }).action).toBe('decompose');
    for (const l of ['decomposed:1', 'from-decompose', 'agent:decompose-queued', 'maybe-resolved']) {
      // `keep`, non un `not.toBe('decompose')` qualsiasi: l'asserzione debole
      // lasciava passare il `requeue`, che è il ri-accodo intero del container —
      // «il modo documentato di rifare max-turns», cioè il loop da un'altra
      // porta (🔴 review #7325).
      expect(prepassDecision({ title, labels: [l] }).action, l).toBe('keep');
    }
    // E SENZA verdetto, che è il caso che il fallthrough mancava: `verdict` è
    // `null` sia quando la issue non porta un marker `FIX_OUTCOME`, sia quando
    // la lettura dei commenti fallisce e il `catch` in `main()` lo azzera.
    expect(prepassDecision({ title, labels: ['decomposed:1'], verdict: null }).action).toBe('keep');
    // Con un verdetto catturato, idem.
    expect(prepassDecision({ title, labels: ['from-decompose'], verdict: 'max-turns' }).action).toBe('keep');
  });

  it('un aggregato si scorpora anche col verdetto blocked-secrets (🟡 review #7318)', () => {
    // `STALE_BLOCK_VERDICTS` ritorna `requeue`, e stava sopra il ramo aggregato:
    // un container con `blocked-secrets` veniva ri-accodato intero, cioè «il
    // modo documentato di rifare max-turns». Lo scorporo ora lo precede.
    expect(prepassDecision({
      title: 'follow-up(#6205): 3 item deferred — REST files-cap', verdict: 'blocked-secrets',
    }).action).toBe('decompose');
    // Un titolo NON di famiglia con lo stesso verdetto resta `requeue`: la
    // decisione del proprietario del 2026-08-24 non è toccata.
    expect(prepassDecision({ title: 'una cosa qualunque', verdict: 'blocked-secrets' }).action).toBe('requeue');
  });

  it('il verdetto batte il requeue ma NON lo scorporo (🔴 review nanako#778)', () => {
    // La guardia stava PRIMA del ramo `AGGREGATE_ITEMS_RE` e gli toglieva il
    // `decompose`. È l'opposto del criterio che la costante dichiara: lo scorporo
    // CAMBIA l'input del fixer esattamente come la scheda dello sweep, ed è il
    // ramo che il drainer stesso sceglie su `max-turns` (DECOMPOSE-ROUTE). Il
    // difetto è arrivato con #7313 su `max-turns`, ma era già latente qui sui
    // verdetti `NON_RETRYABLE` dal #5608 — spostare il blocco lo toglie a tutti.
    for (const verdict of ['max-turns', 'no-root-cause']) {
      for (const title of [
        'follow-up(#6205): 3 item deferred — REST files-cap',
        'follow-up(#6206): 2 items deferred — plurale, che la copia locale mancava',
      ]) {
        expect(prepassDecision({ title, verdict }).action, `${verdict} / ${title}`).toBe('decompose');
      }
    }
  });

  it('senza un verdetto che batte la famiglia, il titolo decide come prima', () => {
    expect(prepassDecision({ title: 'PostHog Exception: TypeError' }).action).toBe('requeue');
    expect(prepassDecision({ title: 'PostHog Exception: TypeError', verdict: 'pr-created' }).action).toBe('requeue');
  });

  it('il verdetto batte il titolo non riconosciuto, e (post-#6427) anche agent:fix', () => {
    // Prima della fix #6427, `agent:fix` intercettava PRIMA del check sul
    // verdetto e tornava `keep`. Ora solo `agent:in-progress` intercetta, quindi
    // qui il verdetto superato decide: requeue.
    expect(prepassDecision({
      title: 'una cosa qualunque', labels: ['agent:fix'], verdict: 'blocked-secrets',
    }).action).toBe('requeue');
  });

  it('agent:in-progress resta più forte del verdetto superato', () => {
    expect(prepassDecision({
      title: 'una cosa qualunque', labels: ['agent:in-progress'], verdict: 'blocked-secrets',
    }).action).toBe('keep');
  });
});

describe('latestVerdict — entrambe le forme di timestamp', () => {
  it('legge created_at (REST) e createdAt (GraphQL), e vince il più recente', () => {
    expect(latestVerdict([
      { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' },
      { body: '<!-- FIX_OUTCOME: blocked-secrets -->', createdAt: '2026-08-22T10:00:00Z' },
    ])).toBe('blocked-secrets');
  });

  it('null senza marker, e tollera input vuoto', () => {
    expect(latestVerdict([{ body: 'solo testo' }])).toBeNull();
    expect(latestVerdict([])).toBeNull();
    expect(latestVerdict(null)).toBeNull();
  });
});

describe('l\'allowlist è un contratto, non un\'euristica', () => {
  it('ogni pattern è ancorato all\'inizio del titolo', () => {
    // I prefissi li scrive un nostro script e fanno parte del contratto di dedup
    // sul titolo canonico. Un pattern non ancorato matcherebbe a metà frase, e
    // una decisione del proprietario che *cita* un guasto verrebbe ri-accodata.
    for (const re of MONITOR_TITLE_PATTERNS) {
      expect(re.source.startsWith('^'), re.source).toBe(true);
    }
  });

  it('un titolo che NOMINA un guasto senza esserne uno resta keep', () => {
    expect(prepassDecision({
      title: 'Decidere se accettare i CI Failure: tests come rumore accettabile',
    }).action).toBe('keep');
  });
});

/**
 * ## Il riconoscimento del registro di VISION.md (#7280)
 *
 * Questi casi girano sul `VISION.md` REALE del repo, non su una fixture. È
 * deliberato: il difetto che chiudono non è «il parser sbaglia una tabella
 * inventata», è «il pre-pass legge male le righe che il proprietario ha
 * davvero scritto». Una fixture direbbe di sì a qualunque criterio.
 *
 * Il rischio del dato vivo — una riga riscritta rende rosso un test — è quello
 * giusto da correre: se la riga di #6280 smette di essere un sì pieno, il
 * criterio DEVE tornare a farsi guardare.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseVisionRegistry,
  matchRegistry,
  registryRowState,
  registryRowScope,
  citedRefs,
  blockedRefs,
  prepassNote,
  noteMarker,
} from '../scripts/ci/needs-human-prepass.mjs';

const VISION = fs.readFileSync(path.resolve(__dirname, '..', 'VISION.md'), 'utf-8');
const REGISTRY = parseVisionRegistry(VISION);

/** L'esito del pre-pass su un corpo che cita `#n`, senza altri segnali. */
function verdictFor(n: number) {
  const g = matchRegistry(`Scheda\n\nContesto: vedi #${n} per la decisione.`, REGISTRY, { homeScope: 'site' });
  if (!g.unconditional.length && !g.conditional.length) return 'nessuna-riga';
  return g.unconditional.length && !g.conditional.length ? 'sblocca' : 'annota';
}

describe('registro di VISION.md — incondizionata vs condizionata (i casi reali)', () => {
  it('il registro si legge davvero: la tabella non è vuota', () => {
    expect(REGISTRY.length).toBeGreaterThan(10);
  });

  it('#6280 (candidatura assistita): «SÌ, procedi» è un sì pieno → SBLOCCA', () => {
    expect(verdictFor(6280)).toBe('sblocca');
  });

  it('#4854 (aste targhe): «SÌ, procedi» → SBLOCCA', () => {
    expect(verdictFor(4854)).toBe('sblocca');
  });

  it('#5995 (repo weight): leve 2 e 5 «non autorizzate» → NON sblocca da solo', () => {
    // È la trappola centrale: una regola «cita una riga registrata → requeue»
    // riaprirebbe qui lavoro che il proprietario ha esplicitamente negato.
    expect(verdictFor(5995)).toBe('annota');
    const row = REGISTRY.find((r) => r.refs.includes(5995))!;
    expect(row.state).toBe('conditional');
    expect(row.why.join(' ')).toMatch(/NON è autorizzata|BACKLOG/);
  });

  it('#5983 (gate SEO): è un NO → NON sblocca', () => {
    expect(verdictFor(5983)).toBe('annota');
    expect(REGISTRY.find((r) => r.refs.includes(5983))!.why).toContain('decisione negativa');
  });

  it('#5681 (re-permission consensi): «NON si fa, per ora» → NON sblocca', () => {
    expect(verdictFor(5681)).toBe('annota');
  });

  it('#5926 (CMP unificata): «SÌ, con vincolo esplicito» → NON sblocca', () => {
    // Un sì che porta un requisito tecnico non è un via libera automatico: chi
    // lo implementa deve leggere il vincolo, e il pre-pass non sa leggerlo.
    expect(verdictFor(5926)).toBe('annota');
  });

  it('#5705 (avvisi di lavoro): famiglia job-alert riservata → NON sblocca', () => {
    expect(verdictFor(5705)).toBe('annota');
  });

  it('una issue che non cita nessuna riga non aggancia niente', () => {
    expect(verdictFor(999999)).toBe('nessuna-riga');
  });
});

describe('registryRowState — il criterio, non i suoi esempi', () => {
  it('il silenzio non è un sì: senza marcatore affermativo la riga è condizionata', () => {
    // L'asimmetria è la stessa dell'allowlist di famiglie: l'assenza di prova
    // non è prova. Un default «incondizionata» renderebbe pericolosa ogni riga
    // futura scritta in fretta.
    const r = registryRowState('Publisher doppio sulla stessa coda: spento lo schedule del sito');
    expect(r.state).toBe('conditional');
    expect(r.why[0]).toMatch(/nessun marcatore affermativo/);
  });

  it('`si` pronome NON è un sì: ogni riga negativa lo contiene', () => {
    // Un `/\bsi\b/i` leggerebbe come affermative esattamente le righe che negano.
    expect(registryRowState('NON si fa, per ora').state).toBe('conditional');
    expect(registryRowState('Le issue della famiglia job-alert si lasciano stare').state).toBe('conditional');
  });

  it('«non solo per questa issue» resta un sì pieno (#5928)', () => {
    // Un qualificatore su `\bnon\b` spegnerebbe il riconoscimento proprio sulle
    // righe più larghe, che sono quelle che vale di più riconoscere.
    expect(registryRowState('**SÌ, e i futuri deploy sono autonomi da ora** — non solo per questa issue').state)
      .toBe('unconditional');
  });

  it('«opzione A» sceglie fra alternative: non autorizza in blocco', () => {
    expect(registryRowState('#6227 (bande salariali stimate): **opzione A** — scrivere `salarySource`').state)
      .toBe('conditional');
  });
});

describe('numerazione: due repo, un registro', () => {
  it('`AGENTS.md #1` non è la issue #1', () => {
    // Senza il lookbehind la riga del 2026-08-20 entrava nel registro come una
    // decisione sulla issue #1 — un numero che qualunque corpo può nominare.
    expect([...citedRefs('vedi AGENTS.md #1 per il dettaglio')]).toEqual([]);
    expect([...citedRefs('vedi la issue #1 per il dettaglio')]).toEqual([1]);
  });

  it('una riga che parla del corpus non decide su un numero del sito', () => {
    // `VISION.md` sta sul sito ma registra il ciclo intero: le righe del
    // 2026-09-05 decidono su #727/#814/#832, che sono numeri del CORPUS.
    expect(registryRowScope('Obiettivo crawler-goal RIATTIVATO (#727 piano, #728 audit, corpus)')).toBe('corpus');
    expect(registryRowScope('#6280 (candidatura assistita): **SÌ, procedi**')).toBe('site');

    const corpusRow = { date: '2026-09-05', decision: 'x', source: '', refs: [832], scope: 'corpus', state: 'unconditional', why: [] };
    expect(matchRegistry('vedi #832', [corpusRow], { homeScope: 'site' }).refs).toEqual([]);
    expect(matchRegistry('vedi nanakokyobashi-rgb/frontaliere-articles#832', [corpusRow], { homeScope: 'site' }).refs)
      .toEqual([832]);
    expect(matchRegistry('vedi #832', [corpusRow], { homeScope: 'corpus' }).refs).toEqual([832]);
  });

  it('un riferimento a un terzo repo non conta', () => {
    expect([...citedRefs('facebook/react#1234', { repo: 'valerielinc-ops/frontaliere-si-o-no' })]).toEqual([]);
  });
});

describe('il registro non scavalca i verdetti che questo stadio non sa cambiare', () => {
  const yes = REGISTRY.filter((r) => r.refs.includes(6280));

  it('riga incondizionata + nessun verdetto → requeue col registro citato', () => {
    const d = prepassDecision({ title: 'candidatura assistita: checkout', body: 'vedi #6280', registry: REGISTRY });
    expect(d.action).toBe('requeue');
    expect(d.reason).toMatch(/registro di `VISION\.md`/);
  });

  it('`max-turns` batte il registro: la decisione non accorcia la run già morta', () => {
    const d = prepassDecision({
      title: 'candidatura assistita: checkout', body: 'vedi #6280', registry: REGISTRY, verdict: 'max-turns',
    });
    expect(d.action).not.toBe('requeue');
  });

  it('una riga sola condizionata basta a fermare lo sblocco, anche accanto a un sì pieno', () => {
    // Un corpo a cavallo fra #6280 (sì) e #5995 (leve non autorizzate) descrive
    // un lavoro che sta su entrambe: nel dubbio non si sblocca.
    expect(yes.length).toBeGreaterThan(0);
    const d = prepassDecision({ title: 'lavoro misto', body: 'tocca #6280 e #5995', registry: REGISTRY });
    expect(d.action).toBe('keep');
    expect(d.note).toMatch(/condizionata o negativa/);
  });

  it('la riga condizionata viene ALLEGATA: la issue non è più indistinguibile nel keep', () => {
    const d = prepassDecision({ title: 'repo weight', body: 'leva 2 di #5995', registry: REGISTRY });
    expect(d.action).toBe('keep');
    expect(d.note).toContain('Registro di `VISION.md`');
    expect(d.note).toMatch(/2026-08-24/);
    expect(d.marker).toBe('<!-- PREPASS_NOTE: r=5995 -->');
  });

  it('il tracker permanente non si annota (il digest cambia corpo ogni lunedì)', () => {
    const d = prepassDecision({
      title: '🧭 Decisioni del proprietario — digest', body: 'vedi #5995',
      labels: ['agent:no-age-out'], registry: REGISTRY,
    });
    expect(d.action).toBe('keep');
    expect(d.note).toBeUndefined();
  });

  // #7648: `keep-open` dice la stessa cosa di `agent:no-age-out` — la causa vive
  // fuori dal repository — e va letta dallo stesso ramo, altrimenti il prepass
  // ri-accoda o scorpora un'attesa altrui.
  it('anche keep-open è un tracker: keep, mai accodato né scorporato', () => {
    const d = prepassDecision({
      title: 'Instagram/TikTok publishing: attivare i poster',
      body: 'due review esterne',
      labels: ['keep-open'],
      registry: REGISTRY,
    });
    expect(d.action).toBe('keep');
    expect(d.reason).toMatch(/tracker/i);
  });
});

describe('blocchi scaduti — la forma reale di nanako#471', () => {
  const BODY = [
    'Scope residuo dal body di PR #433.',
    '',
    '## 1. Gemello sito non ancora portato — blocked su PR esterna aperta',
    '',
    'Stato dichiarato nel body: `PR concatenata valerielinc-ops/frontaliere-si-o-no#6023`, non ancora mergiata.',
    '',
    '## 2. Ledger diagnostico — nessun blocco qui',
    '',
    'Si fa nello stesso giro, vedi #999.',
  ].join('\n');

  it('il riferimento sta tre paragrafi sotto la parola `blocked`: la riga non basta, la sezione sì', () => {
    const refs = blockedRefs(BODY, { homeScope: 'corpus' });
    expect(refs.map((r) => r.key)).toEqual(['valerielinc-ops/frontaliere-si-o-no#6023']);
  });

  it('una sezione senza `blocked` non contribuisce riferimenti', () => {
    expect(blockedRefs(BODY, { homeScope: 'corpus' }).some((r) => r.number === 999)).toBe(false);
  });

  it('un corpo che non nomina mai `blocked` costa zero letture', () => {
    expect(blockedRefs('nessun blocco qui, solo #123', { homeScope: 'site' })).toEqual([]);
  });

  it('la nota dice stato e data, e il blocco scaduto da solo NON instrada', () => {
    // Il titolo qui NON è di famiglia monitor apposta: `follow-up(#433):` lo
    // sarebbe e il `requeue` verrebbe da lì, non dal blocco scaduto — cioè il
    // test non proverebbe niente su questo meccanismo.
    const stale = [{ key: 'a#1', link: 'valerielinc-ops/frontaliere-si-o-no#6023', state: 'MERGED', at: '2026-08-18' }];
    const d = prepassDecision({ title: 'gemello sito ai-models.mjs non portato', staleBlocks: stale });
    expect(d.action).toBe('keep');
    expect(d.note).toContain('MERGED');
    expect(d.note).toContain('2026-08-18');
    expect(noteMarker({ refs: [] }, stale)).toBe('<!-- PREPASS_NOTE: b=a#1 -->');
  });

  it('senza righe e senza blocchi non si scrive niente (nessun commento a vuoto)', () => {
    expect(prepassNote({ unconditional: [], conditional: [], refs: [] }, [])).toBeNull();
    expect(noteMarker({ refs: [] }, [])).toBeNull();
  });
});
