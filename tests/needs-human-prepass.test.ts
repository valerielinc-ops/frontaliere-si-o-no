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

  it.each(['agent:fix', 'agent:fix-queued', 'agent:decompose', 'agent:decompose-queued', 'agent:in-progress'])(
    'già in lavorazione (%s) → keep, mai un doppio instradamento', (label) => {
      expect(prepassDecision({ title: 'CI Failure: tests', labels: [label] }).action).toBe('keep');
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

  it('il verdetto batte il titolo non riconosciuto, non le label di lavorazione', () => {
    expect(prepassDecision({
      title: 'una cosa qualunque', labels: ['agent:fix'], verdict: 'blocked-secrets',
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
