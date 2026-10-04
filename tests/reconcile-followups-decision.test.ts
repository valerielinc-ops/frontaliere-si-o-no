/**
 * Lock the two-tier auto-close decision of reconcile-followups.mjs
 * (lever 1: drain the maybe-resolved pile deterministically without losing quality).
 *
 * The matcher (`detectAlreadyResolved`) is tested separately in
 * followup-resolution-match.test.ts; here we only lock the TIER policy: when a
 * deterministically-resolved follow-up flips to flag vs auto-close vs held, including
 * the human-objection and multi-item-aggregate safety vetoes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  bucketVerifyRequestBody,
  dailyBucketCloseGate,
  dailyBucketStructureReason,
  dailyBucketSummaryLine,
  dailyBucketGateInputs,
  decideBucketVerifyRequest,
  isAggregateTitle,
  decideReconcileAction,
  isReconcileFlagComment,
  isStrongAutoCloseEvidence,
  parseIssueCommentsResponse,
  reconcileDailyItems,
  recheckThenReconcileDailyItems,
  shouldEnsureVerifyLabel,
} from '../scripts/ci/reconcile-followups.mjs';
import { itemBlockedMarker, itemBornSatisfiedMarker, itemEvidenceMarker, parseItemMarkers } from '../scripts/ci/lib/followup-item-evidence.mjs';
import { isTrustedAuthor } from '../scripts/ci/route-already-fixed.mjs';
import { applyBlockedRecheck, planBlockedRecheck, unblockedCommentBody } from '../scripts/ci/lib/followup-blocked-recheck.mjs';

describe('alreadyCommented — esito vuoto riuscito distinto dall’errore (#8034)', () => {
  it('tratta stdout vuoto/whitespace come lista commenti vuota, ma null come errore', () => {
    expect(parseIssueCommentsResponse('')).toEqual([]);
    expect(parseIssueCommentsResponse(' \n\t ')).toEqual([]);
    expect(parseIssueCommentsResponse('{"comments":[]}')).toEqual([]);
    expect(parseIssueCommentsResponse(null)).toBeNull();
    expect(parseIssueCommentsResponse('not-json')).toBeNull();
  });
});

describe('isAggregateTitle — multi-item follow-ups never auto-close', () => {
  it('flags N≥2 "item(s)" titles as aggregate', () => {
    expect(isAggregateTitle('follow-up(#1674): 3 item deferred — fix(seo): ...')).toBe(true);
    expect(isAggregateTitle('follow-up(#1651): 2 items deferred — fix(data): ...')).toBe(true);
    expect(isAggregateTitle('follow-up(#1651): 2 item deferiti — fix(data): ...')).toBe(true);
  });
  it('treats single-item / count-less titles as non-aggregate (eligible)', () => {
    expect(isAggregateTitle('follow-up(#1685): 1 item deferred — perf(...): ...')).toBe(false);
    expect(isAggregateTitle('follow-up(#1685): 1 item deferito — perf(...): ...')).toBe(false);
    expect(isAggregateTitle('fix(crawlers): extract shared assertJsonListShape guard')).toBe(false);
    expect(isAggregateTitle('')).toBe(false);
  });
  it('flags sweep/batch/bulk titles as aggregate even without an "N items" count (#1826 class)', () => {
    expect(isAggregateTitle('Sweep: ~30 crawlers need shared fetchHtml')).toBe(true);
    expect(isAggregateTitle('follow-up(#1826): batch-fix all parser selectors')).toBe(true);
    expect(isAggregateTitle('chore: bulk migrate job slugs')).toBe(true);
    // word-boundary: substrings inside unrelated words don't trigger
    expect(isAggregateTitle('fix: swept the floor reference')).toBe(false);
  });
  it('explicit "1 item deferred" wins over an ordinary "batch"/"sweep"/"bulk" word in the same title — count is authoritative, no keyword fallback (#3378)', () => {
    expect(isAggregateTitle(
      'follow-up(#3371): 1 item deferred — fix(job-alerts): batch backfill re-checks tier-3 before tier-4 URL fallback',
    )).toBe(false);
  });
});

describe('isStrongAutoCloseEvidence — weak single tokens never auto-close', () => {
  it('≥2 distinct matched tokens → strong', () => {
    expect(isStrongAutoCloseEvidence(['meta.model', 'CDN_BASE()'])).toBe(true);
  });
  it('single RICH token is still insufficient for auto-close (#1085)', () => {
    // Un solo token può essere lo status quo che la Suggested action chiede di
    // cambiare. La conferma a due livelli non deve trasformarlo in una chiusura.
    expect(isStrongAutoCloseEvidence(['displayCount = page === 1 ? a : b'])).toBe(false);
    expect(isStrongAutoCloseEvidence(['foo(bar).baz'])).toBe(false); // ( ) . → 3 punct
  });
  it('single weak token (≤1 punctuation: bare dot-member / single op) → NOT strong (held for human)', () => {
    expect(isStrongAutoCloseEvidence(['meta.model'])).toBe(false); // 1 dot
    expect(isStrongAutoCloseEvidence(['injected > 0'])).toBe(false); // 1 op
    expect(isStrongAutoCloseEvidence(['window.__CDN_DATA_BASE__'])).toBe(false); // 1 dot (underscores aren't punct)
  });
  it('empty → not strong', () => {
    expect(isStrongAutoCloseEvidence([])).toBe(false);
    expect(isStrongAutoCloseEvidence(undefined)).toBe(false);
  });
  it('an explicit stable-item Acceptance token is strong when its single token is matched', () => {
    expect(isStrongAutoCloseEvidence(
      ['stripSiteTitleSuffix()'],
      { acceptanceToken: '`stripSiteTitleSuffix()`' },
    )).toBe(true);
    expect(isStrongAutoCloseEvidence(['stripSiteTitleSuffix()'])).toBe(false);
  });
});

describe('daily bucket reconcile — explicit Acceptance token', () => {
  const body = [
    '## Batch',
    '',
    '- Daily key: 2026-09-11 (Europe/Zurich)',
    '- State: sealed',
    '- Target repository: valerielinc-ops/frontaliere-si-o-no',
    '',
    '## Item',
    '',
    '### FU-2026-09-11-001 — normalize Manor title',
    '- State: open',
    '- Sources: PR #8245',
    '- Target repository: valerielinc-ops/frontaliere-si-o-no',
    '- Target file: `scripts/update-manor-jobs.mjs`',
    '- Suggested action: apply `stripSiteTitleSuffix()` to the parsed title',
    '- Acceptance token: `stripSiteTitleSuffix()`',
  ].join('\n');
  const io = {
    fileExists: (p: string) => p === 'scripts/update-manor-jobs.mjs',
    readFile: () => 'const title = stripSiteTitleSuffix(rawTitle);',
  };

  it('marks the item done and clears the official bucket gate', () => {
    const reconciled = reconcileDailyItems(
      body,
      io,
      '2026-09-11',
      'valerielinc-ops/frontaliere-si-o-no',
      1,
    );
    expect(reconciled.changed).toBe(true);
    expect(reconciled.changes).toHaveLength(1);
    expect(reconciled.body).toContain('- State: done');

    const gate = dailyBucketCloseGate(
      reconciled.body,
      io,
      '2026-09-11',
      'valerielinc-ops/frontaliere-si-o-no',
      1,
    );
    expect(gate.blocks).toBe(false);
  });
});

describe('reconcile flag history — item markers do not consume the grace window', () => {
  it('does not treat an item-done marker as an aggregate flag', () => {
    expect(isReconcileFlagComment(
      '<!-- reconcile-bot -->\n✅ Item `FU-2026-09-11-004` marcato `done`.',
    )).toBe(false);
  });

  it('recognizes the dedicated current marker and legacy aggregate flag comments', () => {
    expect(isReconcileFlagComment(
      '<!-- reconcile-bot:flag -->\n<!-- reconcile-bot -->\n🤖 **Reconcile (auto)**: done-but-open',
    )).toBe(true);
    expect(isReconcileFlagComment(
      '<!-- reconcile-bot -->\n🤖 **Reconcile (auto)**: done-but-open',
    )).toBe(true);
  });
});

describe('decideReconcileAction — two-tier, double-confirm-across-time', () => {
  const base = { resolved: true, hasMaybeResolved: false, hasPriorFlag: false, isAggregate: false, blocked: false, strongEvidence: true };

  it('does nothing when not resolved', () => {
    expect(decideReconcileAction({ ...base, resolved: false })).toBe('none');
  });

  it('first detection → flag (grace window), never closes on first sight', () => {
    expect(decideReconcileAction({ ...base })).toBe('flag');
  });

  it('second confirmation (prior flag + label still present, eligible) → close', () => {
    expect(decideReconcileAction({ ...base, hasPriorFlag: true, hasMaybeResolved: true })).toBe('close');
  });

  it('human objection (we flagged before, label since removed) → none', () => {
    expect(decideReconcileAction({ ...base, hasPriorFlag: true, hasMaybeResolved: false })).toBe('none');
  });

  it('multi-item aggregate never auto-closes (held after first flag)', () => {
    expect(decideReconcileAction({ ...base, isAggregate: true })).toBe('flag');
    expect(decideReconcileAction({ ...base, isAggregate: true, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
  });

  it('keep-open / strategic label vetoes auto-close (held after first flag)', () => {
    expect(decideReconcileAction({ ...base, blocked: true })).toBe('flag');
    expect(decideReconcileAction({ ...base, blocked: true, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
  });

  it('NO_AUTOCLOSE escape hatch forces tier-1 only', () => {
    expect(decideReconcileAction({ ...base, noAutoclose: true, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
    expect(decideReconcileAction({ ...base, noAutoclose: true })).toBe('flag');
  });

  it('label present but no prior flag from us → flag (gets its own grace cycle, not an instant close)', () => {
    expect(decideReconcileAction({ ...base, hasMaybeResolved: true, hasPriorFlag: false })).toBe('flag');
  });

  it('weak evidence never auto-closes: first seen → flag, already flagged → held (none)', () => {
    expect(decideReconcileAction({ ...base, strongEvidence: false })).toBe('flag');
    expect(decideReconcileAction({ ...base, strongEvidence: false, hasPriorFlag: true, hasMaybeResolved: true })).toBe('none');
  });

  it('un fallimento nella lettura dei commenti è input sconosciuto, non una prima segnalazione (#1078)', () => {
    expect(decideReconcileAction({ ...base, hasPriorFlag: null })).toBe('none');
  });

  it('un fallimento nei commenti non salta l’intera issue nel ciclo CLI (#1078)', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'scripts/ci/reconcile-followups.mjs'), 'utf8');
    const guard = source.match(/const hasPriorFlag = alreadyCommented\(iss\.number\);([\s\S]*?)const strongEvidence/);
    expect(guard?.[1]).toContain('hasPriorFlag === null');
    expect(guard?.[1]).not.toContain('continue;');
  });

  it('mantiene distinto un edit fallito e confronta anche il titolo prima del write', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'scripts/ci/reconcile-followups.mjs'), 'utf8');
    expect(source).toContain('if (allowFail) return null;');
    expect(source).toContain('if (edited === null)');
    expect(source).toContain("String(latest.title || '') !== String(iss.title || '')");
  });
});

describe('richiesta di verifica per un bucket senza item aperti (FU_BUCKET_VERIFY_REQUEST)', () => {
  const DAY = '2026-09-30';
  const A = `FU-${DAY}-001`;
  const B = `FU-${DAY}-002`;
  const bucketItem = (id: string, state: string) => [
    `### ${id} — prospector legge __NEXT_DATA__`,
    `- State: ${state}`,
    '- Sources: PR #9001',
    '- Target repository: valerielinc-ops/frontaliere-si-o-no',
    '- Target file: `scripts/lib/prospector/extract.mjs`',
    '- Suggested action: leggi `__NEXT_DATA__` in `extractDetailFields()`',
    '- METRICA: prima=3 atteso=0 | COMANDO: node scripts/lib/prospector/extract.mjs --audit',
    '- Acceptance token: `extractDetailFields()`',
  ].join('\n');
  const bucket = (...items: string[]) => [
    '## Batch',
    '',
    `- Daily key: ${DAY} (Europe/Zurich)`,
    '- State: sealed',
    '- Target repository: valerielinc-ops/frontaliere-si-o-no',
    '',
    '## Item',
    ...items.flatMap((entry) => ['', entry]),
    '',
  ].join('\n');
  const bot = { author: { login: 'github-actions' }, authorAssociation: 'NONE', createdAt: '2026-10-01T08:00:00Z' };
  const evidenceComment = (id: string) => ({
    ...bot,
    body: [
      itemEvidenceMarker({ item: id, pr: 9001, commit: 'abcdef1234567890', run: 37000000001, link: 'target-file' }),
      itemBlockedMarker({ item: id, reason: 'awaiting-verification' }),
    ].join('\n'),
  });
  const io = {
    fileExists: (p: string) => p === 'scripts/lib/prospector/extract.mjs',
    readFile: () => 'const fields = extractDetailFields(window.__NEXT_DATA__);',
  };

  it('un item blocked con evidenza e nessun open → UNA richiesta con la riga METRICA', () => {
    const body = bucket(bucketItem(A, 'blocked'), bucketItem(B, 'done'));
    const comments = [evidenceComment(A)];
    const request = decideBucketVerifyRequest({ body, comments, isTrusted: isTrustedAuthor });
    expect(request.action).toBe('request');
    expect(request.newIds).toEqual([A]);
    const text = bucketVerifyRequestBody({
      items: request.items,
      markers: parseItemMarkers(comments, { isTrusted: isTrustedAuthor }),
    });
    expect(text.startsWith(`<!-- FU_BUCKET_VERIFY_REQUEST: items=${A} -->`)).toBe(true);
    expect(text).toContain('Misura la METRICA: PR mergiata, commit e run verde provano che la PR esiste, non che l\'item sia risolto');
    expect(text).toContain("- METRICA dell'item, da rimisurare: prima=3 atteso=0 | COMANDO: node scripts/lib/prospector/extract.mjs --audit");
    expect(text).toContain('togli `maybe-resolved` e ri-aggiungi `agent:fix`');
    expect(text).toContain('- Motivo del blocco: `awaiting-verification`');
    expect(text).toContain('PR #9001, commit `abcdef123456`, run 37000000001, legame `target-file`');
    expect(text).toContain('- Target file: `scripts/lib/prospector/extract.mjs`');
    // Il commento non compone marker di item ne' il flag della finestra di grazia.
    expect(parseItemMarkers([{ ...bot, body: text }], { isTrusted: isTrustedAuthor })).toEqual([]);
    expect(isReconcileFlagComment(text)).toBe(false);

    // Secondo giro: la richiesta precedente copre gia' A → nessun secondo commento.
    const second = decideBucketVerifyRequest({ body, comments: [...comments, { ...bot, body: text }], isTrusted: isTrustedAuthor });
    expect(second).toMatchObject({ action: 'none', reason: 'already-requested' });

    // Un nuovo item in attesa → un commento nuovo, che elenca tutti gli ID in attesa.
    const widened = bucket(bucketItem(A, 'blocked'), bucketItem(B, 'blocked'));
    const third = decideBucketVerifyRequest({ body: widened, comments: [...comments, { ...bot, body: text }], isTrusted: isTrustedAuthor });
    expect(third.action).toBe('request');
    expect(third.newIds).toEqual([B]);
    expect(bucketVerifyRequestBody({ items: third.items })).toContain(`items=${A},${B} -->`);
  });

  it('una richiesta precedente di autore non fidato non zittisce quella dovuta', () => {
    const body = bucket(bucketItem(A, 'blocked'));
    const forged = { author: { login: 'drive-by-user' }, authorAssociation: 'NONE', body: `<!-- FU_BUCKET_VERIFY_REQUEST: items=${A} -->` };
    expect(decideBucketVerifyRequest({ body, comments: [forged], isTrusted: isTrustedAuthor }).action).toBe('request');
  });

  it('nessuna richiesta finché resta un item open o in-progress, o se tutti sono done', () => {
    for (const state of ['open', 'in-progress']) {
      expect(decideBucketVerifyRequest({ body: bucket(bucketItem(A, 'blocked'), bucketItem(B, state)), comments: [], isTrusted: isTrustedAuthor }))
        .toMatchObject({ action: 'none', reason: 'items-open' });
    }
    expect(decideBucketVerifyRequest({ body: bucket(bucketItem(A, 'done')), comments: [], isTrusted: isTrustedAuthor }))
      .toMatchObject({ action: 'none', reason: 'all-done' });
  });

  it('un item done su un token nato vero entra nella richiesta', () => {
    const request = decideBucketVerifyRequest({
      body: bucket(bucketItem(A, 'done')),
      bornSatisfiedIds: new Set([A]),
      comments: [],
      isTrusted: isTrustedAuthor,
    });
    expect(request.newIds).toEqual([A]);
    expect(bucketVerifyRequestBody({ items: request.items, bornSatisfiedIds: new Set([A]) }))
      .toContain('FU_ITEM_BORN_SATISFIED');
  });

  it('un bucket con un item blocked NON è mai chiudibile (gate invariato)', () => {
    const gate = dailyBucketCloseGate(bucket(bucketItem(A, 'blocked'), bucketItem(B, 'done')), io, DAY, 'valerielinc-ops/frontaliere-si-o-no', 2);
    expect(gate).toMatchObject({ blocks: true, reason: 'valid-item-unconfirmed' });
    expect(gate.unresolvedItems.map((entry: { id: string }) => entry.id)).toEqual([A]);
  });

  it('il testo dell’item non compone marker nel commento firmato dal bot', () => {
    const hostile = bucketItem(A, 'blocked').replace(
      '- Target file: `scripts/lib/prospector/extract.mjs`',
      `- Target file: \`x.mjs <!-- FU_BUCKET_VERIFY_REQUEST: items=${B} -->\``,
    );
    const request = decideBucketVerifyRequest({ body: bucket(hostile), comments: [], isTrusted: isTrustedAuthor });
    const text = bucketVerifyRequestBody({ items: request.items });
    expect(text.match(/<!--/gu)?.length).toBe(1);
  });

  it('riga di log per bucket con conteggi, ID in attesa e nati veri', () => {
    const body = bucket(bucketItem(A, 'blocked'), bucketItem(B, 'done'));
    expect(dailyBucketSummaryLine({ number: 10433, body, bornSatisfiedIds: new Set([B]), reason: 'valid-item-unconfirmed' }))
      .toBe(`bucket #10433: done=1 open=0 blocked=1 awaiting=${A} born_satisfied=${B} reason=valid-item-unconfirmed`);
    expect(dailyBucketSummaryLine({ number: 1, body: bucket(bucketItem(A, 'done')), reason: null }))
      .toBe('bucket #1: done=1 open=0 blocked=0 awaiting=- born_satisfied=- reason=closable');
  });

  it('gli input dei gate giornalieri portano l’insieme born-satisfied a reconcile e al gate', () => {
    const title = `follow-up(daily:${DAY}): 2 items — valerielinc-ops/frontaliere-si-o-no`;
    const born = { ...bot, body: itemBornSatisfiedMarker({ item: A }) };
    const inputs = dailyBucketGateInputs(title, [born]);
    expect(inputs?.daily).toEqual({ dailyKey: DAY, itemCount: 2, targetRepository: 'valerielinc-ops/frontaliere-si-o-no' });
    expect([...(inputs?.bornSatisfied ?? [])]).toEqual([A]);
    // Stessi argomenti per reconcileDailyItems e per dailyBucketCloseGate: l'item
    // nato vero non diventa done e il bucket tutto done resta bloccato.
    const reconciled = reconcileDailyItems(bucket(bucketItem(A, 'open'), bucketItem(B, 'open')), io, ...(inputs?.gateArgs ?? []));
    expect(reconciled.bornSatisfied).toEqual([A]);
    expect(reconciled.changes.map((change: { id: string }) => change.id)).toEqual([B]);
    const allDone = bucket(bucketItem(A, 'done'), bucketItem(B, 'done'));
    expect(dailyBucketCloseGate(allDone, io, ...(inputs?.gateArgs ?? []))).toMatchObject({ blocks: true, reason: 'born-satisfied-token' });
    // Senza marker gli stessi argomenti lasciano il comportamento di oggi.
    const plain = dailyBucketGateInputs(title, []);
    expect(dailyBucketCloseGate(allDone, io, ...(plain?.gateArgs ?? [])).reason).not.toBe('born-satisfied-token');
  });

  it('commenti illeggibili o titolo non giornaliero → nessun input (bucket lasciato invariato)', () => {
    expect(dailyBucketGateInputs(`follow-up(daily:${DAY}): 1 item — owner/repo`, null)).toBeNull();
    expect(dailyBucketGateInputs('follow-up: aggregato', [])).toBeNull();
  });

  it('il veto strutturale condiviso coincide con il motivo di reconcileDailyItems', () => {
    const body = bucket(bucketItem(A, 'blocked'), bucketItem(B, 'done'));
    const repo = 'valerielinc-ops/frontaliere-si-o-no';
    expect(dailyBucketStructureReason(body, DAY, repo, 2)).toBeNull();
    for (const [input, args] of [
      [body.replace('- State: sealed', '- State: collecting'), [DAY, repo, 2]],
      [body, ['2026-09-29', repo, 2]],
      [body, [DAY, 'owner/other', 2]],
      [body, [DAY, repo, 3]],
    ] as const) {
      const reason = dailyBucketStructureReason(input, ...args);
      expect(reason).not.toBeNull();
      expect(reconcileDailyItems(input, io, ...args).reason).toBe(reason);
    }
  });

  it('la rimisura dei blocked: un item ancora blocked tiene il bucket NON chiudibile (gate invariato)', () => {
    const body = bucket(bucketItem(A, 'blocked'), bucketItem(B, 'done'));
    const plan = planBlockedRecheck({
      body,
      dailyKey: DAY,
      markers: [],
      // Token assente oggi, nessun commit dopo il blocco: A resta blocked.
      io: { fileExists: io.fileExists, readFile: () => 'const nothing = 1;' },
      readers: { commitAfter: () => ({ status: 'ok', commit: null }), fileAt: () => ({ status: 'error' }) },
      now: Date.parse('2026-10-04T00:00:00Z'),
      reentryBudget: { remaining: 3 },
    });
    expect(plan.results).toEqual([expect.objectContaining({ id: A, outcome: 'waiting', why: 'no-new-commit' })]);
    const gate = dailyBucketCloseGate(applyBlockedRecheck(body, {}).body, io, DAY, 'valerielinc-ops/frontaliere-si-o-no', 2);
    expect(gate).toMatchObject({ blocks: true, reason: 'valid-item-unconfirmed' });
    expect(gate.unresolvedItems.map((entry: { id: string }) => entry.id)).toEqual([A]);
  });

  it('un item awaiting-verification esce per token (non nato vero), mai per rientro', () => {
    const body = bucket(bucketItem(A, 'blocked'));
    const markers = parseItemMarkers([{ ...bot, body: itemBlockedMarker({ item: A, reason: 'awaiting-verification' }) }], { isTrusted: isTrustedAuthor });
    const plan = planBlockedRecheck({
      body,
      dailyKey: DAY,
      markers,
      io,
      readers: { commitAfter: () => ({ status: 'error' }), fileAt: () => ({ status: 'ok', content: 'const legacy = 1;' }) },
      now: Date.parse('2026-10-04T00:00:00Z'),
      reentryBudget: { remaining: 3 },
    });
    expect(plan.results).toEqual([expect.objectContaining({ id: A, outcome: 'done' })]);
  });

  it('due giri consecutivi: al più UN marker FU_ITEM_UNBLOCKED per item', () => {
    const body = bucket(bucketItem(A, 'blocked'));
    const readers = {
      commitAfter: () => ({ status: 'ok', commit: { sha: 'abcdef1234567890', date: '2026-10-02T00:00:00Z' } }),
      fileAt: () => ({ status: 'ok', content: '' }),
    };
    const ioNoToken = { fileExists: io.fileExists, readFile: () => 'const nothing = 1;' };
    const comments: Array<{ body: string }> = [];
    let current = body;
    for (let round = 0; round < 2; round++) {
      const plan = planBlockedRecheck({
        body: current, dailyKey: DAY, markers: parseItemMarkers(comments, { isTrusted: isTrustedAuthor }),
        io: ioNoToken, readers, now: Date.parse('2026-10-04T00:00:00Z'), reentryBudget: { remaining: 3 },
      });
      for (const entry of plan.results.filter((candidate: { outcome: string }) => candidate.outcome === 'reenter')) {
        comments.push({ ...bot, body: unblockedCommentBody(entry) });
        current = applyBlockedRecheck(current, { reentered: [entry.id] }).body;
      }
      // Il fixer rimisura e lo riblocca (FU-09): stato di nuovo blocked.
      current = current.replace('- State: open', '- State: blocked');
    }
    const count = comments.filter((comment) => comment.body.includes(`FU_ITEM_UNBLOCKED: item=${A}`)).length;
    expect(count).toBeLessThanOrEqual(1);
    expect(count).toBeGreaterThan(0);
  });

  it('la sequenza per bucket rimisura i blocked PRIMA di reconcileDailyItems e riconcilia il corpo rimisurato', () => {
    const body = bucket(bucketItem(A, 'blocked'), bucketItem(B, 'done'));
    const repo = 'valerielinc-ops/frontaliere-si-o-no';
    const calls: string[] = [];
    const step = recheckThenReconcileDailyItems(body, io, [DAY, repo, 2, new Set()], (current: string) => {
      calls.push(current);
      // Il rientro riporta A a `open`: solo cosi' la riconciliazione lo vede.
      return { body: applyBlockedRecheck(current, { reentered: [A] }).body, skipIssue: false };
    });
    expect(calls).toEqual([body]);
    // Sul corpo originale A e' blocked e reconcileDailyItems non lo tocca.
    expect(reconcileDailyItems(body, io, DAY, repo, 2).changes).toEqual([]);
    expect(step.reconciliation?.changes.map((change: { id: string }) => change.id)).toEqual([A]);
  });

  it('la sequenza per bucket non rimisura un bucket strutturalmente invalido e si ferma su skipIssue', () => {
    const repo = 'valerielinc-ops/frontaliere-si-o-no';
    const collecting = bucket(bucketItem(A, 'blocked')).replace('- State: sealed', '- State: collecting');
    let called = 0;
    const invalid = recheckThenReconcileDailyItems(collecting, io, [DAY, repo, 1, new Set()], () => { called += 1; return { body: collecting, skipIssue: false }; });
    expect(called).toBe(0);
    expect(invalid.recheck).toBeNull();
    expect(invalid.reconciliation?.reason).toBe('bucket-collecting');
    const wrongCount = recheckThenReconcileDailyItems(bucket(bucketItem(A, 'blocked')), io, [DAY, repo, 3, new Set()], () => { called += 1; return { body: '', skipIssue: false }; });
    expect(called).toBe(0);
    expect(wrongCount.reconciliation?.reason).toBe('mismatched-item-count');
    const skipped = recheckThenReconcileDailyItems(bucket(bucketItem(A, 'blocked')), io, [DAY, repo, 1, new Set()], () => ({ body: '', skipIssue: true }));
    expect(skipped).toEqual({ recheck: { body: '', skipIssue: true }, reconciliation: null });
  });

  it('maybe-resolved non viene rimessa dopo un’obiezione umana al flag', () => {
    const flag = { ...bot, body: '<!-- reconcile-bot:flag -->\n🤖 **Reconcile (auto)**' };
    expect(isReconcileFlagComment(flag.body)).toBe(true);
    expect(shouldEnsureVerifyLabel({ comments: [flag], labelNames: ['follow-up'] })).toBe(false);
    expect(shouldEnsureVerifyLabel({ comments: [flag], labelNames: ['follow-up', 'maybe-resolved'] })).toBe(true);
    expect(shouldEnsureVerifyLabel({ comments: [], labelNames: ['follow-up'] })).toBe(true);
  });
});
