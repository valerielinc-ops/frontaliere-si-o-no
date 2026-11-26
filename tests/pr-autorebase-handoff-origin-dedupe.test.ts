import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHAIN_LIMIT_MARKER,
  MAX_HANDOFF_GENERATIONS,
  buildConflictHandoffIssue,
  createHandoffIssueIndex,
  decideHandoffChain,
  parseHandoffChain,
  planConflictHandoff,
  reapplyIssueCandidates,
  resolveMergeConflict,
} from '../scripts/ci/pr-autorebase.mjs';
import { groupHandoffs } from '../scripts/ci/reconcile-conflict-handoffs.mjs';
import { generatedConflictPartition } from '../scripts/ci/generated-files-registry.mjs';

const SOURCE = readFileSync('scripts/ci/pr-autorebase.mjs', 'utf8');
const CONTRACT = '.github/corpus-workflows/contract.json';

type Row = { number: number; title: string; body: string; labels: string[]; created_at: string };
const rowsOf = (store: Row[]) => store
  .map((i) => JSON.stringify([i.number, i.title, i.body, i.labels, i.created_at])).join('\n');

// ── (a) dedupe per origine: PR #20164, HEAD 4a55b92 poi ff6d604 ─────────────
describe('REPLAY #20164 — una sola issue aperta per PR di origine, qualunque HEAD', () => {
  const H1 = `4a55b92${'0'.repeat(33)}`;
  const H2 = `ff6d604${'0'.repeat(33)}`;

  /** Uno sweep ridotto alle decisioni pure (come nel replay di #11147). */
  function sweep(store: Row[], head: string, { routed = true }: { routed?: boolean } = {}) {
    const index = createHandoffIssueIndex(() => rowsOf(store));
    const plan = planConflictHandoff({ existing: index.forOrigin(20164), num: 20164, head });
    const { title, body } = buildConflictHandoffIssue({ num: 20164, branch: 'fix/issue-20150', head, files: [CONTRACT] });
    if (plan.action === 'create') {
      store.push({ number: 20183, title, body, labels: routed ? ['agent:triaged', 'agent:fix'] : ['agent:triaged'], created_at: '2026-11-26T09:00:00Z' });
    } else if (plan.action === 'reuse') {
      store.find((i) => i.number === plan.issue)!.body = body;
    }
    return plan;
  }

  it('HEAD nuova su issue instradata ma non reclamata → stessa issue, evidenza aggiornata', () => {
    const store: Row[] = [];
    expect(sweep(store, H1).action).toBe('create');
    expect(sweep(store, H2)).toEqual({ action: 'reuse', issue: 20183 });
    expect(store).toHaveLength(1);
    expect(store[0].body).toContain('HEAD `ff6d604');
    expect(store[0].body).not.toContain('HEAD `4a55b92');
  });

  it('HEAD nuova su issue reclamata → nessuna issue nuova, solo una nota', () => {
    const store: Row[] = [];
    sweep(store, H1);
    store[0].labels.push('agent:in-progress');
    const before = store[0].body;
    expect(sweep(store, H2)).toEqual({ action: 'note-new-head', issue: 20183 });
    expect(store).toHaveLength(1);
    expect(store[0].body).toBe(before);
  });

  it('stessa HEAD, issue instradata → nessuna scrittura; issue chiusa (assente dall\'elenco) resta chiusa', () => {
    const store: Row[] = [];
    sweep(store, H1);
    expect(sweep(store, H1)).toEqual({ action: 'already-handed-off', issue: 20183 });
    // Una issue chiusa non e' nell'elenco delle aperte: il piano non la riapre, ne crea una per il conflitto vivo.
    expect(planConflictHandoff({ existing: [], num: 20164, head: H2 })).toEqual({ action: 'create' });
  });

  it('il riconciliatore riduce a una due issue aperte della stessa origine con HEAD diverse', () => {
    const mk = (number: number, head: string, labels: string[] = []) => ({
      number,
      ...buildConflictHandoffIssue({ num: 20164, branch: 'b', head, files: [CONTRACT] }),
      labels,
      created_at: '2026-11-26T09:00:00Z',
    });
    const groups = groupHandoffs([mk(20206, H2), mk(20183, H1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keeper.number).toBe(20183);
    expect(groups[0].duplicates.map((i) => i.number)).toEqual([20206]);
    const claimed = groupHandoffs([mk(20206, H2, ['agent:in-progress']), mk(20183, H1)]);
    expect(claimed[0].keeper.number).toBe(20206);
    expect(claimed[0].duplicates.map((i) => i.number)).toEqual([20183]);
  });

  it('il cablaggio: nota idempotente per HEAD, nessuna issue nuova quando e\' reclamata', () => {
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function readReapplyContext('));
    expect(fn.indexOf("plan.action === 'note-new-head'")).toBeLessThan(fn.indexOf("'issue', 'create'"));
    const note = SOURCE.slice(SOURCE.indexOf('function noteNewHeadOnBusyHandoff('), SOURCE.indexOf('function prClosingIssueNumbers('));
    expect(note).toContain('CONFLICT_HANDOFF_NEW_HEAD head=');
    expect(note.indexOf('hasCommentMarker(issue, noteMarker)')).toBeLessThan(note.indexOf("'issue', 'comment'"));
    expect(note).not.toContain("'issue', 'create'");
  });
});

// ── (b) conflitto misto: elenchi distinti nel body ──────────────────────────
describe('hand-off di un conflitto misto: da risolvere e da rigenerare', () => {
  const HEAD = 'a'.repeat(40);
  const section = (body: string, from: string, to: string) => {
    const start = body.indexOf(from);
    const end = body.indexOf(to, start + from.length);
    return body.slice(start, end === -1 ? undefined : end);
  };

  it('contract.json + workday-client.mjs: solo workday-client da risolvere, contract.json da rigenerare', () => {
    const { body } = buildConflictHandoffIssue({
      num: 20204,
      branch: 'fix/x',
      head: HEAD,
      files: [CONTRACT, 'scripts/lib/ats-clients/workday-client.mjs'],
    });
    const toResolve = section(body, 'File da RISOLVERE', 'File da RIGENERARE');
    const toRegenerate = section(body, 'File da RIGENERARE', 'Da fare:');
    expect(toResolve).toContain('scripts/lib/ats-clients/workday-client.mjs');
    expect(toResolve).not.toContain('contract.json');
    expect(toRegenerate).toContain(CONTRACT);
    expect(toRegenerate).not.toContain('workday-client');
    // L'istruzione di rigenerare e' quella del registro.
    expect(toRegenerate).toContain('node scripts/generate-crawler-group-workflows.mjs --check');
    expect(toRegenerate).toContain('CRAWLER_SOURCE_REF=main');
    expect(body).not.toContain('File in conflitto:');
  });

  it('un input del generatore in conflitto: ordine obbligato, risolvi prima di rigenerare', () => {
    const files = [CONTRACT, 'scripts/generate-crawler-group-workflows.mjs'];
    const part = generatedConflictPartition(files);
    expect(part.inputConflicts).toEqual(['scripts/generate-crawler-group-workflows.mjs']);
    const { body } = buildConflictHandoffIssue({ num: 1, branch: 'b', head: HEAD, files });
    expect(body).toContain('Ordine obbligato');
    expect(section(body, 'File da RISOLVERE', 'File da RIGENERARE')).toContain('generate-crawler-group-workflows.mjs');
  });

  it('senza file del registro il body resta quello di sempre', () => {
    const { body } = buildConflictHandoffIssue({ num: 1, branch: 'b', head: HEAD, files: ['a.ts'] });
    expect(body).toContain('File in conflitto:');
    expect(body).not.toContain('RIGENERARE');
  });

  it('workday-client e un file scritto a mano non sono input del generatore', () => {
    expect(generatedConflictPartition([CONTRACT, 'scripts/lib/ats-clients/workday-client.mjs']).inputConflicts).toEqual([]);
  });
});

// ── (c) risoluzione parziale su un repository vero ──────────────────────────
describe('conflitto misto: risoluzione automatica quando possibile', () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (cwd: string, path: string, content: string) => {
    mkdirSync(join(join(cwd, path), '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const commit = (cwd: string, message: string) => {
    git(cwd, 'add', '--', '.');
    git(cwd, 'commit', '-q', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };

  /** base → main e feature modificano `files` con le funzioni date → merge in conflitto. */
  function repo(base: Record<string, string>, main: Record<string, string>, feature: Record<string, string>) {
    const cwd = mkdtempSync(join(tmpdir(), 'autorebase-mixed-'));
    roots.push(cwd);
    git(cwd, 'init', '-q', '--initial-branch=main');
    git(cwd, 'config', 'user.name', 'Autorebase test');
    git(cwd, 'config', 'user.email', 'autorebase-test@example.invalid');
    for (const [path, content] of Object.entries(base)) write(cwd, path, content);
    commit(cwd, 'base');
    git(cwd, 'checkout', '-q', '-b', 'feature');
    git(cwd, 'checkout', '-q', 'main');
    for (const [path, content] of Object.entries(main)) write(cwd, path, content);
    git(cwd, 'update-ref', 'refs/remotes/origin/main', commit(cwd, 'main change'));
    git(cwd, 'checkout', '-q', 'feature');
    for (const [path, content] of Object.entries(feature)) write(cwd, path, content);
    const featureHead = commit(cwd, 'feature change');
    const merge = spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd, encoding: 'utf8' });
    expect(merge.status).toBe(1);
    return { cwd, featureHead };
  }

  function runner() {
    const calls: string[] = [];
    const commandRunner = (command: { id: string }, { cwd }: { cwd: string }) => {
      calls.push(command.id);
      if (command.id === 'crawler-group-workflows') write(cwd, CONTRACT, '{"generated":"merge"}\n');
      return { ok: true, stdout: '', stderr: '' };
    };
    return { calls, commandRunner };
  }

  const lines = (...n: string[]) => `${n.join('\n')}\n`;
  const HAND = 'scripts/lib/ats-clients/workday-client.mjs';

  it('i file scritti a mano si fondono puliti e confligge solo contract.json → risolto, nessun hand-off', () => {
    const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g');
    const { cwd } = repo(
      { [CONTRACT]: 'base\n', [HAND]: base },
      { [CONTRACT]: 'main\n', [HAND]: lines('A', 'b', 'c', 'd', 'e', 'f', 'g') },
      { [CONTRACT]: 'feature\n', [HAND]: lines('a', 'b', 'c', 'd', 'e', 'f', 'G') },
    );
    expect(git(cwd, 'diff', '--name-only', '--diff-filter=U')).toBe(CONTRACT);
    const injected = runner();
    const result = resolveMergeConflict({ cwd, commandRunner: injected.commandRunner });
    expect(result).toMatchObject({ resolved: true, mode: 'generated' });
    expect(injected.calls).toEqual(['crawler-group-workflows', 'crawler-group-workflows-check']);
    expect(readFileSync(join(cwd, HAND), 'utf8')).toBe(lines('A', 'b', 'c', 'd', 'e', 'f', 'G'));
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('manuale in conflitto di sole righe import + generato → unione e rigenerazione, un solo merge', () => {
    const { cwd } = repo(
      { [CONTRACT]: 'base\n', [HAND]: lines("import x from './x';", 'export const a = 1;') },
      { [CONTRACT]: 'main\n', [HAND]: lines("import a from './a';", 'export const a = 1;') },
      { [CONTRACT]: 'feature\n', [HAND]: lines("import b from './b';", 'export const a = 1;') },
    );
    const injected = runner();
    const result = resolveMergeConflict({ cwd, commandRunner: injected.commandRunner });
    expect(result).toMatchObject({ resolved: true, mode: 'generated+import-union' });
    expect(injected.calls).toEqual(['crawler-group-workflows', 'crawler-group-workflows-check']);
    const merged = readFileSync(join(cwd, HAND), 'utf8');
    expect(merged).toContain("import a from './a';");
    expect(merged).toContain("import b from './b';");
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it('manuale con conflitto vero + generato → non risolto, il generatore non gira, partizione nel risultato', () => {
    const { cwd, featureHead } = repo(
      { [CONTRACT]: 'base\n', [HAND]: 'x = 1\n' },
      { [CONTRACT]: 'main\n', [HAND]: 'x = 2\n' },
      { [CONTRACT]: 'feature\n', [HAND]: 'x = 3\n' },
    );
    const injected = runner();
    const result = resolveMergeConflict({ cwd, commandRunner: injected.commandRunner });
    expect(result.resolved).toBe(false);
    expect(result.mode).toBe('mixed-manual');
    expect(result.generated.partition).toMatchObject({ generated: [CONTRACT], manual: [HAND], inputConflicts: [] });
    expect(injected.calls).toEqual([]);
    git(cwd, 'merge', '--abort');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(featureHead);
  });

  it('manuale in conflitto che e\' input del generatore → mai importato per unione, mai rigenerato', () => {
    const generator = 'scripts/generate-crawler-group-workflows.mjs';
    const { cwd } = repo(
      { [CONTRACT]: 'base\n', [generator]: lines("import x from './x';") },
      { [CONTRACT]: 'main\n', [generator]: lines("import a from './a';") },
      { [CONTRACT]: 'feature\n', [generator]: lines("import b from './b';") },
    );
    const injected = runner();
    const result = resolveMergeConflict({ cwd, commandRunner: injected.commandRunner });
    expect(result.resolved).toBe(false);
    expect(injected.calls).toEqual([]);
    expect(result.generated.partition.inputConflicts).toEqual([generator]);
  });
});

// ── (d) catena di riapplicazioni: #20179 → #20185 → #20203 → #20231 ────────
describe('catena di riapplicazioni', () => {
  const HEAD = 'c'.repeat(40);
  // #20185: primo hand-off di #20179 (nessun marker: generazione 1).
  const first = {
    number: 20185,
    ...buildConflictHandoffIssue({ num: 20179, branch: 'fix/issue-20170', head: HEAD, files: [CONTRACT] }),
  };

  it('la PR #20203 (fix/issue-20185) e\' una riapplicazione: radice #20179, generazione 2, riferimento alla catena', () => {
    expect(reapplyIssueCandidates({ branch: 'fix/issue-20185', closes: [20170, 20185] })).toEqual([20185, 20170]);
    const chain = decideHandoffChain({ num: 20203, prBody: 'Supersedes #20179\nCloses #20185', issues: [first] });
    expect(chain).toEqual({ isReapply: true, root: 20179, prev: 20185, generation: 2, blocked: false });
    const second = buildConflictHandoffIssue({ num: 20203, branch: 'fix/issue-20185', head: HEAD, files: [CONTRACT], chain });
    expect(second.title).toBe('Conflitto con main dopo LGTM: riapplicare la PR #20203 su main');
    expect(second.body).toContain('radice PR #20179, generazione 2 di 2');
    expect(second.body).toContain('#20185');
    expect(parseHandoffChain(second.body, second.title)).toEqual({ root: 20179, generation: 2, prev: 20185 });
  });

  it('un body senza marker e\' la generazione 1 della sua origine', () => {
    expect(parseHandoffChain(first.body, first.title)).toEqual({ root: 20179, generation: 1, prev: null });
    expect(parseHandoffChain('', 'altro')).toBeNull();
  });

  it('alla 3a generazione: bloccata, needs-human sulla PR e nessun hand-off', () => {
    const chain2 = decideHandoffChain({ num: 20203, prBody: 'Supersedes #20179', issues: [first] });
    const second = { number: 20231, ...buildConflictHandoffIssue({ num: 20203, branch: 'fix/issue-20185', head: HEAD, files: [CONTRACT], chain: chain2 }) };
    const chain3 = decideHandoffChain({ num: 20260, prBody: 'Supersedes #20203', issues: [second] });
    expect(chain3).toEqual({ isReapply: true, root: 20179, prev: 20231, generation: 3, blocked: true });
    expect(MAX_HANDOFF_GENERATIONS).toBe(2);
    // Wiring: l'arresto avviene prima di ogni creazione di issue e mette needs-human con il marker.
    const fn = SOURCE.slice(SOURCE.indexOf('function handOffConflictToFixer('), SOURCE.indexOf('function readReapplyContext('));
    expect(fn.indexOf('stopHandoffChain(num, chain, reviewInput)')).toBeLessThan(fn.indexOf("'issue', 'create'"));
    const stop = SOURCE.slice(SOURCE.indexOf('function stopHandoffChain('), SOURCE.indexOf('function noteNewHeadOnBusyHandoff('));
    expect(stop).toContain("'--add-label', 'needs-human'");
    expect(stop).toContain('CHAIN_LIMIT_MARKER');
    expect(CHAIN_LIMIT_MARKER).toMatch(/^<!-- .* -->$/u);
    // Dopo l'arresto il marker ferma ogni tick successivo, prima di leggere qualunque cosa.
    expect(fn.indexOf('hasCommentMarker(num, CHAIN_LIMIT_MARKER)')).toBeLessThan(fn.indexOf('readReapplyContext(num, branch)'));
  });

  it('la sola keyword Supersedes (issue illeggibile) basta a riconoscere la riapplicazione; una PR normale no', () => {
    expect(decideHandoffChain({ num: 7, prBody: 'Supersedes #3', issues: [] }))
      .toEqual({ isReapply: true, root: 3, prev: null, generation: 2, blocked: false });
    expect(decideHandoffChain({ num: 7, prBody: 'Closes #3', issues: [{ number: 3, title: 'Altro', body: '' }] }))
      .toEqual({ isReapply: false, root: 7, prev: null, generation: 1, blocked: false });
  });
});
