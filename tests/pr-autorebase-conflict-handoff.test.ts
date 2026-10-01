import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildConflictHandoffIssue,
  conflictHandoffMarker,
  shouldHandOffConflict,
  agentPrConflictNeedsHandOff,
  isAgentOwnedPr,
  handoffIssueNumbers,
} from '../scripts/ci/pr-autorebase.mjs';

const SOURCE = readFileSync(new URL('../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');
const HEAD = '685bcb73'.padEnd(40, '0');

describe('pr-autorebase — conflitto dopo LGTM affidato a issue-fix (#9260)', () => {
  it('passa la mano solo con LGTM e una volta per HEAD', () => {
    expect(shouldHandOffConflict({ lgtm: true, alreadyHandedOff: false })).toBe(true);
    expect(shouldHandOffConflict({ lgtm: false, alreadyHandedOff: false })).toBe(false);
    expect(shouldHandOffConflict({ lgtm: true, alreadyHandedOff: true })).toBe(false);
  });

  it('il marker e\' legato alla HEAD: una HEAD nuova e\' un conflitto nuovo', () => {
    expect(conflictHandoffMarker(HEAD)).toBe('<!-- AUTOREBASE_CONFLICT_HANDOFF head=685bcb730000 -->');
    expect(conflictHandoffMarker('b'.repeat(40))).not.toBe(conflictHandoffMarker(HEAD));
  });

  it('la issue porta PR, branch, HEAD e file, con un titolo stabile e senza keyword di chiusura sulla PR', () => {
    const { title, body } = buildConflictHandoffIssue({
      num: 9260,
      branch: 'fix/issue-8931-bfs-depth-20260919',
      head: HEAD,
      files: ['build-plugins/plateAuctionsPagesPlugin.ts', 'services/plateAuctions/paths.ts', 'services/router.ts'],
    });
    expect(title).toBe('Conflitto con main dopo LGTM: riapplicare la PR #9260 su main');
    expect(body).toContain('`fix/issue-8931-bfs-depth-20260919`');
    expect(body).toContain('`685bcb730000`');
    expect(body).toContain('- `services/router.ts`');
    expect(body).toContain('Supersedes #9260');
    // Una keyword di chiusura adiacente a #9260 chiuderebbe la PR vecchia al
    // merge della nuova PR prima che qualcuno verifichi la sostituzione.
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#9260\b/i);
  });

  it('ogni ramo che abortisce un conflitto non auto-risolvibile passa la mano', () => {
    const aborts = SOURCE.match(/ensureStaleLabel\(num\);\n\s+commentConflictOnce\(num, branch\);\n\s+handOffConflictToFixer\(num, branch, head, lgtm, \{ agentOwned \}\);/g) || [];
    const bare = SOURCE.match(/commentConflictOnce\(num, branch\);/g) || [];
    expect(aborts.length).toBe(3);
    expect(bare.length).toBe(aborts.length);
  });

  it('la issue salta il triage e riceve agent:fix con un evento separato', () => {
    expect(SOURCE).toContain("'--label', 'agent:triaged'");
    expect(SOURCE).toMatch(/'issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix'/);
  });
});

describe('pr-autorebase — hand-off fail-closed (review #1620)', () => {
  it('merge-tree deve confermare il conflitto e il marker segue il routing confermato', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function commentConflictOnce('));
    expect(fn).toContain("if (verdict.state !== 'conflicted')");
    const routed = fn.indexOf("if (!ghOk(['issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix']))");
    const marker = fn.indexOf('${marker}');
    expect(routed).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(routed);
    // Elenco consistente (REST), non la search API: il suo indice in ritardo
    // ha lasciato creare #10586 e #10587 per la stessa HEAD di #10569.
    expect(fn).toContain('openIssuesTitled(title)');
    expect(fn).not.toMatch(/'--search'/);
  });

  it('dopo la creazione rilegge e instrada la issue canonica, chiudendo le duplicate', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function commentConflictOnce('));
    const create = fn.indexOf("'issue', 'create'");
    const reread = fn.indexOf('const after = openIssuesTitled(title);', create);
    const dedupe = fn.indexOf('closeDuplicateHandoffIssues(after)', reread);
    const routed = fn.indexOf("'--add-label', 'agent:fix'", dedupe);
    expect(create).toBeGreaterThan(0);
    expect(reread).toBeGreaterThan(create);
    expect(dedupe).toBeGreaterThan(reread);
    expect(routed).toBeGreaterThan(dedupe);
    // Anche una duplicata lasciata da un tick precedente si chiude al riuso.
    expect(fn).toContain('closeDuplicateHandoffIssues(existing)');
  });
});

describe('handoffIssueNumbers — titolo esatto, ordine crescente, fail-closed', () => {
  const title = 'Conflitto con main: riapplicare la PR #10569 su main';
  const line = (n: number, t: string) => JSON.stringify([n, t]);

  it('due issue con lo stesso titolo: la canonica è la più vecchia', () => {
    expect(handoffIssueNumbers([line(10587, title), line(10586, title), line(10600, `${title} (bis)`)].join('\n'), title))
      .toEqual([10586, 10587]);
  });

  it('nessuna issue → elenco vuoto, non null', () => {
    expect(handoffIssueNumbers('', title)).toEqual([]);
    expect(handoffIssueNumbers(`${line(1, 'altro')}\n`, title)).toEqual([]);
  });

  it('una riga illeggibile rende l\'elenco inaffidabile', () => {
    expect(handoffIssueNumbers(`${line(1, title)}\n{not json`, title)).toBeNull();
    expect(handoffIssueNumbers(JSON.stringify({ number: 1, title }), title)).toBeNull();
  });
});

describe('pr-autorebase — PR del ciclo in conflitto senza LGTM (#10095, #10098)', () => {
  it('passa la mano anche senza LGTM a una PR agent:autofix, una volta per HEAD', () => {
    expect(shouldHandOffConflict({ lgtm: false, agentOwned: true, alreadyHandedOff: false })).toBe(true);
    expect(shouldHandOffConflict({ lgtm: false, agentOwned: true, alreadyHandedOff: true })).toBe(false);
  });

  it('vale anche nei rami near-merge: stale-review o collision-risk non tolgono la PR al ciclo (review 5331343431)', () => {
    for (const extra of ['stale-review', 'collision-risk']) {
      const agentOwned = isAgentOwnedPr(['agent:autofix', extra]);
      expect(agentOwned).toBe(true);
      expect(shouldHandOffConflict({ lgtm: false, agentOwned, alreadyHandedOff: false })).toBe(true);
    }
    expect(isAgentOwnedPr(['agent:autofix', 'needs-human'])).toBe(false);
    expect(isAgentOwnedPr(['stale-review'])).toBe(false);
    // Stessa provenienza di rescuer/recycle/custode: il branch storico del ciclo
    // basta anche senza label (#10608, gemella senza `agent:autofix`).
    expect(isAgentOwnedPr(['stale-review'], 'fix/issue-10544')).toBe(true);
    expect(isAgentOwnedPr([], 'automerge-weather')).toBe(true);
    expect(isAgentOwnedPr(['needs-human'], 'fix/issue-10544')).toBe(false);
    expect(isAgentOwnedPr([], 'fix-gh013-data-refresh-triad-20260930')).toBe(false);
    // Ogni hand-off di processPR porta lo stesso `agentOwned`: nessuna chiamata lo perde.
    const processPr = SOURCE.slice(SOURCE.indexOf('async function processPR('));
    const calls = processPr.match(/handOffConflictToFixer\([^)]*\)/g) || [];
    expect(calls.length).toBe(4);
    for (const call of calls) expect(call).toBe('handOffConflictToFixer(num, branch, head, lgtm, { agentOwned })');
    expect(processPr).toContain('const agentOwned = isAgentOwnedPr(labels, branch);');
    expect(shouldHandOffConflict({ lgtm: false, agentOwned: false, alreadyHandedOff: false })).toBe(false);
  });

  it('solo per una PR del ciclo in conflitto accertato, fuori dai rami near-merge e senza needs-human', () => {
    const agent = ['agent:autofix'];
    expect(agentPrConflictNeedsHandOff({ conflicted: true, nearMerge: false, labels: agent })).toBe(true);
    expect(agentPrConflictNeedsHandOff({ conflicted: true, nearMerge: false, labels: [{ name: 'agent:autofix' }, { name: 'has-conflicts' }] })).toBe(true);
    expect(agentPrConflictNeedsHandOff({ conflicted: true, nearMerge: false, labels: [...agent, 'needs-human'] })).toBe(false);
    expect(agentPrConflictNeedsHandOff({ conflicted: true, nearMerge: false, labels: ['has-conflicts'] })).toBe(false);
    expect(agentPrConflictNeedsHandOff({ conflicted: true, nearMerge: false, labels: ['has-conflicts'], headRefName: 'fix/issue-10544' })).toBe(true);
    // I rami near-merge passano già la mano dopo l'abort del merge.
    expect(agentPrConflictNeedsHandOff({ conflicted: true, nearMerge: true, labels: agent })).toBe(false);
    // `null` = merge-tree non verificabile: fail-closed.
    expect(agentPrConflictNeedsHandOff({ conflicted: null, nearMerge: false, labels: agent })).toBe(false);
    expect(agentPrConflictNeedsHandOff({ conflicted: false, nearMerge: false, labels: agent })).toBe(false);
  });

  it('la issue senza LGTM ha un titolo proprio e non promette un contributo approvato', () => {
    const { title, body } = buildConflictHandoffIssue({
      num: 10095,
      branch: 'fix/issue-10082',
      head: HEAD,
      files: ['tests/crawler-slice-integrity.test.ts'],
      lgtm: false,
    });
    expect(title).toBe('Conflitto con main: riapplicare la PR #10095 su main');
    expect(body).toContain('`agent:autofix`');
    expect(body).toContain('non avvia review');
    expect(body).toContain('Supersedes #10095');
    expect(body).not.toContain('aveva un `## LGTM`');
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#10095\b/i);
    // Il titolo con LGTM resta quello di prima: le issue già aperte si riusano.
    expect(buildConflictHandoffIssue({ num: 1, branch: 'b', head: HEAD, files: [] }).title)
      .toBe('Conflitto con main dopo LGTM: riapplicare la PR #1 su main');
  });

  it('processPR la chiama nel ramo non near-merge, dopo la rilevazione del conflitto', () => {
    const processPr = SOURCE.slice(SOURCE.indexOf('async function processPR('));
    const scan = processPr.indexOf('const conflictScan = reportMainConflict(');
    const branch = processPr.indexOf('if (!nearMerge) {');
    const call = processPr.indexOf('handOffConflictToFixer(num, branch, head, lgtm, { agentOwned });');
    expect(scan).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(scan);
    expect(call).toBeGreaterThan(branch);
    expect(processPr.slice(branch, call)).toContain('agentPrConflictNeedsHandOff({ conflicted: conflictScan, nearMerge, labels, headRefName: branch })');
  });
});
