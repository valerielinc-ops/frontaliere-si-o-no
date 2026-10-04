/**
 * Chiusura degli hand-off di conflitto il cui lavoro è già fatto.
 *
 * Misurato il 2026-10-01 su 8 hand-off aperti:
 *  - 5 avevano la PR di origine già mergiata (#10383 #10385 #10444 #10536
 *    #10657): il conflitto era rientrato sul branch originale e nessun passo del
 *    ciclo chiudeva la issue (pre-flight «non chiudo», drainer
 *    `FOLLOWUP_NO_AUTOCLOSE=1`, bridge del fixer senza close);
 *  - #10657 in particolare: risolto su una HEAD NUOVA del branch (merge di
 *    main), che la regola «stessa HEAD» del pre-flight non riconosceva;
 *  - #10586/#10587: stesso hand-off di #10569, creato due volte a 5 s di
 *    distanza da due run concorrenti di pr-autorebase.
 *
 * Review del gemello nel corpus (frontaliere-articles#2018): l'assenza di
 * `has-conflicts` non prova niente, perché pr-autorebase la aggiunge
 * best-effort e apre l'hand-off anche se l'aggiunta fallisce. Con la PR di
 * origine aperta si chiude solo con la prova positiva: `has-conflicts` tolta da
 * pr-autorebase (merge-tree pulito) DOPO l'apertura dell'hand-off.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildConflictHandoffIssue } from '../scripts/ci/pr-autorebase.mjs';
import {
  conflictClearedAfter,
  conflictLabelEventsArgs,
  handoffResolution,
  parseConflictLabelEvents,
} from '../scripts/ci/check-issue-already-resolved.mjs';
import {
  closingComment,
  decideHandoff,
  declaresClosing,
  declaresSupersede,
  duplicateOldEnough,
  electHandoffKeeper,
  groupHandoffs,
  MIN_DUPLICATE_AGE_MINUTES,
  NOT_PLANNED_REASONS,
  originClosedPastGrace,
  originContentOnMain,
  planDuplicateClosures,
  reapplyInFlight,
  RECONCILE_MARKER,
  stillClosable,
} from '../scripts/ci/reconcile-conflict-handoffs.mjs';
import { ENTRYPOINTS } from '../scripts/ci/check-dependency-free-import-closure.mjs';

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const OPENED = '2026-09-30T15:00:00Z';
const labelEvent = (event: string, createdAt: string, name = 'has-conflicts') => ({ event, label: { name }, created_at: createdAt });
// pr-autorebase mette la label, apre l'hand-off, e la toglie a merge-tree pulito.
const CLEARED = [labelEvent('labeled', '2026-09-30T14:59:50Z'), labelEvent('unlabeled', '2026-09-30T17:00:00Z')];

function handoff(number: number, origin: number, { labels = [] as string[], lgtm = false } = {}) {
  const { title, body } = buildConflictHandoffIssue({
    num: origin,
    branch: `fix/issue-${origin - 1}`,
    head: HEAD,
    files: ['tests/data-refresh-pr-wiring.test.ts'],
    lgtm,
  });
  return { number, title, body, labels, created_at: OPENED };
}

const openOrigin = (over: Record<string, unknown> = {}) => ({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  headRefOid: HEAD,
  labels: [],
  ...over,
});

describe('conflictClearedAfter: la prova da merge-tree', () => {
  it('has-conflicts tolta dopo l\'apertura dell\'hand-off → prova', () => {
    expect(conflictClearedAfter(CLEARED, OPENED)).toBe(true);
  });

  it.each([
    ['REGRESSIONE review corpus: label mai applicata (edit best-effort fallito)', []],
    ['conflitto precedente, coppia di eventi prima dell\'hand-off', [labelEvent('labeled', '2026-09-29T10:00:00Z'), labelEvent('unlabeled', '2026-09-29T12:00:00Z')]],
    ['label rimessa dopo la rimozione (conflitto di nuovo)', [...CLEARED, labelEvent('labeled', '2026-09-30T18:00:00Z')]],
    ['label ancora presente', [labelEvent('labeled', '2026-09-30T14:59:50Z')]],
    ['solo altre label', [labelEvent('unlabeled', '2026-09-30T17:00:00Z', 'stale-review')]],
    ['eventi illeggibili', null],
  ])('%s → nessuna prova', (_label, events) => {
    expect(conflictClearedAfter(events as any, OPENED)).toBe(false);
  });

  it('senza data di apertura non c\'è prova', () => {
    expect(conflictClearedAfter(CLEARED, '')).toBe(false);
  });

  it('gli eventi arrivano in NDJSON da gh api --jq; una riga malformata li rende illeggibili', () => {
    const raw = '{"event":"labeled","created_at":"2026-09-30T14:59:50Z"}\n{"event":"unlabeled","created_at":"2026-09-30T17:00:00Z"}\n';
    expect(conflictClearedAfter(parseConflictLabelEvents(raw), OPENED)).toBe(true);
    expect(parseConflictLabelEvents('')).toEqual([]);
    expect(parseConflictLabelEvents('{"event":')).toBeNull();
    expect(parseConflictLabelEvents(null as any)).toBeNull();
    const args = conflictLabelEventsArgs('o/r', 10569);
    expect(args).toContain('repos/o/r/issues/10569/events?per_page=100');
    expect(args.join(' ')).toContain('.label.name == "has-conflicts"');
  });
});

describe('handoffResolution: il conflitto rientrato, sulla stessa HEAD o su una nuova (#10657)', () => {
  it('PR di origine mergiata → risolto, senza bisogno di prova', () => {
    expect(handoffResolution({ state: 'MERGED' }, { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: true, reason: 'merged' });
  });

  it('stessa HEAD mergeable: si chiude solo con la prova, altrimenti resta il vecchio rinvio', () => {
    expect(handoffResolution(openOrigin(), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
      .toEqual({ resolved: true, reason: 'conflict-resolved' });
    expect(handoffResolution(openOrigin(), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: false, reason: 'conflict-clear-unproven', sameHeadMergeable: true });
  });

  it('HEAD nuova, mergeable, senza has-conflicts e con la prova → risolto', () => {
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD }), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
      .toEqual({ resolved: true, reason: 'conflict-resolved-new-head' });
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD, labels: [{ name: 'stale-review' }] }), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
      .toEqual({ resolved: true, reason: 'conflict-resolved-new-head' });
  });

  it('REGRESSIONE review corpus: HEAD nuova senza label né prova (cache MERGEABLE vecchia) → si riapplica', () => {
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD }), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: false, reason: 'conflict-clear-unproven' });
  });

  it.each([
    [{ labels: [{ name: 'has-conflicts' }] }, 'origin-has-conflicts'],
    [{ labels: ['has-conflicts'] }, 'origin-has-conflicts'],
    [{ labels: undefined }, 'origin-labels-unreadable'],
    [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'origin-open'],
    [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'origin-mergeability-stale'],
    [{ mergeStateStatus: 'DIRTY' }, 'origin-mergeability-stale'],
  ])('HEAD nuova con %j → non risolto (%s), anche con la prova', (over, reason) => {
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD, ...over }), { expectedHead: HEAD.slice(0, 12), conflictClearedAfterOpen: true }))
      .toEqual({ resolved: false, reason });
  });

  it('HEAD illeggibile resta non verificata', () => {
    expect(handoffResolution(openOrigin({ headRefOid: '' }), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: false, reason: 'origin-head-unverified' });
  });
});

describe('keyword delle PR: una per issue, numero intero', () => {
  it.each([
    ['Closes #10586', true],
    ['closes: #10586', true],
    ['Fixes #10586\nCloses #1', true],
    ['Resolved #10586.', true],
    ['Closes #105860', false],
    ['Refs #10586', false],
    ['Closes #10587', false],
    ['Closes #1 #10586', true],
    ['fix(ci): riapplica la PR (closes #10586)\n\nbody', true],
  ])('declaresClosing(%j, 10586) → %s', (body, expected) => {
    expect(declaresClosing(body, 10586)).toBe(expected);
  });

  it('Supersedes riconosce solo la PR di origine esatta', () => {
    expect(declaresSupersede('Supersedes #10569', 10569)).toBe(true);
    expect(declaresSupersede('supersedes #10569\n', 10569)).toBe(true);
    expect(declaresSupersede('Supersedes #105690', 10569)).toBe(false);
    expect(declaresSupersede(null, 10569)).toBe(false);
  });

  it('una riapplicazione in volo si riconosce dal branch del fixer o dalle keyword, mai dalla PR di origine', () => {
    const prs = [
      { number: 10569, headRefName: 'fix/issue-10482', body: 'Closes #10482' },
      { number: 10700, headRefName: 'fix/issue-10586', body: '' },
    ];
    expect(reapplyInFlight(prs, { issueNumber: 10586, originNumber: 10569 })?.number).toBe(10700);
    expect(reapplyInFlight([prs[0]], { issueNumber: 10586, originNumber: 10569 })).toBeNull();
    expect(reapplyInFlight([{ number: 10701, headRefName: 'x', body: 'Supersedes #10569' }], { issueNumber: 10586, originNumber: 10569 })?.number)
      .toBe(10701);
    expect(reapplyInFlight([{ number: 10702, headRefName: 'fix/issue-105860', body: '' }], { issueNumber: 10586, originNumber: 10569 }))
      .toBeNull();
  });
});

describe('groupHandoffs: duplicati della stessa PR di origine (#10586/#10587)', () => {
  it('resta la più vecchia, l\'altra è un duplicato', () => {
    const groups = groupHandoffs([handoff(10587, 10569), handoff(10586, 10569), handoff(10657, 10655, { lgtm: true })]);
    const g10569 = groups.find((g) => g.origin === 10569)!;
    expect(g10569.keeper.number).toBe(10586);
    expect(g10569.duplicates.map((i) => i.number)).toEqual([10587]);
    expect(groups.find((g) => g.origin === 10655)!.duplicates).toEqual([]);
  });

  it('il lavoro avviato vince sull\'età: claim o PR in volo sulla più recente', () => {
    const claimed = groupHandoffs([handoff(10586, 10569), handoff(10587, 10569, { labels: ['agent:in-progress'] })]);
    expect(claimed[0].keeper.number).toBe(10587);
    const withPr = groupHandoffs(
      [handoff(10586, 10569), handoff(10587, 10569)],
      [{ number: 10710, headRefName: 'fix/issue-10587', body: '' }],
    );
    expect(withPr[0].keeper.number).toBe(10587);
    expect(withPr[0].duplicates.map((i) => i.number)).toEqual([10586]);
  });

  it('ignora le issue che non sono hand-off', () => {
    expect(groupHandoffs([{ number: 1, title: 'Re: Conflitto con main: riapplicare la PR #2 su main', body: '', labels: [] }]))
      .toEqual([]);
  });
});

describe('decideHandoff: chiude solo il lavoro dimostrabilmente fatto', () => {
  const issue = handoff(10586, 10569);

  it('REGRESSIONE #10657/#10383/#10385/#10444/#10536: PR di origine mergiata → chiusa', () => {
    expect(decideHandoff({ issue, origin: { state: 'MERGED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'origin-merged', pr: 10569 });
  });

  it('riapplicazione mergiata con Closes o Supersedes → chiusa anche se la PR di origine è chiusa', () => {
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 10720, body: 'Supersedes #10569\nCloses #10586' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 10720 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 10721, body: 'Supersedes #10569' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 10721 });
  });

  it('la PR di origine stessa non vale come riapplicazione', () => {
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 10569, body: 'Closes #10586' }], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'origin-closed' });
  });

  it('PR di origine aperta e di nuovo pulita, con has-conflicts tolta dopo l\'hand-off → chiusa', () => {
    expect(decideHandoff({ issue, origin: openOrigin({ headRefOid: NEW_HEAD }), mergedPrs: [], openPrs: [], conflictEvents: CLEARED }))
      .toEqual({ action: 'close', reason: 'conflict-resolved-new-head', pr: 10569 });
    expect(decideHandoff({ issue, origin: openOrigin(), mergedPrs: [], openPrs: [], conflictEvents: CLEARED }))
      .toEqual({ action: 'close', reason: 'conflict-resolved', pr: 10569 });
  });

  it('REGRESSIONE review corpus: PR di origine mergeable senza prova da merge-tree → resta aperta', () => {
    for (const conflictEvents of [null, [], [labelEvent('labeled', '2026-09-29T10:00:00Z'), labelEvent('unlabeled', '2026-09-29T12:00:00Z')]]) {
      expect(decideHandoff({ issue, origin: openOrigin({ headRefOid: NEW_HEAD }), mergedPrs: [], openPrs: [], conflictEvents }))
        .toEqual({ action: 'keep', reason: 'conflict-clear-unproven' });
      expect(decideHandoff({ issue, origin: openOrigin(), mergedPrs: [], openPrs: [], conflictEvents }))
        .toEqual({ action: 'keep', reason: 'conflict-clear-unproven' });
    }
  });

  it('la riapplicazione si riconosce anche dal titolo della PR mergiata', () => {
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 10722, title: 'fix(ci): reapply (closes #10586)', body: '' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 10722 });
  });

  it('subito prima di chiudere si rilegge lo stato dal vivo: claim preso o issue già chiusa → niente', () => {
    expect(stillClosable({ state: 'OPEN', labels: [{ name: 'agent:triaged' }] })).toBe(true);
    expect(stillClosable({ state: 'OPEN', labels: [{ name: 'agent:in-progress' }] })).toBe(false);
    expect(stillClosable({ state: 'CLOSED', labels: [] })).toBe(false);
    expect(stillClosable({ state: 'OPEN' })).toBe(false);
    expect(stillClosable(null)).toBe(false);
  });

  it.each([
    ['ancora in conflitto', openOrigin({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', labels: [{ name: 'has-conflicts' }] }), 'origin-open'],
    ['HEAD nuova ancora has-conflicts', openOrigin({ headRefOid: NEW_HEAD, labels: [{ name: 'has-conflicts' }] }), 'origin-has-conflicts'],
    ['chiusa senza merge', { state: 'CLOSED' }, 'origin-closed'],
    ['illeggibile', null, 'origin-unreadable'],
  ])('PR di origine %s → resta aperta', (_label, origin, reason) => {
    expect(decideHandoff({ issue, origin, mergedPrs: [], openPrs: [] })).toEqual({ action: 'keep', reason });
  });

  it('una riapplicazione in volo tiene aperto l\'hand-off anche se la PR di origine è tornata pulita', () => {
    expect(decideHandoff({
      issue,
      origin: openOrigin(),
      mergedPrs: [],
      openPrs: [{ number: 10730, headRefName: 'fix/issue-10586', body: 'Closes #10586' }],
    })).toEqual({ action: 'keep', reason: 'reapply-in-flight', pr: 10730 });
    expect(decideHandoff({ issue, origin: openOrigin(), mergedPrs: [], openPrs: null }))
      .toEqual({ action: 'keep', reason: 'open-prs-unreadable' });
  });

  it('un claim attivo non si tocca: il fixer ci sta lavorando', () => {
    const claimed = handoff(10586, 10569, { labels: ['agent:in-progress'] });
    expect(decideHandoff({ issue: claimed, origin: { state: 'MERGED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'claim-active' });
  });

  it('il commento porta il marker e il motivo, mai una keyword di chiusura', () => {
    const text = closingComment({ reason: 'duplicate', originNumber: 10569, keeper: 10586 });
    expect(text.startsWith(RECONCILE_MARKER)).toBe(true);
    expect(text).toContain('duplicato di #10586');
    expect(closingComment({ reason: 'origin-merged', pr: 10569, originNumber: 10569 })).toContain('**completed**');
    for (const reason of ['duplicate', 'reapplied', 'origin-merged', 'conflict-resolved', 'conflict-resolved-new-head']) {
      const body = closingComment({ reason, pr: 10720, originNumber: 10569, keeper: 10586 });
      expect(body).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#\d/i);
    }
  });
});

// --- LC-02: un hand-off per PR di origine; origine chiusa ---------------------

const at = (iso: string) => Date.parse(iso);
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

describe('REPLAY #11147: il keeper è chi è instradato, e un duplicato appena nato non si chiude', () => {
  // 03-10: #11151 (titolo senza LGTM, mai instradata) alle 15:12:24Z; #11154
  // (titolo «dopo LGTM», stessa HEAD) creata 11 minuti dopo e chiusa come
  // duplicate 3 minuti più tardi, prima di ricevere `agent:fix`.
  const i11151 = { ...handoff(11151, 11147), labels: ['agent:triaged'], created_at: '2026-10-03T15:12:24Z' };
  const i11154 = { ...handoff(11154, 11147, { lgtm: true }), labels: ['agent:triaged'], created_at: '2026-10-03T15:23:53Z' };

  it('i due titoli sono diversi, ma il gruppo è uno solo: la chiave è la PR di origine', () => {
    expect(i11151.title).not.toBe(i11154.title);
    const groups = groupHandoffs([i11151, i11154]);
    expect(groups.map((g) => g.origin)).toEqual([11147]);
  });

  it('dopo 3 minuti, nessuno instradato: nessuna chiusura (il nuovo sta ricevendo agent:fix)', () => {
    const now = at('2026-10-03T15:26:53Z');
    const [group] = groupHandoffs([i11151, i11154], []);
    expect(group.keeper.number).toBe(11151);
    const plan = planDuplicateClosures(group, [], now);
    expect(plan.close).toEqual([]);
    expect(plan.deferred.map((d) => d.issue.number)).toEqual([11154]);
    expect(plan.deferred[0].why).toContain(`${MIN_DUPLICATE_AGE_MINUTES} minuti`);
  });

  it('dopo 10 minuti, con #11154 instradata: resta #11154 e il duplicato è #11151', () => {
    const now = at('2026-10-03T15:23:53Z') + minutes(MIN_DUPLICATE_AGE_MINUTES);
    const routed = { ...i11154, labels: ['agent:triaged', 'agent:fix'] };
    const [group] = groupHandoffs([i11151, routed], []);
    expect(group.keeper.number).toBe(11154);
    expect(planDuplicateClosures(group, [], now).close.map((i) => i.number)).toEqual([11151]);
  });

  it('elezione: claim o PR in volo, poi instradata (anche in coda), poi il numero più basso', () => {
    const a = { ...handoff(1, 9), labels: [] as string[] };
    const queued = { ...handoff(2, 9), labels: ['agent:fix-queued'] };
    const claimed = { ...handoff(3, 9), labels: ['agent:in-progress'] };
    expect(electHandoffKeeper([a, queued], 9).number).toBe(2);
    expect(electHandoffKeeper([a, queued, claimed], 9).number).toBe(3);
    expect(electHandoffKeeper([a, queued], 9, [{ number: 50, headRefName: 'fix/issue-1', body: '' }]).number).toBe(1);
    expect(electHandoffKeeper([queued, a], 9).number).toBe(2);
    expect(electHandoffKeeper([], 9)).toBeNull();
  });

  it('created_at assente o illeggibile conta come vecchio (comportamento di prima)', () => {
    const now = at('2026-10-03T16:00:00Z');
    expect(duplicateOldEnough({ number: 1 }, now)).toBe(true);
    expect(duplicateOldEnough({ number: 1, created_at: 'boh' }, now)).toBe(true);
    expect(duplicateOldEnough({ number: 1, created_at: '2026-10-03T15:51:00Z' }, now)).toBe(false);
    expect(duplicateOldEnough({ number: 1, createdAt: '2026-10-03T15:50:00Z' }, now)).toBe(true);
  });

  it('un duplicato con lavoro avviato o PR aperte illeggibili resta al tick dopo', () => {
    const now = at('2026-10-04T00:00:00Z');
    const [group] = groupHandoffs([i11151, i11154], []);
    expect(planDuplicateClosures(group, null as any, now).close).toEqual([]);
    expect(planDuplicateClosures(group, [{ number: 11160, headRefName: 'fix/issue-11154', body: '' }], now).close).toEqual([]);
  });
});

/** Patch nel formato di `pulls/<n>/files`: contesto `before`, rimozioni, aggiunte. */
const patch = (lines: string[], removed: string[] = [], before: string[] = []) => [
  `@@ -1,${before.length + removed.length} +1,${before.length + lines.length} @@`,
  ...before.map((l) => ` ${l}`),
  ...removed.map((l) => `-${l}`),
  ...lines.map((l) => `+${l}`),
].join('\n');

