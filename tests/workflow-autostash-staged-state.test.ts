/**
 * Workflow di stato: commit saltato perché --autostash svuota l'indice.
 *
 * The sequence
 *
 *     git add data/state.json
 *     git pull --rebase --autostash origin main
 *     if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
 *     git commit …
 *
 * looks safe and is not. An autostash is re-applied with a plain
 * `git stash apply` (no `--index`): whenever the pull actually moves HEAD, the
 * edits to TRACKED files that were staged come back as UNSTAGED changes. The
 * index is then empty, `git diff --cached --quiet` succeeds, and the step
 * exits 0 saying there was nothing to commit. Reproduced on git 2.54 —
 * "Created autostash … Fast-forward … Applied autostash", then ` M state.json`.
 * When main did NOT move ("Already up to date") the index is kept, which is
 * what makes the defect intermittent and the job green either way.
 *
 * Measured on main: quality-alerts.yml stopped committing
 * data/quality-alerts-history.jsonl on 2026-09-26 (run 36997640781 logs the
 * three lines above followed by "No alert state changes to commit"), so the
 * L6 monitor read a 173-hour-old history against a 36-hour limit.
 * refresh-gsc-marquee-demand.yml carried the same three lines.
 *
 * The fix is ordering, not flags: commit first, then let
 * scripts/lib/git-push-with-retry.sh rebase the local commit on rejection.
 * This lint reads every workflow step by step and refuses the trap.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
// Literal on purpose: scripts/ci/run-related-tests.mjs links this test to
// every file under the directory through this string, so a PR that touches
// only a workflow still selects it.
const WORKFLOW_DIR = join(ROOT, '.github/workflows');

const FAILURE_TITLE = "Workflow di stato: commit saltato perché --autostash svuota l'indice";

type Finding = { line: number; command: string };

/**
 * Walk one step's shell script in order and report every command that reads
 * the index (`git diff --cached|--staged`, `git commit`) after an autostash
 * has un-staged what an earlier `git add` staged, with no `git add` in
 * between to stage it again.
 */
function findAutostashIndexLoss(script: string): Finding[] {
  const findings: Finding[] = [];
  let staged = false;
  let lost = false;
  // Join `\` continuations so a flag on the next physical line is still seen.
  const lines = script.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    // One physical line can chain commands: judge them left to right.
    for (const command of line.split(/&&|\|\||;/).map((part) => part.trim())) {
      if (!/\bgit\b/.test(command)) continue;
      if (/\bgit\s+(?:-C\s+\S+\s+)?add\b/.test(command)) {
        staged = true;
        lost = false;
        continue;
      }
      // `--autostash` on the command, or the same behaviour switched on inline
      // with `git -c rebase.autoStash=true pull --rebase`.
      if (
        /\bgit\b.*\b(?:pull|rebase|merge)\b.*--autostash\b/.test(command)
        || /\bgit\b.*-c\s+rebase\.autostash=true\b.*\b(?:pull|rebase)\b/i.test(command)
      ) {
        if (staged) lost = true;
        continue;
      }
      const readsIndex = /\bgit\b.*\bdiff\b.*--(?:cached|staged)\b/.test(command)
        || /\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(command);
      if (!readsIndex) continue;
      if (lost) findings.push({ line: index + 1, command });
      if (/\bcommit\b/.test(command)) {
        staged = false;
        lost = false;
      }
    }
  });
  return findings;
}

type Step = { name?: string; run?: unknown };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function runSteps(file: string): Array<{ where: string; run: string }> {
  const document = (parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) ?? {}) as Workflow;
  return Object.entries(document.jobs ?? {}).flatMap(([jobId, job]) =>
    (job?.steps ?? [])
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => typeof step?.run === 'string')
      .map(({ step, index }) => ({
        where: `${file} › ${jobId} › ${step.name ?? `step ${index + 1}`}`,
        run: step.run as string,
      })),
  );
}

