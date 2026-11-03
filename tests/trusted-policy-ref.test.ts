import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * `github.event.pull_request.base.sha` è il commit di main da cui la PR è
 * PARTITA, non la policy che main applica oggi. Se main aggiunge un modulo del
 * gate dopo l'apertura della PR, quel ref non ce l'ha: `contents/<path>?ref=`
 * risponde 404, il download muore e il verdetto che arriva all'autore è
 * «required review gate skipped» — un rosso che non nomina né il file né il
 * ref. Misurato sul corpus (PR #1599) e riprodotto su questo repo
 * (run 35472199618). Questi test pinnano le due proprietà: l'ancoraggio alla
 * punta di main pinnata, e un errore che dice cosa manca e dove.
 */
const raw = readFileSync('.github/workflows/tests.yml', 'utf8');
const workflow = YAML.parse(raw);

type Step = { id?: string; name?: string; run?: string; env?: Record<string, string> };

function steps(): Step[] {
  return Object.values(workflow.jobs as Record<string, { steps?: Step[] }>)
    .flatMap((job) => job.steps ?? []);
}

function downloaders(): Step[] {
  return steps().filter((step) => /\bdownload_main (?:scripts\/|"\$)/u.test(String(step.run ?? '')));
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (/\s/u.test(char) && quote === null) {
      if (word) words.push(word);
      word = '';
      continue;
    }
    word += char;
  }
  if (escaped) word += '\\';
  if (word) words.push(word);
  return words;
}

function downloaderWorkflowSource(): string {
  return steps().map((step) => String(step.run ?? '')).join('\n');
}

function requiredPositionalArguments(functionName: 'download_main' | 'download_trusted_policy'): number {
  const source = downloaderWorkflowSource();
  const definition = new RegExp(`^\\s*${functionName}\\s*\\(\\s*\\)\\s*\\{\\s*$`, 'mu');
  const match = definition.exec(source);
  expect(match, `definizione di ${functionName} assente da tests.yml`).toBeTruthy();
  const bodyStart = match!.index + match![0].length;
  const nextDefinition = /^\s*[A-Za-z_][\w]*\s*\(\s*\)\s*\{/mu.exec(source.slice(bodyStart));
  const body = source.slice(bodyStart, nextDefinition ? bodyStart + nextDefinition.index : undefined);
  const required = [...body.matchAll(/\$\{(\d+)(?::-[^}]*|=[^}]*)?\}|\$(\d+)/gu)]
    .filter((reference) => !reference[0].includes(':-') && !reference[0].includes('='))
    .map((reference) => Number(reference[1] ?? reference[2]));
  return Math.max(0, ...required);
}

function downloaderCalls(): { functionName: string; argumentCount: number; line: string }[] {
  const calls: { functionName: string; argumentCount: number; line: string }[] = [];
  for (const run of steps().map((step) => String(step.run ?? ''))) {
    for (const line of run.split('\n')) {
      const match = /^\s*(download_main|download_trusted_policy)\b(.*)$/u.exec(line);
      if (!match || match[2].trimStart().startsWith('()')) continue;
      calls.push({ functionName: match[1], argumentCount: shellWords(match[2]).length, line: line.trim() });
    }
  }
  return calls;
}

function downloaderScript(): string {
  const step = steps().find((candidate) => candidate.id === 'trusted_policy_downloader');
  const run = String(step?.run ?? '');
  const open = run.indexOf("<<'POLICY_DOWNLOADER'\n");
  const close = run.indexOf('\nPOLICY_DOWNLOADER\n', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return run.slice(open + "<<'POLICY_DOWNLOADER'\n".length, close);
}

function runDownload(
  responses: string[],
  path = 'scripts/ci/policy.mjs',
  mode: 'required' | 'optional' = 'required',
  invocation?: string[],
) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-download-'));
  const binDir = join(dir, 'bin');
  const fakeGh = join(dir, 'gh');
  const fakeSleep = join(binDir, 'sleep');
  const downloader = join(dir, 'downloader.sh');
  const runner = join(dir, 'run.sh');
  const responseFile = join(dir, 'responses.txt');
  const callCountFile = join(dir, 'calls.txt');
  const sleepLog = join(dir, 'sleeps.txt');
  const destination = join(dir, 'policy', path);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(responseFile, `${responses.join('\n')}\n`);
  writeFileSync(downloader, downloaderScript());
  writeFileSync(fakeGh, [
    '#!/bin/bash',
    'set -euo pipefail',
    'count=0',
    '[ ! -f "$GH_CALL_COUNT" ] || read -r count < "$GH_CALL_COUNT"',
    'count=$((count + 1))',
    'printf "%s\\n" "$count" > "$GH_CALL_COUNT"',
    'response=$(sed -n "${count}p" "$GH_RESPONSES")',
    'case "$response" in',
    '  OK:*) printf "%s\\n" "${response#OK:}" ;;',
    '  ERR:*) printf "%s\\n" "${response#ERR:}" >&2; exit 1 ;;',
    '  *) printf "unexpected fake gh response: %s\\n" "$response" >&2; exit 90 ;;',
    'esac',
  ].join('\n'));
  writeFileSync(fakeSleep, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$SLEEP_LOG"\n');
  writeFileSync(runner, [
    'set -euo pipefail',
    'source "$POLICY_DOWNLOADER"',
    ...(invocation ?? [`${mode === 'required' ? 'download_main' : 'download_optional'} "$TEST_PATH" "$TEST_DEST"`]),
  ].join('\n'));
  chmodSync(fakeGh, 0o755);
  chmodSync(fakeSleep, 0o755);

  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', [runner], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        POLICY_DOWNLOADER: downloader,
        TRUSTED_GH_BIN: fakeGh,
        POLICY_REF: 'a'.repeat(40),
        GITHUB_REPOSITORY: 'owner/repo',
        GH_RESPONSES: responseFile,
        GH_CALL_COUNT: callCountFile,
        SLEEP_LOG: sleepLog,
        TEST_PATH: path,
        TEST_DEST: destination,
        REFRESH_ROOT: join(dir, 'policy'),
      },
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    status = failure.status ?? 1;
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  const attempts = (() => {
    try { return Number(readFileSync(callCountFile, 'utf8').trim()); } catch { return 0; }
  })();
  const sleeps = (() => {
    try { return readFileSync(sleepLog, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  })();
  let downloaded = '';
  try { downloaded = readFileSync(destination, 'utf8'); } catch { /* il file può non esistere per fail-closed */ }
  rmSync(dir, { recursive: true, force: true });
  return { status, output, attempts, sleeps, downloaded };
}

describe('ref della policy fidata', () => {
  it('tutte le chiamate ai downloader passano gli argomenti richiesti dalla definizione', () => {
    const calls = downloaderCalls();
    const source = downloaderWorkflowSource();
    const references = [...source.matchAll(/\b(download_main|download_trusted_policy)\b/gu)].length;
    const definitions = [...source.matchAll(/^\s*(?:download_main|download_trusted_policy)\s*\(\s*\)\s*\{/gmu)].length;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length + definitions, 'ogni riferimento deve essere una definizione o una chiamata estratta')
      .toBe(references);
    for (const call of calls) {
      const required = requiredPositionalArguments(call.functionName as 'download_main' | 'download_trusted_policy');
      expect(call.argumentCount, `${call.functionName} richiede ${required} argomenti: ${call.line}`)
        .toBeGreaterThanOrEqual(required);
    }
  });

  it('il refresh esegue download_main con path e destinazione sotto bash -u e gh finto', () => {
    const result = runDownload(
      ['OK:export const refreshed = true;'],
      'scripts/ci/review-gate.mjs',
      'required',
      [
        'policy_root="$REFRESH_ROOT"',
        'for trusted_path in "$TEST_PATH"; do',
        '  download_main "${trusted_path}" "$policy_root/$trusted_path"',
        'done',
      ],
    );
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.downloaded).toContain('refreshed = true');
  });

  it('nessuno step della policy si ancora a base.sha', () => {
    const anchored = downloaders()
      .filter((step) => String((step.env ?? {}).POLICY_REF ?? '').includes('pull_request.base.sha'))
      .map((step) => step.id ?? step.name);
    expect(anchored, `step ancora su base.sha: ${anchored.join(', ')}`).toEqual([]);
  });

  it('ogni downloader usa lo SHA risolto una volta sola', () => {
    const all = downloaders();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const step of all) {
      expect(String((step.env ?? {}).POLICY_REF ?? ''), `POLICY_REF di ${step.id ?? step.name}`)
        .toContain('steps.policy_ref.outputs.sha');
    }
  });

  it('il resolver esiste, pinna uno SHA a 40 cifre e non ripiega su base.sha', () => {
    const resolver = steps().find((step) => step.id === 'policy_ref');
    expect(resolver).toBeTruthy();
    const run = String(resolver!.run);
    expect(run).toContain('commits/main');
    expect(run).toMatch(/\[0-9a-f\]\{40\}/u);
    expect(run).toContain('printf \'sha=%s\\n\'');
    // Un ripiego su base.sha rimetterebbe in gioco la policy incompleta.
    expect(run).not.toMatch(/policy_ref="?\$\{?FALLBACK_REF/u);
  });

  it('il resolver gira prima di ogni downloader', () => {
    const order = steps();
    const resolver = order.findIndex((step) => step.id === 'policy_ref');
    const firstDownloader = order.findIndex((step) => /\bdownload_main (?:scripts\/|"\$)/u.test(String(step.run ?? '')));
    expect(resolver).toBeGreaterThan(-1);
    expect(resolver).toBeLessThan(firstDownloader);
  });

  it('tutti i download usano il solo helper di rete condiviso', () => {
    const helper = downloaderScript();
    expect(helper).toContain('download_trusted_policy()');
    expect(helper).toContain("--header 'Accept: application/vnd.github.raw+json'");
    expect(helper).toContain('non scaricabile da main@${POLICY_REF}');
    const contentEndpointCalls = steps().map((step) => String(step.run ?? '')).join('\n')
      .match(/"repos\/\$\{GITHUB_REPOSITORY\}\/contents\/\$\{path\}\?ref=\$\{POLICY_REF\}"/gu) ?? [];
    expect(contentEndpointCalls).toHaveLength(1);
    for (const step of downloaders()) {
      expect(String(step.run), `helper condiviso in ${step.id ?? step.name}`)
        .toContain('source "$RUNNER_TEMP/trusted-policy-downloader.sh"');
    }
  });
});

describe('retry limitato del downloader della policy fidata', () => {
  it('ritenta un 500 e attende 5 secondi prima del secondo tentativo', () => {
    const result = runDownload([
      'ERR:gh: Internal Server Error (HTTP 500)',
      'OK:export const trusted = true;',
    ]);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
    expect(result.sleeps).toEqual(['5']);
    expect(result.downloaded).toContain('trusted = true');
  });

  it('usa tutti e quattro i tentativi e il backoff 5/15/30', () => {
    const result = runDownload([
      'ERR:gh: Internal Server Error (HTTP 500)',
      'ERR:gh: Bad Gateway (HTTP 502)',
      'ERR:gh: Service Unavailable (HTTP 503)',
      'OK:export const trusted = true;',
    ]);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(4);
    expect(result.sleeps).toEqual(['5', '15', '30']);
  });

  it('ritenta un timeout di rete', () => {
    const result = runDownload([
      'ERR:gh: net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
      'OK:export const trusted = true;',
    ]);
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
    expect(result.sleeps).toEqual(['5']);
  });

  it.each([
    ['404', 'gh: Not Found (HTTP 404)'],
    ['401', 'gh: Bad credentials (HTTP 401)'],
    ['403', 'gh: Resource not accessible by integration (HTTP 403)'],
  ])('non ritenta su %s e fallisce chiuso', (_label, error) => {
    const result = runDownload([`ERR:${error}`]);
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.output).toContain('scripts/ci/policy.mjs');
    expect(result.output).toContain(`main@${'a'.repeat(40)}`);
  });

  it('per un 404 opzionale non ritenta e continua senza creare il file', () => {
    const result = runDownload(['ERR:gh: Not Found (HTTP 404)'], 'scripts/ci/optional.mjs', 'optional');
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.output).toContain('policy fidata opzionale assente');
    expect(result.downloaded).toBe('');
  });

  it('un contenuto JavaScript non valido fallisce senza retry', () => {
    const result = runDownload(['OK:export const = ;']);
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.output).toContain('contenuto non valido');
  });

  it('valida i JSON trusted senza ritentare un payload non valido', () => {
    const valid = runDownload(['OK:{"type":"module"}'], 'package.json');
    expect(valid.status).toBe(0);
    expect(valid.downloaded).toContain('"type":"module"');
    const invalid = runDownload(['OK:{']);
    expect(invalid.status).not.toBe(0);
    expect(invalid.attempts).toBe(1);
    expect(invalid.sleeps).toEqual([]);
    expect(invalid.output).toContain('contenuto non valido');
  });

  it('root finale vuota produce un errore esplicito prima di risolvere moduli Node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-root-guard-'));
    const downloader = join(dir, 'downloader.sh');
    const runner = join(dir, 'run.sh');
    writeFileSync(downloader, downloaderScript());
    writeFileSync(runner, [
      'set -euo pipefail',
      'source "$POLICY_DOWNLOADER"',
      'require_trusted_policy_module "${REVIEW_POLICY_ROOT:-}" scripts/ci/review-gate.mjs',
    ].join('\n'));
    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', [runner], {
        encoding: 'utf8',
        env: { ...process.env, POLICY_DOWNLOADER: downloader, REVIEW_POLICY_ROOT: '' },
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    expect(status).not.toBe(0);
    expect(output).toContain('policy fidata non disponibile');
    expect(output).not.toContain('Cannot find module');
    rmSync(dir, { recursive: true, force: true });
  });
});