describe('originContentOnMain: tutto o non provato', () => {
  const added = ['export const A = 1;', '', '  return a + b;'];
  const files = [{ filename: 'src/a.ts', status: 'modified', patch: patch(added, ['old'], ['// x']) }];
  const main = (text: string | null) => () => text;

  it('tutte le righe aggiunte non vuote su main → provato, con il conteggio', () => {
    expect(originContentOnMain(files, main('// x\nexport const A = 1;\n\n  return a + b;\n')))
      .toEqual({ proven: true, checked: added.filter((l) => l.trim()).length, files: ['src/a.ts'] });
  });

  it('una sola riga mancante → non provato', () => {
    const verdict = originContentOnMain(files, main('export const A = 1;\n'));
    expect(verdict.proven).toBe(false);
    expect((verdict as any).reason).toContain('src/a.ts: hunk 1/1');
  });

  it('file senza patch (binario o troppo grande) → non provato', () => {
    expect(originContentOnMain([{ filename: 'img.png', status: 'modified' }], main('x')).proven).toBe(false);
    expect(originContentOnMain([...files, { filename: 'big.json', status: 'modified', patch: '' }], main('export const A = 1;\n  return a + b;')).proven).toBe(false);
  });

  it('lettura di main fallita, file assente o eccezione → non provato', () => {
    expect(originContentOnMain(files, main(null)).proven).toBe(false);
    expect(originContentOnMain(files, () => { throw new Error('503'); }).proven).toBe(false);
  });

  it('file rimosso, sole rimozioni o elenco vuoto → non provato', () => {
    expect(originContentOnMain([{ filename: 'gone.ts', status: 'removed', patch: patch([], ['x']) }], main('')).proven).toBe(false);
    expect(originContentOnMain([{ filename: 'a.ts', status: 'modified', patch: patch([], ['x']) }], main('')).proven).toBe(false);
    expect(originContentOnMain([], main('')).proven).toBe(false);
    expect(originContentOnMain(null as any, main('')).proven).toBe(false);
  });

  it('l\'intestazione +++ non è una riga aggiunta; gli spazi ai bordi e ripetuti non contano', () => {
    const withHeader = [{ filename: 'a.ts', status: 'modified', patch: `+++ b/a.ts\n${patch(['  // due  spazi'])}` }];
    expect(originContentOnMain(withHeader, main('\t// due spazi\r\n')).proven).toBe(true);
  });

  it('dentro un hunk una riga che inizia con ++ è una riga aggiunta, non un\'intestazione', () => {
    const plusPlus = [{ filename: 'a.ts', status: 'modified', patch: patch(['++i;', 'const x = 1;']) }];
    expect(originContentOnMain(plusPlus, main('const x = 1;\n')).proven).toBe(false);
    expect(originContentOnMain(plusPlus, main('++i;\nconst x = 1;\n'))).toEqual({ proven: true, checked: 2, files: ['a.ts'] });
  });
});

