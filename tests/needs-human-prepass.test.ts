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
    for (const title of ['Crawler Failure: Run zurich', 'PostHog Exception: TypeError']) {
      const d = prepassDecision({ title, verdict: 'max-turns' });
      expect(d.action, title).toBe('keep');
      expect(d.reason, title).toMatch(/max-turns/);
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
