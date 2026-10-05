import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildConflictHandoffIssue,
  conflictHandoffMarker,
  shouldHandOffConflict,
  agentPrConflictNeedsHandOff,
  isAgentOwnedPr,
  CONFLICT_RESOLUTION_LOCK_LABEL,
  CONFLICT_RESOLUTION_LOCK_MAX_AGE_MS,
  decideConflictResolutionLock,
  handoffIssuesForOrigin,
  createHandoffIssueIndex,
  planConflictHandoff,
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
    const routed = fn.indexOf("const routed = ghRun(['issue', 'edit', issue, '--repo', REPO, '--add-label', 'agent:fix']);");
    const check = fn.indexOf('if (!routed.ok) {', routed);
    const marker = fn.indexOf('${marker}');
    expect(routed).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(routed);
    expect(marker).toBeGreaterThan(check);
    // L'uscita senza routing dice perche' (#11151: agent:fix mai arrivata, motivo ignoto).
    expect(fn.slice(check, marker)).toContain('${routed.error}');
    // Elenco consistente (REST), non la search API: il suo indice in ritardo
    // ha lasciato creare #10586 e #10587 per la stessa HEAD di #10569.
    expect(fn).toContain('handoffIssueIndex.forOrigin(num)');
    expect(fn).not.toMatch(/'--search'/);
    expect(SOURCE).not.toMatch(/'--search'[^\n]*Conflitto con main/);
  });

  it('dopo la creazione rilegge e instrada la issue canonica, chiudendo le duplicate', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function commentConflictOnce('));
    const create = fn.indexOf("'issue', 'create'");
    const invalidate = fn.indexOf('handoffIssueIndex.invalidate();', create);
    const reread = fn.indexOf('const after = handoffIssueIndex.forOrigin(num);', invalidate);
    const dedupe = fn.indexOf('closeDuplicateHandoffIssues(after, num)', reread);
    const routed = fn.indexOf("'--add-label', 'agent:fix'", dedupe);
    expect(create).toBeGreaterThan(0);
    expect(invalidate).toBeGreaterThan(create);
    expect(reread).toBeGreaterThan(invalidate);
    expect(dedupe).toBeGreaterThan(reread);
    expect(routed).toBeGreaterThan(dedupe);
    // Anche una duplicata lasciata da un tick precedente si chiude al riuso.
    expect(fn).toContain('closeDuplicateHandoffIssues(existing, num)');
  });
});

describe('handoffIssuesForOrigin — chiave = PR di origine, ordine crescente, fail-closed', () => {
  const title = 'Conflitto con main: riapplicare la PR #10569 su main';
  const lgtmTitle = 'Conflitto con main dopo LGTM: riapplicare la PR #10569 su main';
  const line = (n: number, t: string, labels: string[] = [], body = '') => JSON.stringify([n, t, body, labels, '2026-10-03T15:00:00Z']);

  it('le due varianti del titolo (con e senza LGTM) sono lo stesso hand-off; un\'altra origine no', () => {
    const rows = [line(10587, lgtmTitle, ['agent:fix']), line(10586, title), line(10600, `${title} (bis)`), line(10601, 'Conflitto con main: riapplicare la PR #105690 su main')];
    const found = handoffIssuesForOrigin(rows.join('\n'), 10569);
    expect(found!.map((i) => i.number)).toEqual([10586, 10587]);
    expect(found![1]).toMatchObject({ title: lgtmTitle, labels: ['agent:fix'], created_at: '2026-10-03T15:00:00Z' });
  });

  it('nessuna issue → elenco vuoto, non null', () => {
    expect(handoffIssuesForOrigin('', 10569)).toEqual([]);
    expect(handoffIssuesForOrigin(`${line(1, 'altro')}\n`, 10569)).toEqual([]);
  });

  it('una riga illeggibile rende l\'elenco inaffidabile', () => {
    expect(handoffIssuesForOrigin(`${line(1, title)}\n{not json`, 10569)).toBeNull();
    expect(handoffIssuesForOrigin(JSON.stringify({ number: 1, title }), 10569)).toBeNull();
  });
});