// Review del corpus sulla PR di trasporto 2090 (unico 🔴): la prova era un
// `Set` di righe, quindi una riga aggiunta che su main compare SOLO altrove (il
// contesto di un altro hunk) o una riga aggiunta due volte e presente una sola
// facevano «su main» una PR mai applicata. La prova e' ora un'applicazione al
// contrario: il nuovo lato di ogni hunk (contesto + aggiunte, in ordine) deve
// stare CONTIGUO su main, ogni hunk in una posizione distinta e nell'ordine
// della patch.
describe('originContentOnMain: applicazione hunk per hunk, non presenza di righe', () => {
  const main = (text: string | null) => () => text;
  const file = (p: string) => [{ filename: 'src/b.ts', status: 'modified', patch: p }];
  // Due hunk: il primo aggiunge `return null;` in a(), il secondo ha la stessa
  // riga come CONTESTO in b() e cambia `old()` in `fresh()`.
  const twoHunks = [
    '@@ -1,3 +1,4 @@',
    ' function a() {',
    '+  return null;',
    ' }',
    ' ',
    '@@ -10,4 +11,4 @@',
    ' function b() {',
    '-  old();',
    '+  fresh();',
    '   return null;',
    ' }',
  ].join('\n');
  const ORIGINAL = 'function a() {\n}\n\n// ...\nfunction b() {\n  old();\n  return null;\n}\n';
  const APPLIED = 'import x;\nfunction a() {\n  return null;\n}\n\n// ...\n// altro\nfunction b() {\n  fresh();\n  return null;\n}\n';

  it('una riga aggiunta presente su main solo nel contesto di un altro hunk → non provato', () => {
    // Su main c'e' `fresh()` (secondo hunk applicato) ma a() e' ancora vuota:
    // `return null;` compare solo dentro b().
    const onlySecond = 'function a() {\n}\n\nfunction b() {\n  fresh();\n  return null;\n}\n';
    const verdict = originContentOnMain(file(twoHunks), main(onlySecond));
    expect(verdict.proven).toBe(false);
    expect((verdict as any).reason).toContain('src/b.ts: hunk 1/2');
    expect(originContentOnMain(file(twoHunks), main(ORIGINAL)).proven).toBe(false);
  });

  it('una riga aggiunta due volte ma presente una volta su main → non provato', () => {
    const twice = '@@ -1,2 +1,4 @@\n const list = [\n+  \'a\',\n+  \'a\',\n ];';
    expect(originContentOnMain(file(twice), main('const list = [\n  \'a\',\n];\n')).proven).toBe(false);
    expect(originContentOnMain(file(twice), main('const list = [\n  \'a\',\n  \'a\',\n];\n')))
      .toEqual({ proven: true, checked: 2, files: ['src/b.ts'] });
  });

  it('patch davvero applicata, con righe nuove fra un hunk e l\'altro → provato', () => {
    expect(originContentOnMain(file(twoHunks), main(APPLIED))).toEqual({ proven: true, checked: 2, files: ['src/b.ts'] });
  });

  it('hunk su main in ordine inverso, o due hunk sulla stessa posizione → non provato', () => {
    const same = '@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -8,2 +9,3 @@\n a\n+b\n c';
    expect(originContentOnMain(file(same), main('a\nb\nc\n')).proven).toBe(false);
    expect(originContentOnMain(file(same), main('a\nb\nc\nz\na\nb\nc\n')).proven).toBe(true);
    const reversed = 'function b() {\n  fresh();\n  return null;\n}\nfunction a() {\n  return null;\n}\n';
    expect(originContentOnMain(file(twoHunks), main(reversed)).proven).toBe(false);
  });

  it('diff troncato (righe meno di quelle dichiarate dall\'intestazione dell\'hunk) → non provato', () => {
    const truncated = '@@ -1,3 +1,5 @@\n a\n+b\n+c';
    const verdict = originContentOnMain(file(truncated), main('a\nb\nc\nd\ne\n'));
    expect(verdict.proven).toBe(false);
    expect((verdict as any).reason).toContain('troncat');
  });

  it('patch senza intestazione di hunk o con una riga estranea → non provato', () => {
    expect(originContentOnMain(file('+solo una riga'), main('solo una riga\n')).proven).toBe(false);
    expect(originContentOnMain(file('@@ -1,1 +1,2 @@\n a\n+b\n?c'), main('a\nb\n')).proven).toBe(false);
  });

  it('una rimozione fra due righe di contesto e\' provata solo se su main non c\'e\' piu\'', () => {
    const swap = '@@ -1,3 +1,3 @@\n a\n-old\n+new\n b';
    expect(originContentOnMain(file(swap), main('a\nnew\nb\n')).proven).toBe(true);
    expect(originContentOnMain(file(swap), main('a\nold\nnew\nb\n')).proven).toBe(false);
    expect(originContentOnMain(file(swap), main('a\nnew\nold\nb\n')).proven).toBe(false);
  });

  it('una rimozione in testa o in coda all\'hunk ancora l\'hunk all\'inizio o alla fine del file', () => {
    const head = '@@ -1,2 +1,2 @@\n-old\n+new\n a';
    expect(originContentOnMain(file(head), main('new\na\n')).proven).toBe(true);
    expect(originContentOnMain(file(head), main('old\nnew\na\n')).proven).toBe(false);
    const tail = '@@ -1,2 +1,2 @@\n a\n+new\n-old';
    expect(originContentOnMain(file(tail), main('a\nnew\n')).proven).toBe(true);
    expect(originContentOnMain(file(tail), main('a\nnew\nold\n')).proven).toBe(false);
  });

  it('\\ No newline at end of file non e\' una riga del file', () => {
    const noEol = '@@ -1,1 +1,2 @@\n a\n+b\n\\ No newline at end of file';
    expect(originContentOnMain(file(noEol), main('a\nb')).proven).toBe(true);
  });
});

