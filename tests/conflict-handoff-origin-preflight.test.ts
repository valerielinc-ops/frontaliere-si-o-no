/**
 * Issue di hand-off di un conflitto: la PR di origine non è un overlap, e una
 * PR di origine già mergiata (o di nuovo MERGEABLE) chiude l'hand-off senza
 * una PR di riapplicazione.
 *
 * Misurato il 27-09:
 *  - #10131 («riapplicare la PR #10121») chiusa `overlap-skip` con
 *    `fu-attempt:1` perché i file erano «già in volo nella PR #10121», cioè la
 *    PR che l'hand-off doveva sostituire; il drainer l'avrebbe rinviata a ogni
 *    tick finché #10121 restava aperta.
 *  - #10133 («riapplicare la PR #10123»): #10123 aggiornata con main alle
 *    17:37Z e mergiata alle 17:57Z; issue-fix ha aperto comunque #10136 alle
 *    18:00Z, duplicato subito in conflitto, con un secondo hand-off (#10137).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildConflictHandoffIssue } from '../scripts/ci/pr-autorebase.mjs';
import {
  conflictHandoffOriginPr as drainerOriginPr,
  findOverlapFile,
  normalizeOpenPrPage,
  STALLED_PR_LABELS,
} from '../scripts/ci/followup-drainer.mjs';
import {
  conflictHandoffExpectedHead,
  conflictHandoffOriginPr as preflightOriginPr,
  handoffOriginVerdict,
} from '../scripts/ci/check-issue-already-resolved.mjs';

const HEAD = 'a'.repeat(40);
const handoffTitle = (lgtm: boolean) => buildConflictHandoffIssue({
  num: 10121,
  branch: 'fix/offerwall-spa-status-10107-20260927',
  head: HEAD,
  files: ['services/offerwallClickGate.ts'],
  lgtm,
}).title;

describe('titolo di hand-off: i due parser leggono ciò che pr-autorebase scrive', () => {
  it.each([true, false])('lgtm=%s → PR di origine', (lgtm) => {
    expect(drainerOriginPr(handoffTitle(lgtm))).toBe(10121);
    expect(preflightOriginPr(handoffTitle(lgtm))).toBe(10121);
  });

  it.each([
    'fix(offerwall): reconcile stale SPA route state',
    'follow-up(daily:2026-09-27): 1 item — valerielinc-ops/frontaliere-si-o-no',
    'Re: Conflitto con main: riapplicare la PR #10121 su main',
    'Conflitto con main: riapplicare la PR #abc su main',
    '',
  ])('non è un hand-off: %j', (title) => {
    expect(drainerOriginPr(title)).toBeNull();
    expect(preflightOriginPr(title)).toBeNull();
  });
});

describe('findOverlapFile ignora la PR che l\'hand-off sostituisce (#10131)', () => {
  type PrEntry = { title: string; files: Set<string>; labels?: string[] };
  const map = new Map<number, PrEntry>([
    [10121, { title: 'fix(offerwall): reconcile stale SPA route state', files: new Set(['services/offerwallClickGate.ts']) }],
  ]);

  it('senza eccezione la PR di origine blocca il proprio hand-off', () => {
    expect(findOverlapFile(['services/offerwallClickGate.ts'], map)?.prNumber).toBe(10121);
  });

  it('con ignorePr la PR di origine non conta', () => {
    expect(findOverlapFile(['services/offerwallClickGate.ts'], map, {
      ignorePr: drainerOriginPr(handoffTitle(true)),
    })).toBeNull();
  });

  it('un\'ALTRA PR aperta sugli stessi file resta un overlap', () => {
    const withOther = new Map(map);
    withOther.set(10200, { title: 'fix: other', files: new Set(['services/offerwallClickGate.ts']) });
    expect(findOverlapFile(['services/offerwallClickGate.ts'], withOther, { ignorePr: 10121 })?.prNumber)
      .toBe(10200);
  });

  it.each(STALLED_PR_LABELS)('REGRESSIONE #10586: una PR ferma (%s) non è lavoro in volo', (label) => {
    // #10555 era `has-conflicts` + `stale-review`: aspettarla rinviava per
    // sempre l'hand-off di #10569, che a sua volta la teneva in conflitto.
    const withStalled = new Map(map);
    withStalled.set(10555, {
      title: 'fix(ci): gate scheduled data refreshes through PRs',
      files: new Set(['services/offerwallClickGate.ts']),
      labels: [label],
    });
    expect(findOverlapFile(['services/offerwallClickGate.ts'], withStalled, { ignorePr: 10121 })).toBeNull();
  });

  it('una PR attiva con label qualsiasi resta un overlap', () => {
    const withActive = new Map(map);
    withActive.set(10200, { title: 'fix: other', files: new Set(['services/offerwallClickGate.ts']), labels: ['collision-risk', 'agent:autofix'] });
    expect(findOverlapFile(['services/offerwallClickGate.ts'], withActive, { ignorePr: 10121 })?.prNumber).toBe(10200);
  });

  it('la mappa delle PR aperte porta le label dalla REST; assenti = nessuna (overlap pieno)', () => {
    expect(normalizeOpenPrPage([
      { number: 10555, title: 't', body: null, labels: [{ name: 'has-conflicts' }, { name: 'stale-review' }] },
      { number: 10556, title: 'u', body: 'b' },
    ])?.rows).toEqual([
      { number: 10555, title: 't', body: '', labels: ['has-conflicts', 'stale-review'] },
      { number: 10556, title: 'u', body: 'b', labels: [] },
    ]);
    const source = readFileSync('scripts/ci/followup-drainer.mjs', 'utf8');
    expect(source).toContain('labels: pr.labels, files: new Set(filesScan.rows)');
  });

  it('il pre-flight del drainer passa il titolo del candidato', () => {
    const source = readFileSync('scripts/ci/followup-drainer.mjs', 'utf8');
    expect(source).toMatch(
      /findOverlapFile\(candPaths, prFilesScan\.map, \{\s*ignorePr: conflictHandoffOriginPr\(cand\.title\),\s*\}\)/,
    );
  });
});

describe('handoffOriginVerdict: quando l\'hand-off non ha più nulla da riapplicare (#10136)', () => {
  it.each([
    [{ state: 'MERGED', mergeable: 'UNKNOWN' }, true, 'merged'],
    [{ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: HEAD }, true, 'conflict-resolved'],
    [{ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: HEAD }, false, 'origin-open'],
    [{ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', headRefOid: HEAD }, false, 'origin-mergeability-stale'],
    [{ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: 'b'.repeat(40) }, false, 'origin-head-unverified'],
    [{ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, false, 'origin-head-unverified'],
    [{ state: 'CLOSED', mergeable: 'CONFLICTING' }, false, 'origin-closed'],
    [null, false, 'origin-unreadable'],
  ])('%j → resolved=%s (%s)', (pr, resolved, reason) => {
    expect(handoffOriginVerdict(pr, { expectedHead: HEAD.slice(0, 12) })).toEqual({ resolved, reason });
  });

  it('legge la head osservata nel body del hand-off e non accetta una head nuova', () => {
    const { body } = buildConflictHandoffIssue({
      num: 10121,
      branch: 'fix/example',
      head: HEAD,
      files: ['src/example.ts'],
    });
    expect(conflictHandoffExpectedHead(body)).toBe(HEAD.slice(0, 12));
    expect(handoffOriginVerdict({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRefOid: HEAD,
    }, { expectedHead: conflictHandoffExpectedHead(body) })).toEqual({
      resolved: true,
      reason: 'conflict-resolved',
    });
  });

  it('il ramo di hand-off precede il filtro follow-up-only, che lo lasciava passare', () => {
    const source = readFileSync('scripts/ci/check-issue-already-resolved.mjs', 'utf8');
    const main = source.slice(source.indexOf('function main() {'));
    const handoff = main.indexOf('const handoffOrigin = conflictHandoffOriginPr(iss.title);');
    const followUpOnly = main.indexOf("if (!labels.includes('follow-up')) {");
    const closed = main.indexOf("if (String(iss.state || '').toUpperCase() === 'CLOSED') {");
    expect(handoff).toBeGreaterThan(closed);
    expect(handoff).toBeGreaterThan(-1);
    expect(handoff).toBeLessThan(followUpOnly);
    expect(main.slice(handoff, followUpOnly)).toContain("'--json', 'state,mergeable,mergeStateStatus,headRefOid,labels'");
  });
});

describe('prompt di issue-fix: stessa eccezione nella regola Overlap-file', () => {
  it('la PR #N dell\'hand-off non conta come overlap', () => {
    const workflow = readFileSync('.github/workflows/issue-fix.yml', 'utf8');
    const rule = workflow.slice(workflow.indexOf('**Overlap-file**'), workflow.indexOf('**Capability guard'));
    expect(rule).toContain('riapplicare la PR #N su main');
    expect(rule).toContain('la PR #N non è overlap');
  });

  it('le PR ferme non contano come overlap, con le stesse label del drainer', () => {
    const workflow = readFileSync('.github/workflows/issue-fix.yml', 'utf8');
    const rule = workflow.slice(workflow.indexOf('**Overlap-file**'), workflow.indexOf('**Capability guard'));
    expect(rule).toContain('--json number,title,labels');
    for (const label of STALLED_PR_LABELS) expect(rule).toContain(`\`${label}\``);
    expect(rule).toContain('STALLED_PR_LABELS');
  });
});
