/**
 * Hand-off «superato» di check-issue-already-resolved.mjs: fixture ricavate dal
 * caso del 26-11 (cinque PR parallele per «coordinate Workday egress»; #20086 e'
 * stata mergiata, #20157/#20160/#20164/#20179 sono andate in conflitto). I
 * numeri di issue sono inventati, le PR sono quelle reali.
 */
import { describe, it, expect } from 'vitest';
import {
  declaredClosingIssues,
  handoffSupersededVerdict,
  isGeneratedPath,
} from '../scripts/ci/check-issue-already-resolved.mjs';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const OLD = '2026-11-26T08:00:00Z';
const files = (...paths: string[]) => paths.map((path) => ({ path }));

type Db = Record<string, unknown>;
// read() risponde in base al comando; una chiave assente = lettura fallita.
function reader(db: Db) {
  return (args: string[]) => {
    const id = args[0] === 'pr' && args[1] === 'list' ? 'list' : args[2];
    const hit = db[`${args[0]} ${args[1]} ${id}`];
    return hit === undefined ? null : JSON.stringify(hit);
  };
}
const run = (db: Db, originPr = 20157) => handoffSupersededVerdict({
  originPr, handoffIssue: 30001, read: reader(db), now: NOW,
});

const workdayMerged = { number: 20086, state: 'MERGED', files: files('scripts/crawlers/workday-egress.mjs', 'tests/workday-egress.test.ts') };
const issueDone = { state: 'CLOSED', stateReason: 'COMPLETED', closedByPullRequestsReferences: [{ number: 20086 }] };