describe('decideHandoff: PR di origine CHIUSA senza merge', () => {
  const CLOSED_AT = '2026-10-01T09:36:15Z';
  const closedOrigin = (over: Record<string, unknown> = {}) => ({ state: 'CLOSED', closedAt: CLOSED_AT, labels: [], body: 'Closes #7421', ...over });
  const after30h = at(CLOSED_AT) + hours(30);
  const notOnMain = { proven: false, reason: 'scripts/lib/rehydrate-section-shards.sh: 92/116 righe aggiunte non su main' };
  const issue7421Parked = { number: 7421, state: 'OPEN', labels: [{ name: 'maybe-resolved' }, { name: 'automation-deferred' }] };
  // #10731: hand-off mai instradato, con il marker ALREADY_FIXED_ROUTED sul thread.
  const h10731 = {
    ...handoff(10731, 10467),
    labels: ['agent:triaged', 'maybe-resolved'],
    comments: [{ body: '<!-- ALREADY_FIXED_ROUTED pr=10727 run=36841197125 -->' }],
  };

  it('REPLAY #10873 (PR #10865): patch applicata su main hunk per hunk → completed', () => {
    // Forma misurata il 03-10 sulla PR #10865: 3 file, una riga di commento
    // con due spazi che #11201 ha poi normalizzato su main.
    const files = [
      { filename: 'build-plugins/jobsSeoPagesPlugin.ts', status: 'modified', patch: patch(['  // tracked locale cluster when one exists.  These pages are emitted by the', '  const archive = true;'], ['old'], ['x']) },
      { filename: 'tests/cross-canton-active-drift-bridge.test.ts', status: 'modified', patch: patch(['    expect(x).toBe(true);']) },
      { filename: 'tests/seo/historical-archive-hreflang.test.ts', status: 'added', patch: patch(['import { it } from \'vitest\';', 'it(\'hreflang\', () => {});']) },
    ];
    const mainText: Record<string, string> = {
      'build-plugins/jobsSeoPagesPlugin.ts': 'x\n  // tracked locale cluster when one exists. These pages are emitted by the\n  const archive = true;\n',
      'tests/cross-canton-active-drift-bridge.test.ts': '    expect(x).toBe(true);\n',
      'tests/seo/historical-archive-hreflang.test.ts': 'import { it } from \'vitest\';\nit(\'hreflang\', () => {});\n',
    };
    const contentProof = originContentOnMain(files, (p: string) => mainText[p] ?? null);
    expect(contentProof.proven).toBe(true);
    const issue = handoff(10873, 10865);
    const origin = closedOrigin({ closedAt: '2026-10-02T06:23:08Z', body: '' });
    const now = at('2026-10-03T16:00:00Z');
    expect(decideHandoff({ issue, origin, mergedPrs: [], openPrs: [], contentProof, originIssues: [], now }))
      .toEqual({ action: 'close', reason: 'origin-closed-content-on-main', pr: 10865 });
    const text = closingComment({ reason: 'origin-closed-content-on-main', originNumber: 10865, pr: 10865, contentProof });
    expect(text).toContain('`build-plugins/jobsSeoPagesPlugin.ts`');
    expect(text).toContain(`tutte le ${(contentProof as any).checked} righe`);
    expect(text).toContain('**completed**');
    expect(NOT_PLANNED_REASONS.has('origin-closed-content-on-main')).toBe(false);
  });

  it('REPLAY #10731 (PR #10467): contenuto assente da main, marker ALREADY_FIXED_ROUTED presente → not planned, MAI completed', () => {
    for (const originIssues of [[issue7421Parked], [{ number: 7421, state: 'CLOSED', labels: [] }]]) {
      const decision = decideHandoff({ issue: h10731, origin: closedOrigin(), mergedPrs: [], openPrs: [], contentProof: notOnMain, originIssues, now: after30h });
      expect(decision).toEqual({ action: 'close', reason: 'origin-closed-superseded', pr: 10467 });
    }
    expect(NOT_PLANNED_REASONS.has('origin-closed-superseded')).toBe(true);
    const text = closingComment({ reason: 'origin-closed-superseded', originNumber: 10467, pr: 10467, contentProof: notOnMain, originIssues: [issue7421Parked] });
    expect(text).toContain('il contenuto della PR di origine NON risulta su main');
    expect(text).toContain('#7421 (aperta, maybe-resolved, automation-deferred)');
    expect(text).toContain('**not planned**');
    expect(text).not.toContain('**completed**');
  });

  it('la label orphaned (chiusa da un custode) non rende completed un contenuto assente da main', () => {
    const origin = closedOrigin({ labels: [{ name: 'orphaned' }] });
    expect(decideHandoff({ issue: h10731, origin, mergedPrs: [], openPrs: [], contentProof: notOnMain, originIssues: [issue7421Parked], now: after30h }))
      .toEqual({ action: 'close', reason: 'origin-closed-superseded', pr: 10467 });
  });

  it.each([
    ['chiusa da 2 ore', { now: at(CLOSED_AT) + hours(2) }, 'origin-closed'],
    ['closedAt assente', { origin: { state: 'CLOSED' } }, 'origin-closed'],
    ['closedAt illeggibile', { origin: { state: 'CLOSED', closedAt: 'ieri' } }, 'origin-closed'],
    ['hand-off instradato (agent:fix)', { issue: { ...h10731, labels: ['agent:fix'] } }, 'origin-closed-handoff-routed'],
    ['hand-off in coda (agent:fix-queued)', { issue: { ...h10731, labels: ['agent:fix-queued'] } }, 'origin-closed-handoff-routed'],
    ['issue di origine aperta senza routing', { originIssues: [{ number: 7421, state: 'OPEN', labels: [{ name: 'maybe-resolved' }] }] }, 'origin-closed-issue-not-requeued'],
    ['issue di origine illeggibile', { originIssues: [null] }, 'origin-closed-issue-not-requeued'],
    ['elenco delle issue di origine illeggibile', { originIssues: null }, 'origin-closed-issue-not-requeued'],
    ['elenco dei file della PR illeggibile', { contentProof: null }, 'origin-content-unchecked'],
    ['PR aperte illeggibili', { openPrs: null }, 'open-prs-unreadable'],
  ])('%s → resta aperta', (_label, over, reason) => {
    const input = { issue: h10731, origin: closedOrigin(), mergedPrs: [], openPrs: [], contentProof: notOnMain, originIssues: [issue7421Parked], now: after30h, ...over } as any;
    expect(decideHandoff(input)).toEqual({ action: 'keep', reason });
  });

  it('una riapplicazione in volo tiene aperto l\'hand-off anche con il contenuto su main', () => {
    expect(decideHandoff({
      issue: h10731, origin: closedOrigin(), mergedPrs: [], now: after30h,
      openPrs: [{ number: 10800, headRefName: 'fix/issue-10731', body: '' }],
      contentProof: { proven: true, checked: 3, files: ['a'] }, originIssues: [],
    })).toEqual({ action: 'keep', reason: 'reapply-in-flight', pr: 10800 });
  });

  it('claim attivo e riapplicazione mergiata restano prioritari', () => {
    const claimed = { ...h10731, labels: ['agent:in-progress'] };
    expect(decideHandoff({ issue: claimed, origin: closedOrigin(), mergedPrs: [], openPrs: [], contentProof: notOnMain, originIssues: [], now: after30h }))
      .toEqual({ action: 'keep', reason: 'claim-active' });
    expect(decideHandoff({ issue: h10731, origin: closedOrigin(), mergedPrs: [{ number: 10900, body: 'Supersedes #10467' }], openPrs: [], contentProof: notOnMain, originIssues: [], now: after30h }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 10900 });
  });

  it('issue di origine instradate o parcheggiate non sono orfane', () => {
    for (const name of ['agent:fix', 'agent:fix-queued', 'fu-parked', 'automation-deferred', 'needs-human']) {
      expect(decideHandoff({ issue: h10731, origin: closedOrigin(), mergedPrs: [], openPrs: [], contentProof: notOnMain, originIssues: [{ number: 1, state: 'OPEN', labels: [{ name }] }], now: after30h }).reason)
        .toBe('origin-closed-superseded');
    }
  });

  it('la grazia di 24 ore vale solo per un\'origine CLOSED con closedAt leggibile', () => {
    expect(originClosedPastGrace(closedOrigin(), after30h)).toBe(true);
    expect(originClosedPastGrace(closedOrigin(), at(CLOSED_AT) + hours(23))).toBe(false);
    expect(originClosedPastGrace({ state: 'MERGED', closedAt: CLOSED_AT }, after30h)).toBe(false);
    expect(originClosedPastGrace({ state: 'CLOSED' }, after30h)).toBe(false);
  });

  it('i commenti nuovi portano il marker e nessuna keyword di chiusura', () => {
    for (const reason of ['origin-closed-content-on-main', 'origin-closed-superseded']) {
      const body = closingComment({ reason, pr: 10467, originNumber: 10467, contentProof: notOnMain, originIssues: [issue7421Parked, { number: 8, state: 'CLOSED', labels: [] }] });
      expect(body.startsWith(RECONCILE_MARKER)).toBe(true);
      expect(body).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#\d/i);
    }
  });
});