describe('REPLAY #11147 — un solo hand-off per PR di origine, anche se il LGTM arriva fra due sweep', () => {
  // Stato di GitHub simulato: le issue aperte di hand-off, come le restituisce
  // l'elenco REST (`[number, title, body, labels, created_at]`).
  type Row = { number: number; title: string; body: string; labels: string[]; created_at: string };
  const rowsOf = (store: Row[]) => store.map((i) => JSON.stringify([i.number, i.title, i.body, i.labels, i.created_at])).join('\n');

  /** Uno sweep di pr-autorebase su UNA PR, ridotto alle decisioni pure. */
  function sweep(store: Row[], { num, lgtm, routingSucceeds }: { num: number; lgtm: boolean; routingSucceeds: boolean }) {
    const writes: string[] = [];
    const index = createHandoffIssueIndex(() => rowsOf(store));
    const plan = planConflictHandoff({ existing: index.forOrigin(num), num, head: HEAD });
    if (plan.action === 'already-handed-off') return { plan, writes };
    let issue = plan.action === 'reuse' ? plan.issue : 0;
    if (plan.action === 'create') {
      const { title, body } = buildConflictHandoffIssue({ num, branch: 'fix/issue-11095', head: HEAD, files: ['a.ts'], lgtm });
      issue = 11151 + store.length * 3;
      store.push({ number: issue, title, body, labels: ['agent:triaged'], created_at: '2026-10-03T15:12:24Z' });
      writes.push(`create #${issue}`);
    }
    writes.push(`edit #${issue} +agent:fix`);
    if (routingSucceeds) store.find((i) => i.number === issue)!.labels.push('agent:fix');
    return { plan, writes };
  }

  it('sweep senza LGTM (routing fallito) e poi sweep dopo LGTM sulla stessa origine → una sola issue', () => {
    const store: Row[] = [];
    expect(sweep(store, { num: 11147, lgtm: false, routingSucceeds: false }).plan.action).toBe('create');
    const second = sweep(store, { num: 11147, lgtm: true, routingSucceeds: true });
    expect(second.plan).toEqual({ action: 'reuse', issue: store[0].number });
    expect(second.writes).toEqual([`edit #${store[0].number} +agent:fix`]);
    expect(store.map((i) => i.number)).toEqual([store[0].number]);
    // Il titolo del primo sweep resta (niente retitle: un `edited` riavvia i workflow delle issue).
    expect(store[0].title).toBe('Conflitto con main: riapplicare la PR #11147 su main');
  });

  it('issue già aperta per la stessa origine, stessa HEAD e instradata → nessuna scrittura, anche senza marker sulla PR', () => {
    const store: Row[] = [];
    sweep(store, { num: 11147, lgtm: false, routingSucceeds: true });
    for (const lgtm of [false, true]) {
      const again = sweep(store, { num: 11147, lgtm, routingSucceeds: true });
      expect(again.plan).toEqual({ action: 'already-handed-off', issue: store[0].number });
      expect(again.writes).toEqual([]);
    }
  });

  it('stessa origine ma HEAD nuova, o issue non instradata → si riusa e si instrada di nuovo', () => {
    const { title, body } = buildConflictHandoffIssue({ num: 11147, branch: 'b', head: HEAD, files: [], lgtm: true });
    const routed = [{ number: 11157, title, body, labels: ['agent:fix'], created_at: null }];
    expect(planConflictHandoff({ existing: routed, num: 11147, head: 'c'.repeat(40) })).toEqual({ action: 'reuse', issue: 11157 });
    expect(planConflictHandoff({ existing: [{ ...routed[0], labels: ['agent:triaged'] }], num: 11147, head: HEAD })).toEqual({ action: 'reuse', issue: 11157 });
    expect(planConflictHandoff({ existing: [{ ...routed[0], labels: ['agent:in-progress'] }], num: 11147, head: HEAD }))
      .toEqual({ action: 'already-handed-off', issue: 11157 });
    // Corpo senza HEAD leggibile: non si dimostra la stessa HEAD → si riusa.
    expect(planConflictHandoff({ existing: [{ ...routed[0], body: '' }], num: 11147, head: HEAD })).toEqual({ action: 'reuse', issue: 11157 });
    expect(planConflictHandoff({ existing: [], num: 11147, head: HEAD })).toEqual({ action: 'create' });
  });

  it('fra più issue della stessa origine si riusa quella instradata, non la più vecchia (stessa elezione del riconciliatore)', () => {
    const mk = (number: number, lgtm: boolean, labels: string[]) => ({ ...buildConflictHandoffIssue({ num: 11147, branch: 'b', head: HEAD, files: [], lgtm }), number, labels, created_at: null });
    const plan = planConflictHandoff({ existing: [mk(11151, false, ['agent:triaged']), mk(11157, true, ['agent:fix'])], num: 11147, head: HEAD });
    expect(plan).toEqual({ action: 'already-handed-off', issue: 11157 });
  });

  it('tre PR in conflitto nello stesso sweep → una sola lettura dell\'elenco; la creazione la invalida', () => {
    let reads = 0;
    const index = createHandoffIssueIndex(() => { reads += 1; return ''; });
    for (const num of [11147, 11148, 11149]) expect(index.forOrigin(num)).toEqual([]);
    expect(reads).toBe(1);
    index.invalidate();
    index.forOrigin(11147);
    expect(reads).toBe(2);
  });

  it('un elenco illeggibile non resta in memoria: il prossimo uso ritenta', () => {
    let reads = 0;
    const index = createHandoffIssueIndex(() => { reads += 1; return reads === 1 ? null : ''; });
    expect(index.forOrigin(1)).toBeNull();
    expect(index.forOrigin(1)).toEqual([]);
    expect(reads).toBe(2);
  });

  it('il cablaggio: un solo indice a livello di modulo, nessuna lettura per titolo', () => {
    expect(SOURCE.match(/createHandoffIssueIndex\(readOpenHandoffRows\)/g) || []).toHaveLength(1);
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function commentConflictOnce('));
    expect(fn).not.toContain('readOpenHandoffRows(');
    expect(fn).toContain('planConflictHandoff({ existing, num, head })');
    expect(fn.indexOf("if (plan.action === 'already-handed-off')")).toBeLessThan(fn.indexOf("'issue', 'create'"));
    const dedupe = SOURCE.slice(SOURCE.indexOf('function closeDuplicateHandoffIssues('), SOURCE.indexOf('function handOffConflictToFixer('));
    expect(dedupe).toContain('electHandoffKeeper(members, num, [])');
    expect(dedupe).toContain('duplicateOldEnough(member, now)');
    // Un duplicato reclamato dal fixer non si chiude qui (come planDuplicateClosures del riconciliatore).
    expect(dedupe).toContain('handoffBusy(member, num, [])');
    expect(dedupe.indexOf('handoffBusy(member, num, [])')).toBeLessThan(dedupe.indexOf("'issue', 'close'"));
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

  it('un lock agent:resolving-conflict valido sospende il passaggio di mano', () => {
    expect(agentPrConflictNeedsHandOff({
      conflicted: true,
      nearMerge: false,
      labels: ['agent:autofix', CONFLICT_RESOLUTION_LOCK_LABEL],
    })).toBe(false);
  });

  describe('lock a tempo', () => {
    const lockedAt = Date.parse('2026-10-06T09:00:00Z');
    const event = (name: 'labeled' | 'unlabeled', at: string) => ({
      event: name,
      label: { name: CONFLICT_RESOLUTION_LOCK_LABEL },
      created_at: at,
    });

    it('scade dopo 60 minuti e lascia ripartire il hand-off', () => {
      const decision = decideConflictResolutionLock({
        labels: [CONFLICT_RESOLUTION_LOCK_LABEL],
        events: [event('labeled', '2026-10-06T09:00:00Z')],
        headCommittedAt: '2026-10-06T09:01:00Z',
        now: lockedAt + CONFLICT_RESOLUTION_LOCK_MAX_AGE_MS,
      });
      expect(decision).toMatchObject({ state: 'expired', release: true, lockedAt });
      expect(shouldHandOffConflict({
        lgtm: false,
        agentOwned: true,
        alreadyHandedOff: false,
        conflictLockState: decision.state,
      })).toBe(true);
    });

    it('rimuove il lock al primo push successivo', () => {
      const decision = decideConflictResolutionLock({
        labels: [CONFLICT_RESOLUTION_LOCK_LABEL],
        events: [event('labeled', '2026-10-06T09:00:00Z')],
        headCommittedAt: '2026-10-06T09:02:00Z',
        now: '2026-10-06T09:10:00Z',
      });
      expect(decision).toMatchObject({ state: 'pushed', release: true, lockedAt });
    });

    it('senza lock mantiene il comportamento precedente', () => {
      const decision = decideConflictResolutionLock({
        labels: [],
        events: [],
        headCommittedAt: '2026-10-06T09:01:00Z',
        now: '2026-10-06T09:10:00Z',
      });
      expect(decision).toEqual({ state: 'none', release: false });
      expect(shouldHandOffConflict({
        lgtm: false,
        agentOwned: true,
        alreadyHandedOff: false,
        conflictLockState: decision.state,
      })).toBe(true);
    });
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
