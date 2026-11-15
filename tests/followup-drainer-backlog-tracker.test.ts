/**
 * followup-drainer — detectBacklogTracker pre-flight (#5312/#5314/#5283/#18710).
 *
 * Le issue di handoff di sessione ("Backlog dalla sessione …", "… il residuo")
 * elencano il lavoro residuo invece di descrivere UN difetto: nessuna root
 * cause comune, nessun target-file proprio. Il fixer ci finiva dentro e usciva
 * con un fix parziale o con i turni esauriti. Questo detector le intercetta
 * PRIMA della promozione.
 *
 * CONSERVATIVO (bias a promuovere): serve marker nel titolo + body che ENUMERA
 * ≥3 voci. Il marker da solo non basta — misurato sulle 2360 issue del repo
 * compare in 14 titoli, ma 7 di quelle sono backlog *in prosa* con uno scope
 * reale (#3337, #3029, #3030, …) e devono restare promuovibili.
 */
import { describe, it, expect } from 'vitest';
import { detectBacklogTracker, countBacklogItems } from '../scripts/ci/followup-drainer.mjs';

/** Forma reale di #5312 / #5314: sezioni numerate `## N.`, nessuna checkbox. */
const REAL_BODY_5314 = [
  'Residuo della sessione del 2026-08-07. Il lavoro fatto è nella PR #5273.',
  '',
  '## 1. Portare a casa la PR #5273 — bloccante',
  '',
  'Stato alla chiusura: OPEN, DIRTY, CI da rifare.',
  '',
  '## 2. Il corpus: engine e mirror',
  '',
  'Testo.',
  '',
  '## 3. Deploy',
  '',
  'Testo.',
].join('\n');

/** Forma reale di #5283: task-list `- [ ]` sotto heading non numerati. */
const REAL_BODY_5283 = [
  'Issue #5012 è stata chiusa dal merge della PR #5184; questo è il tracker.',
  '',
  '## Prodotto — Fase 3 dell’issue originale, mai iniziata',
  '',
  '- [ ] Collegare CompanyAlert al sistema di raccomandazione.',
  '- [ ] Altri canali di notifica.',
  '- [x] Deep-link email (fatto in #5184).',
  '',
  '## Deliverability',
  '',
  '- [ ] Warm-up del dominio mittente.',
].join('\n');

/** Forma emessa da issue-decompose per il contenitore residuo professione×cantone. */
const RESIDUAL_PROFESSION_CANTON_TITLE = 'residuo professione×cantone — 346 gap da scomporre';
const RESIDUAL_PROFESSION_CANTON_BODY = [
  '## Scheda',
  '- CAUSA: il contenitore non ha una root cause implementativa singola.',
  '',
  '## Residuo snapshot da scomporre',
  '- addetto-pulizie (21): AG, APPENZELLO, BE, FR, GE, GL, GR, JU, LU, NE, NW, SG, SH, SO, SZ, TG, UR, VD, VS, ZG, ZH',
  '- architetto (21): AG, APPENZELLO, BASILEA, BE, GE, GL, GR, JU, LU, NE, NW, OW, SG, SH, SO, SZ, TG, UR, VD, VS, ZG',
  '- elettricista (2): GL, JU',
  '',
  '## Origine',
  'Parent: #13323',
].join('\n');

/** Forma del contenitore residual follow-up #18710: item FU con target verificabile. */
const RESIDUAL_FOLLOWUP_TITLE =
  'Residual follow-up 2026-11-08: CI, portal, crawler and metadata verification';
const RESIDUAL_FOLLOWUP_BODY = [
  '## Scheda',
  '- CAUSA: i residui sono verifiche indipendenti e vanno scorporati.',
  '',
  '## Residui da scorporare',
  '- FU-2026-11-001 — target scripts/assisted-application/lib/portal/portal.mjs; METRICA: test.',
  '- FU-2026-11-002 — target scripts/assisted-application/lib/portal/portal.mjs; METRICA: rg.',
  '- FU-2026-11-003 — target tests/assisted-application-portal-hardening.test.ts; METRICA: test.',
  '- FU-2026-11-007 — target scripts/ci/check-sibling-patterns.mjs; METRICA: node.',
  '- FU-2026-11-008 — target scripts/seo/bing-site-explorer-crawl.mjs; METRICA: test.',
  '- FU-2026-11-011 — target scripts/assisted-application/lib/portal/read-only-contracts.mjs; METRICA: e2e.',
  '- FU-2026-11-013 — target .github/workflows/backfill-expired-from-history.yml; METRICA: test.',
  '- FU-2026-11-015 — target tests/assisted-application-review.test.ts; METRICA: test.',
  '- FU-2026-11-016 — target scripts/lib/klinik-adelheid-job-parser.mjs; METRICA: typecheck.',
  '- FU-2026-11-018 — target scripts/assisted-application/lib/portal/residence-address.mjs; METRICA: test.',
  '- FU-2026-11-019 — target scripts/assisted-application/portal-e2e.mjs; METRICA: e2e.',
  '- FU-2026-11-020 — target tests/seo/bing-site-explorer-crawl.test.ts; METRICA: test.',
  '- FU-2026-11-024 — target scripts/lib/live-article-meta.mjs; METRICA: typecheck.',
  '',
  '## Origine',
  'Parent: #17602',
].join('\n');

