import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { analyzeWorkflow } from '../scripts/ci/checkout-profile-analyzer.mjs';
import { uncoveredAllowListCode } from '../scripts/ci/verify-checkout-profiles.mjs';

/**
 * Il corpus chiama `housekeeping-jobs-logic.yml` a uno SHA pinnato, ma il
 * workflow esegue il codice di `main` del sito. Finche' la lista sparse stava
 * nel YAML, lista e codice arrivavano da due commit diversi: il 02-10 e il
 * 03-10-2026 `scripts/lib/dedicated-crawler-common.mjs` importava
 * `packages/articles/engine/shared/htmlMarkup.mjs`, fuori dalla lista dello
 * SHA pinnato, e ogni slice moriva con ERR_MODULE_NOT_FOUND.
 *
 * Ora la lista vive in `scripts/ci/housekeeping-sparse-paths.txt`, letta da
 * `main` insieme al codice. Questo test tiene vere le due meta' del patto: il
 * file copre tutto cio' che gli entrypoint caricano, e il YAML non ha un'altra
 * lista che possa tornare a divergere.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = '.github/workflows/housekeeping-jobs-logic.yml';
const LIST = 'scripts/ci/housekeeping-sparse-paths.txt';
const VERIFY_STEP = 'Verify sparse path list matches the checked-out commit';
const FAILURE_TITLE = 'Housekeeping: import fuori dalla lista sparse (ERR_MODULE_NOT_FOUND in arrivo)';

type Step = { name?: string; id?: string; uses?: string; run?: string; with?: Record<string, unknown> };

const workflowSource = readFileSync(join(ROOT, WORKFLOW), 'utf8');
const steps = (YAML.parse(workflowSource) as { jobs: { housekeeping: { steps: Step[] } } })
  .jobs.housekeeping.steps;
const stepIndex = (name: string) => steps.findIndex((step) => step.name === name);
const readListStep = steps[stepIndex('Read sparse path list')];

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Esegue lo step vero del workflow su un file lista, come farebbe il runner. */
function runReadListStep(listContent: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'housekeeping-sparse-paths-'));
  tempRoots.push(root);
  if (listContent !== null) {
    mkdirSync(join(root, dirname(LIST)), { recursive: true });
    writeFileSync(join(root, LIST), listContent);
  }
  const output = join(root, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync('/bin/bash', ['-c', readListStep?.run ?? 'exit 99'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  const written = readFileSync(output, 'utf8');
  const block = /^paths<<(\S+)\n([\s\S]*?)\n\1$/m.exec(written);
  return {
    status: result.status,
    stdout: result.stdout,
    paths: block ? block[2].split('\n') : [],
    listBlob: /^list_blob=([0-9a-f]{40,64})$/m.exec(written)?.[1],
  };
}

const realList = runReadListStep(readFileSync(join(ROOT, LIST), 'utf8'));

function housekeepingEntries(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const job = analyzeWorkflow(join(ROOT, WORKFLOW), pkg.scripts).jobs
    .find((candidate: { jobId: string }) => candidate.jobId === 'housekeeping');
  return [...(job?.entries ?? []), ...(job?.inlineEntries ?? []), ...COMMIT_SCRIPT_ENTRIES];
}

/**
 * Script node che `scripts/lib/git-commit-data.sh` lancia nel ramo
 * `--slice-only`: l'analizzatore si ferma allo shell e non li vede, ma un loro
 * import fuori lista darebbe lo stesso ERR_MODULE_NOT_FOUND.
 */
const COMMIT_SCRIPT_ENTRIES = [
  'scripts/lib/crawler-generation-receipt.mjs',
  'scripts/ci/canonicalize-expired-archive-slice.mjs',
];

/** Esegue lo step vero di verifica in un repo con la lista committata. */
function runVerifyStep(expectedBlob: (committedBlob: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'housekeeping-sparse-verify-'));
  tempRoots.push(root);
  mkdirSync(join(root, dirname(LIST)), { recursive: true });
  writeFileSync(join(root, LIST), 'scripts\n');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', LIST);
  const commit = git(
    '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '-m', 'lista',
  );
  const committedBlob = git('rev-parse', `HEAD:${LIST}`).stdout.trim();
  const result = spawnSync('/bin/bash', ['-c', steps[stepIndex(VERIFY_STEP)]?.run ?? 'exit 99'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, EXPECTED_LIST_BLOB: expectedBlob(committedBlob) },
  });
  return { status: result.status, stdout: result.stdout, committedBlob, commitStatus: commit.status };
}

