// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Build history: push su main dentro build-locale (gambe concorrenti sul
 * critical path) — issue 9247.
 *
 * Le gambe del matrix build-locale facevano tre `git push` su main a testa
 * (dodici per run), in gara fra loro e con ogni altro scrittore di main: run
 * 37107091990, step "Append build memory history row" a 37,8 min sulla gamba
 * it e quattro righe perse dietro il continue-on-error. Ora le gambe mettono
 * le righe in staging e le caricano come artifact; il job build-history-commit
 * fa UN commit per run dopo tutte le gambe. Questi test diventano rossi se
 * qualcuno rimette il push dentro la gamba o mette il job di commit nel
 * percorso di publish.
 */

const ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const WORKFLOW = YAML.parse(DEPLOY_YML) as { jobs: Record<string, any> };
const BUILD_LOCALE_STEPS: Array<Record<string, any>> = WORKFLOW.jobs['build-locale'].steps;
const STAGER = resolve(ROOT, 'scripts/lib/append-build-history-row.sh');
const WRITER = resolve(ROOT, 'scripts/lib/commit-build-history-rows.sh');
const PRODUCERS = [
  'Append build memory history row',
  'Append post-build phase timings row',
  'Append incremental manifest history row',
];
const GIT_WRITE = /\bgit\s+(push|commit)\b|git-push-with-retry\.sh|commit-build-history-rows\.sh/;

const stepRuns = (job: Record<string, any>): string[] =>
  (job.steps ?? []).map((step: Record<string, any>) => String(step.run ?? ''));

