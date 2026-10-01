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
  groupHandoffs,
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
