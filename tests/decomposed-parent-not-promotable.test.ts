/**
 * Padre decomposto → mai promosso al fixer (#6504).
 *
 * Lo stadio di decomposizione lascia il padre APERTO con `decomposed:1`: il suo
 * lavoro vive nelle sub-issue figlie e lo chiude il PARENT-CLOSE del drainer
 * quando sono tutte chiuse. Tre passi lo sapevano già (`isAgeOutCandidate`,
 * `isReparkableCandidate`, il pool del VERDICT-EXIT); i due che PROMUOVONO —
 * il rescue degli orfani nel drainer e il pass triaged-but-not-routed di
 * `triage-sweep` — no. Il buco era un loop chiuso e misurato su #6504: il padre
 * resta `agent:fix` senza PR → il rescue lo vede orfano e lo ri-accoda → il
 * DRAIN lo ripromuove → il fixer riscopre l'overlap con le figlie e chiude
 * `overlap-skip`, che è deliberatamente FUORI da `NON_RETRYABLE` (per una PR
 * bloccante è transitorio) → si ricomincia. Due run Claude complete il
 * 2026-09-03 più due `max-turns` prima, tutte con esito «skip senza PR».
 *
 * Questi test fissano la regola sulla funzione pura condivisa, non sul testo dei
 * sorgenti, e coprono il rientro dalla porta di servizio: dopo che il drainer
 * ripulisce le label di routing stantie, il padre diventa "triaged senza
 * routing" — esattamente il pool che `triage-sweep` ri-instrada.
 */
import { describe, it, expect } from 'vitest';
import { isDecomposedParent, LBL_DECOMPOSED, classifyIssue } from '../scripts/lib/classify-issue.mjs';
import { isAgeOutCandidate, isReparkableCandidate } from '../scripts/ci/followup-drainer.mjs';

const iss = (labels: string[], extra: Record<string, unknown> = {}) => ({
  number: 6504,
  title: 'Aziende senza logo sulle pagine annuncio di lavoro',
  labels: labels.map((name) => ({ name })),
  ...extra,
});

// Le label reali di #6504 al momento del quarto run sprecato.
const PARENT_6504 = [
  'priority:medium', 'agent:fix', 'agent:triaged', 'fu-prio:low',
  'fu-attempt:2', 'crawler-data-quality', 'agent:in-progress', LBL_DECOMPOSED,
];

describe('isDecomposedParent', () => {
  it('riconosce il padre dalla label, non dal titolo né dai commenti', () => {
    expect(isDecomposedParent(iss(PARENT_6504))).toBe(true);
    expect(isDecomposedParent(iss([LBL_DECOMPOSED]))).toBe(true);
  });

  it('non tocca le figlie né una follow-up normale', () => {
    expect(isDecomposedParent(iss(['from-decompose', 'agent:fix-queued']))).toBe(false);
    expect(isDecomposedParent(iss(['agent:fix-queued', 'fu-prio:low']))).toBe(false);
  });

  it('è totale su input degeneri (mai un throw dentro un .filter di pool)', () => {
    expect(isDecomposedParent({})).toBe(false);
    expect(isDecomposedParent(undefined as never)).toBe(false);
    expect(isDecomposedParent({ labels: [] })).toBe(false);
  });
});

describe('#6504 — il padre non entra in nessun pool di promozione', () => {
  // Il pool `stuckFix` del rescue è `isQueueManaged && !queued && !parked &&
  // !isDecomposedParent`. La issue reale è route='queue', quindi prima di questo
  // fix passava i primi tre predicati: è l'ultimo che deve fermarla.
  it('#6504 è queue-managed (quindi era davvero eleggibile al rescue)', () => {
    expect(classifyIssue(iss(PARENT_6504).title, PARENT_6504).route).toBe('queue');
  });

  it('il predicato è ciò che la esclude dal rescue e dal DRAIN', () => {
    const parent = iss(PARENT_6504);
    const stuckFixEligible = !isDecomposedParent(parent);
    expect(stuckFixEligible).toBe(false);
    // DRAIN: stesso guard sulla coda, per una label rimessa a mano o
    // sopravvissuta a un tick precedente a questo fix.
    const queued = [iss(PARENT_6504), iss(['agent:fix-queued', 'fu-prio:low'], { number: 7000 })];
    expect(queued.filter((i) => !isDecomposedParent(i)).map((i) => i.number)).toEqual([7000]);
  });

  it('resta escluso da age-out e parked-retry (regressione dei guard già esistenti)', () => {
    const parked = iss([...PARENT_6504.filter((l) => l !== 'agent:fix'), 'fu-parked']);
    expect(isReparkableCandidate(parked)).toBe(false);
    expect(isAgeOutCandidate(iss([LBL_DECOMPOSED, 'agent:triaged']), {
      now: Date.parse('2027-01-01T00:00:00Z'),
      ageOutDays: 30,
    })).toBe(false);
  });
});

describe('triage-sweep — la porta di servizio dopo il cleanup del drainer', () => {
  // ROUTING_LABELS da triage-sweep.mjs: il pool `unrouted` è
  // `agent:triaged` && nessuna di queste && !isDecomposedParent.
  const ROUTING_LABELS = ['agent:fix', 'agent:fix-queued', 'fu-parked', 'fu-attempt:1', 'fu-attempt:2', 'fu-attempt:3'];
  const has = (i: { labels: { name: string }[] }, l: string) => i.labels.some((x) => x.name === l);
  const unrouted = (pool: ReturnType<typeof iss>[]) =>
    pool.filter((i) => !ROUTING_LABELS.some((r) => has(i, r)) && !isDecomposedParent(i));

  it('il padre ripulito dal drainer NON viene ri-instradato', () => {
    // Stato esatto lasciato dal CLEANUP: niente agent:fix/agent:fix-queued e
    // niente fu-attempt (le label di routing stantie sono andate).
    const cleaned = iss(['priority:medium', 'agent:triaged', 'crawler-data-quality', LBL_DECOMPOSED]);
    expect(has(cleaned, 'agent:fix')).toBe(false); // davvero "senza routing"
    expect(unrouted([cleaned])).toEqual([]);
  });

  it('una issue triaged senza routing e senza decomposizione resta instradabile', () => {
    const normale = iss(['agent:triaged', 'priority:medium'], { number: 7001 });
    expect(unrouted([normale]).map((i) => i.number)).toEqual([7001]);
  });
});