describe('handoffSupersededVerdict', () => {
  it('(a) #20157 chiusa senza merge, nessuna PR aperta la sostituisce -> superato', () => {
    const v = run({
      'pr view 20157': { number: 20157, state: 'CLOSED', closedAt: OLD, mergedAt: null, closingIssuesReferences: [{ number: 101 }], files: files('scripts/crawlers/workday-egress.mjs') },
      'pr list list': [{ number: 20200, headRefName: 'fix/other', closingIssuesReferences: [{ number: 999 }], body: 'altro' }],
    });
    expect(v).toMatchObject({ resolved: true, reason: 'origin-closed-unmerged' });
  });

  it("(a) non scatta se un'altra PR aperta chiude le stesse issue, cita l'origine o ha il branch dell'hand-off", () => {
    const origin = { number: 20157, state: 'CLOSED', closedAt: OLD, closingIssuesReferences: [{ number: 101 }], files: files('a.mjs') };
    expect(run({ 'pr view 20157': origin, 'pr list list': [{ number: 5, headRefName: 'x', closingIssuesReferences: [{ number: 101 }], body: '' }] }).resolved).toBe(false);
    expect(run({ 'pr view 20157': origin, 'pr list list': [{ number: 5, headRefName: 'x', closingIssuesReferences: [], body: 'Supersedes #20157' }] }).resolved).toBe(false);
    expect(run({ 'pr view 20157': origin, 'pr list list': [{ number: 5, title: 'supersedes #20157', headRefName: 'x', closingIssuesReferences: [], body: '' }] })).toMatchObject({ resolved: false, reason: 'superseded-other-open-pr' });
    expect(run({ 'pr view 20157': origin, 'pr list list': [{ number: 5, headRefName: 'fix/issue-30001', closingIssuesReferences: [], body: '' }] }).resolved).toBe(false);
  });

  it("(a) non scatta se la chiusura e' recente (close+reopen di pr-autorebase) o la lista PR e' illeggibile", () => {
    const recent = { number: 20157, state: 'CLOSED', closedAt: '2026-11-26T11:55:00Z', closingIssuesReferences: [], files: files('a.mjs') };
    expect(run({ 'pr view 20157': recent, 'pr list list': [] })).toMatchObject({ resolved: false, reason: 'superseded-closed-too-recent' });
    const old = { ...recent, closedAt: OLD };
    expect(run({ 'pr view 20157': old })).toMatchObject({ resolved: false, reason: 'superseded-open-prs-unreadable' });
  });

  it('(b) PR aperta con tutte le issue chiuse COMPLETED da una PR mergiata che copre i suoi file -> superato', () => {
    const v = run({
      'pr view 20157': { number: 20157, state: 'OPEN', closingIssuesReferences: [{ number: 101 }], files: files('scripts/crawlers/workday-egress.mjs', 'data/crawler-group-assignments.json') },
      'issue view 101': issueDone,
      'pr view 20086': workdayMerged,
    });
    expect(v).toMatchObject({ resolved: true, reason: 'issues-closed-by-merged-prs', prs: [20086], issues: [101] });
  });

  it('(b) legge le righe Closes #N del body quando closingIssuesReferences e\' vuoto', () => {
    const v = run({
      'pr view 20157': { number: 20157, state: 'OPEN', closingIssuesReferences: [], body: '## Implementato\n- x\n\nCloses #101', files: files('scripts/crawlers/workday-egress.mjs') },
      'issue view 101': issueDone,
      'pr view 20086': workdayMerged,
    });
    expect(v.resolved).toBe(true);
  });

  it('PR aperta con issue ancora aperte -> non superato', () => {
    const v = run({
      'pr view 20157': { number: 20157, state: 'OPEN', closingIssuesReferences: [{ number: 101 }], files: files('a.mjs') },
      'issue view 101': { state: 'OPEN', stateReason: null, closedByPullRequestsReferences: [] },
    });
    expect(v).toMatchObject({ resolved: false, reason: 'superseded-issue-not-completed' });
  });

  it('issue chiusa not_planned o senza PR mergiata -> non superato', () => {
    const origin = { number: 20157, state: 'OPEN', closingIssuesReferences: [{ number: 101 }], files: files('a.mjs') };
    expect(run({ 'pr view 20157': origin, 'issue view 101': { ...issueDone, stateReason: 'NOT_PLANNED' } }).resolved).toBe(false);
    expect(run({ 'pr view 20157': origin, 'issue view 101': { ...issueDone, closedByPullRequestsReferences: [] } }).resolved).toBe(false);
    expect(run({ 'pr view 20157': origin, 'issue view 101': issueDone, 'pr view 20086': { ...workdayMerged, state: 'CLOSED' } }).resolved).toBe(false);
  });

  it('issue chiusa da una PR mergiata che tocca un sottoinsieme diverso di file scritti a mano -> non superato', () => {
    const v = run({
      'pr view 20157': { number: 20157, state: 'OPEN', closingIssuesReferences: [{ number: 101 }], files: files('scripts/crawlers/workday-egress.mjs', 'scripts/crawlers/workday-retry.mjs') },
      'issue view 101': issueDone,
      'pr view 20086': workdayMerged,
    });
    expect(v).toMatchObject({ resolved: false, reason: 'superseded-handwritten-files-not-covered' });
  });

  it('PR senza issue dichiarate: (b) non si applica', () => {
    const v = run({ 'pr view 20157': { number: 20157, state: 'OPEN', closingIssuesReferences: [], body: 'Addresses #5', files: files('a.mjs') } });
    expect(v).toMatchObject({ resolved: false, reason: 'superseded-no-declared-issues' });
  });

  it('fail-closed: ogni lettura API fallita o troncata -> non superato', () => {
    expect(run({}).resolved).toBe(false);
    const origin = { number: 20157, state: 'OPEN', closingIssuesReferences: [{ number: 101 }], files: files('scripts/crawlers/workday-egress.mjs') };
    expect(run({ 'pr view 20157': origin }).reason).toBe('superseded-issue-unreadable');
    expect(run({ 'pr view 20157': origin, 'issue view 101': issueDone }).reason).toBe('superseded-merger-unreadable');
    const truncated = { ...workdayMerged, files: Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.mjs` })) };
    expect(run({ 'pr view 20157': origin, 'issue view 101': issueDone, 'pr view 20086': truncated }).reason).toBe('superseded-merger-files-unreadable');
    const throwing = handoffSupersededVerdict({ originPr: 1, handoffIssue: 2, read: () => { throw new Error('boom'); }, now: NOW });
    expect(throwing.resolved).toBe(false);
    expect(run({ 'pr view 20157': { number: 20157, state: 'MERGED' } }).resolved).toBe(false);
  });
});

describe('helpers', () => {
  it('declaredClosingIssues dedup e ordina', () => {
    expect(declaredClosingIssues({ closingIssuesReferences: [{ number: 9 }, { number: 3 }, { number: 9 }] })).toEqual([3, 9]);
    expect(declaredClosingIssues({ body: 'Closes #4\nFixes valerielinc-ops/x#2\nAddresses #7' })).toEqual([2, 4]);
  });
  it('isGeneratedPath riconosce i file del registro e non il codice a mano', () => {
    expect(isGeneratedPath('data/crawler-group-assignments.json')).toBe(true);
    expect(isGeneratedPath('scripts/crawlers/workday-egress.mjs')).toBe(false);
  });
});