describe('detectBacklogTracker — contenitore di lavoro residuo (park preemptivo)', () => {
  it('rileva la forma reale #5314 (marker "Backlog" + 3 sezioni numerate)', () => {
    expect(
      detectBacklogTracker('Backlog: il residuo della sessione del 2026-08-07 (PR #5273)', REAL_BODY_5314),
    ).toBe(true);
  });

  it('rileva la forma reale #5283 (marker "il residuo" a metà titolo + 4 checkbox)', () => {
    expect(
      detectBacklogTracker('CompanyAlert #5012: il residuo (Fase 3, deliverability, SEO)', REAL_BODY_5283),
    ).toBe(true);
  });

  it('è case-insensitive sul marker di titolo', () => {
    expect(detectBacklogTracker('BACKLOG dalla sessione #4974', REAL_BODY_5314)).toBe(true);
  });

  it('conta insieme checkbox e sezioni numerate (le due forme coesistono)', () => {
    const body = ['## 1. Prima', '- [ ] voce a', '- [ ] voce b'].join('\n');
    expect(detectBacklogTracker('Backlog misto', body)).toBe(true);
  });
});

describe('detectBacklogTracker — NON backlog-tracker (promuovi)', () => {
  it('NON scatta sul marker da solo, senza body enumerato — il caso #3337/#3029', () => {
    // "Backlog: 77 aziende dirette svizzere non ancora crawlate": titolo da
    // backlog, ma UNO scope reale descritto in prosa → deve restare fixabile.
    const prosa = [
      'Le 77 aziende non hanno crawler. Root cause: consolidamento #3701.',
      '',
      'Serve un crawler generico multi-employer.',
    ].join('\n');
    expect(detectBacklogTracker('Backlog: 77 aziende dirette svizzere non ancora crawlate', prosa)).toBe(
      false,
    );
  });

  it('NON scatta sotto soglia (2 voci enumerate)', () => {
    const body = ['## 1. Prima', 'testo', '', '## 2. Seconda', 'testo'].join('\n');
    expect(detectBacklogTracker('Backlog quasi vuoto', body)).toBe(false);
  });

  it('NON scatta senza marker nel titolo, anche con body molto enumerato', () => {
    expect(detectBacklogTracker('fix(seo): canonical errato su /lavoro-zurigo-autista/', REAL_BODY_5283)).toBe(
      false,
    );
  });

  it('NON scatta su "residuo" senza l’articolo (marker richiede "il residuo")', () => {
    expect(detectBacklogTracker('fix: rimuove residuo di cache stale', REAL_BODY_5283)).toBe(false);
  });

  it('gestisce input vuoto/null senza throw', () => {
    expect(detectBacklogTracker('', '')).toBe(false);
    expect(
      detectBacklogTracker(undefined as unknown as string, undefined as unknown as string),
    ).toBe(false);
  });
});

describe('countBacklogItems', () => {
  it('conta le sezioni numerate della forma #5314', () => {
    expect(countBacklogItems(REAL_BODY_5314)).toBe(3);
  });

  it('conta checkbox spuntate e non spuntate della forma #5283', () => {
    expect(countBacklogItems(REAL_BODY_5283)).toBe(4);
  });

  it('conta le righe del residual snapshot solo dentro il suo header di dominio', () => {
    expect(countBacklogItems(RESIDUAL_PROFESSION_CANTON_BODY)).toBe(3);
    expect(countBacklogItems(RESIDUAL_PROFESSION_CANTON_BODY.replace(
      '## Residuo snapshot da scomporre',
      '## Snapshot non classificato',
    ))).toBe(0);
  });

  it('instrada il contenitore professione×cantone allo stadio di decomposizione', () => {
    expect(detectBacklogTracker(
      RESIDUAL_PROFESSION_CANTON_TITLE,
      RESIDUAL_PROFESSION_CANTON_BODY,
    )).toBe(true);
  });

  it('instrada il contenitore residual follow-up con 13 item FU allo stadio di decomposizione', () => {
    expect(detectBacklogTracker(RESIDUAL_FOLLOWUP_TITLE, RESIDUAL_FOLLOWUP_BODY)).toBe(true);
    expect(countBacklogItems(RESIDUAL_FOLLOWUP_BODY)).toBe(13);
  });

  it('non usa il solo prefisso residual follow-up senza l’inventario FU target', () => {
    const body = [
      '## Residui da scorporare',
      '- FU-2026-11-001 — target scripts/ci/one.mjs',
      '- FU-2026-11-002 — target scripts/ci/two.mjs',
    ].join('\n');
    expect(detectBacklogTracker(RESIDUAL_FOLLOWUP_TITLE, body)).toBe(false);
    expect(detectBacklogTracker(
      'Residual follow-up: prose-only handoff',
      ['## Residui da scorporare', '- voce normale', '- altra voce', '- terza voce'].join('\n'),
    )).toBe(false);
  });

  it('non usa il solo elenco di professioni per riconoscere un titolo non-target', () => {
    expect(detectBacklogTracker(
      'fix: residuo di una singola pagina professionale',
      RESIDUAL_PROFESSION_CANTON_BODY,
    )).toBe(false);
  });

  it('non conta un heading `##` non numerato', () => {
    expect(countBacklogItems('## Obiettivo\n\n## Contesto')).toBe(0);
  });

  it('non conta un bullet normale né un "1." in mezzo al testo', () => {
    expect(countBacklogItems('- voce normale\n\nvedi il punto 1. qui')).toBe(0);
  });

  it('ritorna 0 su body vuoto/null', () => {
    expect(countBacklogItems('')).toBe(0);
    expect(countBacklogItems(undefined as unknown as string)).toBe(0);
  });
});
