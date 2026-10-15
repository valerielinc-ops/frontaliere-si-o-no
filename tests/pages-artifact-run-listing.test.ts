import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * Osservatore del resolver dell'artifact Pages contro l'elenco di run «fermo».
 *
 * `GET …/workflows/deploy.yml/runs?branch=main&status=success` senza finestra
 * `created` restituisce a tratti un elenco vecchio di settimane o mesi. La run
 * 37036020157 (2026-10-02) ha ricevuto 150 candidati, il piu' recente del
 * 16-08: tutti oltre la retention, e l'errore diceva «nessun artifact» mentre
 * le build del giorno avevano il loro. Due fixer hanno letto «artifact scaduto
 * per retention» senza guardare la data del primo candidato.
 *
 * Qui lo script dell'action gira DAVVERO, con un `gh` finto che riproduce il
 * comportamento dell'API: senza `created` risponde con l'elenco fermo, con
 * `created` con quello corrente. Se la query torna a `branch+status` senza
 * finestra, il caso «fresco» diventa rosso.
 */

const ROOT = path.resolve(__dirname, '..');
const ACTION_PATH = '.github/actions/fetch-pages-artifact/action.yml';
const DEPLOY_PATH = '.github/workflows/deploy.yml';
const MEASURE_PATH = '.github/workflows/measure-deploy-delta.yml';
const DAY_MS = 86_400_000;

const actionSource = readFileSync(path.join(ROOT, ACTION_PATH), 'utf8');
const action = yaml.load(actionSource) as { runs: { steps: Array<{ id?: string; run?: string }> } };
const script = action.runs.steps.find((step) => step.id === 'fetch')?.run ?? '';

const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
const run = (id: number, daysAgo: number) => ({ id, created_at: isoDaysAgo(daysAgo), head_sha: `${id}`.padEnd(40, 'a') });

// Elenco corrente, volutamente NON in ordine: la scelta deve venire
// dall'ordinamento locale su created_at, non dall'ordine della risposta.
const FRESH_RUNS = [run(3003, 3), run(3001, 0.2), run(3002, 1)];
// Elenco «fermo»: il piu' recente ha mesi, come nella run 37036020157.
const STALE_RUNS = [run(1001, 48), run(1002, 60), run(1003, 200)];

const GH_STUB = `#!/usr/bin/env bash
# gh finto: risponde solo a \`gh api\`, dai file di $GH_STUB_DIR.
set -euo pipefail
url=""; jqf=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jq) jqf="$2"; shift 2 ;;
    -H) shift 2 ;;
    api) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$GH_STUB_DIR/calls.log"
emit() { if [ -n "$jqf" ]; then jq -r "$jqf" "$1"; else cat "$1"; fi; }
case "$url" in
  */actions/workflows/deploy.yml/runs\\?*)
    case "$url" in
      *created=*) emit "$GH_STUB_DIR/runs-with-created.json" ;;
      *) emit "$GH_STUB_DIR/runs-without-created.json" ;;
    esac ;;
  */actions/runs/*/artifacts\\?*)
    id="\${url#*/actions/runs/}"; id="\${id%%/*}"
    emit "$GH_STUB_DIR/artifacts-$id.json" ;;
  */actions/artifacts/*/zip)
    cat "$GH_STUB_DIR/pages.zip" ;;
  *) echo "gh stub: unexpected call $url" >&2; exit 1 ;;
esac
`;

let sandbox = '';

