/**
 * followup-drainer — un padre decomposto non è lavoro del fixer (#7340).
 *
 * Dopo lo scorporo lo scope vive nelle sub-issue (`DECOMPOSED_INTO`), che
 * entrano in coda da sole; il padre ha un unico stato terminale, il
 * PARENT-CLOSE a figlie tutte chiuse. Finché `decomposed:1` non escludeva i
 * candidati del fixer, il padre veniva ri-armato dal RESCUE e ripromosso dal
 * DRAIN: un run Claude su una issue senza lavoro proprio, che non può che
 * finire senza PR (o duplicare una figlia), e da lì di nuovo in coda fino a
 * `fu-parked`. Misurato il 2026-09-04: #7340 in `agent:fix` con `fu-attempt:1`
 * il giorno dopo essere stata scorporata in #7382-#7386, e altri tre padri —
 * #7375 #7345 #7343 — nello stesso stato.
 *
 * L'invariante era già a valle (AGE-OUT, VERDICT-EXIT escludono `decomposed:1`
 * da sempre): questi test la fissano anche a monte.
 */
import { describe, it, expect } from 'vitest';
import {
  PARENT_DEQUEUED_MARKER,
  applyParentDequeue,
  isDecomposedParent,
  isDecomposeEligible,
  parentDequeueCommentDecision,
} from '../scripts/ci/followup-drainer.mjs';

const iss = (labels: string[], extra: Record<string, unknown> = {}) => ({
  number: 7340,
  title: 'follow-up(#7332): 4 item deferred — information-gain',
  labels: labels.map((name) => ({ name })),
  ...extra,
});

describe('isDecomposedParent', () => {
  it('vero solo per il padre decomposto', () => {
    expect(isDecomposedParent(iss(['follow-up', 'decomposed:1', 'agent:fix']))).toBe(true);
  });

  it('falso per una follow-up normale in coda', () => {
    expect(isDecomposedParent(iss(['follow-up', 'agent:fix-queued', 'fu-prio:high']))).toBe(false);
  });

  it('falso per una FIGLIA della decomposizione: quella il lavoro ce l\'ha', () => {
    // `from-decompose` è il lato opposto del marcatore: atomica, con scheda,
    // ed è esattamente ciò che il fixer deve prendere in carico.
    expect(isDecomposedParent(iss(['follow-up', 'from-decompose', 'agent:fix-queued']))).toBe(false);
  });

  it('tollera una issue senza label', () => {
    expect(isDecomposedParent({ number: 1, labels: [] })).toBe(false);
    expect(isDecomposedParent({ number: 1 })).toBe(false);
  });
});

describe('la selezione dei candidati fixer esclude i padri decomposti', () => {
  // Replica dei tre predicati di filtro dei call-site (RESCUE stuckFix /
  // crawlerFix, DRAIN queued): tutti passano per `isDecomposedParent`.
  const parent = iss(['follow-up', 'decomposed:1', 'agent:fix', 'fu-attempt:1']);
  const child = iss(['follow-up', 'from-decompose', 'agent:fix-queued', 'fu-prio:high']);

  it('il padre non è ri-armabile né promuovibile, la figlia sì', () => {
    expect(isDecomposedParent(parent)).toBe(true);
    expect(isDecomposedParent(child)).toBe(false);
  });

  it('coerenza con l\'esclusione già in vigore a valle', () => {
    // Stesso soggetto, stessa risposta: un padre decomposto non rientra
    // nemmeno nello stadio di scorporo (anti-ricorsione).
    expect(isDecomposeEligible(parent)).toBe(false);
  });
});

describe('PARENT-DEQUEUE: un commento solo, il riaccodamento resta un segnale', () => {
  // Misurato il 2026-10-03: 13 commenti identici su 9443 e su 9508 in 25 ore,
  // uno per ogni tick in cui la label era stata rimessa.
  const BODY = 'padre decomposto fuori dalla coda del fixer';

  /** Una issue finta: `comments` è ciò che la lettura restituisce. */
  function harness(comments: Array<{ body: string }> | null) {
    const posted: string[] = [];
    const removed: number[] = [];
    const logs: string[] = [];
    const io = {
      readComments: () => comments,
      postComment: (_num: number, body: string) => {
        posted.push(body);
        comments?.push({ body });
      },
      removeLabels: (num: number) => { removed.push(num); },
      body: BODY,
      log: (line: string) => { logs.push(line); },
    };
    return { io, posted, removed, logs };
  }

  it('primo giro: commento col marker in testa, label tolte', () => {
    const h = harness([{ body: 'un commento qualsiasi' }]);
    expect(applyParentDequeue({ number: 9443 }, h.io)).toBe('comment');
    expect(h.posted).toEqual([`${PARENT_DEQUEUED_MARKER}\n${BODY}`]);
    expect(h.removed).toEqual([9443]);
  });

  it('secondo giro (label rimessa): label tolte, ZERO commenti, decisione `repeat` con warning', () => {
    const h = harness([]);
    expect(applyParentDequeue({ number: 9443 }, h.io)).toBe('comment');
    expect(applyParentDequeue({ number: 9443 }, h.io)).toBe('repeat');
    expect(h.posted).toHaveLength(1); // cron-count-ok: un solo commento è il contratto dell'idempotenza
    expect(h.removed).toEqual([9443, 9443]);
    expect(h.logs.some((l) => l.startsWith('::warning::parent-dequeue ripetuto #9443'))).toBe(true);
  });

  it('lettura dei commenti fallita (null o eccezione): zero commenti, label tolte comunque', () => {
    const asNull = harness(null);
    expect(applyParentDequeue({ number: 9508 }, asNull.io)).toBe('unreadable');
    expect(asNull.posted).toEqual([]);
    expect(asNull.removed).toEqual([9508]);

    const throwing = harness([]);
    throwing.io.readComments = () => { throw new Error('gh: HTTP 502'); };
    expect(applyParentDequeue({ number: 9508 }, throwing.io)).toBe('unreadable');
    expect(throwing.posted).toEqual([]);
    expect(throwing.removed).toEqual([9508]);
  });

  it('un commento fallito non impedisce la rimozione delle label', () => {
    const h = harness([]);
    h.io.postComment = () => { throw new Error('gh: HTTP 500'); };
    expect(applyParentDequeue({ number: 9443 }, h.io)).toBe('comment');
    expect(h.removed).toEqual([9443]);
  });

  it('i commenti senza marker (i 13 storici) non contano come dequeue già annunciato', () => {
    expect(parentDequeueCommentDecision([{ body: `⏭️ ${BODY}` }])).toBe('comment');
    expect(parentDequeueCommentDecision([{ body: `<!--PARENT_DEQUEUED-->\n${BODY}` }])).toBe('repeat');
    expect(parentDequeueCommentDecision(undefined)).toBe('unreadable');
  });
});
