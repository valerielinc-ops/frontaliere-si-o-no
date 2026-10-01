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
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildConflictHandoffIssue } from '../scripts/ci/pr-autorebase.mjs';
import { handoffResolution } from '../scripts/ci/check-issue-already-resolved.mjs';
import {
  closingComment,
  decideHandoff,
  declaresClosing,
  declaresSupersede,
  groupHandoffs,
  reapplyInFlight,
  RECONCILE_MARKER,
} from '../scripts/ci/reconcile-conflict-handoffs.mjs';
import { ENTRYPOINTS } from '../scripts/ci/check-dependency-free-import-closure.mjs';

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

function handoff(number: number, origin: number, { labels = [] as string[], lgtm = false } = {}) {
  const { title, body } = buildConflictHandoffIssue({
    num: origin,
    branch: `fix/issue-${origin - 1}`,
    head: HEAD,
    files: ['tests/data-refresh-pr-wiring.test.ts'],
    lgtm,
  });
  return { number, title, body, labels };
}

const openOrigin = (over: Record<string, unknown> = {}) => ({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  headRefOid: HEAD,
  labels: [],
  ...over,
});

describe('handoffResolution: il conflitto rientrato su una HEAD nuova (#10657)', () => {
  it('stessa HEAD: delega a handoffOriginVerdict', () => {
    expect(handoffResolution(openOrigin(), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: true, reason: 'conflict-resolved' });
    expect(handoffResolution({ state: 'MERGED' }, { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: true, reason: 'merged' });
  });

  it('HEAD nuova, mergeable e senza has-conflicts → risolto', () => {
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD }), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: true, reason: 'conflict-resolved-new-head' });
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD, labels: [{ name: 'stale-review' }] }), { expectedHead: HEAD.slice(0, 12) }))
      .toEqual({ resolved: true, reason: 'conflict-resolved-new-head' });
  });

  it.each([
    [{ labels: [{ name: 'has-conflicts' }] }, 'origin-has-conflicts'],
    [{ labels: ['has-conflicts'] }, 'origin-has-conflicts'],
    [{ labels: undefined }, 'origin-labels-unreadable'],
    [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'origin-open'],
    [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'origin-mergeability-stale'],
    [{ mergeStateStatus: 'DIRTY' }, 'origin-mergeability-stale'],
  ])('HEAD nuova con %j → non risolto (%s)', (over, reason) => {
    expect(handoffResolution(openOrigin({ headRefOid: NEW_HEAD, ...over }), { expectedHead: HEAD.slice(0, 12) }))
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

  it('PR di origine aperta e di nuovo pulita (HEAD nuova) → chiusa', () => {
    expect(decideHandoff({ issue, origin: openOrigin({ headRefOid: NEW_HEAD }), mergedPrs: [], openPrs: [] }))
      .toEqual({ action: 'close', reason: 'conflict-resolved-new-head', pr: 10569 });
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
  it('il pre-flight chiude un hand-off risolto invece di shortCircuit', () => {
    const source = readFileSync('scripts/ci/check-issue-already-resolved.mjs', 'utf8');
    const main = source.slice(source.indexOf('function main() {'));
    const branch = main.slice(
      main.indexOf('const handoffOrigin = conflictHandoffOriginPr(iss.title);'),
      main.indexOf("if (!labels.includes('follow-up')) {"),
    );
    expect(branch).toContain('handoffResolution(origin');
    expect(branch).toContain('closeResolvedHandoff(');
    expect(branch).not.toContain('shortCircuit(');
    const closer = source.slice(source.indexOf('function closeResolvedHandoff('), source.indexOf('function main() {'));
    expect(closer).toContain("'issue', 'close', ISSUE");
    expect(closer).toContain("'--reason', 'completed'");
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