function resolve({ withCreated, withoutCreated }: { withCreated: unknown[]; withoutCreated: unknown[] }) {
  const dir = mkdtempSync(path.join(sandbox, 'case-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), GH_STUB);
  chmodSync(path.join(bin, 'gh'), 0o755);
  writeFileSync(path.join(dir, 'runs-with-created.json'), JSON.stringify({ workflow_runs: withCreated }));
  writeFileSync(path.join(dir, 'runs-without-created.json'), JSON.stringify({ workflow_runs: withoutCreated }));
  // 3001 (la piu' recente) ha l'artifact scaduto; 3002 lo ha vivo; 3003 anche.
  const artifact = (id: number, expired: boolean) => ({
    artifacts: [{ id: id * 10, name: 'github-pages', expired, created_at: isoDaysAgo(1) }],
  });
  writeFileSync(path.join(dir, 'artifacts-3001.json'), JSON.stringify(artifact(3001, true)));
  writeFileSync(path.join(dir, 'artifacts-3002.json'), JSON.stringify(artifact(3002, false)));
  writeFileSync(path.join(dir, 'artifacts-3003.json'), JSON.stringify(artifact(3003, false)));
  for (const stale of STALE_RUNS) {
    writeFileSync(path.join(dir, `artifacts-${stale.id}.json`), JSON.stringify(artifact(stale.id, true)));
  }
  execFileSync('cp', [path.join(sandbox, 'pages.zip'), path.join(dir, 'pages.zip')]);
  const output = path.join(dir, 'github-output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_STUB_DIR: dir,
      GH_TOKEN: 'stub',
      GH_REPO: 'owner/repo',
      INPUT_RUN_ID: '',
      INPUT_OUTPUT_DIR: path.join(dir, 'out'),
      INPUT_EXPECTED_SHA: '',
      GITHUB_OUTPUT: output,
    },
  });
  const callsLog = path.join(dir, 'calls.log');
  return {
    status: result.status,
    log: `${result.stdout}\n${result.stderr}`,
    outputs: readFileSync(output, 'utf8'),
    calls: existsSync(callsLog) ? readFileSync(callsLog, 'utf8').split('\n').filter(Boolean) : [],
  };
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'pages-artifact-run-listing-'));
  const payload = path.join(sandbox, 'payload');
  mkdirSync(payload);
  writeFileSync(path.join(payload, 'index.html'), '<!doctype html><title>fixture</title>');
  execFileSync('tar', ['-cf', path.join(sandbox, 'artifact.tar'), '-C', payload, 'index.html']);
  execFileSync('zip', ['-q', '-j', path.join(sandbox, 'pages.zip'), path.join(sandbox, 'artifact.tar')]);
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('fetch-pages-artifact: elenco delle run con finestra created', () => {
  it('lo script del resolver e\' quello dello step `fetch`', () => {
    expect(script).toContain('actions/workflows/deploy.yml/runs?');
  });

  it('elenco fresco: sceglie la run piu\' recente con artifact vivo', () => {
    const result = resolve({ withCreated: FRESH_RUNS, withoutCreated: STALE_RUNS });
    expect(result.log).not.toContain('::error');
    expect(result.status).toBe(0);
    // 3001 e' la piu' recente ma il suo artifact e' scaduto → 3002.
    expect(result.outputs).toContain('run-id=3002');
    expect(result.log).toMatch(/run 3001 .*no live github-pages artifact/);
    // Ordinamento locale: il primo candidato stampato e' il piu' recente,
    // anche se la risposta lo porta in seconda posizione.
    expect(result.log.indexOf('  3001\t')).toBeLessThan(result.log.indexOf('  3002\t'));
    expect(result.log.indexOf('  3002\t')).toBeLessThan(result.log.indexOf('  3003\t'));
  });

  it('la query porta la finestra created = retention + 1 giorno', () => {
    const result = resolve({ withCreated: FRESH_RUNS, withoutCreated: STALE_RUNS });
    const listing = result.calls.filter((call) => call.includes('/actions/workflows/deploy.yml/runs?'));
    expect(listing.length).toBeGreaterThan(0);
    const retention = Number(/RETENTION_DAYS=(\d+)/.exec(script)?.[1]);
    const expected = new Date(Date.now() - (retention + 1) * DAY_MS).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.now() - (retention + 2) * DAY_MS).toISOString().slice(0, 10);
    for (const call of listing) {
      expect(call).toContain('branch=main');
      const since = /[?&]created=%3E%3D(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(call)?.[1];
      // Il test puo' attraversare la mezzanotte UTC fra lo script e questa riga.
      expect([expected, dayBefore]).toContain(since);
    }
  });

  it('elenco fermo: fallisce con «elenco API non aggiornato», non con «nessun artifact»', () => {
    // L'API ignora la finestra e serve comunque l'elenco vecchio di mesi.
    const result = resolve({ withCreated: STALE_RUNS, withoutCreated: STALE_RUNS });
    expect(result.status).toBe(1);
    expect(result.log).toContain('Elenco API non aggiornato');
    expect(result.log).toContain(STALE_RUNS[0].created_at);
    expect(result.log).not.toMatch(/still has a 'github-pages' artifact|Walk-back cap reached/);
    // Fermato prima di interrogare gli artifact di candidati tutti scaduti.
    expect(result.calls.some((call) => /\/actions\/runs\/\d+\/artifacts/.test(call))).toBe(false);
    expect(result.outputs).toBe('');
  });

  it('nessuna run nella finestra: lo dice, con la data della finestra', () => {
    const result = resolve({ withCreated: [], withoutCreated: STALE_RUNS });
    expect(result.status).toBe(1);
    expect(result.log).toMatch(/No successful deploy\.yml run on main created since \d{4}-\d{2}-\d{2}/);
  });

  it('nessun messaggio suggerisce piu\' di alzare MAX_PAGES', () => {
    const errors = script.split('\n').filter((line) => line.includes('::error'));
    expect(errors.filter((line) => /\bRaise MAX_PAGES\b/.test(line))).toEqual([]);
  });
});

describe('la finestra created segue la retention dichiarata in deploy.yml', () => {
  // La retention dell'artifact `github-pages` si legge dal workflow che lo
  // carica: se cambia li', resolver e workflow di misura devono seguirla.
  // Si legge lo step vero (`with.name: github-pages`), non il primo
  // `retention-days` che segue nel testo: se l'upload perdesse il suo, una
  // regex pescherebbe quello dello step dopo.
  const deploy = yaml.load(readFileSync(path.join(ROOT, DEPLOY_PATH), 'utf8')) as {
    jobs: Record<string, { steps?: Array<{ with?: Record<string, unknown> }> }>;
  };
  const uploads = Object.values(deploy.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.with?.name === 'github-pages' && 'retention-days' in (step.with ?? {}));
  const retention = uploads.length === 1 ? String(uploads[0].with?.['retention-days']) : null;

  it('deploy.yml dichiara la retention di github-pages', () => {
    expect(uploads).toHaveLength(1);
    expect(retention).toMatch(/^\d+$/);
  });

  it.each([ACTION_PATH, MEASURE_PATH])('%s usa la stessa retention', (file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    expect(/^\s*RETENTION_DAYS=(\d+)\s*$/m.exec(source)?.[1]).toBe(retention);
  });
});