describe('deploy.yml — la storia di build ha un solo scrittore per run (#9247)', () => {
  it('nessun produttore di righe nella gamba committa o pusha', () => {
    // Solo il codice, non l'header che racconta il vecchio percorso.
    const stagerCode = readFileSync(STAGER, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(stagerCode, 'lo script di staging invoca git').not.toMatch(/(^|[\s;|&(])git\s/m);
    expect(stagerCode).not.toMatch(GIT_WRITE);
    for (const name of PRODUCERS) {
      const step = BUILD_LOCALE_STEPS.find((s) => s.name === name);
      expect(step, `build-locale: manca lo step "${name}"`).toBeDefined();
      expect(step!.run).toContain('scripts/lib/append-build-history-row.sh');
      expect(step!.run, `"${name}" scrive su main dentro la gamba`).not.toMatch(GIT_WRITE);
      expect(step!.env?.HISTORY_STAGE_DIR).toBe('${{ runner.temp }}/build-history-rows');
      expect(step!.if).toBe('always()');
      expect(step!['continue-on-error']).toBe(true);
    }
  });

  it('nessuno step della gamba tocca data/build-history con un commit o un push', () => {
    for (const step of BUILD_LOCALE_STEPS) {
      const run = String(step.run ?? '');
      if (!run.includes('data/build-history') && !run.includes('memory-peaks.jsonl')) continue;
      expect(run, `"${step.name}": commit/push della storia di build dentro la gamba`).not.toMatch(GIT_WRITE);
    }
  });

  it('la gamba carica le righe in staging come artifact, anche se e\' rossa', () => {
    const upload = BUILD_LOCALE_STEPS.find((s) => s.name === 'Upload build-history rows');
    expect(upload, 'build-locale: manca lo step "Upload build-history rows"').toBeDefined();
    expect(upload!.uses).toBe('actions/upload-artifact@v7');
    expect(upload!.if).toBe('always()');
    expect(upload!['continue-on-error']).toBe(true);
    expect(String(upload!.with?.name)).toMatch(/^build-history-rows-\$\{\{ matrix\.locale \}\}/);
    expect(upload!.with?.path).toBe('${{ runner.temp }}/build-history-rows/');
    expect(upload!.with?.['if-no-files-found']).toBe('ignore');
    const uploadIndex = BUILD_LOCALE_STEPS.indexOf(upload!);
    for (const name of PRODUCERS) {
      const producerIndex = BUILD_LOCALE_STEPS.findIndex((s) => s.name === name);
      expect(producerIndex, `"${name}" deve stare prima dell'upload`).toBeLessThan(uploadIndex);
    }
  });

  it('il job build-history-commit gira dopo tutte le gambe ed e\' solo telemetria', () => {
    const job = WORKFLOW.jobs['build-history-commit'];
    expect(job, 'deploy.yml: manca il job build-history-commit').toBeDefined();
    expect([].concat(job.needs)).toEqual(['build-locale']);
    expect(String(job.if)).toContain('always()');
    expect(job['continue-on-error']).toBe(true);
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(10);
    const download = job.steps.find((s: Record<string, any>) => s.uses === 'actions/download-artifact@v8');
    expect(download?.with?.pattern).toBe('build-history-rows-*');
    // Senza merge-multiple: due tentativi della stessa gamba hanno file omonimi.
    expect(download?.with?.['merge-multiple']).not.toBe(true);
    expect(stepRuns(job).some((run) => run.includes('bash scripts/lib/commit-build-history-rows.sh'))).toBe(true);
  });

  it('build-history-commit e\' l\'unico job che committa la storia di build', () => {
    expect(readFileSync(WRITER, 'utf8')).toContain('git-push-with-retry.sh');
    for (const [id, job] of Object.entries(WORKFLOW.jobs)) {
      for (const step of job.steps ?? []) {
        const run = String(step.run ?? '');
        if (run.includes('commit-build-history-rows.sh')) {
          expect(id, `"${step.name}" committa la storia di build fuori dal job dedicato`).toBe(
            'build-history-commit',
          );
        }
        if (id === 'build-locale' && /git-push-with-retry\.sh|\bgit\s+push\b/.test(run)) {
          // L'unico push rimasto nella gamba e' quello di dist-size-history
          // (solo gamba it), fuori da questa scheda.
          expect(step.name).toBe('Commit dist-size-history row + url-first-seen updates');
          expect(run).not.toContain('data/build-history');
        }
      }
    }
  });

  it('nessun job aspetta build-history-commit (fuori dal percorso di publish)', () => {
    for (const [id, job] of Object.entries(WORKFLOW.jobs)) {
      expect([].concat(job.needs ?? []), `${id} non deve aspettare build-history-commit`).not.toContain(
        'build-history-commit',
      );
    }
  });
});

function runStager(stageDir: string, label: string, row: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [STAGER], {
    cwd: stageDir,
    input: row,
    encoding: 'utf8',
    env: {
      ...process.env,
      HISTORY_STAGE_DIR: join(stageDir, 'rows'),
      HISTORY_LABEL: label,
      ROW_LOCALE: 'it',
      ...extraEnv,
    },
  });
}

describe('append-build-history-row.sh — solo staging, nessun git', () => {
  it('due label finiscono in due file, senza mai invocare git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-stage-'));
    const fakeBin = join(dir, 'bin');
    const marker = join(dir, 'git-was-called');
    try {
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, 'git'), `#!/usr/bin/env bash\n: > ${JSON.stringify(marker)}\nexit 97\n`);
      chmodSync(join(fakeBin, 'git'), 0o755);
      const env = { PATH: `${fakeBin}:${process.env.PATH}` };
      const memory = runStager(dir, 'build-history', '{"locale":"it","peak_rss_mb":1}', env);
      const profile = runStager(dir, 'build-history-profile', '{"locale":"it","kind":"build-profile"}', env);
      const second = runStager(dir, 'build-history', '{"locale":"it","peak_rss_mb":2}', env);
      expect([memory.status, profile.status, second.status], memory.stderr + profile.stderr).toEqual([0, 0, 0]);
      expect(readdirSync(join(dir, 'rows')).sort()).toEqual([
        'build-history-it.jsonl',
        'build-history-profile-it.jsonl',
      ]);
      expect(readFileSync(join(dir, 'rows', 'build-history-it.jsonl'), 'utf8')).toBe(
        '{"locale":"it","peak_rss_mb":1}\n{"locale":"it","peak_rss_mb":2}\n',
      );
      expect(existsSync(marker), 'lo staging ha invocato git').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('una riga non JSON o su piu\' righe esce 1 e non scrive niente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-stage-bad-'));
    try {
      expect(runStager(dir, 'build-history', 'not json').status).toBe(1);
      expect(runStager(dir, 'build-history', '[1,2]').status).toBe(1);
      expect(runStager(dir, 'build-history', '{"a":1}\n{"b":2}').status).toBe(1);
      expect(runStager(dir, '../escape', '{"a":1}').status).toBe(1);
      expect(existsSync(join(dir, 'rows'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('una riga vuota non e\' un errore e non crea file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bh-stage-empty-'));
    try {
      const result = runStager(dir, 'build-history', '');
      expect(result.status).toBe(0);
      expect(existsSync(join(dir, 'rows'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const HISTORY = 'data/build-history/memory-peaks.jsonl';
const WRITER_FILES = [
  'scripts/lib/commit-build-history-rows.sh',
  'scripts/lib/git-push-with-retry.sh',
  'scripts/lib/configure-main-push-auth.sh',
  'scripts/lib/clear-checkout-git-credentials.sh',
  'scripts/lib/git-push-rejection.sh',
  'scripts/lib/accumulator-byte-floor-guard.mjs',
  'scripts/ci/assert-accumulator-write.mjs',
];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function cloneWithWriter(remote: string, dir: string): void {
  git(dir, ['clone', '-q', '--branch', 'main', remote, '.']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  for (const rel of WRITER_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(resolve(ROOT, rel), join(dir, rel));
  }
}

function writeRows(rowsDir: string, artifact: string, file: string, lines: string[]): void {
  mkdirSync(join(rowsDir, artifact), { recursive: true });
  writeFileSync(join(rowsDir, artifact, file), lines.map((l) => `${l}\n`).join(''));
}

function runWriter(cwd: string, rowsDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', ['scripts/lib/commit-build-history-rows.sh'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      HISTORY_ROWS_DIR: rowsDir,
      HISTORY_COMMIT_MSG: 'chore(build-history): append rows run 42',
    },
  });
}

function initRemote(base: string, files: Record<string, string>): string {
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  mkdirSync(remote);
  mkdirSync(seed);
  git(remote, ['init', '-q', '--bare']);
  git(seed, ['init', '-q']);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), content);
    git(seed, ['add', rel]);
  }
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'HEAD:main']);
  return remote;
}

