/**
 * followup-drainer — su un bucket giornaliero il verdetto del fixer vale per
 * l'ITEM, non per la issue.
 *
 * Il difetto: tutti gli stadi del drainer (rescue, VERDICT-EXIT, parked-retry)
 * leggevano l'ULTIMO `FIX_OUTCOME` della issue e lo confrontavano con
 * `NON_RETRYABLE`. Su un bucket giornaliero quel verdetto riguarda un solo
 * item, e dopo `route-already-fixed.mjs` e' gia' stato scritto sull'item
 * (`FU_ITEM_EVIDENCE` / `FU_ITEM_BLOCKED`, `State: blocked`). Leggerlo ancora
 * come verdetto del bucket parcheggiava, flaggava `maybe-resolved` o differiva
 * l'intera issue, e gli item successivi non venivano mai raggiunti (la issue
 * 8334: `fu-attempt:3` + `fu-parked` + `maybe-resolved` insieme).
 *
 * Titolo di fallimento: «Drainer: bucket giornaliero fermato dal verdetto di un
 * item già scritto sull'item».
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bucketVerdictCoverage,
  effectiveIssueVerdict,
  isTrustedMarkerAuthor,
  latestFixOutcomeFromComments,
} from '../scripts/ci/followup-drainer.mjs';
import {
  itemAttemptMarker,
  itemBlockedMarker,
  itemEvidenceMarker,
} from '../scripts/ci/lib/followup-item-evidence.mjs';

const ITEM = 'FU-2026-10-02-004';
const BOT = { author: { login: 'github-actions' }, authorAssociation: 'NONE' };
const STRANGER = { author: { login: 'someone-else' }, authorAssociation: 'NONE' };

const outcome = (code: string, createdAt: string, who = BOT) => ({
  ...who,
  body: `<!-- FIX_OUTCOME: ${code} -->\nverdetto del fixer`,
  createdAt,
});
const evidence = (createdAt: string, who = BOT) => ({
  ...who,
  body: [
    itemAttemptMarker({ item: ITEM, outcome: 'already-fixed', run: 111 }),
    itemEvidenceMarker({ item: ITEM, pr: 42, commit: 'abcdef1234567', run: 222, link: 'target-file' }),
    itemBlockedMarker({ item: ITEM, reason: 'awaiting-verification' }),
    'item in attesa di verifica',
  ].join('\n'),
  createdAt,
});
const blocked = (reason: string, createdAt: string, who = BOT) => ({
  ...who,
  body: `${itemBlockedMarker({ item: ITEM, reason })}\nitem bloccato`,
  createdAt,
});
const attemptOnly = (code: string, createdAt: string) => ({
  ...BOT,
  body: `${itemAttemptMarker({ item: ITEM, outcome: code, run: 333 })}\ntentativo registrato`,
  createdAt,
});

const BUCKET = { isDailyBucket: true, hasOpenItem: true, isTrusted: isTrustedMarkerAuthor };
const SINGLE = { isDailyBucket: false, hasOpenItem: true, isTrusted: isTrustedMarkerAuthor };

describe('effectiveIssueVerdict — il verdetto gia\' scritto sull\'item non ferma il bucket', () => {
  it('bucket, already-fixed seguito da FU_ITEM_EVIDENCE → null (niente park, niente flag)', () => {
    const comments = [outcome('already-fixed', '2026-10-02T05:00:00Z'), evidence('2026-10-02T05:01:00Z')];
    expect(latestFixOutcomeFromComments(comments)).toBe('already-fixed');
    expect(effectiveIssueVerdict(comments, BUCKET)).toBeNull();
    const coverage = bucketVerdictCoverage(comments, BUCKET);
    expect(coverage.covered).toBe(true);
    expect(coverage.outcome).toBe('already-fixed');
    expect(coverage.marker).toMatchObject({ item: ITEM });
  });

  it('bucket, no-root-cause seguito da FU_ITEM_BLOCKED → null', () => {
    const comments = [outcome('no-root-cause', '2026-10-02T05:00:00Z'), blocked('no-root-cause', '2026-10-02T05:00:30Z')];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBeNull();
  });

  it('bucket, no-root-cause SENZA marker successivo → verdetto invariato (escalation come oggi)', () => {
    const comments = [outcome('no-root-cause', '2026-10-02T05:00:00Z')];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBe('no-root-cause');
  });

  it('marker precedente al FIX_OUTCOME (run vecchia) → non copre', () => {
    const comments = [evidence('2026-10-01T05:01:00Z'), outcome('already-fixed', '2026-10-02T05:00:00Z')];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBe('already-fixed');
  });

  it('a parita\' di secondo copre solo il commento che segue il verdetto, non quello che lo precede', () => {
    const at = '2026-10-02T05:00:00Z';
    expect(effectiveIssueVerdict([outcome('already-fixed', at), evidence(at)], BUCKET)).toBeNull();
    expect(effectiveIssueVerdict([evidence(at), outcome('already-fixed', at)], BUCKET)).toBe('already-fixed');
  });

  it('un marker nello STESSO commento del verdetto non copre', () => {
    const combined = { ...BOT, createdAt: '2026-10-02T05:00:00Z', body: `<!-- FIX_OUTCOME: no-root-cause -->\n${itemBlockedMarker({ item: ITEM, reason: 'no-root-cause' })}` };
    expect(effectiveIssueVerdict([combined], BUCKET)).toBe('no-root-cause');
  });

  it('marker di autore non fidato → non copre', () => {
    const comments = [outcome('already-fixed', '2026-10-02T05:00:00Z'), evidence('2026-10-02T05:01:00Z', STRANGER)];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBe('already-fixed');
  });

  it('senza predicato di fiducia non si fida di nessuno → non copre (fail-closed)', () => {
    const comments = [outcome('already-fixed', '2026-10-02T05:00:00Z'), evidence('2026-10-02T05:01:00Z')];
    expect(effectiveIssueVerdict(comments, { isDailyBucket: true, hasOpenItem: true })).toBe('already-fixed');
  });

  it('bucket SENZA item open → il verdetto vale per la issue (park / maybe-resolved come prima)', () => {
    // route-already-fixed ha bloccato l'ULTIMO item (openRemaining=false): non
    // c'e' «resto del bucket» da proteggere. Rimetterlo in coda lo lascerebbe
    // fermo in agent:fix-queued, saltato dal DRAIN a ogni tick come no-open-item.
    const comments = [outcome('already-fixed', '2026-10-02T05:00:00Z'), evidence('2026-10-02T05:01:00Z')];
    expect(effectiveIssueVerdict(comments, { ...BUCKET, hasOpenItem: false })).toBe('already-fixed');
    expect(bucketVerdictCoverage(comments, { ...BUCKET, hasOpenItem: false }).covered).toBe(false);
  });

  it('hasOpenItem assente → non copre (fail-closed)', () => {
    const comments = [outcome('already-fixed', '2026-10-02T05:00:00Z'), evidence('2026-10-02T05:01:00Z')];
    expect(effectiveIssueVerdict(comments, { isDailyBucket: true, isTrusted: isTrustedMarkerAuthor })).toBe('already-fixed');
  });

  it('solo FU_ITEM_ATTEMPT → non copre (registra il tentativo, non l\'esito sull\'item)', () => {
    const comments = [outcome('no-root-cause', '2026-10-02T05:00:00Z'), attemptOnly('no-root-cause', '2026-10-02T05:01:00Z')];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBe('no-root-cause');
  });

  it('issue singola con gli stessi commenti → verdetto invariato', () => {
    const comments = [outcome('already-fixed', '2026-10-02T05:00:00Z'), evidence('2026-10-02T05:01:00Z')];
    expect(effectiveIssueVerdict(comments, SINGLE)).toBe('already-fixed');
  });

  it('un verdetto nuovo DOPO il marker torna a valere (il marker copre solo il verdetto precedente)', () => {
    const comments = [
      outcome('already-fixed', '2026-10-02T05:00:00Z'),
      evidence('2026-10-02T05:01:00Z'),
      outcome('no-root-cause', '2026-10-02T09:00:00Z'),
    ];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBe('no-root-cause');
  });

  it('nessun verdetto → null, come latestFixOutcomeFromComments', () => {
    expect(effectiveIssueVerdict([evidence('2026-10-02T05:01:00Z')], BUCKET)).toBeNull();
    expect(bucketVerdictCoverage([], BUCKET).covered).toBe(false);
  });

  it('forma REST (parked-retry): created_at, user.login e author_association', () => {
    const rest = [
      { body: '<!-- FIX_OUTCOME: already-fixed -->', created_at: '2026-10-02T05:00:00Z', user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' },
      { body: evidence('x').body, created_at: '2026-10-02T05:01:00Z', user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' },
    ];
    expect(effectiveIssueVerdict(rest, BUCKET)).toBeNull();
  });

  it('forma REST: un utente umano con login da bot non e\' fidato (user.type autoritativo)', () => {
    const rest = [
      { body: '<!-- FIX_OUTCOME: already-fixed -->', created_at: '2026-10-02T05:00:00Z', user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'NONE' },
      { body: evidence('x').body, created_at: '2026-10-02T05:01:00Z', user: { login: 'claude', type: 'User' }, author_association: 'NONE' },
    ];
    expect(effectiveIssueVerdict(rest, BUCKET)).toBe('already-fixed');
  });

  it('un collaboratore umano e\' fidato (stesso predicato di route-already-fixed)', () => {
    const comments = [
      outcome('no-root-cause', '2026-10-02T05:00:00Z'),
      blocked('no-root-cause', '2026-10-02T06:00:00Z', { author: { login: 'owner' }, authorAssociation: 'OWNER' }),
    ];
    expect(effectiveIssueVerdict(comments, BUCKET)).toBeNull();
  });
});

describe('wiring nel drainer — ogni stadio che parcheggia, differisce, flagga o salta legge il verdetto effettivo', () => {
  const source = readFileSync('scripts/ci/followup-drainer.mjs', 'utf8');
  const runDrainAt = source.indexOf('export function runDrain() {');
  const runDrainBody = source.slice(runDrainAt);

  it('nessuno stadio confronta piu\' il FIX_OUTCOME grezzo della issue con NON_RETRYABLE senza passare dalla copertura', () => {
    // Ancora presente: senza, slice(-1) terrebbe un solo carattere e il
    // not.toMatch passerebbe a vuoto.
    expect(runDrainAt).toBeGreaterThan(-1);
    expect(runDrainBody).not.toMatch(/const parkedVerdict = latestFixOutcomeFromComments\(/u);
  });

  it('VERDICT-EXIT: la copertura e\' valutata prima di verdictExitDecision', () => {
    const coverage = source.indexOf("stageVerdictCoverage(iss, comments, 'verdict-exit')");
    const decision = source.indexOf('const d = verdictExitDecision(outcome, {');
    expect(coverage).toBeGreaterThan(-1);
    expect(decision).toBeGreaterThan(coverage);
  });

  it('parked-retry: lo skip NON_RETRYABLE usa il verdetto effettivo', () => {
    const coverage = source.indexOf("stageVerdictCoverage(iss, comments, 'parked-retry')");
    const skip = source.indexOf('if (parkedVerdict && NON_RETRYABLE.has(parkedVerdict))');
    expect(coverage).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(coverage);
  });

  it('rescue: il park NON_RETRYABLE consulta la copertura e un verdetto coperto ricade nel ramo eta\'-tentativi', () => {
    const branch = source.indexOf('if (outcome && NON_RETRYABLE.has(outcome)) {');
    const park = source.indexOf('PARK #${iss.number} (esito non-ri-tentabile', branch);
    const guard = source.indexOf('rescueVerdictCovered(iss, outcome)', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(branch);
    expect(park).toBeGreaterThan(guard);
  });

  it('la copertura richiede un item open, letto dal corpo della issue', () => {
    const start = source.indexOf('function bucketCoverageOptions(');
    const end = source.indexOf('function stageVerdictCoverage(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("hasOpenItem: selectFirstOpenItem(iss?.body || '') !== null");
  });

  it('nessun ramo nuovo chiude la issue: la copertura non e\' una prova di chiusura', () => {
    const start = source.indexOf('function stageVerdictCoverage(');
    const end = source.indexOf('function rescueVerdictCovered(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const helper = source.slice(start, end);
    expect(helper).not.toMatch(/issue', 'close'|LBL_RESOLVED_AUTO|LBL_MAYBE_RESOLVED/u);
  });

  it('osservabilita\': riga di log e contatore verdict_covered nello step summary', () => {
    expect(source).toContain('verdetto coperto da marker item (#');
    expect(source).toContain('verdict_covered=${');
  });
});