describe('housekeeping sparse path list', () => {
  it('the workflow step turns the versioned list into checkout paths', () => {
    expect(realList.status, realList.stdout).toBe(0);
    expect(realList.paths.length).toBeGreaterThan(0);
    expect(realList.paths).toContain('scripts');
    expect(realList.listBlob).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('materializes every file the workflow entrypoints import', () => {
    const entries = housekeepingEntries();
    // Senza entrypoint la chiusura e' vuota e il controllo sotto passerebbe
    // senza aver guardato nulla.
    expect(entries).toContain('scripts/cleanup-jobs.mjs');
    expect(entries).toContain('scripts/load-rc-env.mjs');
    // Se git-commit-data.sh sparisse dal workflow, la lista a mano sopra
    // non avrebbe piu' ragione di esistere.
    expect(entries).toContain('scripts/lib/git-commit-data.sh');
    const commitScript = readFileSync(join(ROOT, 'scripts/lib/git-commit-data.sh'), 'utf8');
    for (const entry of COMMIT_SCRIPT_ENTRIES) {
      expect(commitScript).toContain(entry.split('/').pop());
    }

    const uncovered = uncoveredAllowListCode(realList.paths, entries, { cone: true });
    expect(
      uncovered,
      `${FAILURE_TITLE}\nAggiungi a ${LIST} la directory di: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('reports an entrypoint the list does not cover', () => {
    expect(uncoveredAllowListCode(['package.json'], ['scripts/cleanup-jobs.mjs'], { cone: true }))
      .toContain('scripts/cleanup-jobs.mjs');
  });

  it.each([
    ['a missing list file', null, 'is missing from main'],
    ['a list with comments only', '# solo commenti\n\n', 'lists no path'],
    ['a negated pattern', 'scripts\n!/data\n', 'has unsupported line(s)'],
    ['a trailing comment', 'scripts # codice\n', 'has unsupported line(s)'],
    ['an absolute path', '/scripts\n', 'has unsupported line(s)'],
  ])('fails closed on %s', (_label, content, message) => {
    const result = runReadListStep(content);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::${LIST} ${message}`);
    expect(result.paths).toEqual([]);
  });

  it('keeps no path list in the YAML besides the versioned file', () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkouts.map((step) => step.name)).toEqual([
      'Checkout sparse path list',
      'Checkout source repository',
    ]);
    // Il primo checkout porta solo la directory della lista; il secondo prende
    // i path dall'output dello step che la legge. Nessun altro path letterale.
    expect(checkouts[0].with?.['sparse-checkout']).toBe(dirname(LIST));
    expect(checkouts[1].with?.['sparse-checkout']).toBe('${{ steps.sparse_paths.outputs.paths }}');
    expect(readListStep?.id).toBe('sparse_paths');
    expect(readListStep?.run).toContain(`list=${LIST}`);
    expect(workflowSource).not.toMatch(/sparse-checkout:\s*[|>]/);
    expect(workflowSource).not.toMatch(/git sparse-checkout (?:set|add)/);
  });

  it('reads list and code from the same ref with the same checkout settings', () => {
    const [listCheckout, sourceCheckout] = steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
    const { 'sparse-checkout': _listPaths, ...listSettings } = listCheckout.with ?? {};
    const { 'sparse-checkout': _sourcePaths, ...sourceSettings } = sourceCheckout.with ?? {};
    expect(listCheckout.uses).toBe(sourceCheckout.uses);
    expect(listSettings).toEqual(sourceSettings);
    expect(sourceSettings).toMatchObject({
      ref: 'main',
      'persist-credentials': false,
      // `git sparse-checkout set` conserva la modalita' gia' configurata: se i
      // due checkout divergessero, i path cone verrebbero letti come pattern.
      'sparse-checkout-cone-mode': true,
    });
  });

  it('fails closed when main moves the list between the two checkouts', () => {
    const order = [
      'Checkout sparse path list',
      'Read sparse path list',
      'Checkout source repository',
      VERIFY_STEP,
      'Setup Node.js',
    ].map(stepIndex);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect((steps[order[3]] as { env?: Record<string, string> }).env?.EXPECTED_LIST_BLOB)
      .toBe('${{ steps.sparse_paths.outputs.list_blob }}');

    // Lo step gira davvero: stesso blob passa, blob diverso ferma il job.
    const same = runVerifyStep((blob) => blob);
    expect(same.commitStatus).toBe(0);
    expect(same.status, same.stdout).toBe(0);
    // Il blob id che lo step di lettura calcola e' quello che git ha committato.
    expect(runReadListStep('scripts\n').listBlob).toBe(same.committedBlob);

    const moved = runVerifyStep(() => '0'.repeat(40));
    expect(moved.status).toBe(1);
    expect(moved.stdout).toContain(`::error::${LIST} changed on main between the two checkouts`);
  });

  it('fails closed when the checkout materializes no slice directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'housekeeping-sparse-noslices-'));
    tempRoots.push(root);
    const validate = steps[stepIndex('Validate and clean job slices')];
    const result = spawnSync('/bin/bash', ['-c', validate?.run ?? 'exit 99'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOUSEKEEPING_LANE: 'rest' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::data/jobs/by-crawler is missing after the sparse checkout');
  });
});
