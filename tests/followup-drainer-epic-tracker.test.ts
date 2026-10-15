/**
 * followup-drainer — detectEpicTracker pre-flight (#4517).
 *
 * `fix-outcome:revenue-tracker-manual` ricorre 10×/14gg: un batch di issue
 * `[EPIC] ...` delega l'intero scope a sub-issue già in coda propria — il
 * fixer Claude lo scopre sempre, dopo un run completo. Questo detector
 * intercetta il pattern PRIMA della promozione. CONSERVATIVO (bias a
 * promuovere): serve titolo `[EPIC] ...` + sezione `## Sub-issues` con
 * almeno un riferimento `#N`.
 */
import { describe, it, expect } from 'vitest';
import { detectEpicTracker, extractSubIssueNumbers } from '../scripts/ci/followup-drainer.mjs';

const REAL_BODY_4459 = [
  '## Obiettivo',
  '',
  'Catturare la domanda "stipendio {professione} {cantone/citta}".',
  '',
  '## Sub-issues',
  '',
  '- [ ] #4460 — conteggio + piano canonical hub-spoke',
  '- [ ] #4461 — plugin SSG salary-intent professione x cantone',
  '',
  '## Criteri di accettazione epic',
  '',
  '- Piano canonical documentato prima del plugin.',
].join('\n');

describe('detectEpicTracker — epic di coordinamento (park preemptivo)', () => {
  it('rileva il body reale #4459 ([EPIC] + ## Sub-issues con 2 riferimenti)', () => {
    expect(detectEpicTracker('[EPIC] feat(seo): landing stipendio professione×cantone', REAL_BODY_4459)).toBe(
      true,
    );
  });

  it('rileva con un solo sub-issue elencato', () => {
    const body = ['## Sub-issues', '', '- [ ] #100 — unica sub-issue'].join('\n');
    expect(detectEpicTracker('[EPIC] singola sub-issue', body)).toBe(true);
  });

  it('è case-insensitive sul prefisso [EPIC]', () => {
    const body = ['## Sub-issues', '- [ ] #1'].join('\n');
    expect(detectEpicTracker('[epic] lowercase title', body)).toBe(true);
  });
});

describe('detectEpicTracker — NON epic-tracker (promuovi)', () => {
  it('non scatta senza prefisso [EPIC] nel titolo, anche con ## Sub-issues', () => {
    const body = ['## Sub-issues', '- [ ] #100'].join('\n');
    expect(detectEpicTracker('feat(seo): normal issue title', body)).toBe(false);
  });

  it('non scatta se manca la sezione ## Sub-issues', () => {
    expect(detectEpicTracker('[EPIC] no sub-issues section', '## Obiettivo\n\nScope diretto qui.')).toBe(
      false,
    );
  });

  it('non scatta se la sezione ## Sub-issues è vuota (nessun riferimento #N)', () => {
    const body = ['## Sub-issues', '', 'TBD — non ancora decomposta.', '', '## Altro'].join('\n');
    expect(detectEpicTracker('[EPIC] sezione vuota', body)).toBe(false);
  });

  it('non scatta se il riferimento #N è FUORI dalla sezione ## Sub-issues (es. in ## Vincoli)', () => {
    const body = ['## Sub-issues', '', 'TBD.', '', '## Vincoli', '', 'Vedi anche #9999.'].join('\n');
    expect(detectEpicTracker('[EPIC] riferimento fuori sezione', body)).toBe(false);
  });

  it('gestisce input vuoto/null senza throw', () => {
    expect(detectEpicTracker('', '')).toBe(false);
    expect(detectEpicTracker(undefined as unknown as string, undefined as unknown as string)).toBe(false);
  });
});

describe('extractSubIssueNumbers', () => {
  it('estrae tutti i numeri dalla sezione ## Sub-issues del body reale #4459', () => {
    expect(extractSubIssueNumbers(REAL_BODY_4459)).toEqual([4460, 4461]);
  });

  it('dedupe numeri ripetuti', () => {
    const body = ['## Sub-issues', '- [ ] #5 — a', '- [ ] #5 — duplicato'].join('\n');
    expect(extractSubIssueNumbers(body)).toEqual([5]);
  });

  it('ritorna array vuoto senza sezione ## Sub-issues', () => {
    expect(extractSubIssueNumbers('## Obiettivo\n\nNiente qui.')).toEqual([]);
  });

  it('ignora riferimenti fuori dalla sezione ## Sub-issues', () => {
    const body = ['## Sub-issues', '- [ ] #1', '', '## Altro', 'menziona #2 ma fuori scope'].join('\n');
    expect(extractSubIssueNumbers(body)).toEqual([1]);
  });
});