describe('findAutostashIndexLoss', () => {
  it('flags add → pull --rebase --autostash → diff --cached', () => {
    const script = [
      'git config user.name bot',
      'git add data/state.json 2>/dev/null || true',
      'git pull --rebase --autostash origin main',
      'if git diff --cached --quiet; then',
      '  exit 0',
      'fi',
      'git commit -m state',
    ].join('\n');
    expect(findAutostashIndexLoss(script)).toEqual([
      { line: 4, command: 'if git diff --cached --quiet' },
      { line: 7, command: 'git commit -m state' },
    ]);
  });

  it('flags the same trap spelled with --staged, rebase and a line continuation', () => {
    const script = [
      'git add data/state.json',
      'git fetch origin main',
      'git rebase \\',
      '  --autostash origin/main',
      'git diff --staged --quiet || git commit -m state',
    ].join('\n');
    expect(findAutostashIndexLoss(script).map((finding) => finding.command)).toEqual([
      'git diff --staged --quiet',
      'git commit -m state',
    ]);
  });

  it('flags the trap when autostash is switched on with -c rebase.autoStash=true', () => {
    const script = [
      'git add data/state.json',
      'git -c rebase.autoStash=true pull --rebase origin main',
      'git diff --cached --quiet || git commit -m state',
    ].join('\n');
    expect(findAutostashIndexLoss(script).map((finding) => finding.command)).toEqual([
      'git diff --cached --quiet',
      'git commit -m state',
    ]);
    // Commit first, then the same pull: nothing staged is left to lose.
    expect(findAutostashIndexLoss([
      'git add data/state.json',
      'git commit -m state',
      'git -c rebase.autoStash=true pull --rebase origin main',
    ].join('\n'))).toEqual([]);
  });

  it('accepts commit-first, then integrate', () => {
    const script = [
      'git add data/state.json',
      'if git diff --cached --quiet; then exit 0; fi',
      'git commit -m state',
      'bash scripts/lib/git-push-with-retry.sh',
    ].join('\n');
    expect(findAutostashIndexLoss(script)).toEqual([]);
  });

  it('accepts an autostash pull that runs before anything is staged, or is followed by a fresh add', () => {
    expect(findAutostashIndexLoss([
      'git pull --rebase --autostash origin main',
      'git add data/state.json',
      'git diff --cached --quiet || git commit -m state',
    ].join('\n'))).toEqual([]);
    expect(findAutostashIndexLoss([
      'git add data/state.json',
      'git pull --rebase --autostash origin main',
      'git add data/state.json',
      'git diff --cached --quiet || git commit -m state',
    ].join('\n'))).toEqual([]);
  });

  it('ignores the sequence when it only appears in comments', () => {
    expect(findAutostashIndexLoss([
      'git add data/state.json',
      '# the old order ran git pull --rebase --autostash origin main here',
      'git diff --cached --quiet || git commit -m state',
    ].join('\n'))).toEqual([]);
  });
});

describe('workflow steps never read the index after an autostash un-staged it', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file)).sort();

  it('reads the real workflow directory', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('quality-alerts.yml');
    expect(files).toContain('refresh-gsc-marquee-demand.yml');
  });

  it(FAILURE_TITLE, () => {
    const offenders = files.flatMap((file) =>
      runSteps(file).flatMap(({ where, run }) =>
        findAutostashIndexLoss(run).map(
          (finding) => `${where} (riga ${finding.line} dello step): ${finding.command}`,
        ),
      ),
    );
    expect(
      offenders,
      `${FAILURE_TITLE}. Committa PRIMA di integrare (git add → git diff --cached → git commit → scripts/lib/git-push-with-retry.sh), oppure ripeti il git add dopo il pull.`,
    ).toEqual([]);
  });

  it.each(['quality-alerts.yml', 'refresh-gsc-marquee-demand.yml'])(
    '%s commit step has no autostash and does not swallow a failed git add',
    (file) => {
      const commitStep = runSteps(file).find(({ run }) => /\bgit commit\b/.test(run));
      expect(commitStep, `${file} has no commit step`).toBeDefined();
      const code = (commitStep?.run ?? '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/--autostash/);
      // A swallowed `git add` failure stages nothing and reads as "no changes".
      expect(code).not.toMatch(/git add[^\n]*\|\|\s*true/);
    },
  );
});