function cloneAt(remote: string, dir: string): void {
  mkdirSync(dir);
  git(dir, ['clone', '-q', '--branch', 'main', remote, '.']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

function appendOnMain(dir: string, lines: string[], message: string): void {
  const path = join(dir, HISTORY);
  writeFileSync(path, readFileSync(path, 'utf8') + lines.map((l) => `${l}\n`).join(''));
  git(dir, ['commit', '-q', '-am', message]);
  git(dir, ['push', '-q', 'origin', 'HEAD:main']);
}

describe('commit-build-history-rows.sh — un commit per run, idempotente', () => {
  it('unisce le righe di tutte le gambe in un commit, dedup e rigenerazione su main avanzato', () => {
    const base = mkdtempSync(join(tmpdir(), 'bh-commit-'));
    const runner = join(base, 'runner');
    const rival = join(base, 'rival');
    const rowsDir = join(base, 'rows');
    const shim = join(base, 'shim');
    try {
      const remote = initRemote(base, { [HISTORY]: '{"old":1}\n' });
      mkdirSync(runner);
      cloneWithWriter(remote, runner);

      // Un altro scrittore appende su main fra il fetch dello script e il suo
      // push: un `git` finto nel PATH esegue il fetch vero e poi, una volta
      // sola, pubblica il commit del rivale. Il primo push viene respinto e,
      // senza merge=union in questo repo, il rebase va in conflitto sulla coda
      // del file → ramo --regenerate-cmd.
      cloneAt(remote, rival);
      writeFileSync(join(rival, HISTORY), '{"old":1}\n{"rival":1}\n');
      git(rival, ['commit', '-q', '-am', 'rival append']);
      mkdirSync(shim);
      const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(shim, 'git'),
        [
          '#!/usr/bin/env bash',
          '"$BH_REAL_GIT" "$@"; status=$?',
          'if [ "${1:-}" = fetch ] && [ ! -e "$BH_RACE_MARKER" ]; then',
          '  : > "$BH_RACE_MARKER"',
          '  "$BH_REAL_GIT" -C "$BH_RIVAL_DIR" push -q origin HEAD:main >&2',
          'fi',
          'exit $status',
          '',
        ].join('\n'),
      );
      chmodSync(join(shim, 'git'), 0o755);
      const raceEnv = {
        PATH: `${shim}:${process.env.PATH ?? ''}`,
        BH_REAL_GIT: realGit,
        BH_RACE_MARKER: join(base, 'race-done'),
        BH_RIVAL_DIR: rival,
      };

      writeRows(rowsDir, 'build-history-rows-it-1', 'build-history-it.jsonl', ['{"locale":"it","m":1}']);
      writeRows(rowsDir, 'build-history-rows-it-1', 'build-history-profile-it.jsonl', [
        '{"locale":"it","kind":"build-profile"}',
        'troncata {"locale"',
      ]);
      // Rerun della gamba it: file omonimo in un artifact diverso.
      writeRows(rowsDir, 'build-history-rows-it-2', 'build-history-it.jsonl', ['{"locale":"it","m":2}']);
      // Riga gia' su main (commit di un tentativo precedente): non si duplica.
      writeRows(rowsDir, 'build-history-rows-de-1', 'build-history-de.jsonl', ['{"old":1}', '{"locale":"de","m":1}']);

      const before = Number(git(remote, ['rev-list', '--count', 'main']).trim());
      const result = runWriter(runner, rowsDir, raceEnv);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(raceEnv.BH_RACE_MARKER), 'il rivale deve aver pubblicato').toBe(true);
      expect(result.stderr + result.stdout).toContain('1 riga/e non JSON scartate');
      // Il main avanzato ha fatto passare il push dal ramo di rigenerazione.
      expect(result.stdout).toContain('Rebase conflict; regenerating data on top of new base');

      const after = Number(git(remote, ['rev-list', '--count', 'main']).trim());
      expect(after - before, 'il job deve aggiungere UN commit su main (piu\' quello del rivale)').toBe(2);
      expect(git(remote, ['log', '-1', '--format=%s', 'main']).trim()).toBe(
        'chore(build-history): append rows run 42',
      );
      const lines = git(remote, ['show', `main:${HISTORY}`]).trim().split('\n');
      expect(lines.slice(0, 2)).toEqual(['{"old":1}', '{"rival":1}']);
      expect(lines.slice(2).sort()).toEqual([
        '{"locale":"de","m":1}',
        '{"locale":"it","kind":"build-profile"}',
        '{"locale":"it","m":1}',
        '{"locale":"it","m":2}',
      ]);

      // Stesse righe di nuovo (rerun del job di commit): niente commit vuoto.
      const again = runWriter(runner, rowsDir);
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(again.stdout).toContain('niente da committare');
      expect(Number(git(remote, ['rev-list', '--count', 'main']).trim())).toBe(after);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it('dedup contro la punta di main, non contro il checkout vecchio del job (rerun con merge=union)', () => {
    // Il checkout del job e' github.sha, vecchio di 40-130 minuti. Nel rerun
    // di una gamba il job riscarica gli artifact del tentativo 1, le cui righe
    // sono gia' su main ma non nel checkout. Con merge=union il rebase di quei
    // doppioni non va in conflitto: il dedup deve guardare la punta di main.
    const base = mkdtempSync(join(tmpdir(), 'bh-commit-stale-'));
    const runner = join(base, 'runner');
    const writer = join(base, 'writer');
    const rowsDir = join(base, 'rows');
    try {
      const remote = initRemote(base, {
        '.gitattributes': `${HISTORY} merge=union\n`,
        [HISTORY]: '{"old":1}\n',
      });
      mkdirSync(runner);
      cloneWithWriter(remote, runner);

      cloneAt(remote, writer);
      const attempt1 = ['de', 'en', 'fr', 'it'].map((l) => `{"r":1,"locale":"${l}"}`);
      appendOnMain(writer, attempt1, 'chore(build-history): append rows run 1 attempt 1');
      appendOnMain(writer, ['{"r":2,"locale":"de"}'], 'chore(build-history): append rows run 2');

      writeRows(rowsDir, 'build-history-rows-de-1', 'build-history-de.jsonl', [attempt1[0]]);
      writeRows(rowsDir, 'build-history-rows-de-2', 'build-history-de.jsonl', ['{"r":1,"locale":"de","attempt":2}']);
      writeRows(rowsDir, 'build-history-rows-en-1', 'build-history-en.jsonl', [attempt1[1]]);
      writeRows(rowsDir, 'build-history-rows-fr-1', 'build-history-fr.jsonl', [attempt1[2]]);
      writeRows(rowsDir, 'build-history-rows-it-1', 'build-history-it.jsonl', [attempt1[3]]);

      // Un checkout con modifiche tracciate non e' quello del job: niente reset.
      writeFileSync(join(runner, HISTORY), '{"old":1}\n{"local":1}\n');
      const dirty = runWriter(runner, rowsDir);
      expect(dirty.status).toBe(1);
      expect(dirty.stdout + dirty.stderr).toContain('rifiuto il reset');
      expect(readFileSync(join(runner, HISTORY), 'utf8')).toContain('{"local":1}');
      git(runner, ['checkout', '--', HISTORY]);

      const result = runWriter(runner, rowsDir);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const lines = git(remote, ['show', `main:${HISTORY}`]).trim().split('\n');
      expect(new Set(lines).size, `righe doppie su main:\n${lines.join('\n')}`).toBe(lines.length);
      expect(lines).toEqual([
        '{"old":1}',
        ...attempt1,
        '{"r":2,"locale":"de"}',
        '{"r":1,"locale":"de","attempt":2}',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it('senza file di righe avvisa ed esce 0 senza toccare git', () => {
    const base = mkdtempSync(join(tmpdir(), 'bh-commit-empty-'));
    try {
      const result = spawnSync('bash', [WRITER], {
        cwd: base,
        encoding: 'utf8',
        env: { ...process.env, HISTORY_ROWS_DIR: join(base, 'missing') },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('nessun file di righe');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