describe('contratto del gemello del corpus (generator/tests/conflict-handoff-reconcile.test.mjs)', () => {
  // Il file è `identical`: il trasporto lo copia nel corpus senza i test nuovi.
  // Questi casi sono quelli che il gemello pinna oggi e devono restare verdi.
  const twin = (number: number, origin: number, labels: string[] = []) => handoff(number, origin, { labels });

  it('keeper: il numero più basso salvo claim', () => {
    const groups = groupHandoffs([twin(1587, 1569), twin(1586, 1569)]);
    expect(groups[0].keeper.number).toBe(1586);
    expect(groups[0].duplicates.map((i) => i.number)).toEqual([1587]);
    const claimed = groupHandoffs([twin(1586, 1569), twin(1587, 1569, ['agent:in-progress'])]);
    expect(claimed[0].keeper.number).toBe(1587);
  });

  it('decideHandoff: stessi esiti di prima, compresa l\'origine chiusa senza closedAt', () => {
    const issue = twin(1586, 1569);
    expect(decideHandoff({ issue, origin: { state: 'MERGED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'origin-merged', pr: 1569 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 1720, body: 'Supersedes #1569' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 1720 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [{ number: 1722, title: 'reapply (closes #1586)', body: '' }], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'reapplied', pr: 1722 });
    expect(decideHandoff({ issue, origin: { state: 'CLOSED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'origin-closed' });
    expect(decideHandoff({ issue, origin: openOrigin({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'origin-open' });
    expect(decideHandoff({ issue, origin: openOrigin(), mergedPrs: [], openPrs: null }))
      .toEqual({ action: 'keep', reason: 'open-prs-unreadable' });
    expect(decideHandoff({ issue: twin(1586, 1569, ['agent:in-progress']), origin: { state: 'MERGED' }, mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'keep', reason: 'claim-active' });
  });

  it('il commento dei cinque motivi di prima porta il marker e nessuna keyword', () => {
    for (const reason of ['duplicate', 'reapplied', 'origin-merged', 'conflict-resolved', 'conflict-resolved-new-head']) {
      const body = closingComment({ reason, pr: 1720, originNumber: 1569, keeper: 1586 });
      expect(body.startsWith(RECONCILE_MARKER)).toBe(true);
      expect(body).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#\d/i);
    }
  });

  it('nessun import nuovo: il corpus ha gli stessi moduli importati di prima', () => {
    const source = readFileSync('scripts/ci/reconcile-conflict-handoffs.mjs', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      './check-issue-already-resolved.mjs',
      './followup-resolution-match.mjs',
      './lib/run-budget.mjs',
      './stale-claim-detector.mjs',
      'node:child_process',
      'node:fs',
      'node:path',
      'node:url',
    ]);
  });
});

describe('wiring: pre-flight e drainer chiudono, non lasciano maybe-resolved', () => {
  it('il pre-flight chiude un hand-off risolto con prova; senza prova sulla stessa HEAD resta il vecchio rinvio', () => {
    const source = readFileSync('scripts/ci/check-issue-already-resolved.mjs', 'utf8');
    const main = source.slice(source.indexOf('function main() {'));
    const branch = main.slice(
      main.indexOf('const handoffOrigin = conflictHandoffOriginPr(iss.title);'),
      main.indexOf("if (!labels.includes('follow-up')) {"),
    );
    expect(branch).toContain('conflictClearedAfter(events, openedAt)');
    expect(branch).toContain('handoffResolution(origin');
    expect(branch).toContain('closeResolvedHandoff(');
    expect(branch.match(/shortCircuit\(/g)).toHaveLength(1);
    const sameHead = branch.slice(branch.indexOf('if (verdict.sameHeadMergeable) {'), branch.indexOf('if (!verdict.resolved) {'));
    expect(sameHead).toContain('shortCircuit(');
    const closer = source.slice(source.indexOf('function closeResolvedHandoff('), source.indexOf('function main() {'));
    expect(closer).toContain("'issue', 'close', ISSUE");
    expect(closer).toContain("'--reason', 'completed'");
  });

  it('il riconciliatore legge gli eventi della label solo per una PR di origine aperta e rilegge il claim prima di chiudere', () => {
    const source = readFileSync('scripts/ci/reconcile-conflict-handoffs.mjs', 'utf8');
    expect(source).toContain("String(originPr?.state || '').toUpperCase() === 'OPEN' ? readConflictEvents(origin) : null");
    const closer = source.slice(source.indexOf('function closeIssue('), source.indexOf('function main() {'));
    expect(closer.indexOf('stillClosable(')).toBeGreaterThan(-1);
    expect(closer.indexOf('stillClosable(')).toBeLessThan(closer.indexOf("'issue', 'comment'"));
  });

  it('origine chiusa: file, main e issue si leggono solo oltre la grazia; «superato» chiude not planned e rilegge il routing', () => {
    const source = readFileSync('scripts/ci/reconcile-conflict-handoffs.mjs', 'utf8');
    const main = source.slice(source.indexOf('function main() {'));
    expect(main).toContain('const closedLong = originClosedPastGrace(originPr, now)');
    // Nessuna lettura quando la decisione e' comunque keep (riapplicazione in volo o PR aperte illeggibili).
    const closedLongExpr = main.slice(main.indexOf('const closedLong ='), main.indexOf('const contentProof ='));
    expect(closedLongExpr).toContain('Array.isArray(openPrs)');
    expect(closedLongExpr).toContain('reapplyInFlight(openPrs, { issueNumber: keeper.number, originNumber: origin }) === null');
    expect(closedLongExpr).toContain('budget.canAfford(CONTENT_PROOF_BUDGET_MS)');
    expect(main).toContain('const contentProof = closedLong ? readContentProof(origin) : null;');
    expect(main).toContain('const originIssues = closedLong ? readOriginIssues(originPr) : null;');
    expect(main).toContain('planDuplicateClosures(');
    expect(source).toContain("'--json', 'state,mergedAt,closedAt,mergeable,mergeStateStatus,headRefOid,labels,title,body'");
    const closer = source.slice(source.indexOf('function closeIssue('), source.indexOf('function main() {'));
    expect(closer).toContain("NOT_PLANNED_REASONS.has(reason) ? 'not planned' : 'completed'");
    expect(closer.indexOf('handoffRouted(live)')).toBeGreaterThan(-1);
    expect(closer.indexOf('handoffRouted(live)')).toBeLessThan(closer.indexOf("'issue', 'comment'"));
  });

  it('il drainer riconcilia gli hand-off prima di promuovere, con GITHUB_TOKEN e senza bloccare il drain', () => {
    const document = YAML.parse(readFileSync('.github/workflows/followup-drainer.yml', 'utf8')) as any;
    const steps = Object.values(document.jobs ?? {}).flatMap((job: any) => job.steps ?? []) as any[];
    const reconcile = steps.findIndex((step) => step.run === 'node scripts/ci/reconcile-conflict-handoffs.mjs');
    const drain = steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('node scripts/ci/followup-drainer.mjs'));
    expect(reconcile).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(drain);
    expect(steps[reconcile]['continue-on-error']).toBe(true);
    expect(steps[reconcile].env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(ENTRYPOINTS).toContain('scripts/ci/reconcile-conflict-handoffs.mjs');
  });
});
